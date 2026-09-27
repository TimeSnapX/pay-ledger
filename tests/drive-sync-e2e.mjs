// Headless Chrome check at 390x844 for Auto-save to Drive. Google Identity
// Services and the Drive REST API are mocked in the page (no network):
// not-configured state, in-app browser hides Connect, connect -> folder +
// files created (CSV stays text/csv), edits PATCH the same IDs, debounce
// coalescing, 401 -> silent token -> retry, 404 / trashed -> recreate,
// offline -> retry on reconnect, dirty flag survives reload, "Tap to
// reconnect", big backups go resumable, import keeps the connection,
// Disconnect, manual Save to Google Drive untouched.
//   BASE=http://127.0.0.1:4174 PLAYWRIGHT_DIR=/workspace/tools SHOTS=/tmp/shots node tests/drive-sync-e2e.mjs
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const req = createRequire(path.join(process.env.PLAYWRIGHT_DIR || here, "package.json"));
let pw;
try { pw = req("playwright-core"); } catch { pw = req("playwright"); }
const { chromium } = pw;

const BASE = process.env.BASE || "http://127.0.0.1:4174";
const APP = `${BASE}/pay-ledger/`;
const SHOTS = process.env.SHOTS || "/tmp/shots";
await mkdir(SHOTS, { recursive: true });
const V = "?v=4";
const TEST_CLIENT_ID = "1234567890-test.apps.googleusercontent.com";
const GIS_SRC = "https://accounts.google.com/gsi/client";

const MESSENGER_UA =
  "Mozilla/5.0 (Linux; Android 14; SM-S911B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.127 Mobile Safari/537.36 [FB_IAB/Orca-Android;FBAV/475.0.0.45.109;]";
const CHROME_UA =
  "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.127 Mobile Safari/537.36";

const errors = [];
const log = (...a) => console.log(" ", ...a);
const check = (cond, msg) => {
  if (!cond) errors.push(msg);
  log(cond ? "\u2713" : "\u2717", msg);
};
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME || "/usr/bin/google-chrome" });

/* ---------- mocks ---------- */

// Stand-in for https://accounts.google.com/gsi/client (served for that URL).
const GIS_MOCK = `
(() => {
  const G = (window.__gis = window.__gis || { mode: "ok", requests: [], tokenN: 0, revoked: [], inits: [] });
  window.google = { accounts: { oauth2: {
    initTokenClient(cfg) {
      G.inits.push({ client_id: cfg.client_id, scope: cfg.scope });
      return { requestAccessToken(o = {}) {
        G.requests.push({ ...o, hasPrompt: "prompt" in o });
        setTimeout(() => {
          if (G.mode === "blockSilent" && o.prompt === "") return cfg.error_callback({ type: "popup_failed_to_open" });
          if (G.mode === "closed") return cfg.error_callback({ type: "popup_closed" });
          cfg.callback({ access_token: "tok-" + (++G.tokenN), expires_in: 3599, scope: cfg.scope, token_type: "Bearer" });
        }, 30);
      } };
    },
    hasGrantedAllScopes(r, s) { return String(r.scope || "").split(" ").includes(s); },
    revoke(t, cb) { G.revoked.push(t); cb && cb(); },
  } } };
})();`;

