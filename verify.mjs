import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(path.join("C:\\Users\\kenny\\bitmail", "package.json"));
const { chromium } = require("playwright");

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, "test-results");
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ headless: true });
const errors = [];

async function shot(page, name) {
  await page.screenshot({ path: path.join(out, name + ".png"), fullPage: true });
}

function listen(page) {
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console: " + m.text());
  });
}

async function runDesktop() {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await context.addInitScript(() => {
    indexedDB.deleteDatabase("pay-ledger");
  });
  const page = await context.newPage();
  listen(page);
  await page.goto("http://localhost:4174", { waitUntil: "networkidle" });
  await page.waitForSelector("h1");
  const title = await page.locator("h1").first().innerText();
  if (!/Pay Ledger/i.test(title)) errors.push("title: " + title);
  await page.waitForSelector(".empty h2");
  await shot(page, "01-empty-overview");

  await page.click('[data-open="shift"]');
  await page.waitForSelector("#dlg-shift[open]");
  await page.fill("#shift-date", "2026-09-17");
  await page.click('[data-day-type="weekday"]');
  await page.fill("#shift-h", "11");
  await page.fill("#shift-m", "45");
  await page.fill("#shift-break", "30");
  await page.waitForFunction(() => document.querySelector("#shift-paid")?.textContent.includes("11h 15m"));
  const paid = await page.locator("#shift-paid").innerText();
  const gross = await page.locator("#shift-gross").innerText();
  if (paid !== "11h 15m") errors.push("paid preview: " + paid);
  if (!gross.includes("556.34")) errors.push("gross preview: " + gross);
  const otNote = await page.locator("#shift-ot-note").innerText();
  if (!/8h @ 1×/.test(otNote) || !/2h @ 1.5×/.test(otNote) || !/1h 15m @ 2×/.test(otNote)) {
    errors.push("ot note: " + otNote);
  }
  await shot(page, "02-log-hours-dialog");

  await page.fill("#shift-date", "2026-09-19");
  await page.click('[data-day-type="sat-ot"]');
  await page.fill("#shift-h", "2");
  await page.fill("#shift-m", "0");
  await page.waitForFunction(() => document.querySelector("#shift-gross")?.textContent.includes("288.47"));
  const satGross = await page.locator("#shift-gross").innerText();
  const satPaid = await page.locator("#shift-paid").innerText();
  if (!satGross.includes("288.47")) errors.push("sat OT 2h gross: " + satGross);
  if (satPaid !== "4h") errors.push("sat OT 2h paid: " + satPaid);
  const satNote = await page.locator("#shift-ot-note").innerText();
  if (!/2h @ 1.5×/.test(satNote) || !/2h @ 2×/.test(satNote)) errors.push("sat OT split: " + satNote);
  await shot(page, "02b-sat-ot");

  await page.fill("#shift-date", "2026-09-20");
  await page.click('[data-day-type="sunday"]');
  await page.waitForFunction(() => document.querySelector("#shift-gross")?.textContent.includes("329.68"));
  const sunGross = await page.locator("#shift-gross").innerText();
  const sunPaid = await page.locator("#shift-paid").innerText();
  if (!sunGross.includes("329.68")) errors.push("sunday 2h gross: " + sunGross);
  if (sunPaid !== "4h") errors.push("sunday 2h paid: " + sunPaid);
  const sunNote = await page.locator("#shift-ot-note").innerText();
  if (!/4h @ 2×/.test(sunNote) || /1.5×/.test(sunNote)) errors.push("sunday split: " + sunNote);
  await shot(page, "02c-sunday");

  await page.click('[data-day-type="weekday"]');
  await page.fill("#shift-h", "11");
  await page.fill("#shift-m", "45");
  await page.waitForFunction(() => document.querySelector("#shift-gross")?.textContent.includes("556.34"));
  await page.click('#shift-form button[type="submit"]');
  await page.waitForSelector(".toast:not([hidden])");
  await page.waitForSelector(".stat-value");
  const weekGross = await page.locator(".stat-card .stat-value").first().innerText();
  if (!weekGross.includes("556.34")) errors.push("week card: " + weekGross);
  await shot(page, "03-overview-after-shift");

  await page.click('.tab[data-view="hours"]');
  await page.waitForSelector("table");
  const table = await page.locator("table").innerText();
  if (!/11h 15m/.test(table) || !/\$556.34/.test(table)) errors.push("hours table: " + table.slice(0, 200));
  if (!/1h 15m/.test(table)) errors.push("double time missing from table: " + table.slice(0, 280));
  await shot(page, "04-hours-table");

  await page.click('[data-open="payslip"]');
  await page.waitForSelector("#dlg-payslip[open]");
  await page.fill("#slip-net", "1842.55");
  await page.fill("#slip-gross", "2318.06");
  await page.fill("#slip-tax", "559.47");
  const netVal = await page.locator("#slip-net").inputValue();
  if (netVal !== "1842.55") errors.push("net overwritten by calculator: " + netVal);
  await page.setInputFiles("#slip-file", {
    name: "week-ending-payslip.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"),
  });
  await shot(page, "05-payslip-dialog");
  await page.click('#payslip-form button[type="submit"]');
  await page.waitForSelector(".toast:not([hidden])");
  await page.click('.tab[data-view="payslips"]');
  await page.waitForSelector(".slip");
  const slipText = await page.locator(".slip").innerText();
  if (!/\$1,842.55/.test(slipText) && !/\$1842.55/.test(slipText)) {
    errors.push("payslip card: " + slipText);
  }
  if (!/actual gross/i.test(slipText)) errors.push("payslip missing actual gross: " + slipText);
  if (!/File stored/i.test(slipText)) errors.push("file chip missing: " + slipText);
  await shot(page, "06-payslips");

  await page.click(".slip");
  await page.waitForSelector("#dlg-payslip[open]");
  await page.click("#slip-view");
  await page.waitForSelector("#dlg-viewer[open]");
  await shot(page, "07-payslip-viewer");
  await page.click('#dlg-viewer [data-close]');

  await page.click('.tab[data-view="jobs"]');
  await page.waitForSelector(".job-card");
  await page.click(".job-card");
  await page.waitForSelector("#dlg-job[open]");
  await page.fill("#job-name", "Job 1 · HR multi-drop");
  await page.click('#job-form button[type="submit"]');
  await page.waitForFunction(() =>
    document.querySelector("#view-jobs .job-card h3")?.textContent.includes("HR multi-drop"),
  );
  const jobName = await page.locator("#view-jobs .job-card h3").innerText();
  if (!/HR multi-drop/.test(jobName)) errors.push("job rename: " + jobName);
  await shot(page, "08-jobs");

  await page.click('.tab[data-view="hours"]');
  await page.click('#view-hours .row-link');
  await page.waitForSelector("#dlg-shift[open]");
  await page.click('[data-mode="clock"]');
  await page.fill("#shift-start", "05:30");
  await page.fill("#shift-end", "17:15");
  await page.waitForFunction(() => document.querySelector("#shift-paid")?.textContent.includes("11h 15m"));
  await page.click('#shift-form button[type="submit"]');
  await page.waitForSelector(".toast:not([hidden])");
  await shot(page, "09-hours-after-clock-edit");

  await context.close();
}

