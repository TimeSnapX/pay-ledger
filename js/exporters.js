/** CSV + human-readable HTML summary. Pure functions: no DOM, no network. */
import {
  AUD_EXACT,
  dayTypeMeta,
  formatClock,
  formatDay,
  formatHM,
  fyLabel,
  mealAmount,
  normalizeRules,
  roundCents,
  shiftPay,
  suggestDayType,
  sumBy,
} from "./money.js?v=4";

/** Pay figures for a stored shift. Meal allowance is separate and never in estGross. */
export function shiftFigures(s) {
  const dayType = s.dayType || suggestDayType(s.date);
  const calc = shiftPay(s.workedHours, s.breakMins, normalizeRules(s.ot1Rate == null ? s.rate : s), dayType);
  return { ...calc, meal: mealAmount(s) };
}

function csvCell(value) {
  const s = String(value ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function shiftsToCsv(shifts, jobs) {
  const jobName = (id) => jobs.find((j) => j.id === id)?.name || "";
  const header = [
    "date",
    "job",
    "day_type",
    "clock_in",
    "clock_out",
    "on_site_hours",
    "unpaid_break_mins",
    "paid_hours",
    "ordinary_hours",
    "ot1_hours",
    "ot2_hours",
    "ordinary_rate",
    "ot1_rate",
    "ot2_rate",
    "est_gross",
    "meal_allowance",
    "actual_gross",
    "actual_net",
    "notes",
  ];
  const lines = [header.join(",")];
  const sorted = [...shifts].sort((a, b) => a.date.localeCompare(b.date));
  for (const s of sorted) {
    const f = shiftFigures(s);
    const cells = [
      s.date,
      csvCell(jobName(s.jobId)),
      f.dayType,
      s.start || "",
      s.end || "",
      f.worked,
      s.breakMins ?? "",
      f.paidHours,
      f.ordinary,
      f.timeAndHalf,
      f.double,
      roundCents4(f.ordinaryRate),
      roundCents4(f.ot1Rate),
      roundCents4(f.ot2Rate),
      f.estGross.toFixed(2),
      f.meal.toFixed(2),
      s.actualGross ?? "",
      s.actualNet ?? "",
      csvCell(s.notes || ""),
    ];
    lines.push(cells.join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

function roundCents4(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

/**
 * Self-contained, human-readable summary (inline CSS, no scripts, no external
 * requests) that opens nicely in Google Drive's preview or any browser.
 */
export function buildSummaryHtml({ jobs = [], shifts = [], payslips = [], now = new Date() }) {
  const $ = (n) => AUD_EXACT.format(Number(n) || 0);
  const jobName = (id) => jobs.find((j) => j.id === id)?.name || "Job";
  const rows = [...shifts].sort((a, b) => a.date.localeCompare(b.date)).map((s) => ({ s, f: shiftFigures(s) }));
  const slips = [...payslips].sort((a, b) => a.payDate.localeCompare(b.payDate));
  const totalPaid = sumBy(rows, (r) => r.f.paidHours);
  const totalGross = sumBy(rows, (r) => r.f.estGross);
  const totalMeal = sumBy(rows, (r) => r.f.meal);
  const mealCount = rows.filter((r) => r.f.meal).length;
  const slipGross = sumBy(slips, (p) => p.gross);
  const slipNet = sumBy(slips, (p) => p.net);
  const slipTax = sumBy(slips, (p) => p.tax);
  const slipSuper = sumBy(slips, (p) => p.super);
  const stamp = now.toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" });

  const shiftRows = rows
    .map(({ s, f }) => {
      const clock = s.start && s.end ? `${formatClock(s.start)}–${formatClock(s.end)}` : "—";
      return `<tr>
<td>${esc(formatDay(s.date))}</td><td>${esc(jobName(s.jobId))}</td><td>${esc(dayTypeMeta(f.dayType).label)}</td>
<td>${clock}</td><td>${formatHM(f.worked)}</td><td>${formatHM(f.paidHours)}</td>
<td>${f.ordinary ? formatHM(f.ordinary) : "—"}</td><td>${f.timeAndHalf ? formatHM(f.timeAndHalf) : "—"}</td><td>${f.double ? formatHM(f.double) : "—"}</td>
<td class="n">${$(f.estGross)}</td><td class="n">${f.meal ? $(f.meal) : "—"}</td></tr>`;
    })
    .join("\n");

  const slipRows = slips
    .map(
      (p) => `<tr><td>${esc(formatDay(p.payDate))}</td><td>${esc(jobName(p.jobId))}</td>
<td>${p.periodStart && p.periodEnd ? `${esc(formatDay(p.periodStart))} – ${esc(formatDay(p.periodEnd))}` : "—"}</td>
<td class="n">${$(p.gross)}</td><td class="n">${$(p.tax)}</td><td class="n">${$(p.net)}</td><td class="n">${$(p.super)}</td></tr>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pay Ledger summary · ${esc(stamp)}</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;padding:24px;background:#f7f3ea;color:#1b170f;line-height:1.45}
main{max-width:1000px;margin:0 auto}
h1{margin:0 0 4px;font-size:26px}h2{margin:28px 0 8px;font-size:18px}
.muted{color:#6b665a;font-size:13px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-top:16px}
.card{background:#fff;border:1px solid #e3dccb;border-radius:12px;padding:12px 14px}
.card b{display:block;font-size:22px}
.wrap{overflow-x:auto;background:#fff;border:1px solid #e3dccb;border-radius:12px}
table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
th,td{padding:8px 10px;border-bottom:1px solid #eee6d4;text-align:left;white-space:nowrap}
th{background:#faf6ee;color:#6b665a;font-weight:600}
td.n,th.n{text-align:right}
tfoot td{font-weight:700;border-top:2px solid #e3dccb}
</style>
</head>
<body>
<main>
<h1>Pay Ledger summary</h1>
<p class="muted">Generated ${esc(stamp)} · ${esc(fyLabel(now))} · private copy from this phone's Pay Ledger. Est. gross comes from logged hours; payslips are the source of truth. Meal allowance is tax-free and not included in gross.</p>
<div class="cards">
<div class="card"><span class="muted">Hours paid (logged)</span><b>${formatHM(totalPaid)}</b><span class="muted">${rows.length} shift${rows.length === 1 ? "" : "s"}</span></div>
<div class="card"><span class="muted">Est. gross (taxable)</span><b>${$(totalGross)}</b><span class="muted">from hours</span></div>
<div class="card"><span class="muted">Meal allowance (tax-free)</span><b>${$(totalMeal)}</b><span class="muted">${mealCount} × meal, not in gross</span></div>
<div class="card"><span class="muted">Payslips</span><b>${$(slipNet)} net</b><span class="muted">gross ${$(slipGross)} · tax ${$(slipTax)} · super ${$(slipSuper)}</span></div>
</div>
<h2>Shifts</h2>
<div class="wrap"><table>
<thead><tr><th>Date</th><th>Job</th><th>Day</th><th>Clock</th><th>On site</th><th>Paid</th><th>Ordinary</th><th>OT1</th><th>OT2</th><th class="n">Est. gross</th><th class="n">Meal</th></tr></thead>
<tbody>
${shiftRows || '<tr><td colspan="11">No shifts logged.</td></tr>'}
</tbody>
<tfoot><tr><td colspan="5">Total</td><td>${formatHM(totalPaid)}</td><td colspan="3"></td><td class="n">${$(totalGross)}</td><td class="n">${$(totalMeal)}</td></tr></tfoot>
</table></div>
<h2>Payslips</h2>
<div class="wrap"><table>
<thead><tr><th>Paid</th><th>Job</th><th>Period</th><th class="n">Gross</th><th class="n">Tax</th><th class="n">Net</th><th class="n">Super</th></tr></thead>
<tbody>
${slipRows || '<tr><td colspan="7">No payslips on file.</td></tr>'}
</tbody>
<tfoot><tr><td colspan="3">Total</td><td class="n">${$(slipGross)}</td><td class="n">${$(slipTax)}</td><td class="n">${$(slipNet)}</td><td class="n">${$(slipSuper)}</td></tr></tfoot>
</table></div>
<p class="muted">Rates: ${jobs
    .map((j) => {
      const r = normalizeRules(j);
      return `${esc(j.name)} — ordinary ${$(r.rate)}/h for ${r.ordHours}h, OT1 ${$(r.ot1Rate)}/h for ${r.ot1Hours}h, then OT2 ${$(r.ot2Rate)}/h; meal ${$(r.mealAllowance)}`;
    })
    .join("; ")}. Saturday/Sunday use 1.5× / 2× of the ordinary rate.</p>
</main>
</body>
</html>
`;
}