// In-page fake of the Drive v3 API, installed as a fetch wrapper for googleapis.com.
function installFakeDrive() {
  const D = (window.__drive = { files: {}, n: 0, log: [], fail: [], offline: false, expired: [] });
  const realFetch = window.fetch.bind(window);
  const reply = (status, body, headers = {}) =>
    new Response(body == null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  const newId = () => `id${++D.n}`;
  const meta = (f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, trashed: f.trashed });
  const store = (fields) => { const f = { id: newId(), trashed: false, content: "", rev: 0, ...fields }; D.files[f.id] = f; return f; };
  const qval = (qs, re) => { const m = re.exec(qs); return m ? m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\") : null; };
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("https://www.googleapis.com/")) return realFetch(input, init);
    const method = String(init.method || "GET").toUpperCase();
    const headers = init.headers || {};
    const entry = { method, url, auth: headers.Authorization || "", ct: headers["Content-Type"] || "", at: Date.now() };
    D.log.push(entry);
    if (D.offline) { entry.status = "network"; throw new TypeError("Failed to fetch"); }
    const done = (res) => { entry.status = res.status; return res; };
    if (D.expired.includes(entry.auth)) return done(reply(401, { error: { code: 401, message: "Invalid Credentials" } }));
    const fi = D.fail.findIndex((x) => x.method === method && (!x.urlIncludes || url.includes(x.urlIncludes)));
    if (fi >= 0) { const x = D.fail[fi]; if (--x.times <= 0) D.fail.splice(fi, 1); return done(reply(x.status, { error: { code: x.status, message: "mock " + x.status } })); }
    const u = new URL(url);
    const body = init.body == null ? "" : await new Response(init.body).text();
    entry.size = body.length;
    const p = u.pathname;
    if (p === "/drive/v3/about") return done(reply(200, { user: { emailAddress: "tim@example.com" } }));
    if (p === "/drive/v3/files" && method === "GET") {
      const qs = u.searchParams.get("q") || "";
      const name = qval(qs, /name='((?:[^'\\]|\\.)*)'/);
      const mime = qval(qs, /mimeType='([^']*)'/);
      const parent = qval(qs, /'((?:[^'\\]|\\.)*)' in parents/);
      const hit = Object.values(D.files).filter((f) => !f.trashed && (!name || f.name === name) && (!mime || f.mimeType === mime) && (!parent || f.parents.includes(parent)));
      entry.search = { name, parent };
      return done(reply(200, { files: hit.slice(0, 1).map((f) => ({ id: f.id, name: f.name })) }));
    }
    if (p === "/drive/v3/files" && method === "POST") {
      const m = JSON.parse(body);
      const f = store({ name: m.name, mimeType: m.mimeType, parents: m.parents || [] });
      entry.created = f.id;
      return done(reply(200, { id: f.id }));
    }
    let m = /^\/drive\/v3\/files\/([^/]+)$/.exec(p);
    if (m && method === "GET") { const f = D.files[m[1]]; return done(f ? reply(200, meta(f)) : reply(404, { error: { code: 404, message: "File not found" } })); }
    if (p === "/upload/drive/v3/files" && method === "POST") {
      const type = u.searchParams.get("uploadType");
      entry.uploadType = type;
      if (type === "multipart") {
        const b = /boundary=([^;]+)/.exec(entry.ct)[1];
        const parts = body.split(`--${b}`).slice(1, -1).map((part) => { const i = part.indexOf("\r\n\r\n"); return { head: part.slice(0, i), data: part.slice(i + 4, -2) }; });
        const md = JSON.parse(parts[0].data);
        const parentOk = (md.parents || []).every((pid) => pid === "root" || (D.files[pid] && !D.files[pid].trashed));
        if (!parentOk) return done(reply(404, { error: { code: 404, message: "File not found: parent" } }));
        const f = store({ name: md.name, mimeType: md.mimeType, parents: md.parents || [], content: parts[1].data, partType: /Content-Type: ([^\r\n]+)/.exec(parts[1].head)[1] });
        entry.created = f.id;
        return done(reply(200, meta(f)));
      }
      if (type === "resumable") {
        const md = JSON.parse(body || "{}");
        const f = store({ name: md.name, mimeType: md.mimeType, parents: md.parents || [], pending: true });
        entry.created = f.id;
        return done(reply(200, {}, { Location: `https://www.googleapis.com/upload/session/${f.id}` }));
      }
    }
    m = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(p);
    if (m && method === "PATCH") {
      const f = D.files[m[1]];
      entry.uploadType = u.searchParams.get("uploadType");
      entry.target = m[1];
      if (!f) return done(reply(404, { error: { code: 404, message: "File not found: " + m[1] } }));
      if (entry.uploadType === "resumable") return done(reply(200, {}, { Location: `https://www.googleapis.com/upload/session/${f.id}` }));
      f.content = body; f.rev += 1; f.lastType = entry.ct;
      return done(reply(200, meta(f)));
    }
    m = /^\/upload\/session\/([^/]+)$/.exec(p);
    if (m && method === "PUT") { const f = D.files[m[1]]; f.content = body; f.rev += 1; delete f.pending; entry.target = f.id; return done(reply(200, meta(f))); }
    return done(reply(400, { error: { code: 400, message: "mock: unhandled " + method + " " + p } }));
  };
}

