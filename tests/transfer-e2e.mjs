// Headless Chrome check at 390x844 for moving the ledger between browsers:
// Messenger UA -> banner, Copy backup (clipboard), Drive dialog offers Copy
// backup instead of downloads; fresh "Chrome" storage -> Paste backup ->
// identical shifts; confirmation with counts + pre-import copy + undo;
// bad / truncated pastes change nothing; manual copy fallback.
//   BASE=http://127.0.0.1:4174 PLAYWRIGHT_DIR=/workspace/tools node tests/transfer-e2e.mjs
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
const SHOTS = process.env.SHOTS || path.join(here, "..", "test-results");
await mkdir(SHOTS, { recursive: true });

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

async function newPage(ua, { clipboard = true } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: ua, acceptDownloads: true, locale: "en-AU", timezoneId: "Australia/Brisbane",
  });
  if (clipboard) await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  return { ctx, page };
}

const dump = (page) =>
  page.evaluate(async () => {
    const db = await import("/pay-ledger/js/db.js?v=3");
    const [jobs, shifts, payslips, files, meta] = await Promise.all(["jobs", "shifts", "payslips", "files", "meta"].map((s) => db.all(s)));
    const sort = (a) => [...a].sort((x, y) => String(x.id ?? x.key).localeCompare(String(y.id ?? y.key)));
    const fileSigs = await Promise.all(sort(files).map(async (f) => ({ id: f.id, name: f.name, size: f.blob.size, bytes: Array.from(new Uint8Array(await f.blob.arrayBuffer())).join(",").length })));
    return { jobs: sort(jobs), shifts: sort(shifts), payslips: sort(payslips), files: fileSigs, meta: sort(meta) };
  });

const noMojibake = async (page, where) => {
  const text = await page.evaluate(() => document.documentElement.innerText + document.title);
  check(!/\u00C2|\u00E2\u20AC|\u00E2\u02C6|\u00C3\u2014|\uFFFD/.test(text), `no mojibake on ${where}`);
};

/* ---------- 1. Messenger: seed a large ledger ---------- */
console.log("1. Messenger UA: seed ~460 KB ledger");
const m = await newPage(MESSENGER_UA);
await m.page.goto(`${APP}#/overview`, { waitUntil: "networkidle" });
await m.page.evaluate(async () => {
  const db = await import("/pay-ledger/js/db.js?v=3");
  const { withPay } = await import("/pay-ledger/js/migrate.js?v=3");
  const { BEVCHAIN_RULES } = await import("/pay-ledger/js/money.js?v=3");
  const job = { id: "job-bev", name: "BevChain", ...BEVCHAIN_RULES, breakMins: 30, color: "#e2a336", createdAt: "2026-01-01T00:00:00.000Z" };
  const shifts = [];
  for (let i = 0; i < 700; i++) {
    const d = new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    const s = withPay({
      id: `s-${String(i).padStart(4, "0")}`, jobId: job.id, date: d, mode: "clock", start: "05:30", end: "14:15",
      breakMins: 30, workedHours: 8.75, rate: job.rate, ot1Rate: job.ot1Rate, ot2Rate: job.ot2Rate, ordHours: job.ordHours, ot1Hours: job.ot1Hours,
      meal: i % 3 === 0, mealRate: job.mealAllowance, actualGross: null, actualNet: null,
      notes: i % 5 === 0 ? "Eagle Farm \u00b7 run \u2192 Toowoomba \u2014 caf\u00e9 stop \ud83d\ude9a" : "",
      createdAt: `${d}T08:00:00.000Z`, updatedAt: `${d}T08:00:00.000Z`,
    });
    shifts.push(s);
  }
  const bytes = new Uint8Array(90000).map((_, i) => (i * 7) % 256);
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  const payload = {
    app: "pay-ledger", version: 2, exportedAt: new Date().toISOString(), jobs: [job], shifts,
    payslips: [{ id: "p-1", jobId: job.id, payDate: "2026-09-24", periodStart: "2026-09-14", periodEnd: "2026-09-20", net: 949.16, gross: 1065.86, tax: 159, super: 75.16, fileId: "f-1", notes: "Randstad \u00b7 slip", createdAt: "2026-09-24T00:00:00.000Z" }],
    files: [{ id: "f-1", name: "payslip.pdf", type: "application/pdf", size: bytes.length, uploadedAt: "2026-09-24T00:00:00.000Z", dataUrl: `data:application/pdf;base64,${btoa(bin)}` }],
    meta: [{ key: "defaultJobId", value: job.id }],
  };
  await db.importBackup(payload);
});
await m.page.reload({ waitUntil: "networkidle" });
const seeded = await dump(m.page);
check(seeded.shifts.length === 700 && seeded.files.length === 1, `seeded ${seeded.shifts.length} shifts, ${seeded.files.length} file`);

