// Headless Chrome check at 390x844: v1 -> v2 migration through the real old app,
// shift display, meal tick, Drive share + download fallback, no console errors.
//
// Serve the new app at /pay-ledger/ and the pre-update app (git archive 2cceff3)
// at /old/ on the same origin, then:
//   BASE=http://127.0.0.1:4174 SHOTS=/workspace/screenshots node tests/e2e.mjs
// Needs playwright or playwright-core (PLAYWRIGHT_DIR=<dir containing node_modules>)
// and Chrome (CHROME=/usr/bin/google-chrome).
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const req = createRequire(path.join(process.env.PLAYWRIGHT_DIR || here, "package.json"));
let pw;
try { pw = req("playwright-core"); } catch { pw = req("playwright"); }
const { chromium } = pw;

const BASE = process.env.BASE || "http://127.0.0.1:4174";
const APP = `${BASE}/pay-ledger/`;
const SHOTS = process.env.SHOTS || path.join(here, "..", "test-results");
await mkdir(SHOTS, { recursive: true });
const fixture = JSON.parse(await readFile(path.join(here, "fixtures", "v1-backup.json"), "utf8"));

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME || "/usr/bin/google-chrome" });
const errors = [];
const log = (...a) => console.log(" ", ...a);
const check = (cond, msg) => {
  if (!cond) errors.push(msg);
  log(cond ? "✓" : "✗", msg);
};