async function newPage({ ua = CHROME_UA, configured = true } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: ua, locale: "en-AU", timezoneId: "Australia/Brisbane", acceptDownloads: true,
  });
  const gisHits = [];
  // Later routes win in Playwright: catch-all first, then the GIS script.
  await ctx.route("https://accounts.google.com/**", (route) => { gisHits.push(route.request().url()); route.abort(); });
  await ctx.route(GIS_SRC, (route) => { gisHits.push(route.request().url()); route.fulfill({ status: 200, contentType: "text/javascript", body: GIS_MOCK }); });
  // Serve a test config either way, so the real Client ID in the repo doesn't change the test.
  await ctx.route(/\/pay-ledger\/js\/drive-config\.js/, (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: `export const GOOGLE_CLIENT_ID = ${JSON.stringify(configured ? TEST_CLIENT_ID : "")};\n` }));
  await ctx.addInitScript(installFakeDrive);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(`console: ${msg.text()}`); });
  return { ctx, page, gisHits };
}

const statusText = (page) => page.locator("#view-overview [data-drive-status]").innerText();
const waitStatus = (page, re, timeout = 15000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.querySelector("#view-overview [data-drive-status]")?.innerText || ""), re.source, { timeout });
const driveState = (page) => page.evaluate(() => JSON.parse(JSON.stringify({ files: window.__drive.files, log: window.__drive.log })));
const meta = (page, key) => page.evaluate(async ([k, v]) => (await (await import(`/pay-ledger/js/db.js${v}`)).get("meta", k))?.value ?? null, [key, V]);
const shot = async (page, name) => {
  await page.locator("#view-overview .auto-save").scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 120));
  await page.screenshot({ path: path.join(SHOTS, name) });
  log(`screenshot ${path.join(SHOTS, name)}`);
};
const noOverflow = async (page, where) => {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  check(w <= 390, `no horizontal overflow at 390px on ${where} (${w})`);
};
const noMojibake = async (page, where) => {
  const text = await page.evaluate(() => document.documentElement.innerText + document.title);
  check(!/\u00C2|\u00E2\u20AC|\u00E2\u02C6|\u00C3\u2014|\uFFFD/.test(text), `no mojibake on ${where}`);
};
async function seed(page, n = 5) {
  await page.evaluate(async ([count, v]) => {
    const db = await import(`/pay-ledger/js/db.js${v}`);
    const { withPay } = await import(`/pay-ledger/js/migrate.js${v}`);
    const { BEVCHAIN_RULES } = await import(`/pay-ledger/js/money.js${v}`);
    const job = { id: "job-bev", name: "BevChain", ...BEVCHAIN_RULES, breakMins: 30, color: "#e2a336", createdAt: "2026-01-01T00:00:00.000Z" };
    const shifts = [];
    for (let i = 0; i < count; i++) {
      const d = new Date(Date.UTC(2026, 8, 14) + i * 86400000).toISOString().slice(0, 10);
      shifts.push(withPay({ id: `s-${i}`, jobId: job.id, date: d, mode: "clock", start: "05:30", end: "16:45", breakMins: 30, workedHours: 11.25,
        rate: job.rate, ot1Rate: job.ot1Rate, ot2Rate: job.ot2Rate, ordHours: job.ordHours, ot1Hours: job.ot1Hours, meal: true, mealRate: job.mealAllowance,
        actualGross: null, actualNet: null, notes: "Eagle Farm \u00b7 caf\u00e9 \u2014 run", createdAt: `${d}T08:00:00.000Z`, updatedAt: `${d}T08:00:00.000Z` }));
    }
    await db.importBackup({ app: "pay-ledger", version: 2, exportedAt: new Date().toISOString(), jobs: [job], shifts, payslips: [], files: [], meta: [{ key: "defaultJobId", value: job.id }] });
  }, [n, V]);
}
async function putShift(page, id, date, hours = 8) {
  await page.evaluate(async ([sid, d, h, v]) => {
    const db = await import(`/pay-ledger/js/db.js${v}`);
    const { withPay } = await import(`/pay-ledger/js/migrate.js${v}`);
    const { BEVCHAIN_RULES } = await import(`/pay-ledger/js/money.js${v}`);
    await db.put("shifts", withPay({ id: sid, jobId: "job-bev", date: d, mode: "duration", start: "", end: "", breakMins: 30, workedHours: h, ...BEVCHAIN_RULES,
      meal: false, mealRate: BEVCHAIN_RULES.mealAllowance, actualGross: null, actualNet: null, notes: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  }, [id, date, hours, V]);
}
const byName = (files, name) => Object.values(files).filter((f) => f.name === name && !f.trashed);

/* ---------- 1. Not configured ---------- */
console.log("1. GOOGLE_CLIENT_ID empty -> 'not set up yet', nothing loaded from Google");
{
  const { ctx, page, gisHits } = await newPage({ configured: false });
  await page.goto(`${APP}#/overview`, { waitUntil: "networkidle" });
  await seed(page);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#view-overview [data-drive-status]");
  const t = await statusText(page);
  check(/isn\u2019t set up yet/.test(t), `status: ${t}`);
  check(await page.locator("#view-overview .auto-save button", { hasText: "Connect Google Drive" }).isDisabled(), "Connect button disabled");
  check(await page.locator("#view-overview [data-drive]").isVisible(), "manual Save to Google Drive still there");
  await page.waitForTimeout(300);
  check(gisHits.length === 0, "GIS script not requested");
  check((await driveState(page)).log.length === 0, "no Drive API calls");
  await noOverflow(page, "not-configured overview");
  await shot(page, "drive-1-not-configured.png");
  await ctx.close();
}

/* ---------- 2. In-app browser ---------- */
console.log("2. Messenger in-app browser -> no Connect, explanation");
{
  const { ctx, page, gisHits } = await newPage({ ua: MESSENGER_UA });
  await page.goto(`${APP}#/overview`, { waitUntil: "networkidle" });
  await seed(page);
  await page.reload({ waitUntil: "networkidle" });
  const t = await statusText(page);
  check(/Auto-save needs Chrome/.test(t) && /Messenger\u2019s browser/.test(t), `status: ${t}`);
  check((await page.locator("#view-overview .auto-save [data-drive-connect]").count()) === 0, "Connect Google Drive hidden");
  await page.click("[data-view='jobs']");
  check(/Auto-save needs Chrome/.test(await page.locator("#view-jobs [data-drive-status]").innerText()), "Jobs tab panel says the same");
  await page.click("[data-view='overview']");
  await page.waitForTimeout(300);
  check(gisHits.length === 0, "GIS script not requested in the in-app browser");
  await noOverflow(page, "in-app overview");
  await shot(page, "drive-2-inapp.png");
  await ctx.close();
}

/* ---------- 3. Connect: folder + files ---------- */
console.log("3. Chrome: Connect -> folder + 3 files + weekly copy");
const { ctx, page, gisHits } = await newPage();
await page.goto(`${APP}#/overview`, { waitUntil: "networkidle" });
await seed(page);
await page.reload({ waitUntil: "networkidle" });
check(/Keeps a copy in your Google Drive/.test(await statusText(page)), "disconnected status explains auto-save");
check((await driveState(page)).log.length === 0, "no Drive calls before connecting (seeding did not sync)");
await noOverflow(page, "connect overview");
await shot(page, "drive-3-connect.png");
await page.click("#view-overview [data-drive-connect]");
await waitStatus(page, /^Last saved to Drive \d{1,2}:\d{2}(am|pm)$/);
let st = await driveState(page);
const gis = await page.evaluate(() => window.__gis);
check(gisHits.length === 1 && gisHits[0] === GIS_SRC, `GIS loaded once from ${GIS_SRC}`);
check(gis.inits[0].client_id === TEST_CLIENT_ID && gis.inits[0].scope === "https://www.googleapis.com/auth/drive.file", "token client: config Client ID + ONLY drive.file scope");
check(gis.requests.length === 1 && !gis.requests[0].hasPrompt, "one interactive token request on Connect");
const folders = byName(st.files, "Pay Ledger (auto)");
check(folders.length === 1 && folders[0].mimeType === "application/vnd.google-apps.folder" && folders[0].parents[0] === "root", "folder 'Pay Ledger (auto)' created in My Drive root");
const folderId = folders[0].id;
const csvF = byName(st.files, "pay-ledger-hours.csv");
const jsonF = byName(st.files, "pay-ledger-backup.json");
const htmlF = byName(st.files, "pay-ledger-summary.html");
check(csvF.length === 1 && jsonF.length === 1 && htmlF.length === 1, "3 fixed-name files created once");
check([csvF[0], jsonF[0], htmlF[0]].every((f) => f.parents[0] === folderId), "files are in the folder");
check(csvF[0].mimeType === "text/csv" && csvF[0].partType === "text/csv", "CSV uploaded as text/csv (no Sheets conversion)");
check(jsonF[0].mimeType === "application/json" && htmlF[0].mimeType === "text/html", "JSON application/json, summary text/html");
const creates = st.log.filter((e) => e.uploadType === "multipart");
check(creates.length === 4 && creates.every((e) => e.method === "POST" && e.url.includes("/upload/drive/v3/files?uploadType=multipart")), "creates use POST upload ?uploadType=multipart");
check(st.log.every((e) => e.auth === "Bearer tok-1"), "all calls carry the access token");
const expectCsv = await page.evaluate(async (v) => { const db = await import(`/pay-ledger/js/db.js${v}`); return db.shiftsToCsv(await db.all("shifts"), await db.all("jobs")); }, V);
check(csvF[0].content === expectCsv && csvF[0].content.charCodeAt(0) !== 0xfeff, "CSV content = shiftsToCsv, no BOM");
check(csvF[0].content.includes("Eagle Farm \u00b7 caf\u00e9 \u2014 run"), "CSV keeps unicode notes intact");
const backup = JSON.parse(jsonF[0].content);
check(backup.app === "pay-ledger" && backup.shifts.length === 5, "backup JSON has 5 shifts");
check(!backup.meta.some((r) => String(r.key).startsWith("drive")), "backup JSON has no Drive state");
check(/<html/i.test(htmlF[0].content), "summary is HTML");
const weekName = await page.evaluate(async (v) => (await import(`/pay-ledger/js/drive-sync.js${v}`)).weeklyBackupName(new Date()), V);
check(/^pay-ledger-backup-\d{4}-W\d{2}\.json$/.test(weekName) && byName(st.files, weekName).length === 1, `weekly copy ${weekName} created`);
let sync = await meta(page, "driveSync");
check(sync.connected && sync.folderId === folderId && sync.files.csv === csvF[0].id && sync.files.json === jsonF[0].id && sync.files.html === htmlF[0].id, "folderId + file IDs stored in meta.driveSync");
check(sync.email === "tim@example.com", "email hint stored");
check((await meta(page, "driveDirty")).dirty === false, "dirty flag cleared");
check(/tim@example\.com/.test(await page.locator("#view-overview .auto-save").innerText()), "shows signed-in account + file names");
await noMojibake(page, "connected overview");
await noOverflow(page, "connected overview");
await shot(page, "drive-4-saved.png");
const ids = { csv: csvF[0].id, json: jsonF[0].id, html: htmlF[0].id };

/* ---------- 4. Edits: debounce + PATCH in place ---------- */
console.log("4. Three quick edits -> one debounced sync, PATCH same IDs");
let mark = st.log.length;
await page.click(".top-actions [data-open='shift']");
await page.fill("#shift-date", "2026-09-25");
await page.fill("#shift-h", "9");
await page.fill("#shift-m", "15");
await page.click("#shift-form button[type='submit']");
await page.waitForFunction(() => !document.querySelector("#dlg-shift").open);
const tEdit = Date.now();
await putShift(page, "quick-1", "2026-09-26", 7);
await putShift(page, "quick-2", "2026-09-27", 6);
await waitStatus(page, /^Changes waiting to save/);
check((await meta(page, "driveDirty")).dirty === true, "dirty flag set in meta");
await shot(page, "drive-5-pending.png");
await page.waitForTimeout(3000);
check((await driveState(page)).log.length === mark, "nothing sent during the 5 s debounce");
await waitStatus(page, /^Last saved to Drive/, 15000);
st = await driveState(page);
const edits = st.log.slice(mark);
const firstAt = edits[0]?.at || 0;
log(`first request ${firstAt - tEdit} ms after the first edit; ${edits.length} requests: ${edits.map((e) => `${e.method} ${e.uploadType || ""}`).join(", ")}`);
check(firstAt - tEdit >= 4500, "sync started ~5 s after the edits");
check(edits.length === 3 && edits.every((e) => e.method === "PATCH" && e.uploadType === "media"), "exactly 3 PATCH ?uploadType=media (coalesced)");
check(JSON.stringify(edits.map((e) => e.target).sort()) === JSON.stringify(Object.values(ids).sort()), "PATCHes hit the same file IDs");
check(edits.find((e) => e.target === ids.csv).ct === "text/csv", "CSV update Content-Type text/csv");
check(Object.values(st.files).length === 5, "still 5 items in Drive (no duplicates)");
check(JSON.parse(st.files[ids.json].content).shifts.length === 8 && st.files[ids.csv].content.includes("2026-09-25"), "Drive copy has the new shifts");

/* ---------- 5. 401 -> silent token -> retry ---------- */
console.log("5. Expired token: 401 -> silent re-request once -> retry");
mark = st.log.length;
await page.evaluate(() => window.__drive.expired.push("Bearer tok-1"));
await putShift(page, "after-401", "2026-09-28", 8);
await waitStatus(page, /^Changes waiting/);
await waitStatus(page, /^Last saved to Drive/, 15000);
st = await driveState(page);
const g2 = await page.evaluate(() => window.__gis.requests);
const r401 = st.log.slice(mark);
check(r401[0].status === 401 && r401[1].auth === "Bearer tok-2" && r401[1].url === r401[0].url && r401[0].method === "PATCH" && r401[1].status === 200, "401 then the same PATCH retried with a new token");
check(g2.length === 2 && g2[1].prompt === "" && g2[1].login_hint === "tim@example.com", "silent request (prompt '') with login_hint");
check(r401.filter((e) => e.status === 401).length === 1, "only one 401");

/* ---------- 6. 404 / trashed -> recreate ---------- */
console.log("6. CSV deleted in Drive (404) + summary in the bin -> recreated in the folder");
mark = st.log.length;
await page.evaluate(([c, h]) => { delete window.__drive.files[c]; window.__drive.files[h].trashed = true; }, [ids.csv, ids.html]);
await putShift(page, "after-404", "2026-09-29", 8);
await waitStatus(page, /^Last saved to Drive/, 20000);
st = await driveState(page);
sync = await meta(page, "driveSync");
const newCsv = byName(st.files, "pay-ledger-hours.csv");
const newHtml = byName(st.files, "pay-ledger-summary.html");
check(st.log.slice(mark).some((e) => e.status === 404 && e.target === ids.csv), "PATCH on the stored CSV ID got 404");
check(newCsv.length === 1 && newCsv[0].id !== ids.csv && newCsv[0].parents[0] === folderId && newCsv[0].mimeType === "text/csv", "CSV recreated in the same folder as text/csv");
check(newHtml.length === 1 && newHtml[0].id !== ids.html, "trashed summary recreated");
check(sync.files.csv === newCsv[0].id && sync.files.html === newHtml[0].id && sync.files.json === ids.json, "meta updated with the new IDs, JSON ID unchanged");
check(newCsv[0].content.includes("2026-09-29"), "recreated CSV is current");
ids.csv = newCsv[0].id; ids.html = newHtml[0].id;

/* ---------- 7. Offline -> retry when back online ---------- */
console.log("7. Offline: status + dirty kept, retried on 'online'");
await ctx.setOffline(true);
await page.evaluate(() => { window.__drive.offline = true; });
await putShift(page, "offline-1", "2026-09-30", 8);
await waitStatus(page, /^Offline, will retry$/, 15000);
check((await meta(page, "driveDirty")).dirty === true, "dirty flag kept while offline");
await shot(page, "drive-6-offline.png");
mark = (await driveState(page)).log.length;
await page.evaluate(() => { window.__drive.offline = false; });
await ctx.setOffline(false);
await waitStatus(page, /^Last saved to Drive/, 15000);
st = await driveState(page);
check(st.files[ids.csv].content.includes("2026-09-30"), "offline change uploaded after reconnecting");
check((await meta(page, "driveDirty")).dirty === false, "dirty cleared after the retry");

/* ---------- 8. Dirty survives reload, synced on open ---------- */
console.log("8. Network fails, page reloaded -> synced on app open");
await page.evaluate(() => { window.__drive.offline = true; });
await putShift(page, "reload-1", "2026-10-01", 8);
await waitStatus(page, /^Offline, will retry$/, 15000);
const beforeReload = JSON.parse(JSON.stringify(await page.evaluate(() => window.__drive.files)));
await page.evaluate((files) => sessionStorage.setItem("fakeDrive", JSON.stringify(files)), beforeReload);
await page.addInitScript(() => { const s = sessionStorage.getItem("fakeDrive"); if (s && window.__drive) { const f = JSON.parse(s); window.__drive.files = f; window.__drive.n = 1000; } });
await page.reload({ waitUntil: "networkidle" });
check((await meta(page, "driveDirty")).dirty === true || /Last saved/.test(await statusText(page)), "dirty flag survived the reload");
await waitStatus(page, /^Last saved to Drive/, 15000);
st = await driveState(page);
check(st.files[ids.csv].content.includes("2026-10-01"), "unsynced change uploaded on app open (stored token reused)");
check(st.log.every((e) => e.auth === "Bearer tok-2"), "no new sign-in needed after reload within the hour");

/* ---------- 9. Token can't be refreshed silently -> Tap to reconnect ---------- */
console.log("9. Silent sign-in blocked -> 'Sign in again' + Tap to reconnect; data kept");
await page.evaluate(() => { window.__gis.mode = "blockSilent"; window.__drive.expired.push("Bearer tok-2"); });
await putShift(page, "reauth-1", "2026-10-02", 8);
await waitStatus(page, /^Sign in again/, 15000);
check(await page.locator("#view-overview [data-drive-connect]", { hasText: "Tap to reconnect" }).isVisible(), "Tap to reconnect button");
check((await meta(page, "driveDirty")).dirty === true, "dirty flag kept");
const shiftsKept = await page.evaluate(async (v) => (await (await import(`/pay-ledger/js/db.js${v}`)).all("shifts")).length, V);
check(shiftsKept === 13, `local data untouched (${shiftsKept} shifts)`);
await putShift(page, "reauth-2", "2026-10-03", 8);
await page.waitForTimeout(6000);
check(/^Sign in again/.test(await statusText(page)), "no repeated popups while waiting for a tap");
await shot(page, "drive-7-reconnect.png");
await page.click("#view-overview [data-drive-connect]");
await waitStatus(page, /^Last saved to Drive/, 15000);
st = await driveState(page);
check(st.files[ids.csv].content.includes("2026-10-03") && st.files[ids.csv].content.includes("2026-10-02"), "after the tap both pending changes are saved");
await page.evaluate(() => { window.__gis.mode = "ok"; });

/* ---------- 10. Big backup -> resumable upload ---------- */
console.log("10. Backup over 5 MB (payslip PDFs) -> resumable upload of the JSON");
mark = st.log.length;
await page.evaluate(async (v) => {
  const db = await import(`/pay-ledger/js/db.js${v}`);
  const bytes = new Uint8Array(4.5 * 1024 * 1024).map((_, i) => (i * 31) % 256);
  const id = await db.saveFile(new File([bytes], "big-payslip.pdf", { type: "application/pdf" }));
  await db.put("payslips", { id: "p-big", jobId: "job-bev", payDate: "2026-09-24", periodStart: "2026-09-14", periodEnd: "2026-09-20", net: 949.16, gross: 1065.86, tax: 159, super: 75.16, deductions: 0, notes: "", fileId: id, fileName: "big-payslip.pdf", createdAt: new Date().toISOString() });
}, V);
await waitStatus(page, /^Last saved to Drive/, 30000);
st = await driveState(page);
const big = st.log.slice(mark);
check(big.some((e) => e.method === "PATCH" && e.uploadType === "resumable" && e.target === ids.json) && big.some((e) => e.method === "PUT" && e.target === ids.json && e.size > 5 * 1024 * 1024), "JSON (>5 MB) sent via resumable PATCH + PUT to the same ID");
check(JSON.parse(st.files[ids.json].content).files.length === 1, "big backup landed intact");
check(big.filter((e) => e.uploadType === "media").length === 2, "CSV + summary still simple media PATCH");

/* ---------- 11. Import keeps the connection and syncs ---------- */
console.log("11. Paste/import backup -> Drive state kept, synced");
mark = st.log.length;
const small = await page.evaluate(async (v) => { const db = await import(`/pay-ledger/js/db.js${v}`); const b = await db.exportBackup(); b.shifts = b.shifts.slice(0, 3); b.payslips = []; b.files = []; return b; }, V);
check(!small.meta.some((r) => String(r.key).startsWith("drive")), "exportBackup leaves Drive state out");
await page.evaluate(async ([b, v]) => (await import(`/pay-ledger/js/db.js${v}`)).importBackup(b, { keepCurrent: true }), [small, V]);
await waitStatus(page, /^Last saved to Drive/, 20000);
sync = await meta(page, "driveSync");
check(sync.connected && sync.folderId === folderId && sync.files.csv === ids.csv, "import kept this browser's Drive connection + IDs");
st = await driveState(page);
check(JSON.parse(st.files[ids.json].content).shifts.length === 3, "imported ledger synced to Drive");

/* ---------- 12. Manual Save to Google Drive unchanged ---------- */
console.log("12. Manual Save to Google Drive still works");
await page.locator("#view-overview [data-drive]").scrollIntoViewIfNeeded();
await page.click("#view-overview [data-drive]");
await page.waitForFunction(() => document.querySelector("#dlg-drive").dataset.result, null, { timeout: 15000 });
const names = await page.locator("#drive-files").innerText();
check(/pay-ledger-backup-\d{4}-\d{2}-\d{2}\.json/.test(names) && /pay-ledger-hours-\d{4}-\d{2}-\d{2}\.csv/.test(names) && /pay-ledger-summary-\d{4}-\d{2}-\d{2}\.html/.test(names), "manual dated files unchanged");
await page.click("#dlg-drive [data-close]");

/* ---------- 13. Disconnect ---------- */
console.log("13. Disconnect");
await page.click("#view-overview [data-drive-disconnect]");
await waitStatus(page, /^Keeps a copy/);
sync = await meta(page, "driveSync");
check(!sync.connected && sync.folderId === folderId, "disconnected; folder ID kept for a later reconnect");
check((await page.evaluate(() => window.__gis.revoked)).length === 1, "token revoked");
check(await page.locator("#view-overview [data-drive-connect]", { hasText: "Connect Google Drive" }).isVisible(), "Connect button back");
mark = (await driveState(page)).log.length;
await putShift(page, "after-disconnect", "2026-10-05", 8);
await page.waitForTimeout(6000);
check((await driveState(page)).log.length === mark, "no Drive calls after Disconnect");
await noMojibake(page, "overview after disconnect");
await page.click("[data-view='jobs']");
await page.locator("#view-jobs .auto-save").scrollIntoViewIfNeeded();
await page.screenshot({ path: path.join(SHOTS, "drive-8-jobs-tab.png") });
log(`screenshot ${path.join(SHOTS, "drive-8-jobs-tab.png")}`);
await noOverflow(page, "jobs tab");

await browser.close();
if (errors.length) {
  console.error("\nFAILED:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("\nok \u00b7 Drive auto-save flow, no console errors");
