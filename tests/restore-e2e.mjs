// Headless check of "Restore from Drive", the upload guard and the no-setup
// safety net. Drive + Google sign-in are mocked in the page (no network, and
// nothing ever touches a real Drive).
//   RESTORE_FIXTURE=/path/to/pay-ledger-backup.json BASE=http://127.0.0.1:4174 PLAYWRIGHT_DIR=... node tests/restore-e2e.mjs
// Without RESTORE_FIXTURE a synthetic 19-shift / 3-payslip backup is used.
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GIS_MOCK, installFakeDrive } from "./drive-mock.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const req = createRequire(path.join(process.env.PLAYWRIGHT_DIR || here, "package.json"));
let pw;
try { pw = req("playwright-core"); } catch { pw = req("playwright"); }
const { chromium } = pw;
const BASE = process.env.BASE || "http://127.0.0.1:4174";
const APP = `${BASE}/pay-ledger/`;
const V = "?v=5";
const GIS_SRC = "https://accounts.google.com/gsi/client";
const REMOTE_TIME = "2026-10-14T03:45:37.596Z"; // 14 Oct, 1:45 pm Brisbane

function synthetic() {
  const job = { id: "job-bev", name: "BevChain", rate: 41.21, ot1Rate: 52.75, ot2Rate: 69.23, ordHours: 7.6, ot1Hours: 2, mealAllowance: 21.15, breakMins: 30, color: "#e2a336", createdAt: "2026-09-17T00:00:00.000Z" };
  const shifts = Array.from({ length: 19 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 8, 17) + i * 86400000).toISOString().slice(0, 10);
    return { id: `s${i}`, jobId: job.id, date, mode: "duration", start: "", end: "", breakMins: 30, workedHours: 10, rate: 41.21, ot1Rate: 52.75, ot2Rate: 69.23, ordHours: 7.6, ot1Hours: 2, meal: true, mealRate: 21.15, actualGross: null, actualNet: null, notes: "", createdAt: `${date}T08:00:00.000Z`, updatedAt: `${date}T08:00:00.000Z` };
  });
  const payslips = ["2026-09-24", "2026-10-01", "2026-10-07"].map((d, i) => ({ id: `p${i}`, jobId: job.id, payDate: d, periodStart: d, periodEnd: d, gross: 1000 + i, tax: 100, net: 900 + i, super: 75, deductions: 0, notes: "", createdAt: `${d}T08:00:00.000Z` }));
  return JSON.stringify({ app: "pay-ledger", version: 2, exportedAt: REMOTE_TIME, jobs: [job], shifts, payslips, files: [], meta: [{ key: "defaultJobId", value: job.id }] });
}
const FIXTURE = process.env.RESTORE_FIXTURE ? await readFile(process.env.RESTORE_FIXTURE, "utf8") : synthetic();
const fx = JSON.parse(FIXTURE);
const want = { shifts: fx.shifts.length, payslips: fx.payslips.length, files: fx.files.length };

const errors = [];
const log = (...a) => console.log(" ", ...a);
const check = (cond, msg) => { if (!cond) errors.push(msg); log(cond ? "\u2713" : "\u2717", msg); };
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME || "/usr/bin/google-chrome" });

async function newCtx() {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-AU", timezoneId: "Australia/Brisbane", acceptDownloads: true,
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
  });
  await ctx.route("https://accounts.google.com/**", (r) => r.abort());
  await ctx.route(GIS_SRC, (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: GIS_MOCK }));
  await ctx.route(/\/pay-ledger\/js\/drive-config\.js/, (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: 'export const GOOGLE_CLIENT_ID = "1234567890-test.apps.googleusercontent.com";\n' }));
  await ctx.addInitScript(installFakeDrive);
  // Drive already holds the backup (as written by the old version: no appProperties).
  await ctx.addInitScript(([text, mt]) => {
    const D = window.__drive;
    D.files.fold = { id: "fold", name: "Pay Ledger (auto)", mimeType: "application/vnd.google-apps.folder", parents: ["root"], trashed: false, content: "", rev: 0, modifiedTime: mt };
    D.files.bjson = { id: "bjson", name: "pay-ledger-backup.json", mimeType: "application/json", parents: ["fold"], trashed: false, content: text, rev: 0, modifiedTime: mt };
  }, [FIXTURE, REMOTE_TIME]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  return { ctx, page };
}
// Drive status: banner line while the ledger is empty, else the overview's auto-save panel.
const SEL = "#safety-banner [data-safety-drive], #view-overview [data-drive-status]";
const status = (page) => page.locator(SEL).first().innerText();
const waitStatus = (page, re, timeout = 20000) =>
  page.waitForFunction(([src, sel]) => [...document.querySelectorAll(sel)].some((el) => new RegExp(src).test(el.innerText || "")), [re.source, SEL], { timeout });
