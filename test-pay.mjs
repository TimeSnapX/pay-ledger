// BevChain pay rules, meal allowance, v1 -> v2 migration, exports, share fallback.
// Run: node test-pay.mjs
import { readFileSync } from "node:fs";
import {
  AUD_EXACT,
  BEVCHAIN_RULES,
  formatShiftTimes,
  lineAmount,
  mealAmount,
  payFromHours,
  roundCents,
  shiftPay,
  sumBy,
} from "./js/money.js";
import { SCHEMA_VERSION, migrateDataset } from "./js/migrate.js";
import { buildSummaryHtml, shiftFigures, shiftsToCsv } from "./js/exporters.js";
import { pickShareableFiles, shareOrDownload } from "./js/share.js";

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed += 1;
}
const eq = (a, b, msg) => assert(a === b, `${msg}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
const $ = (n) => AUD_EXACT.format(n);
const R = BEVCHAIN_RULES;

console.log("== 1. Payslip 14–20 Sep (Randstad / BevChain) ==");
eq(lineAmount(4, R.ot1Rate), 211.0, "OT1 4.00h @ $52.75");
eq(lineAmount(3.3, R.ot2Rate), 228.46, "OT2 3.30h @ $69.23");
// Payslip hours as one line per band. 15.2 × 41.21 = 626.392 -> $626.39 (1c under the slip's $626.40).
const perLine = payFromHours({ ordinary: 15.2, ot1: 4, ot2: 3.3 }, R);
console.log("  per band, one line each:", perLine.lines.map((l) => `${l.hours}h @ $${l.rate} = ${$(l.amount)}`).join(" · "), "=>", $(perLine.gross));
eq(perLine.gross, 1065.85, "single-line-per-band total (ordinary 15.2 × 41.21 rounds to $626.39)");
// The slip is two 11.25h shifts, each band rounded per shift line: 2 × (313.20 + 105.50 + 114.23).
const one = shiftPay(11.75, 30, R, "weekday");
eq(one.paidHours, 11.25, "11h45 on site - 30m = 11.25h paid");
eq(one.ordinary, 7.6, "11.25h splits: 7.6 ordinary");
eq(one.timeAndHalf, 2, "11.25h splits: 2 OT1");
eq(one.double, 1.65, "11.25h splits: 1.65 OT2");
console.log("  one 11.25h shift:", one.lines.map((l) => `${l.hours}h @ $${l.rate} = ${$(l.amount)}`).join(" · "), "=>", $(one.estGross));
eq(one.estGross, 532.93, "one 11.25h shift");
const slipLines = {
  ordinary: roundCents(one.lines[0].amount * 2),
  ot1: roundCents(one.lines[1].amount * 2),
  ot2: roundCents(one.lines[2].amount * 2),
};
eq(slipLines.ordinary, 626.4, "Ordinary 15.20h line = $626.40 (as on the slip)");
eq(slipLines.ot1, 211.0, "Time and a half 4.00h = $211.00");
eq(slipLines.ot2, 228.46, "Double time 3.30h = $228.46");
const slipGross = roundCents(slipLines.ordinary + slipLines.ot1 + slipLines.ot2);
eq(slipGross, 1065.86, "Gross wages from payslip hours (per-shift lines)");
console.log("  payslip hours, per-shift lines:", $(slipLines.ordinary), "+", $(slipLines.ot1), "+", $(slipLines.ot2), "=", $(slipGross));
const meal2 = roundCents(2 * R.mealAllowance);
eq(meal2, 42.3, "2 meal allowances");
eq(roundCents(slipGross - 159 + meal2), 949.16, "net = gross - PAYG + tax-free meal");

console.log("== 2. Weekday split rules / weekend untouched ==");
const w8 = shiftPay(8.5, 30, R, "weekday");
eq(w8.ordinary, 7.6, "8h: 7.6 ordinary");
eq(w8.timeAndHalf, 0.4, "8h: 0.4 OT1");
eq(w8.double, 0, "8h: no OT2");
const w76 = shiftPay(7.6, 0, R, "weekday");
eq(w76.estGross, 313.2, "7.6h exactly = $313.20");
eq(shiftPay(2, 0, R, "sat-ot").estGross, 288.47, "Sat OT 2h (4h min, 1.5×/2× of ordinary) unchanged");
eq(shiftPay(6, 0, R, "sat-ot").estGross, 453.31, "Sat OT 6h unchanged");
eq(shiftPay(2, 0, R, "sat-ordinary").estGross, 247.26, "rostered Sat 2h -> 4h @ 1.5× unchanged");
eq(shiftPay(8, 0, R, "sunday").estGross, 659.36, "Sunday 8h all 2× unchanged");
eq(shiftPay(11.25, 0, 41.21, "weekday").estGross, 556.34, "legacy numeric rate keeps v1 8h/1.5×/2× maths");

console.log("== 3. Migration of the reconstructed v1 dataset ==");
const v1 = JSON.parse(readFileSync(new URL("./tests/fixtures/v1-backup.json", import.meta.url), "utf8"));
const m = migrateDataset(v1);
eq(m.shifts.length, 7, "all 7 shifts kept");
eq(m.payslips.length, 1, "payslip kept");
assert(JSON.stringify(m.payslips[0]) === JSON.stringify(v1.payslips[0]), "payslip byte-identical");
for (const s of v1.shifts) {
  const n = m.shifts.find((x) => x.id === s.id);
  assert(n, `shift ${s.date} present`);
  for (const k of ["id", "jobId", "date", "mode", "start", "end", "breakMins", "workedHours", "notes", "createdAt", "actualNet", "actualGross"]) {
    eq(n[k], s[k], `shift ${s.date} ${k} preserved`);
  }
  eq(n.v1EstGross, s.estGross, `shift ${s.date} keeps its v1 estimate for audit`);
}
const job = m.jobs[0];
eq(job.rate, 41.21, "job ordinary rate");
eq(job.ot1Rate, 52.75, "job OT1 rate");
eq(job.ot2Rate, 69.23, "job OT2 rate");
eq(job.ordHours, 7.6, "job ordinary hours");
eq(job.ot1Hours, 2, "job OT1 hours");
eq(job.mealAllowance, 21.15, "job meal");
eq(m.meta.find((x) => x.key === "schemaVersion").value, SCHEMA_VERSION, "schemaVersion meta");
eq(m.meta.find((x) => x.key === "defaultJobId").value, v1.meta[0].value, "other meta kept");
eq(m.shifts.filter((s) => s.meal).length, 7, "every shift is > 7.6h paid, so all 7 meal ticks default on");
const again = migrateDataset(m);
assert(JSON.stringify(again.shifts) === JSON.stringify(m.shifts), "migration is idempotent");
// Non-BevChain job keeps old behaviour
const other = migrateDataset({
  jobs: [v1.jobs[0], { id: "j2", name: "Warehouse", rate: 30, breakMins: 30 }],
  shifts: [{ ...v1.shifts[0], id: "x", jobId: "j2", rate: 30 }],
});
eq(other.jobs[1].ordHours, 8, "other job keeps 8h");
eq(other.shifts[0].estGross, shiftPay(11.75, 30, 30, "weekday").estGross, "other job estimate unchanged");
eq(other.shifts[0].meal, false, "other job: no meal allowance");

console.log("== 4. Mon 21 – Fri 25 Sep estimate ==");
const week = m.shifts.filter((s) => s.date >= "2026-09-21" && s.date <= "2026-09-25").map((s) => ({ s, f: shiftFigures(s) }));
const wk = {
  paid: sumBy(week, (r) => r.f.paidHours),
  ord: sumBy(week, (r) => r.f.ordinary),
  ot1: sumBy(week, (r) => r.f.timeAndHalf),
  ot2: sumBy(week, (r) => r.f.double),
  gross: sumBy(week, (r) => r.f.estGross),
  meal: sumBy(week, (r) => r.f.meal),
};
for (const r of week) console.log(`  ${r.s.date} ${formatShiftTimes(r.s, r.f.paidHours)} -> ${r.f.ordinary}/${r.f.timeAndHalf}/${r.f.double} = ${$(r.f.estGross)} + meal ${$(r.f.meal)}`);
console.log(`  week: ${wk.paid}h paid = ${wk.ord} ord + ${wk.ot1} OT1 + ${wk.ot2} OT2 -> est. gross ${$(wk.gross)}; meal ${$(wk.meal)} separate`);
eq(wk.paid, 51.75, "51.75h paid");
eq(wk.ord, 38, "38h ordinary");
eq(wk.ot1, 7.8, "7.8h OT1");
eq(wk.ot2, 5.95, "5.95h OT2");
eq(wk.gross, 2389.37, "est. gross Mon–Fri");
eq(wk.meal, 105.75, "5 meal allowances");
eq(wk.gross, sumBy(week, (r) => sumBy(r.f.lines, (l) => l.amount)), "est. gross is only the pay lines (no meal)");
eq(roundCents(wk.gross + wk.meal), 2495.12, "gross + meal shown separately would be $2,495.12 — never shown as gross");

console.log("== 5. Payslip variance is gross to gross ==");
const period = m.shifts.filter((s) => s.date >= "2026-09-14" && s.date <= "2026-09-20");
const estPeriod = sumBy(period, (s) => shiftFigures(s).estGross);
const mealPeriod = sumBy(period, (s) => mealAmount(s));
console.log(`  14–20 Sep logged est. gross ${$(estPeriod)} (meal ${$(mealPeriod)} excluded) vs slip gross ${$(1065.86)} -> variance ${$(roundCents(1065.86 - estPeriod))}`);
eq(estPeriod, 919.98, "logged Thu 11.25h + Fri 9h est. gross");
eq(mealPeriod, 42.3, "2 meals logged in the period, matching the slip");

console.log("== 6. Shift display ==");
eq(formatShiftTimes(m.shifts.find((s) => s.date === "2026-09-18")), "5:00–14:30 · 9h30 on site · 9h paid", "clock shift line");
eq(formatShiftTimes(m.shifts.find((s) => s.date === "2026-09-17")), "11h45 on site · 11h15 paid", "no clock times -> duration only");

console.log("== 7. CSV + summary ==");
const csv = shiftsToCsv(m.shifts, m.jobs);
const [head, ...lines] = csv.trim().split("\r\n");
for (const col of ["clock_in", "clock_out", "on_site_hours", "paid_hours", "ordinary_hours", "ot1_hours", "ot2_hours", "est_gross", "meal_allowance"]) {
  assert(head.split(",").includes(col), `CSV has ${col}`);
}
eq(lines.length, 7, "CSV rows");
eq(lines[1], "2026-09-18,BevChain,weekday,05:00,14:30,9.5,30,9,7.6,1.4,0,41.21,52.75,69.23,387.05,21.15,,,", "CSV row Fri 18");
const html = buildSummaryHtml({ jobs: m.jobs, shifts: m.shifts, payslips: m.payslips, now: new Date(2026, 8, 27, 11) });
assert(html.startsWith("<!DOCTYPE html>") && html.includes('<meta charset="utf-8">'), "summary is a full UTF-8 HTML doc");
assert(!/<script|src=|href=|@import|url\(/i.test(html), "summary has no scripts or external resources");
assert(html.includes("$3,309.35") && html.includes("$148.05") && html.includes("$949.16"), "summary totals (est. gross, meal, net)");
assert(!/\u00C2|\u00E2\u20AC|\u00E2\u02C6|\u00C3\u2014/.test(html + csv), "no mojibake in exports");

console.log("== 8. Share logic (stubbed navigator) ==");
const files = [
  new File(["{}"], "pay-ledger-backup-2026-09-27.json", { type: "application/json" }),
  new File(["a"], "pay-ledger-hours-2026-09-27.csv", { type: "text/csv" }),
  new File(["<p>"], "pay-ledger-summary-2026-09-27.html", { type: "text/html" }),
];
// Mimic Chrome's allowlist: no application/json.
const allow = /^(text\/(plain|csv|html))$/;
let shared = null;
const androidNav = {
  canShare: ({ files }) => files.every((f) => allow.test(f.type)),
  share: async (d) => {
    shared = d;
  },
};
const picked = pickShareableFiles(files, androidNav);
eq(picked[0].name, "pay-ledger-backup-2026-09-27.json.txt", "JSON backup relabelled .txt for Android's allowlist");
const r1 = await shareOrDownload(files, { nav: androidNav, download: () => assert(false, "no download when share works") });
eq(r1.method, "share", "share path used");
eq(shared.files.length, 3, "3 files shared");
const downloaded = [];
const r2 = await shareOrDownload(files, { nav: {}, download: (f) => downloaded.push(f.name) });
eq(r2.method, "download", "no Web Share -> download fallback");
eq(downloaded.length, 3, "3 files downloaded");
const r3 = await shareOrDownload(files, { nav: { ...androidNav, share: async () => { throw Object.assign(new Error("x"), { name: "AbortError" }); } }, download: () => assert(false, "no download on cancel") });
eq(r3.method, "cancelled", "user cancel does not download");
const r4 = await shareOrDownload(files, { nav: { ...androidNav, share: async () => { throw Object.assign(new Error("x"), { name: "NotAllowedError" }); } }, download: () => assert(false, "retry first") });
eq(r4.method, "retry", "expired tap -> offer Share now");

console.log(`\nok · ${passed} checks`);