async function runMobile() {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await context.addInitScript(() => {
    indexedDB.deleteDatabase("pay-ledger");
  });
  const page = await context.newPage();
  listen(page);
  await page.goto("http://localhost:4174", { waitUntil: "networkidle" });
  await page.waitForSelector("h1");
  await shot(page, "10-mobile-overview");
  await page.click('.tab[data-view="hours"]');
  await page.waitForTimeout(200);
  await shot(page, "11-mobile-hours-empty");
  await page.locator('#view-hours [data-open="shift"]').click();
  await page.waitForSelector("#dlg-shift[open]");
  await shot(page, "12-mobile-log-dialog");
  await page.fill("#shift-h", "11");
  await page.fill("#shift-m", "45");
  await page.click('#shift-form button[type="submit"]');
  await page.waitForSelector("#view-hours .hours-cards .row");
  await shot(page, "13-mobile-hours-table");
  await page.click('.tab[data-view="overview"]');
  await page.waitForSelector("#view-overview .stat-value");
  await shot(page, "14-mobile-overview-logged");
  await page.click('.tab[data-view="payslips"]');
  await page.waitForTimeout(200);
  await shot(page, "15-mobile-payslips");
  await page.click('.tab[data-view="jobs"]');
  await page.waitForTimeout(200);
  await shot(page, "16-mobile-jobs");
  await context.close();
}

try {
  await runDesktop();
  await runMobile();
} finally {
  await browser.close();
}

if (errors.length) {
  console.error("FAILED");
  for (const e of errors) console.error(" -", e);
  process.exit(1);
}
console.log("ok");