const counts = (page) => page.evaluate(async (v) => (await import(`/pay-ledger/js/db.js${v}`)).currentCounts(), V);
const uploads = (page) => page.evaluate(() => window.__drive.log.filter((e) => e.uploadType || (e.method === "POST") || (e.method === "PATCH" && !e.metaPatch)).length);
const remoteJson = (page) => page.evaluate(() => window.__drive.files.bjson.content);
async function untilFilled(page, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if ((await counts(page)).shifts > 0) return;
    await page.waitForTimeout(200);
  }
  throw new Error("ledger still empty");
}
const banner = (page) => page.locator("#safety-banner").innerText();

console.log(`Fixture: ${want.shifts} shifts, ${want.payslips} payslips, ${want.files} files`);

/* 1. Empty phone + Drive backup -> guard + Restore from Drive */
console.log("1. Empty ledger, Sign in -> guard pauses upload, offers Restore from Drive");
const { ctx, page } = await newCtx();
await page.goto(`${APP}#/overview`, { waitUntil: "networkidle" });
check((await counts(page)).shifts === 0, "starts empty");
check(/Used Pay Ledger before\?/.test(await banner(page)), "empty-ledger banner offers Google sign-in");
const persisted = await page.evaluate(() => document.documentElement.dataset.persisted);
check(persisted === "true" || persisted === "false", `navigator.storage.persist() called on startup (${persisted})`);
// The empty overview has no Drive panel: the banner carries sign-in + restore.
await page.click("#safety-banner [data-drive-connect]");
await waitStatus(page, /Found your Drive backup/);
const st = await status(page);
log(`status: ${st}`);
check(st.includes(`${want.shifts} shifts, ${want.payslips} payslips`) && st.includes("14 Oct, 1:45 pm"), "status shows Drive counts + Brisbane time");
const btn = await page.locator("#safety-banner [data-drive-restore]").innerText();
check(btn === "Restore from Drive (last saved 14 Oct, 1:45 pm)", `button: ${btn}`);
await page.waitForTimeout(1500);
check((await uploads(page)) === 0, "guard: nothing uploaded while the ledger is empty");
check((await remoteJson(page)) === FIXTURE, "Drive backup untouched");
// "Save now" style retry while empty: still blocked.
await page.evaluate(() => window.dispatchEvent(new CustomEvent("pay-ledger:data-changed")));
await page.waitForTimeout(6500);
check((await uploads(page)) === 0 && (await remoteJson(page)) === FIXTURE, "later change events while empty -> still nothing uploaded");

console.log("2. Restore from Drive");
await page.click("#safety-banner [data-drive-restore]");
await untilFilled(page, 20000);
const c = await counts(page);
check(c.shifts === want.shifts && c.payslips === want.payslips && c.files === want.files, `restored ${c.shifts} shifts, ${c.payslips} payslips, ${c.files} files`);
await waitStatus(page, /^Last synced to Drive: /, 30000);
log(`status: ${await status(page)}`);
const after = JSON.parse(await remoteJson(page));
check(after.shifts.length === want.shifts && after.payslips.length === want.payslips, "Drive backup re-saved with the same data (no loss)");
const ap = await page.evaluate(() => window.__drive.files.bjson.appProperties);
check(ap && ap.shifts === String(want.shifts) && ap.payslips === String(want.payslips), "counts stamped on Drive file");
const hours = await page.evaluate(() => { location.hash = "#/hours"; return new Promise((r) => setTimeout(() => r(document.querySelector("#view-hours").innerText), 400)); });
check(hours.includes("BevChain") || want.shifts === 0, "Hours tab shows restored shifts");

