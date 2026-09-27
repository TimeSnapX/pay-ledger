import { BEVCHAIN_RULES } from "./money.js?v=2";
import { SCHEMA_VERSION, migrateDataset } from "./migrate.js?v=2";
export { shiftsToCsv } from "./exporters.js?v=2";

const DB_NAME = "pay-ledger";
/** IndexedDB version == data schema version. v2: pay rules + meal allowance. */
const DB_VERSION = SCHEMA_VERSION;
const STORES = ["jobs", "shifts", "payslips", "files", "meta"];

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains("jobs")) {
        db.createObjectStore("jobs", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("shifts")) {
        const shifts = db.createObjectStore("shifts", { keyPath: "id" });
        shifts.createIndex("date", "date");
        shifts.createIndex("jobId", "jobId");
      }
      if (!db.objectStoreNames.contains("payslips")) {
        const slips = db.createObjectStore("payslips", { keyPath: "id" });
        slips.createIndex("payDate", "payDate");
        slips.createIndex("jobId", "jobId");
      }
      if (!db.objectStoreNames.contains("files")) {
        db.createObjectStore("files", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
      if (event.oldVersion >= 1 && event.oldVersion < 2) {
        migrateInUpgrade(req.transaction, event.oldVersion);
      } else if (event.oldVersion === 0) {
        req.transaction.objectStore("meta").put({ key: "schemaVersion", value: SCHEMA_VERSION });
      }
    };
    req.onblocked = () => {
      // An older Pay Ledger tab is holding the database. Keep waiting: the
      // upgrade continues as soon as that tab is closed.
      globalThis.dispatchEvent?.(new CustomEvent("pay-ledger:upgrade-blocked"));
    };
    req.onsuccess = () => {
      const db = req.result;
      // A newer version of the app opened in another tab: step aside so it can
      // upgrade, and ask this tab to reload. (Delete requests have newVersion
      // null and are left blocked, as before, so data is never wiped from here.)
      db.onversionchange = (event) => {
        if (event.newVersion == null) return;
        db.close();
        dbPromise = null;
        globalThis.dispatchEvent?.(new CustomEvent("pay-ledger:upgraded-elsewhere"));
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

/**
 * Runs inside the versionchange transaction, so it is atomic: if anything
 * throws, the upgrade aborts and the v1 data is left exactly as it was.
 * A copy of the v1 records is also kept in meta.preMigrationV1.
 */
function migrateInUpgrade(tx, fromVersion) {
  const names = ["jobs", "shifts", "payslips", "meta"];
  const data = {};
  let pending = names.length;
  for (const name of names) {
    const r = tx.objectStore(name).getAll();
    r.onsuccess = () => {
      data[name] = r.result || [];
      if (--pending === 0) write();
    };
  }
  function write() {
    try {
      const out = migrateDataset(data);
      const meta = tx.objectStore("meta");
      meta.put({
        key: "preMigrationV1",
        value: {
          fromVersion,
          savedAt: new Date().toISOString(),
          jobs: data.jobs,
          shifts: data.shifts,
          payslips: data.payslips,
        },
      });
      for (const job of out.jobs) tx.objectStore("jobs").put(job);
      for (const shift of out.shifts) tx.objectStore("shifts").put(shift);
      for (const row of out.meta) meta.put(row);
      meta.put({ key: "lastMigration", value: { from: fromVersion, to: SCHEMA_VERSION, at: new Date().toISOString(), ...out.report } });
    } catch (err) {
      console.error("Migration failed; keeping v1 data", err);
      tx.abort();
    }
  }
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
  });
}

export async function all(store) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readonly").objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function get(store, id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readonly").objectStore(store).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function put(store, value) {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).put(value);
  await txDone(tx);
  return value;
}

export async function del(store, id) {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).delete(id);
  await txDone(tx);
}

export async function clearAll() {
  const db = await openDb();
  const tx = db.transaction(STORES, "readwrite");
  for (const store of STORES) tx.objectStore(store).clear();
  await txDone(tx);
}

export function uid() {
  return crypto.randomUUID();
}

const MAX_FILE_BYTES = 12 * 1024 * 1024;

export async function saveFile(file) {
  if (!file) return null;
  if (file.size > MAX_FILE_BYTES) {
    throw new Error("Payslip is over 12 MB. Compress it or snap a clearer photo.");
  }
  const id = uid();
  const buf = await file.arrayBuffer();
  const record = {
    id,
    name: file.name || "payslip",
    type: file.type || "application/octet-stream",
    size: file.size,
    blob: new Blob([buf], { type: file.type || "application/octet-stream" }),
    uploadedAt: new Date().toISOString(),
  };
  await put("files", record);
  return id;
}

export async function exportBackup() {
  const [jobs, shifts, payslips, files, meta] = await Promise.all([
    all("jobs"),
    all("shifts"),
    all("payslips"),
    all("files"),
    all("meta"),
  ]);
  const packedFiles = await Promise.all(
    files.map(async (file) => ({
      id: file.id,
      name: file.name,
      type: file.type,
      size: file.size,
      uploadedAt: file.uploadedAt,
      dataUrl: await blobToDataUrl(file.blob),
    })),
  );
  return {
    app: "pay-ledger",
    version: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    jobs,
    shifts,
    payslips,
    files: packedFiles,
    meta,
  };
}

export async function importBackup(payload) {
  if (!payload || payload.app !== "pay-ledger") {
    throw new Error("That file is not a Pay Ledger backup.");
  }
  // Older backups (v1) are migrated before anything is written.
  const data = migrateDataset(payload);
  const db = await openDb();
  const tx = db.transaction(STORES, "readwrite");
  for (const store of STORES) tx.objectStore(store).clear();
  for (const job of data.jobs) tx.objectStore("jobs").put(job);
  for (const shift of data.shifts) tx.objectStore("shifts").put(shift);
  for (const slip of data.payslips) tx.objectStore("payslips").put(slip);
  for (const row of data.meta) tx.objectStore("meta").put(row);
  for (const file of payload.files || []) {
    tx.objectStore("files").put({
      id: file.id,
      name: file.name,
      type: file.type,
      size: file.size,
      uploadedAt: file.uploadedAt,
      blob: dataUrlToBlob(file.dataUrl, file.type),
    });
  }
  await txDone(tx);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl, type) {
  if (!dataUrl) return new Blob([], { type: type || "application/octet-stream" });
  const [header, data] = String(dataUrl).split(",");
  const mime = /data:(.*?);/.exec(header)?.[1] || type || "application/octet-stream";
  const bin = atob(data || "");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export async function ensureDefaultJob() {
  const jobs = await all("jobs");
  if (jobs.length) return jobs;
  const job = {
    id: uid(),
    name: "Job 1",
    ...BEVCHAIN_RULES,
    breakMins: 30,
    color: "#e2a336",
    createdAt: new Date().toISOString(),
  };
  await put("jobs", job);
  await put("meta", { key: "defaultJobId", value: job.id });
  return [job];
}
