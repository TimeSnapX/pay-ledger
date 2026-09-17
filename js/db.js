import { computeGross, splitOt } from "./money.js";

const DB_NAME = "pay-ledger";
const DB_VERSION = 1;
const STORES = ["jobs", "shifts", "payslips", "files", "meta"];

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
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
    version: 1,
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
  await clearAll();
  const db = await openDb();
  const tx = db.transaction(STORES, "readwrite");
  for (const job of payload.jobs || []) tx.objectStore("jobs").put(job);
  for (const shift of payload.shifts || []) tx.objectStore("shifts").put(shift);
  for (const slip of payload.payslips || []) tx.objectStore("payslips").put(slip);
  for (const row of payload.meta || []) tx.objectStore("meta").put(row);
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
    rate: 41.21,
    breakMins: 30,
    color: "#e2a336",
    createdAt: new Date().toISOString(),
  };
  await put("jobs", job);
  await put("meta", { key: "defaultJobId", value: job.id });
  return [job];
}

export function shiftsToCsv(shifts, jobs) {
  const jobName = (id) => jobs.find((j) => j.id === id)?.name || "";
  const header = [
    "date",
    "job",
    "time_on_site_hours",
    "unpaid_break_mins",
    "paid_hours",
    "ordinary_hours",
    "time_and_half_hours",
    "double_hours",
    "rate",
    "gross",
    "start",
    "end",
    "notes",
  ];
  const lines = [header.join(",")];
  const sorted = [...shifts].sort((a, b) => a.date.localeCompare(b.date));
  for (const s of sorted) {
    const ot = splitOt(s.paidHours);
    const cells = [
      s.date,
      csvCell(jobName(s.jobId)),
      s.workedHours,
      s.breakMins,
      s.paidHours,
      ot.ordinary,
      ot.timeAndHalf,
      ot.double,
      s.rate,
      computeGross(s.paidHours, s.rate),
      s.start || "",
      s.end || "",
      csvCell(s.notes || ""),
    ];
    lines.push(cells.join(","));
  }
  return lines.join("\n");
}

function csvCell(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
