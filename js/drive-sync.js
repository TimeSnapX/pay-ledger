/**
 * Auto-save to Google Drive. Browser only, no backend, no client secret:
 * Google Identity Services token client with the drive.file scope (the app
 * can only see files it created). IndexedDB stays the source of truth; Drive
 * gets a copy, updated in place after every change (debounced).
 *
 * Folder "Pay Ledger (auto)" in My Drive with fixed file names:
 *   pay-ledger-hours.csv     text/csv (kept as CSV, never converted to Sheets)
 *   pay-ledger-backup.json   application/json (same JSON as Export backup)
 *   pay-ledger-summary.html  text/html
 *   pay-ledger-backup-YYYY-Www.json  one dated copy per ISO week (created once)
 *
 * State lives in the meta store (device only, never in backups):
 *   driveSync  { connected, folderId, files: {csv,json,html}, weekly, lastSyncedAt, email }
 *   driveDirty { dirty, rev, since }   unsynced changes survive a reload
 *   driveToken { value, expiresAt }    short-lived (~1h) access token
 */

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const GIS_SRC = "https://accounts.google.com/gsi/client";
export const FOLDER_NAME = "Pay Ledger (auto)";
export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const DRIVE_FILES = Object.freeze([
  { key: "csv", name: "pay-ledger-hours.csv", mimeType: "text/csv" },
  { key: "json", name: "pay-ledger-backup.json", mimeType: "application/json" },
  { key: "html", name: "pay-ledger-summary.html", mimeType: "text/html" },
]);
export const DRIVE_META = Object.freeze({ sync: "driveSync", dirty: "driveDirty", token: "driveToken" });
export const DATA_CHANGED_EVENT = "pay-ledger:data-changed";

const API = "https://www.googleapis.com/drive/v3/files";
const ABOUT = "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
/** Multipart / media uploads are limited to 5 MB; bigger bodies use a resumable upload. */
const SIMPLE_LIMIT = 5 * 1024 * 1024 - 64 * 1024;

class NeedsAuth extends Error {}
class Offline extends Error {}
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** ISO-8601 week key for a local date, e.g. "2026-W39". */
export function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function weeklyBackupName(date = new Date()) {
  return `pay-ledger-backup-${isoWeekKey(date)}.json`;
}