console.log("3. Guard: deleting shifts locally does not shrink Drive without confirm");
await page.evaluate(() => { location.hash = "#/overview"; });
await page.evaluate(async (v) => {
  const db = await import(`/pay-ledger/js/db.js${v}`);
  const backup = await db.exportBackup(); backup.shifts = []; backup.payslips = []; backup.files = [];
  await db.importBackup(backup);
}, V);
await waitStatus(page, /auto-save is paused/i, 20000);
check(JSON.parse(await remoteJson(page)).shifts.length === want.shifts, "empty ledger NOT uploaded over Drive backup");

console.log("4. Safety copy in Cache Storage + empty-ledger warning");
// Fresh browser storage for IndexedDB only (simulates the wipe), cache + localStorage kept.
await page.evaluate(async () => { await new Promise((r) => { const q = indexedDB.deleteDatabase("pay-ledger"); q.onsuccess = q.onerror = q.onblocked = r; }); });
await page.goto(`${APP}#/overview`, { waitUntil: "networkidle" });
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector("#safety-banner:not([hidden])");
const b1 = await banner(page);
log(`banner: ${b1.replace(/\s+/g, " ")}`);
check(new RegExp(`Your ledger is empty\\. A copy saved on this phone .* has ${want.shifts} shifts`).test(b1.replace(/\s+/g, " ")), "offers the saved copy");
await page.click("#safety-banner [data-restore-local]");
await untilFilled(page, 15000);
const c2 = await counts(page);
check(c2.shifts === want.shifts && c2.payslips === want.payslips, `saved copy restored ${c2.shifts}/${c2.payslips}`);

console.log("5. Cache gone too -> 'had N shifts' warning");
await page.waitForTimeout(2500);
await page.evaluate(async () => { await caches.delete("pl-safety-copy"); await new Promise((r) => { const q = indexedDB.deleteDatabase("pay-ledger"); q.onsuccess = q.onerror = q.onblocked = r; }); });
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector("#safety-banner:not([hidden])");
const b2 = (await banner(page)).replace(/\s+/g, " ");
log(`banner: ${b2}`);
check(b2.includes(`Your ledger is empty, but it had ${want.shifts} shifts`), "warns ledger was emptied");
await ctx.close();

console.log("6. 7-day backup prompt");
{
  const { ctx, page } = await newCtx();
  await page.goto(`${APP}#/overview`, { waitUntil: "networkidle" });
  await page.evaluate(async ([text, v]) => (await import(`/pay-ledger/js/db.js${v}`)).importBackup(JSON.parse(text)), [FIXTURE, V]);
  await page.evaluate(() => { localStorage.setItem("payLedger.firstDataAt", JSON.stringify(new Date(Date.now() - 8 * 86400000).toISOString())); localStorage.removeItem("payLedger.lastBackupAt"); });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#safety-banner:not([hidden])");
  const b = (await banner(page)).replace(/\s+/g, " ");
  log(`banner: ${b}`);
  check(/No backup in 8 days/.test(b), "prompt after 7 days");
  const dl = page.waitForEvent("download");
  await page.click("#safety-banner [data-backup-now]");
  const file = await dl;
  check(/^pay-ledger-\d{4}-\d{2}-\d{2}\.json$/.test(file.suggestedFilename()), `downloaded ${file.suggestedFilename()}`);
  await page.waitForTimeout(300);
  check(await page.locator("#safety-banner").isHidden(), "prompt gone after backup");
  await ctx.close();
}

await browser.close();
if (errors.length) {
  console.log("\nFAILED:\n" + errors.map((e) => " - " + e).join("\n"));
  process.exit(1);
}
console.log("\nok · restore + guard + safety net, no console errors");