/* ---------- 2. Banner ---------- */
console.log("2. Banner in Messenger");
const banner = m.page.locator("#iab-banner");
check(await banner.isVisible(), "in-app banner visible");
const bannerText = await banner.innerText();
check(bannerText.includes("You\u2019re inside Messenger\u2019s browser. Your data here is separate from Chrome."), "banner names Messenger + separate data");
check(bannerText.includes("Tap Copy backup, then open this page in Chrome and tap Paste backup."), "banner steps");
check(bannerText.includes(APP), `banner shows page URL ${APP}`);
const box = await banner.boundingBox();
check(box && box.y < 260 && box.width <= 390, `banner near top (y=${Math.round(box?.y)}) and fits 390px`);
const scrollW = await m.page.evaluate(() => document.documentElement.scrollWidth);
check(scrollW <= 390, `no horizontal overflow (scrollWidth ${scrollW})`);
await m.page.screenshot({ path: path.join(SHOTS, "transfer-1-messenger-banner.png") });
await noMojibake(m.page, "Messenger overview");

await m.page.click("#iab-banner [data-copy-link]");
check((await m.page.evaluate(() => navigator.clipboard.readText())) === APP, "Copy link puts the page URL on the clipboard");

/* ---------- 3. Copy backup ---------- */
console.log("3. Copy backup (banner)");
await m.page.click("#iab-banner [data-copy-backup]");
await m.page.waitForFunction(() => document.querySelector("#dlg-copy").dataset.method, null, { timeout: 15000 });
const copyMethod = await m.page.evaluate(() => document.querySelector("#dlg-copy").dataset.method);
check(copyMethod === "clipboard", `copied via ${copyMethod}`);
const copyStatus = await m.page.locator("#copy-status").innerText();
check(/Copied backup \u00b7 700 shifts, 1 payslip \(\d+ KB\)/.test(copyStatus), `success message: ${copyStatus}`);
const clip = await m.page.evaluate(() => navigator.clipboard.readText());
log(`clipboard: ${Math.round(clip.length / 1024)} KB`);
check(clip.length > 400000, "large backup text on clipboard (>400 KB)");
const exported = await m.page.evaluate(async () => JSON.stringify(await (await import("/pay-ledger/js/db.js?v=3")).exportBackup()));
const strip = (t) => { const o = JSON.parse(t); delete o.exportedAt; return JSON.stringify(o); };
check(strip(clip) === strip(exported), "clipboard text == Export backup JSON (except exportedAt)");
check(await m.page.locator("#copy-next").isVisible(), "next-step hint shown");
await m.page.screenshot({ path: path.join(SHOTS, "transfer-2-copied.png") });
await m.page.click("#dlg-copy [data-close]");

/* ---------- 4. Drive dialog in Messenger ---------- */
console.log("4. Save to Google Drive inside Messenger");
const downloads = [];
m.page.on("download", (d) => downloads.push(d));
await m.page.locator("#view-overview [data-drive]").scrollIntoViewIfNeeded();
await m.page.click("#view-overview [data-drive]");
await m.page.waitForFunction(() => document.querySelector("#dlg-drive").dataset.result, null, { timeout: 15000 });
check((await m.page.evaluate(() => document.querySelector("#dlg-drive").dataset.result)) === "inapp", "Drive dialog detects in-app browser");
const driveText = await m.page.locator("#dlg-drive").innerText();
check(/inside Messenger\u2019s browser/.test(driveText) && /Copy backup/.test(driveText), "Drive dialog explains + offers Copy backup");
check(await m.page.locator("#drive-copy").isVisible(), "Copy backup button in Drive dialog");
check(await m.page.locator("#drive-download").isVisible(), "Download files instead (secondary) visible");
await m.page.waitForTimeout(500);
check(downloads.length === 0, "no automatic downloads in Messenger");
await m.page.screenshot({ path: path.join(SHOTS, "transfer-3-drive-inapp.png") });
await m.page.click("#drive-copy");
await m.page.waitForFunction(() => document.querySelector("#dlg-copy").open && document.querySelector("#dlg-copy").dataset.method, null, { timeout: 15000 });
check(!(await m.page.evaluate(() => document.querySelector("#dlg-drive").open)), "Drive dialog closed when copying");
check((await m.page.locator("#copy-status").innerText()).includes("700 shifts"), "Copy from Drive dialog works");
await m.page.click("#dlg-copy [data-close]");
await m.page.click("#view-overview [data-drive]");
await m.page.waitForFunction(() => document.querySelector("#dlg-drive").dataset.result === "inapp");
await m.page.click("#drive-download");
await m.page.waitForTimeout(800);
check(downloads.length === 3, `Download files instead -> ${downloads.length} downloads`);
await m.page.click("#dlg-drive [data-close]");

