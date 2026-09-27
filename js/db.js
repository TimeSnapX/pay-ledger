import { BEVCHAIN_RULES } from "./money.js?v=4";
import { SCHEMA_VERSION, migrateDataset } from "./migrate.js?v=4";
export { shiftsToCsv } from "./exporters.js?v=4";

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

/** Fired on window after jobs / shifts / payslips / files change (not meta), e.g. for Drive auto-save. */
export const DATA_CHANGED_EVENT = "pay-ledger:data-changed";

function dataChanged(store) {
  if (store === "meta") return;
  try {
    globalThis.dispatchEvent?.(new CustomEvent(DATA_CHANGED_EVENT, { detail: { store } }));
  } catch {}
}

export async function put(store, value) {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).put(value);
  await txDone(tx);
  dataChanged(store);
  return value;
}

export async function del(store, id) {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).delete(id);
  await txDone(tx);
  dataChanged(store);
}

export async function clearAll() {
  const db = await openDb();
  const tx = db.transaction(STORES, "readwrite");
  for (const store of STORES) tx.objectStore(store).clear();
  await txDone(tx);
  dataChanged("all");
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
    // The pre-import safety copy and Drive auto-save state stay on this device only.
    meta: meta.filter((m) => !DEVICE_ONLY_META.has(m.key)),
  };
}

/** meta key holding the ledger as it was just before the last backup import. */
export const PRE_IMPORT_KEY = "preImportBackup";

/** Drive auto-save state: belongs to this browser, never exported, kept across imports. */
export const DRIVE_META_KEYS = Object.freeze(["driveSync", "driveDirty", "driveToken"]);
const DEVICE_ONLY_META = new Set([PRE_IMPORT_KEY, ...DRIVE_META_KEYS]);

function countOf(data) {
  return {
    jobs: (data.jobs || []).length,
    shifts: (data.shifts || []).length,
    payslips: (data.payslips || []).length,
    files: (data.files || []).length,
  };
}

/**
 * Validate + migrate a backup without writing anything. Throws on anything
 * that is not a complete Pay Ledger backup. Returns the records to write and
 * their counts, so the caller can show them before asking to replace.
 */
export function prepareImport(payload) {
  if (!payload || typeof payload !== "object" || payload.app !== "pay-ledger") {
    throw new Error("That is not a Pay Ledger backup.");
  }
  // Older backups (v1) are migrated before anything is written.
  const data = migrateDataset(payload);
  const files = (Array.isArray(payload.files) ? payload.files : []).map((file) => ({
    id: file.id,
    name: file.name,
    type: file.type,
    size: file.size,
    uploadedAt: file.uploadedAt,
    blob: safeBlob(file),
  }));
  const meta = data.meta.filter((row) => !DEVICE_ONLY_META.has(row.key));
  const prepared = { jobs: data.jobs, shifts: data.shifts, payslips: data.payslips, meta, files };
  return { ...prepared, counts: countOf(prepared), exportedAt: payload.exportedAt || null };
}

function safeBlob(file) {
  try {
    return dataUrlToBlob(file?.dataUrl, file?.type);
  } catch {
    throw new Error(`The payslip file “${file?.name || "?"}” in the backup is damaged or cut off. Copy the backup again.`);
  }
}

/** Counts of what is stored in this browser right now. */
export async function currentCounts() {
  const [jobs, shifts, payslips, files] = await Promise.all([all("jobs"), all("shifts"), all("payslips"), all("files")]);
  return { ...countOf({ jobs, shifts, payslips, files }), jobNames: jobs.map((j) => j.name) };
}

/**
 * Replace the whole ledger with a backup, in ONE transaction: either every
 * record is written or nothing changes. With keepCurrent, the ledger as it
 * was is saved (as backup JSON text) in meta.preImportBackup in the same
 * transaction, like the pre-migration copy, so an import can be undone.
 */
export async function importBackup(payload, { keepCurrent = false } = {}) {
  const data = prepareImport(payload);
  let preImport = null;
  if (keepCurrent) {
    const current = await exportBackup();
    preImport = {
      key: PRE_IMPORT_KEY,
      value: { savedAt: new Date().toISOString(), counts: countOf(current), backup: JSON.stringify(current) },
    };
  }
  // This browser's Drive connection is not part of the ledger: keep it.
  const keepDrive = (await Promise.all(DRIVE_META_KEYS.map((key) => get("meta", key)))).filter(Boolean);
  const db = await openDb();
  const tx = db.transaction(STORES, "readwrite");
  const done = txDone(tx);
  try {
    for (const store of STORES) tx.objectStore(store).clear();
    for (const row of keepDrive) tx.objectStore("meta").put(row);
    for (const job of data.jobs) tx.objectStore("jobs").put(job);
    for (const shift of data.shifts) tx.objectStore("shifts").put(shift);
    for (const slip of data.payslips) tx.objectStore("payslips").put(slip);
    for (const row of data.meta) tx.objectStore("meta").put(row);
    for (const file of data.files) tx.objectStore("files").put(file);
    if (preImport) tx.objectStore("meta").put(preImport);
  } catch (err) {
    try {
      tx.abort();
    } catch {}
    await done.catch(() => {});
    throw err;
  }
  await done;
  dataChanged("all");
  return data.counts;
}

/** The saved pre-import copy, if any: { savedAt, counts, backup (JSON text) }. */
export async function getPreImportCopy() {
  return (await get("meta", PRE_IMPORT_KEY))?.value || null;
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
