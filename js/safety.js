/**
 * No-setup safety net (works without Google):
 * - asks the browser to keep this site's storage (navigator.storage.persist()),
 * - keeps a second copy of the latest backup JSON in Cache Storage
 *   ("pl-safety-copy", separate from the service worker's app cache),
 * - remembers in localStorage how much data the ledger last had, so an empty
 *   ledger on startup can be flagged instead of silently starting over,
 * - remembers when a backup was last made (download / copy / Drive).
 */
const CACHE = "pl-safety-copy";
const COPY_URL = new URL("__safety/latest-backup.json", document.baseURI).href;
const LS = {
  lastKnown: "payLedger.lastKnown",
  lastBackup: "payLedger.lastBackupAt",
  firstData: "payLedger.firstDataAt",
  snooze: "payLedger.backupPromptSnooze",
};
export const BACKUP_PROMPT_DAYS = 7;

function lsGet(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}
function lsSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

/** true when the browser agreed to keep the data, false when not, null when unsupported. */
export async function requestPersist() {
  try {
    if (!navigator.storage?.persist) return null;
    if (navigator.storage.persisted && (await navigator.storage.persisted())) return true;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

/** Save the latest backup (only ever called with a non-empty ledger). */
export async function saveLocalCopy(text, counts) {
  const savedAt = new Date().toISOString();
  lsSet(LS.lastKnown, { shifts: counts.shifts, payslips: counts.payslips, at: savedAt });
  if (!lsGet(LS.firstData)) lsSet(LS.firstData, savedAt);
  if (!("caches" in globalThis)) return false;
  try {
    const cache = await caches.open(CACHE);
    await cache.put(
      COPY_URL,
      new Response(text, {
        headers: {
          "Content-Type": "application/json",
          "X-Saved-At": savedAt,
          "X-Counts": JSON.stringify({ shifts: counts.shifts, payslips: counts.payslips }),
        },
      }),
    );
    return true;
  } catch (err) {
    console.warn("safety copy not saved", err);
    return false;
  }
}

/** { text, savedAt, counts } or null. */
export async function readLocalCopy() {
  if (!("caches" in globalThis)) return null;
  try {
    const cache = await caches.open(CACHE);
    const res = await cache.match(COPY_URL);
    if (!res) return null;
    let counts = null;
    try {
      counts = JSON.parse(res.headers.get("X-Counts") || "null");
    } catch {}
    return { text: await res.text(), savedAt: res.headers.get("X-Saved-At"), counts };
  } catch {
    return null;
  }
}

/** What the ledger last had on this device: { shifts, payslips, at } or null. */
export const lastKnown = () => lsGet(LS.lastKnown);

export function markBackedUp(at = new Date().toISOString()) {
  const prev = lsGet(LS.lastBackup);
  if (!prev || Date.parse(at) > Date.parse(prev)) lsSet(LS.lastBackup, at);
}

export function snoozeBackupPrompt(days = 1) {
  lsSet(LS.snooze, new Date(Date.now() + days * 86400000).toISOString());
}

/** Days since the last backup when a prompt is due, else 0. driveLast: last Drive sync ISO. */
export function backupPromptDue(driveLast, nowMs = Date.now()) {
  const snooze = lsGet(LS.snooze);
  if (snooze && Date.parse(snooze) > nowMs) return 0;
  const times = [lsGet(LS.lastBackup), driveLast].filter(Boolean).map((t) => Date.parse(t)).filter(Number.isFinite);
  const ref = times.length ? Math.max(...times) : Date.parse(lsGet(LS.firstData) || "");
  if (!Number.isFinite(ref)) return 0;
  const days = Math.floor((nowMs - ref) / 86400000);
  return days >= BACKUP_PROMPT_DAYS ? days : 0;
}