/* ---------- 5. Chrome: paste into a fresh ledger ---------- */
console.log("5. Chrome UA, empty storage: Paste backup");
const c = await newPage(CHROME_UA);
await c.page.goto(`${APP}#/overview`, { waitUntil: "networkidle" });
check(!(await c.page.locator("#iab-banner").isVisible()), "no banner in Chrome");
check((await c.page.locator("#view-overview").innerText()).includes("Paste backup"), "empty ledger shows Paste backup on overview");
await c.page.evaluate((t) => navigator.clipboard.writeText(t), clip);
await c.page.click("#view-overview [data-paste-backup]");
await c.page.click("#paste-clipboard");
await c.page.waitForFunction(() => document.querySelector("#paste-text").value.length > 1000);
check((await c.page.locator("#paste-text").inputValue()) === clip, "Paste from clipboard filled the box with the full text");
await c.page.screenshot({ path: path.join(SHOTS, "transfer-4-paste.png") });
await c.page.click("#paste-import");
await c.page.waitForFunction(() => !document.querySelector("#dlg-paste").open, null, { timeout: 15000 });
check(!(await c.page.evaluate(() => document.querySelector("#dlg-confirm").open)), "empty ledger: no replace prompt needed");
const got = await dump(c.page);
const cmp = (a, b) => JSON.stringify(a) === JSON.stringify(b);
check(cmp(got.shifts, seeded.shifts), `shifts identical (${got.shifts.length})`);
check(cmp(got.jobs, seeded.jobs) && cmp(got.payslips, seeded.payslips) && cmp(got.files, seeded.files), "jobs, payslips, files identical");
check(!got.meta.some((r) => r.key === "preImportBackup"), "no pre-import copy for an empty ledger");
await c.page.goto(`${APP}#/hours`, { waitUntil: "networkidle" });
await noMojibake(c.page, "Chrome hours after paste");
check(got.shifts.filter((x) => x.notes === "Eagle Farm \u00b7 run \u2192 Toowoomba \u2014 caf\u00e9 stop \ud83d\ude9a").length === 140, "unicode notes (\u00b7 \u2192 \u2014 \u00e9 emoji) survived byte-for-byte");

/* ---------- 6. Bad pastes change nothing ---------- */
console.log("6. Truncated / wrong / broken pastes");
const before = await dump(c.page);
const tryPaste = async (text, label) => {
  await c.page.click("[data-view='jobs']");
  await c.page.click("#view-jobs [data-paste-backup]");
  await c.page.fill("#paste-text", text);
  await c.page.click("#paste-import");
  await c.page.waitForFunction(() => document.querySelector("#paste-status").classList.contains("error") || document.querySelector("#dlg-confirm").open, null, { timeout: 15000 });
  if (await c.page.evaluate(() => document.querySelector("#dlg-confirm").open)) {
    await c.page.click("#dlg-confirm [value='ok']");
    await c.page.waitForFunction(() => document.querySelector("#paste-status").classList.contains("error"), null, { timeout: 15000 });
  }
  const msg = await c.page.locator("#paste-status").innerText();
  log(`${label}: ${msg}`);
  await c.page.click("#dlg-paste [data-close]");
  return msg;
};
check(/incomplete/.test(await tryPaste(clip.slice(0, clip.length - 5000), "truncated")), "truncated paste rejected");
check(/not a Pay Ledger backup/.test(await tryPaste('{"hello":1}', "wrong JSON")), "non-backup JSON rejected");
const broken = JSON.parse(clip); broken.files[0].dataUrl = "data:application/pdf;base64,@@@not-base64@@@";
check(/damaged/.test(await tryPaste(JSON.stringify(broken), "broken file")), "broken file data rejected");
const noKey = JSON.parse(clip); delete noKey.shifts[600].id;
check(/nothing was changed/.test(await tryPaste(JSON.stringify(noKey), "record without key (fails mid-transaction)")), "mid-transaction failure reported");
check(cmp(await dump(c.page), before), "ledger unchanged after bad pastes (transaction rolled back)");