function listen(page, tag) {
  page.on("pageerror", (e) => errors.push(`${tag} pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`${tag} console: ${m.text()}`);
  });
}

async function noMojibake(page, where) {
  const text = await page.evaluate(() => document.documentElement.innerText + document.title);
  check(!/\u00C2|\u00E2\u20AC|\u00E2\u02C6|\u00C3\u2014/.test(text), `no mojibake on ${where}`);
}

async function rawCounts(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open("pay-ledger");
        r.onsuccess = () => {
          const db = r.result;
          const tx = db.transaction(["jobs", "shifts", "payslips", "files", "meta"]);
          const out = { version: db.version };
          let n = 5;
          for (const s of ["jobs", "shifts", "payslips", "files", "meta"]) {
            const g = tx.objectStore(s).getAll();
            g.onsuccess = () => {
              out[s] = g.result;
              if (--n === 0) {
                db.close();
                resolve(out);
              }
            };
          }
        };
        r.onerror = () => reject(r.error);
      }),
  );
}

const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true, locale: "en-AU", timezoneId: "Australia/Brisbane" });
const page = await ctx.newPage();
listen(page, "mobile");

console.log("1. Seed v1 storage with the OLD app (commit 2cceff3)");
await page.goto(`${BASE}/old/`, { waitUntil: "networkidle" });
await page.evaluate(async (payload) => {
  const db = await import("/old/js/db.js");
  await db.importBackup(payload);
}, fixture);
const before = await rawCounts(page);
check(before.version === 1 && before.shifts.length === 7 && before.payslips.length === 1 && before.files.length === 1, `v1 DB seeded: version ${before.version}, ${before.shifts.length} shifts, ${before.payslips.length} payslip, ${before.files.length} file`);

console.log("2. Open the new app -> IndexedDB upgrade v1 -> v2");
await page.goto(`${APP}#/overview`, { waitUntil: "networkidle" });
await page.waitForSelector("#view-overview .stat-card");
const after = await rawCounts(page);
check(after.version === 2, `DB version now ${after.version}`);
check(after.shifts.length === 7 && after.payslips.length === 1 && after.files.length === 1, `after migration: ${after.shifts.length} shifts, ${after.payslips.length} payslip, ${after.files.length} file`);
check(JSON.stringify(after.payslips[0]) === JSON.stringify(before.payslips[0]), "payslip record unchanged");
check(after.shifts.every((s) => s.meal === true && s.mealRate === 21.15), "all 7 shifts (>7.6h paid) migrated with meal ticked");
check(after.meta.some((m) => m.key === "preMigrationV1" && m.value.shifts.length === 7), "pre-migration v1 copy kept in meta");
const job = after.jobs[0];
check(job.rate === 41.21 && job.ot1Rate === 52.75 && job.ot2Rate === 69.23 && job.ordHours === 7.6 && job.ot1Hours === 2 && job.mealAllowance === 21.15, "BevChain job migrated with 41.21 / 52.75 / 69.23 / 7.6h / 2h / $21.15");

const weekCard = await page.locator(".stat-card").nth(1).innerText();
log("this-week card:", weekCard.replace(/\n/g, " | "));
check(weekCard.includes("$2,389.37"), "this week est. gross $2,389.37 (meal excluded)");
check(weekCard.includes("meal $105.75"), "this week meal $105.75 shown separately");
const fyCard = await page.locator(".stat-card").nth(2).innerText();
log("FY card:", fyCard.replace(/\n/g, " | "));
check(fyCard.includes("$3,309.35") && fyCard.includes("meal $148.05"), "FY est. gross $3,309.35 + meal $148.05 separate");
await noMojibake(page, "Overview");
await page.screenshot({ path: path.join(SHOTS, "pay-ledger-overview.png"), fullPage: true });

console.log("3. Hours");
await page.click('.tab[data-view="hours"]');
await page.waitForSelector("#view-hours .hours-cards .row");
const hoursText = await page.locator("#view-hours").innerText();
check(hoursText.includes("5:00–14:30 · 9h30 on site · 9h paid"), "Fri 18 shows 5:00–14:30 · 9h30 on site · 9h paid");
check(hoursText.includes("11h45 on site · 11h15 paid"), "Thu 17 (no clock stored) shows duration only");
check(/Meal allowance \$148\.05 tax-free/.test(hoursText), "Hours summary meal $148.05 tax-free");
check(hoursText.includes("est. gross $3,309.35"), "Hours summary est. gross $3,309.35");
check(!/worked \d/.test(hoursText), 'old "worked 9h" wording gone');
await noMojibake(page, "Hours");
await page.screenshot({ path: path.join(SHOTS, "pay-ledger-hours.png"), fullPage: false });
const fri18 = page.locator('#view-hours .hours-cards .row', { hasText: "5:00–14:30" }).filter({ hasText: "18 Sep" });
await fri18.screenshot({ path: path.join(SHOTS, "pay-ledger-hours-shift-card.png") });

console.log("4. Shift edit form (Fri 18)");
await fri18.click();
await page.waitForSelector("#dlg-shift[open]");
check(await page.isChecked("#shift-meal"), "meal tick is on for the migrated 9h shift");
check((await page.inputValue("#shift-start")) === "05:00" && (await page.inputValue("#shift-end")) === "14:30", "clock times loaded");
check((await page.locator("#shift-gross").innerText()) === "$387.05", "edit preview est. gross $387.05");
await page.locator("#shift-meal").scrollIntoViewIfNeeded();
await page.evaluate(() => document.querySelector("#shift-meal").closest("label").scrollIntoView({ block: "start" }));
await noMojibake(page, "Shift form");
await page.screenshot({ path: path.join(SHOTS, "pay-ledger-shift-edit.png") });
await page.click("#shift-meal"); // untick
check((await page.locator("#shift-gross").innerText()) === "$387.05", "unticking meal does not change est. gross");
await page.click('#shift-form button[type="submit"]');
await page.waitForSelector("#dlg-shift", { state: "hidden" });
await page.waitForTimeout(150);
const hoursAfter = await page.locator("#view-hours").innerText();
check(/Meal allowance \$126\.90 tax-free/.test(hoursAfter) && hoursAfter.includes("$3,309.35"), "meal total drops to $126.90, gross stays $3,309.35");
await page.locator('#view-hours .hours-cards .row', { hasText: "18 Sep" }).click();
await page.waitForSelector("#dlg-shift[open]");
check(!(await page.isChecked("#shift-meal")), "unticked meal persisted");
await page.click("#shift-meal");
await page.click('#shift-form button[type="submit"]');
await page.waitForSelector("#dlg-shift", { state: "hidden" });

console.log("5. New shift: meal auto-default");
await page.click('.top-actions [data-open="shift"]');
await page.waitForSelector("#dlg-shift[open]");
await page.fill("#shift-date", "2026-09-28");
await page.fill("#shift-h", "8");
await page.fill("#shift-m", "0");
await page.fill("#shift-break", "30");
check(!(await page.isChecked("#shift-meal")), "7.5h paid -> meal off");
await page.fill("#shift-m", "15");
check(await page.isChecked("#shift-meal"), "8h15 on site - 30m = 7.75h paid (> 7.6) -> meal auto on");
const newGross = await page.locator("#shift-gross").innerText();
check(newGross === "$321.11", `7.75h est. gross ${newGross} (7.6h @ 41.21 = 313.20 + 0.15h @ 52.75 = 7.91)`);
await page.click('#dlg-shift [data-close]');

console.log("6. Payslips: gross-to-gross variance");
await page.click('.tab[data-view="payslips"]');
await page.waitForSelector(".slip");
const slipText = await page.locator(".slip").innerText();
log(slipText.replace(/\n/g, " | "));
check(slipText.includes("+$145.88") && slipText.includes("est. gross $919.98"), "variance slip gross $1,065.86 - est. gross $919.98 = +$145.88");
check(slipText.includes("Meal logged 2 × = $42.30"), "meal shown separately on the slip reconcile");
await noMojibake(page, "Payslips");
await page.screenshot({ path: path.join(SHOTS, "pay-ledger-payslips.png"), fullPage: true });

console.log("7. Jobs + Drive button (download fallback: headless Chrome has no file share)");
await page.click('.tab[data-view="jobs"]');
await page.waitForSelector(".job-card");
const jobsText = await page.locator("#view-jobs").innerText();
check(jobsText.includes("Saves a private copy to your Drive. Nothing is uploaded to the website."), "Drive explanation shown");
check(jobsText.includes("First 7.6h ordinary · next 2h @ $52.75 · then $69.23"), "job card shows BevChain rules");
await noMojibake(page, "Jobs");
await page.waitForSelector("#toast", { state: "hidden", timeout: 5000 });
await page.locator("#view-jobs .drive-panel").scrollIntoViewIfNeeded();
await page.screenshot({ path: path.join(SHOTS, "pay-ledger-drive-button.png") });
const hasShare = await page.evaluate(() => typeof navigator.share === "function" && typeof navigator.canShare === "function");
log("navigator.share available in headless:", hasShare);
const downloads = [];
page.on("download", (d) => downloads.push(d));
await page.click("#view-jobs [data-drive]");
await page.waitForFunction(() => document.querySelector("#dlg-drive").dataset.result, null, { timeout: 10000 });
const method = await page.evaluate(() => document.querySelector("#dlg-drive").dataset.result);
await page.waitForTimeout(800);
check(method === "download", `fallback method = ${method}`);
check(downloads.length === 3, `${downloads.length} files downloaded`);
const got = {};
for (const d of downloads) {
  const p = await d.path();
  got[d.suggestedFilename()] = await readFile(p, "utf8");
}
const names = Object.keys(got).sort();
log("downloaded:", names.join(", "));
const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
check(names.includes(`pay-ledger-backup-${today}.json`) && names.includes(`pay-ledger-hours-${today}.csv`) && names.includes(`pay-ledger-summary-${today}.html`), "backup JSON, hours CSV and summary HTML");
const backup = JSON.parse(got[`pay-ledger-backup-${today}.json`]);
check(backup.app === "pay-ledger" && backup.version === 2 && backup.shifts.length === 7 && backup.payslips.length === 1 && backup.files.length === 1, "backup JSON is a full v2 backup (same format as Export backup)");
const csv = got[`pay-ledger-hours-${today}.csv`];
check(/clock_in,clock_out,on_site_hours/.test(csv) && /meal_allowance/.test(csv) && csv.includes("2026-09-18,BevChain,weekday,05:00,14:30,9.5,30,9,7.6,1.4,0,41.21,52.75,69.23,387.05,21.15"), "CSV has the new columns");
const sumHtml = got[`pay-ledger-summary-${today}.html`];
check(sumHtml.includes("$3,309.35") && sumHtml.includes("$148.05") && !/<script/i.test(sumHtml), "summary HTML totals, no scripts");
for (const [n, t] of Object.entries(got)) check(!/\u00C2|\u00E2\u20AC|\u00E2\u02C6|\u00C3\u2014/.test(t), `no mojibake in ${n}`);
const driveText = await page.locator("#dlg-drive").innerText();
check(driveText.includes("Pay Ledger") && /upload/i.test(driveText), "fallback note tells the user to upload to a Pay Ledger folder");
await page.screenshot({ path: path.join(SHOTS, "pay-ledger-drive-fallback.png") });
await page.click("#dlg-drive [data-close]");

console.log("8. Summary HTML renders");
const sumPage = await ctx.newPage();
listen(sumPage, "summary");
await sumPage.setContent(sumHtml);
await sumPage.screenshot({ path: path.join(SHOTS, "pay-ledger-summary-html.png"), fullPage: true });
await sumPage.close();

console.log("9. Share path (Web Share stubbed like Android Chrome's allowlist)");
const sharePage = await ctx.newPage();
listen(sharePage, "share");
await sharePage.addInitScript(() => {
  const allow = /^text\/(plain|csv|html)$|^application\/pdf$|^image\//;
  navigator.canShare = (data) => Array.isArray(data?.files) && data.files.length > 0 && data.files.every((f) => allow.test(f.type));
  navigator.share = async (data) => {
    window.__shared = await Promise.all(data.files.map(async (f) => ({ name: f.name, type: f.type, size: f.size, head: (await f.text()).slice(0, 60) })));
  };
});
const shareDownloads = [];
sharePage.on("download", (d) => shareDownloads.push(d));
await sharePage.goto(`${APP}#/overview`, { waitUntil: "networkidle" });
await sharePage.waitForSelector("#view-overview [data-drive]");
await sharePage.locator("#view-overview [data-drive]").scrollIntoViewIfNeeded();
await sharePage.screenshot({ path: path.join(SHOTS, "pay-ledger-overview-drive.png") });
await sharePage.click("#view-overview [data-drive]");
await sharePage.waitForFunction(() => document.querySelector("#dlg-drive").dataset.result, null, { timeout: 10000 });
const shared = await sharePage.evaluate(() => window.__shared);
const shareMethod = await sharePage.evaluate(() => document.querySelector("#dlg-drive").dataset.result);
log("shared:", JSON.stringify(shared?.map((f) => [f.name, f.type, f.size])));
check(shareMethod === "share" && shared?.length === 3, "navigator.share called with 3 files");
check(shared?.[0].name === `pay-ledger-backup-${today}.json.txt` && shared[0].type === "text/plain" && shared[0].head.startsWith('{"app":"pay-ledger"'), "JSON backup shared as .json.txt (text/plain) because Chrome won't share application/json");
check(shared?.[1].type === "text/csv" && shared?.[2].type === "text/html", "CSV + HTML shared with their own types");
check(shareDownloads.length === 0, "no downloads when sharing works");
await sharePage.screenshot({ path: path.join(SHOTS, "pay-ledger-drive-shared.png") });
await sharePage.close();

console.log("10. Import an old v1 backup through the new app (migrates on import)");
await page.goto(`${APP}#/jobs`, { waitUntil: "networkidle" });
await page.waitForSelector(".job-card");
await page.setInputFiles("#import-json", { name: "pay-ledger-2026-09-26.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(fixture)) });
await page.waitForSelector("#dlg-confirm[open]");
await page.click('#dlg-confirm [value="ok"]');
await page.waitForFunction(() => /Backup imported/.test(document.querySelector("#toast").textContent));
const imported = await rawCounts(page);
check(imported.shifts.length === 7 && imported.payslips.length === 1 && imported.files.length === 1 && imported.shifts.every((s) => s.meal && s.ot1Rate === 52.75), "v1 backup import migrated: 7 shifts, 1 payslip, 1 file, meal + OT rates set");

console.log("11. Desktop width sanity (table)");
const desk = await ctx.newPage();
await desk.setViewportSize({ width: 1280, height: 900 });
listen(desk, "desktop");
await desk.goto(`${APP}#/hours`, { waitUntil: "networkidle" });
await desk.waitForSelector("table");
const table = await desk.locator("table").innerText();
check(/5:00–14:30/.test(table) && /\$21\.15/.test(table), "desktop table shows clock + meal column");
await noMojibake(desk, "Hours (desktop)");
await desk.screenshot({ path: path.join(SHOTS, "pay-ledger-hours-desktop.png"), fullPage: true });
await desk.close();

console.log("12. Upgrade while an old-version tab is still open");
const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
const oldTab = await ctx2.newPage();
await oldTab.goto(`${BASE}/old/`, { waitUntil: "networkidle" });
await oldTab.evaluate(async (payload) => (await import("/old/js/db.js")).importBackup(payload), fixture);
const newTab = await ctx2.newPage();
listen(newTab, "blocked-upgrade");
await newTab.goto(`${APP}#/hours`, { waitUntil: "domcontentloaded" });
await newTab.waitForFunction(() => /close any other Pay Ledger tabs/.test(document.querySelector("#toast").textContent), null, { timeout: 10000 });
check(true, "new tab waits and asks to close the old tab");
await oldTab.close();
await newTab.waitForSelector("#view-hours .hours-cards .row", { timeout: 10000 });
const blockedCounts = await rawCounts(newTab);
check(blockedCounts.version === 2 && blockedCounts.shifts.length === 7 && blockedCounts.payslips.length === 1, "upgrade finished after the old tab closed; 7 shifts + payslip intact");
await ctx2.close();

await browser.close();
if (errors.length) {
  console.error("\nFAILED");
  for (const e of errors) console.error(" -", e);
  process.exit(1);
}
console.log("\nok · no console errors");