/** "11:58am" today, "Sat 11:58am" this week, "20 Sep 11:58am" otherwise. */
export function formatSavedTime(iso, now = new Date()) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const h = d.getHours();
  const time = `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return time;
  const days = (now - d) / 86400000;
  if (days >= 0 && days < 6) return `${d.toLocaleDateString("en-AU", { weekday: "short" })} ${time}`;
  return `${d.toLocaleDateString("en-AU", { day: "numeric", month: "short" })} ${time}`;
}

const q = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/**
 * createDriveSync({ clientId, inApp, getMeta, setMeta, buildFiles, onChange })
 *   buildFiles(): Promise<{ csv, json, html }> (strings)
 * Returns { init, connect, reconnect, disconnect, syncNow, markDirty, snapshot }.
 */
export function createDriveSync(opts) {
  const {
    clientId = "",
    inApp = false,
    getMeta,
    setMeta,
    buildFiles,
    onChange = () => {},
    win = globalThis,
    debounceMs = 5000,
    retryMs = [15000, 30000, 60000, 120000, 300000],
    now = () => new Date(),
  } = opts;
  const doc = win.document;
  const fetchImpl = (...args) => win.fetch(...args);

  let sync = { connected: false, folderId: "", files: {}, weekly: "", lastSyncedAt: null, email: "" };
  let dirty = { dirty: false, rev: 0, since: null };
  let token = null;
  let status = "off";
  let detail = "";
  let tokenClient = null;
  let gisPromise = null;
  let pending = null;
  let timer = 0;
  let retryTimer = 0;
  let retryCount = 0;
  let running = null;
  let again = false;
  let needsTap = false;
  let started = false;

  function snapshot() {
    return {
      status,
      detail,
      configured: Boolean(clientId),
      inApp,
      connected: sync.connected,
      dirty: dirty.dirty,
      lastSyncedAt: sync.lastSyncedAt,
      email: sync.email,
      folderId: sync.folderId,
      files: { ...sync.files },
      weekly: sync.weekly,
      needsTap,
    };
  }

  function set(next, info = "") {
    status = next;
    detail = info;
    try {
      onChange(snapshot());
    } catch (err) {
      console.warn("drive status render failed", err);
    }
  }

  const saveSync = () => setMeta(DRIVE_META.sync, { ...sync, files: { ...sync.files } }).catch(() => {});
  const saveDirty = () => setMeta(DRIVE_META.dirty, { ...dirty }).catch(() => {});
  const saveToken = () => setMeta(DRIVE_META.token, token ? { ...token } : null).catch(() => {});

  /* ---------- Google Identity Services ---------- */

  function loadGis() {
    if (win.google?.accounts?.oauth2) return Promise.resolve(initClient());
    if (!gisPromise) {
      gisPromise = new Promise((resolve, reject) => {
        const s = doc.createElement("script");
        s.src = GIS_SRC;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => {
          gisPromise = null;
          s.remove();
          reject(new Offline("Couldn\u2019t load Google sign-in"));
        };
        doc.head.appendChild(s);
      });
    }
    return gisPromise.then(() => initClient());
  }

  function initClient() {
    if (tokenClient) return tokenClient;
    const oauth2 = win.google?.accounts?.oauth2;
    if (!oauth2) throw new Offline("Google sign-in unavailable");
    tokenClient = oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (resp) => {
        const p = pending;
        pending = null;
        if (!p) return;
        if (!resp || resp.error || !resp.access_token) p.reject(new NeedsAuth(resp?.error || "no token"));
        else if (typeof oauth2.hasGrantedAllScopes === "function" && !oauth2.hasGrantedAllScopes(resp, DRIVE_SCOPE)) {
          p.reject(new NeedsAuth("Drive access wasn\u2019t allowed"));
        } else p.resolve(resp);
      },
      error_callback: (err) => {
        const p = pending;
        pending = null;
        p?.reject(new NeedsAuth(err?.type || "popup_failed"));
      },
    });
    return tokenClient;
  }

  /** interactive: called from a tap (popup allowed). Silent: prompt '' (no UI if already granted). */
  async function requestToken(interactive) {
    await loadGis();
    const resp = await new Promise((resolve, reject) => {
      pending?.reject(new NeedsAuth("superseded"));
      const limit = setTimeout(() => {
        if (pending?.resolve === done) pending = null;
        reject(new NeedsAuth("timeout"));
      }, interactive ? 300000 : 20000);
      function done(r) {
        clearTimeout(limit);
        resolve(r);
      }
      pending = {
        resolve: done,
        reject: (e) => {
          clearTimeout(limit);
          reject(e);
        },
      };
      const cfg = interactive ? {} : { prompt: "" };
      if (sync.email) cfg.login_hint = sync.email;
      try {
        tokenClient.requestAccessToken(cfg);
      } catch (err) {
        pending = null;
        clearTimeout(limit);
        reject(new NeedsAuth(err?.message || "request failed"));
      }
    });
    token = { value: resp.access_token, expiresAt: Date.now() + (Number(resp.expires_in) || 3600) * 1000 };
    await saveToken();
    return token.value;
  }

  async function getToken() {
    if (token && token.expiresAt - 60000 > Date.now()) return token.value;
    if (needsTap) throw new NeedsAuth("tap to reconnect");
    return requestToken(false);
  }

  async function dropToken() {
    token = null;
    await saveToken();
  }

  /* ---------- Drive REST ---------- */

  async function authed(url, init = {}, retried = false) {
    const t = await getToken();
    let res;
    try {
      res = await fetchImpl(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${t}` } });
    } catch (err) {
      throw new Offline(err?.message || "network");
    }
    if (res.status === 401) {
      await dropToken();
      if (!retried) return authed(url, init, true);
      throw new NeedsAuth("401");
    }
    return res;
  }

  async function httpError(res) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error?.message) msg = `${res.status}: ${j.error.message}`;
    } catch {}
    return new HttpError(res.status, msg);
  }

  async function findOne(query) {
    const res = await authed(`${API}?q=${encodeURIComponent(query)}&fields=files(id,name)&pageSize=1&spaces=drive`);
    if (!res.ok) throw await httpError(res);
    const j = await res.json();
    return j?.files?.[0]?.id || "";
  }

  async function createFolder() {
    const res = await authed(`${API}?fields=id`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME, parents: ["root"] }),
    });
    if (!res.ok) throw await httpError(res);
    return (await res.json()).id;
  }

  /** Stored ID -> app-created folder of that name in My Drive root -> new folder. */
  async function ensureFolder(verify) {
    if (sync.folderId && !verify) return sync.folderId;
    if (sync.folderId) {
      const res = await authed(`${API}/${encodeURIComponent(sync.folderId)}?fields=id,trashed`);
      if (res.ok) {
        const j = await res.json();
        if (!j.trashed) return sync.folderId;
      } else if (res.status !== 404) throw await httpError(res);
    }
    sync.folderId = "";
    sync.files = {};
    sync.weekly = "";
    const found = await findOne(`name='${q(FOLDER_NAME)}' and mimeType='${FOLDER_MIME}' and 'root' in parents and trashed=false`);
    sync.folderId = found || (await createFolder());
    await saveSync();
    return sync.folderId;
  }

  /** POST (create, multipart) or PATCH (update, media). Big bodies go resumable. */
  async function upload(id, spec, body, parent) {
    const blob = new Blob([body], { type: spec.mimeType });
    // mimeType is the plain type (text/csv etc.), never a Google Docs/Sheets type, so Drive does not convert.
    const meta = { name: spec.name, mimeType: spec.mimeType, parents: [parent] };
    if (blob.size > SIMPLE_LIMIT) return resumable(id, spec, blob, meta);
    if (id) {
      return authed(`${UPLOAD}/${encodeURIComponent(id)}?uploadType=media&fields=id,trashed`, {
        method: "PATCH",
        headers: { "Content-Type": spec.mimeType },
        body: blob,
      });
    }
    const b = `pay-ledger-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const multipart = new Blob(
      [
        `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
        `--${b}\r\nContent-Type: ${spec.mimeType}\r\n\r\n`,
        blob,
        `\r\n--${b}--\r\n`,
      ],
      { type: `multipart/related; boundary=${b}` },
    );
    return authed(`${UPLOAD}?uploadType=multipart&fields=id,name,mimeType`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${b}` },
      body: multipart,
    });
  }

  async function resumable(id, spec, blob, meta) {
    const start = await authed(
      id ? `${UPLOAD}/${encodeURIComponent(id)}?uploadType=resumable&fields=id,trashed` : `${UPLOAD}?uploadType=resumable&fields=id,name,mimeType`,
      {
        method: id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": spec.mimeType },
        body: JSON.stringify(id ? {} : meta),
      },
    );
    if (!start.ok) return start;
    const location = start.headers.get("Location");
    if (!location) throw new HttpError(0, "no upload URL");
    return authed(location, { method: "PUT", headers: { "Content-Type": spec.mimeType }, body: blob });
  }

  /** Update the stored file in place; recreate if it is gone (404) or in the bin. */
  async function putFile(spec, body, ctx) {
    const id = sync.files[spec.key];
    if (id) {
      const res = await upload(id, spec, body);
      if (res.ok) {
        const j = await res.json().catch(() => ({}));
        if (!j.trashed) return;
      } else if (res.status !== 404) throw await httpError(res);
      delete sync.files[spec.key];
      if (!ctx.verified) {
        ctx.folderId = await ensureFolder(true);
        ctx.verified = true;
      }
    }
    // Same file created earlier (another tab / browser / after a reset)? Reuse it instead of duplicating.
    const existing = await findOne(`name='${q(spec.name)}' and '${q(ctx.folderId)}' in parents and trashed=false`);
    if (existing) {
      const res = await upload(existing, spec, body);
      if (!res.ok) throw await httpError(res);
      sync.files[spec.key] = existing;
      await saveSync();
      return;
    }
    let res = await upload(null, spec, body, ctx.folderId);
    if (res.status === 404 && !ctx.verified) {
      ctx.folderId = await ensureFolder(true);
      ctx.verified = true;
      res = await upload(null, spec, body, ctx.folderId);
    }
    if (!res.ok) throw await httpError(res);
    sync.files[spec.key] = (await res.json()).id;
    await saveSync();
  }

  async function putWeekly(json, ctx) {
    const key = isoWeekKey(now());
    if (sync.weekly === key) return;
    const spec = { key: "weekly", name: weeklyBackupName(now()), mimeType: "application/json" };
    const existing = await findOne(`name='${q(spec.name)}' and '${q(ctx.folderId)}' in parents and trashed=false`);
    if (!existing) {
      const res = await upload(null, spec, json, ctx.folderId);
      if (!res.ok) throw await httpError(res);
    }
    sync.weekly = key;
    await saveSync();
  }

  /* ---------- Sync loop ---------- */

  function clearTimers() {
    clearTimeout(timer);
    clearTimeout(retryTimer);
    timer = 0;
    retryTimer = 0;
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      runSync();
    }, ms);
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    const delay = retryMs[Math.min(retryCount, retryMs.length - 1)];
    retryCount += 1;
    retryTimer = setTimeout(() => {
      retryTimer = 0;
      if (dirty.dirty) runSync();
    }, delay);
  }

  function runSync() {
    if (running) {
      again = true;
      return running;
    }
    clearTimers();
    running = (async () => {
      try {
        await doSync();
      } finally {
        running = null;
      }
      if (again) {
        again = false;
        if (dirty.dirty && !needsTap && status !== "offline" && status !== "error") schedule(0);
      }
    })();
    return running;
  }

  async function doSync() {
    if (!clientId || inApp || !sync.connected) return;
    if (needsTap) {
      set("reconnect");
      return;
    }
    if (win.navigator && win.navigator.onLine === false) {
      set("offline");
      scheduleRetry();
      return;
    }
    const startRev = dirty.rev;
    set("saving");
    try {
      const content = await buildFiles();
      const ctx = { folderId: await ensureFolder(false), verified: false };
      for (const spec of DRIVE_FILES) await putFile(spec, content[spec.key], ctx);
      await putWeekly(content.json, ctx).catch((err) => {
        if (err instanceof NeedsAuth || err instanceof Offline) throw err;
        console.warn("weekly Drive copy skipped", err);
      });
      sync.lastSyncedAt = now().toISOString();
      retryCount = 0;
      await saveSync();
      if (dirty.rev === startRev) {
        dirty = { ...dirty, dirty: false, since: null };
        await saveDirty();
      }
      set(dirty.dirty ? "pending" : "saved");
    } catch (err) {
      if (err instanceof NeedsAuth) {
        needsTap = true;
        set("reconnect", err.message);
      } else if (err instanceof Offline) {
        set("offline", err.message);
        scheduleRetry();
      } else {
        console.warn("Drive auto-save failed", err);
        set("error", err?.message || String(err));
        scheduleRetry();
      }
    }
  }

  /* ---------- Public API ---------- */

  async function markDirty() {
    if (!clientId || inApp || !sync.connected) return;
    dirty = { dirty: true, rev: dirty.rev + 1, since: dirty.since || now().toISOString() };
    await saveDirty();
    if (!needsTap && status !== "offline") set("pending");
    else set(status, detail);
    if (!needsTap) schedule(debounceMs);
  }

  function onDataChanged() {
    markDirty().catch((err) => console.warn(err));
  }

  function onHidden() {
    if (doc.visibilityState === "hidden" && dirty.dirty && sync.connected && !needsTap && !running) runSync();
  }

  function onOnline() {
    if (dirty.dirty && sync.connected && !needsTap) {
      retryCount = 0;
      runSync();
    }
  }

  async function init() {
    if (!started) {
      started = true;
      win.addEventListener(DATA_CHANGED_EVENT, onDataChanged);
      win.addEventListener("online", onOnline);
      doc.addEventListener("visibilitychange", onHidden);
    }
    if (!clientId) return set("unconfigured");
    if (inApp) return set("inapp");
    const [s, d, t] = await Promise.all([
      getMeta(DRIVE_META.sync).catch(() => null),
      getMeta(DRIVE_META.dirty).catch(() => null),
      getMeta(DRIVE_META.token).catch(() => null),
    ]);
    if (s) sync = { ...sync, ...s, files: { ...(s.files || {}) } };
    if (d) dirty = { dirty: Boolean(d.dirty), rev: Number(d.rev) || 0, since: d.since || null };
    if (t?.value && t.expiresAt > Date.now()) token = t;
    if (!sync.connected) return set("off");
    loadGis().catch(() => {}); // preload so a tap can open the Google popup straight away
    if (dirty.dirty) {
      set("pending");
      runSync(); // sync on app open when there are unsynced changes
    } else set("saved");
  }

  /** From a tap: sign in (popup), then do a full save. */
  async function connect() {
    if (!clientId || inApp) return;
    set("connecting");
    try {
      await requestToken(true);
    } catch (err) {
      const why = err instanceof Offline ? "offline" : err.message;
      if (sync.connected) {
        needsTap = true;
        set("reconnect", why);
      } else set("off", `Couldn\u2019t connect to Google Drive (${why}). Try again.`);
      return;
    }
    needsTap = false;
    retryCount = 0;
    const first = !sync.connected;
    sync.connected = true;
    await saveSync();
    if (first || !sync.email) {
      try {
        const res = await authed(ABOUT);
        if (res.ok) {
          sync.email = (await res.json())?.user?.emailAddress || "";
          await saveSync();
        }
      } catch {}
    }
    dirty = { dirty: true, rev: dirty.rev + 1, since: dirty.since || now().toISOString() };
    await saveDirty();
    return runSync();
  }

  const reconnect = connect;

  async function disconnect() {
    clearTimers();
    const t = token?.value;
    try {
      if (t && win.google?.accounts?.oauth2?.revoke) win.google.accounts.oauth2.revoke(t, () => {});
    } catch {}
    token = null;
    needsTap = false;
    // Keep folder / file IDs so reconnecting later updates the same files.
    sync = { ...sync, connected: false, lastSyncedAt: null };
    dirty = { dirty: false, rev: dirty.rev, since: null };
    await Promise.all([saveSync(), saveDirty(), saveToken()]);
    set("off");
  }

  async function syncNow() {
    if (!sync.connected) return;
    if (needsTap) return connect();
    retryCount = 0;
    if (!dirty.dirty) {
      dirty = { dirty: true, rev: dirty.rev + 1, since: now().toISOString() };
      await saveDirty();
    }
    return runSync();
  }

  return { init, connect, reconnect, disconnect, syncNow, markDirty, snapshot, _flush: () => running };
}

/** Status line text for the UI. */
export function describeDriveStatus(s, { inAppName = "this app\u2019s browser", now = new Date() } = {}) {
  const last = s.lastSyncedAt ? `Last saved to Drive ${formatSavedTime(s.lastSyncedAt, now)}` : "";
  switch (s.status) {
    case "unconfigured":
      return "Auto-save to Drive isn\u2019t set up yet. Use Save to Google Drive for now.";
    case "inapp":
      return `Auto-save needs Chrome: Google blocks sign-in inside ${inAppName}. Open this page in Chrome to turn it on.`;
    case "off":
      return s.detail || "Keeps a copy in your Google Drive up to date after every change. The app can only see the files it creates.";
    case "connecting":
      return "Connecting to Google Drive\u2026";
    case "pending":
      return last ? `Changes waiting to save \u00b7 ${last}` : "Changes waiting to save\u2026";
    case "saving":
      return "Saving\u2026";
    case "saved":
      return last || "Connected \u00b7 nothing saved yet";
    case "offline":
      return "Offline, will retry";
    case "reconnect":
      return "Sign in again to keep saving. Your changes are safe on this phone.";
    case "error":
      return `Couldn\u2019t save to Drive (${s.detail || "error"}). Will retry.`;
    default:
      return "";
  }
}