/* ---------- 7. Replace with confirmation + pre-import copy + undo ---------- */
console.log("7. Replace existing ledger: counts, pre-import copy, undo");
const smaller = JSON.parse(clip); smaller.shifts = smaller.shifts.slice(0, 50);
await c.page.click("#view-jobs [data-paste-backup]");
await c.page.fill("#paste-text", JSON.stringify(smaller));
await c.page.click("#paste-import");
await c.page.waitForFunction(() => document.querySelector("#dlg-confirm").open);
const confirmText = await c.page.locator("#dlg-confirm").innerText();
log(confirmText.replace(/\n+/g, " | "));
check(/This browser has 700 shifts/.test(confirmText) && /The backup has 50 shifts/.test(confirmText) && /FEWER/.test(confirmText), "confirm shows current vs incoming counts + fewer warning");
await c.page.screenshot({ path: path.join(SHOTS, "transfer-5-confirm.png") });
await c.page.click("#dlg-confirm [value='cancel']");
check(cmp(await dump(c.page), before), "cancel leaves ledger unchanged");
await c.page.click("#paste-import");
await c.page.waitForFunction(() => document.querySelector("#dlg-confirm").open);
await c.page.click("#dlg-confirm [value='ok']");
await c.page.waitForFunction(() => !document.querySelector("#dlg-paste").open, null, { timeout: 15000 });
const replaced = await dump(c.page);
check(replaced.shifts.length === 50, "replaced with 50 shifts");
const pre = replaced.meta.find((r) => r.key === "preImportBackup");
check(pre && pre.value.counts.shifts === 700 && JSON.parse(pre.value.backup).shifts.length === 700, "pre-import copy holds the 700-shift ledger");
const reExport = await c.page.evaluate(async () => (await (await import("/pay-ledger/js/db.js?v=3")).exportBackup()).meta.map((r) => r.key));
check(!reExport.includes("preImportBackup"), "pre-import copy is not put into new backups");
check(await c.page.locator("#view-jobs [data-undo-import]").isVisible(), "Undo last import button shown");
await c.page.click("#view-jobs [data-undo-import]");
await c.page.waitForFunction(() => document.querySelector("#dlg-confirm").open);
await c.page.click("#dlg-confirm [value='ok']");
await c.page.waitForFunction(async () => (await (await import("/pay-ledger/js/db.js?v=3")).all("shifts")).length === 700, null, { timeout: 15000 });
const undone = await dump(c.page);
check(cmp(undone.shifts, seeded.shifts) && cmp(undone.files, seeded.files), "undo restored the identical 700 shifts + file");
await c.page.screenshot({ path: path.join(SHOTS, "transfer-6-jobs-tools.png"), fullPage: true });
await noMojibake(c.page, "Chrome jobs");

/* ---------- 8. Manual copy fallback ---------- */
console.log("8. Clipboard + execCommand blocked -> full-screen textarea");
const f = await newPage(MESSENGER_UA, { clipboard: false });
await f.page.addInitScript(() => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new DOMException("blocked", "NotAllowedError")) }, configurable: true });
  document.execCommand = () => false;
});
await f.page.goto(`${APP}#/overview`, { waitUntil: "networkidle" });
await f.page.evaluate(async (t) => (await import("/pay-ledger/js/db.js?v=3")).importBackup(JSON.parse(t)), clip);
await f.page.reload({ waitUntil: "networkidle" });
await f.page.click("#iab-banner [data-copy-backup]");
await f.page.waitForFunction(() => document.querySelector("#dlg-copy").dataset.method, null, { timeout: 15000 });
check((await f.page.evaluate(() => document.querySelector("#dlg-copy").dataset.method)) === "manual", "falls back to manual copy");
check(await f.page.evaluate(() => document.querySelector("#dlg-copy").classList.contains("full")), "dialog goes full-screen");
const ta = await f.page.evaluate(() => { const t = document.querySelector("#copy-text"); return { len: t.value.length, sel: t.selectionEnd - t.selectionStart, ro: t.readOnly }; });
check(ta.len === clip.length && ta.ro, `readonly textarea holds the full backup (${ta.len} chars)`);
check(ta.sel === ta.len, "text is pre-selected");
check((await f.page.locator("#dlg-copy").innerText()).includes("Select all"), "Select all instructions shown");
await f.page.screenshot({ path: path.join(SHOTS, "transfer-7-manual.png") });

// execCommand-only path (Clipboard API blocked, execCommand works).
const e = await newPage(MESSENGER_UA);
await e.page.addInitScript(() => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("blocked")), readText: () => Promise.reject(new Error("blocked")) }, configurable: true });
  const real = document.execCommand.bind(document);
  document.execCommand = (cmd) => { window.__copied = document.activeElement?.value?.length; return real(cmd); };
});
await e.page.goto(`${APP}#/overview`, { waitUntil: "networkidle" });
await e.page.click("#iab-banner [data-copy-backup]");
await e.page.waitForFunction(() => document.querySelector("#dlg-copy").dataset.method, null, { timeout: 15000 });
const em = await e.page.evaluate(() => ({ m: document.querySelector("#dlg-copy").dataset.method, n: window.__copied }));
check(em.m === "execCommand" && em.n > 0, `execCommand fallback used with auto-selected textarea (${em.m}, ${em.n} chars focused)`);

await browser.close();
if (errors.length) {
  console.error("\nFAILED:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("\nok \u00b7 transfer flow, no console errors");
