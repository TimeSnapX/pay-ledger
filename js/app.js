import * as db from "./db.js";
import {
  AUD_EXACT,
  DAY_TYPES,
  dayTypeMeta,
  formatDay,
  formatDayShort,
  formatHours,
  formatMonth,
  formatSplit,
  fyEnd,
  fyLabel,
  fyStart,
  groupMonths,
  groupWeeks,
  hoursFromClock,
  hoursFromParts,
  inRange,
  roundCents,
  shiftPay,
  splitHours,
  suggestDayType,
  sumBy,
  toISODate,
  todayISO,
  weekEnd,
  weekStart,
} from "./money.js";

const state = {
  view: "overview",
  jobs: [],
  shifts: [],
  payslips: [],
  jobFilter: "all",
  monthFilter: "all",
  shiftMode: "duration",
  dayType: "weekday",
  pendingFile: null,
  existingFileName: "",
};

const els = {
  overview: document.querySelector("#view-overview"),
  hours: document.querySelector("#view-hours"),
  payslips: document.querySelector("#view-payslips"),
  jobs: document.querySelector("#view-jobs"),
  tabs: document.querySelectorAll(".tab"),
  shiftDlg: document.querySelector("#dlg-shift"),
  slipDlg: document.querySelector("#dlg-payslip"),
  jobDlg: document.querySelector("#dlg-job"),
  viewerDlg: document.querySelector("#dlg-viewer"),
  confirmDlg: document.querySelector("#dlg-confirm"),
  toast: document.querySelector("#toast"),
  drop: document.querySelector("#drop-zone"),
  dropLabel: document.querySelector("#drop-label"),
  fileInput: document.querySelector("#slip-file"),
};

let toastTimer = 0;
let objectUrl = "";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

function jobById(id) {
  return state.jobs.find((j) => j.id === id);
}

function jobColor(id) {
  return jobById(id)?.color || "#e2a336";
}

function filteredShifts() {
  return state.shifts.filter((s) => {
    if (state.jobFilter !== "all" && s.jobId !== state.jobFilter) return false;
    if (state.monthFilter !== "all" && s.date.slice(0, 7) !== state.monthFilter) return false;
    return true;
  });
}

function filteredPayslips() {
  return state.payslips.filter((p) => {
    if (state.jobFilter !== "all" && p.jobId !== state.jobFilter) return false;
    if (state.monthFilter !== "all" && p.payDate.slice(0, 7) !== state.monthFilter) return false;
    return true;
  });
}

function monthOptions() {
  const keys = new Set();
  for (const s of state.shifts) keys.add(s.date.slice(0, 7));
  for (const p of state.payslips) keys.add(p.payDate.slice(0, 7));
  return [...keys].sort().reverse();
}

function filterBar() {
  const months = monthOptions()
    .map((key) => {
      const [y, m] = key.split("-").map(Number);
      const label = new Date(y, m - 1, 1).toLocaleDateString("en-AU", {
        month: "long",
        year: "numeric",
      });
      return `<option value="${key}" ${state.monthFilter === key ? "selected" : ""}>${label}</option>`;
    })
    .join("");
  const jobs = state.jobs
    .map(
      (j) =>
        `<option value="${j.id}" ${state.jobFilter === j.id ? "selected" : ""}>${escapeHtml(j.name)}</option>`,
    )
    .join("");
  return `
    <div class="filters">
      <select class="filter" data-filter="job" aria-label="Filter by job">
        <option value="all" ${state.jobFilter === "all" ? "selected" : ""}>All jobs</option>
        ${jobs}
      </select>
      <select class="filter" data-filter="month" aria-label="Filter by month">
        <option value="all" ${state.monthFilter === "all" ? "selected" : ""}>All months</option>
        ${months}
      </select>
    </div>
  `;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2400);
}

async function confirmDelete(title, body, action = "Delete") {
  document.querySelector("#confirm-title").textContent = title;
  document.querySelector("#confirm-body").textContent = body;
  els.confirmDlg.querySelector("[value='ok']").textContent = action;
  els.confirmDlg.returnValue = "cancel";
  els.confirmDlg.showModal();
  return new Promise((resolve) => {
    const onClose = () => {
      els.confirmDlg.removeEventListener("close", onClose);
      resolve(els.confirmDlg.returnValue === "ok");
    };
    els.confirmDlg.addEventListener("close", onClose);
  });
}

async function reload() {
  const [jobs, shifts, payslips] = await Promise.all([
    db.ensureDefaultJob(),
    db.all("shifts"),
    db.all("payslips"),
  ]);
  state.jobs = jobs.sort((a, b) => a.name.localeCompare(b.name));
  state.shifts = shifts.map(enrichShift).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  state.payslips = payslips.sort((a, b) => b.payDate.localeCompare(a.payDate));
  render();
}

function enrichShift(s) {
  const dayType = s.dayType || suggestDayType(s.date);
  const calc = shiftPay(s.workedHours, s.breakMins, s.rate, dayType);
  const actualGross = s.actualGross ?? null;
  return {
    ...s,
    dayType,
    afterBreak: calc.afterBreak,
    paidHours: calc.paidHours,
    ordinaryHours: calc.ordinary,
    timeAndHalfHours: calc.timeAndHalf,
    doubleHours: calc.double,
    estGross: calc.estGross,
    gross: calc.estGross,
    minApplied: calc.minApplied,
    actualGross,
    actualNet: s.actualNet ?? null,
    variance: actualGross != null ? roundCents(actualGross - calc.estGross) : null,
  };
}

function moneyOrNull(id) {
  const raw = document.querySelector(id).value.trim();
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? roundCents(n) : null;
}

function fillMoney(id, value) {
  document.querySelector(id).value = value == null || value === "" ? "" : value;
}

function setView(view) {
  state.view = view;
  history.replaceState(null, "", `#/${view}`);
  render();
}

function render() {
  for (const tab of els.tabs) {
    tab.setAttribute("aria-selected", String(tab.dataset.view === state.view));
  }
  els.overview.hidden = state.view !== "overview";
  els.hours.hidden = state.view !== "hours";
  els.payslips.hidden = state.view !== "payslips";
  els.jobs.hidden = state.view !== "jobs";
  if (state.view === "overview") renderOverview();
  if (state.view === "hours") renderHours();
  if (state.view === "payslips") renderPayslips();
  if (state.view === "jobs") renderJobs();
}

function rangeShifts(start, end) {
  return state.shifts.filter((s) => inRange(s.date, start, end));
}

function rangeSlips(start, end) {
  return state.payslips.filter((p) => inRange(p.payDate, start, end));
}

function renderOverview() {
  const now = new Date();
  const ws = weekStart(now);
  const we = weekEnd(now);
  const ms = new Date(now.getFullYear(), now.getMonth(), 1);
  const me = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const fys = fyStart(now);
  const fye = fyEnd(now);
  const week = rangeShifts(ws, we);
  const month = rangeShifts(ms, me);
  const fy = rangeShifts(fys, fye);
  const fySlips = rangeSlips(fys, fye);
  const compact = window.innerWidth < 700;
  const weeks = groupWeeks(state.shifts, compact ? 6 : 12, now);
  const months = groupMonths(state.shifts, state.payslips, compact ? 4 : 6, now);
  const maxWeek = Math.max(1, ...weeks.map((w) => w.gross));
  const maxMonth = Math.max(1, ...months.map((m) => Math.max(m.gross, m.slipNet, m.income)));
  const fyEst = sumBy(fy, (s) => s.estGross);
  const fyActualGross = sumBy(fySlips, (p) => p.gross);
  const fyActualNet = sumBy(fySlips, (p) => p.net);
  const fyTax = sumBy(fySlips, (p) => p.tax);
  const fySuper = sumBy(fySlips, (p) => p.super);
  const fyDed = sumBy(fySlips, (p) => p.deductions || 0);
  const yearMain = fySlips.length ? fyActualNet : fyEst;

  if (!state.shifts.length && !state.payslips.length) {
    els.overview.innerHTML = `
      <div class="empty">
        <p class="eyebrow">Start the record</p>
        <h2>Log a shift or drop in a payslip</h2>
        <p>Track hours as you work, keep the PDF on file, and watch take-home from payslips. Default rate is $41.21. Weekday OT is 1.5Ã— after 8h and 2Ã— after 10h. Saturday and Sunday use their own rates.</p>
        <div class="top-actions" style="justify-content:center">
          <button class="btn" type="button" data-open="payslip">Add payslip</button>
          <button class="btn primary" type="button" data-open="shift">Log hours</button>
        </div>
      </div>
    `;
    return;
  }

  const recentShifts = state.shifts.slice(0, 6);
  const recentSlips = state.payslips.slice(0, 4);

  els.overview.innerHTML = `
    <div class="stats">
      <article class="stat-card">
        <p class="label">${fyLabel(now)} ${fySlips.length ? "actual net" : "est. gross"}</p>
        <p class="stat-value">${AUD_EXACT.format(yearMain)}</p>
        <p class="sub">${fySlips.length ? "payslip take-home Â· source of truth" : "no payslip yet Â· hours estimate"}</p>
      </article>
      <article class="stat-card">
        <p class="label">This week Â· est. gross</p>
        <p class="stat-value">${AUD_EXACT.format(sumBy(week, (s) => s.estGross))}</p>
        <p class="sub">${formatHours(sumBy(week, (s) => s.paidHours))} paid Â· ${week.length} shift${week.length === 1 ? "" : "s"}</p>
      </article>
      <article class="stat-card">
        <p class="label">${fyLabel(now)} est. gross</p>
        <p class="stat-value">${AUD_EXACT.format(fyEst)}</p>
        <p class="sub">${formatHours(sumBy(fy, (s) => s.paidHours))} logged Â· ${fy.length} shift${fy.length === 1 ? "" : "s"}</p>
      </article>
      <article class="stat-card">
        <p class="label">${fyLabel(now)} actual gross</p>
        <p class="stat-value">${AUD_EXACT.format(fyActualGross)}</p>
        <p class="sub">${fySlips.length} slip${fySlips.length === 1 ? "" : "s"} Â· tax ${AUD_EXACT.format(fyTax)} Â· super ${AUD_EXACT.format(fySuper)}${fyDed ? ` Â· other ${AUD_EXACT.format(fyDed)}` : ""}</p>
      </article>
    </div>
    <div class="charts">
      <article class="panel">
        <div class="panel-head">
          <div>
            <h2>Weekly est. gross</h2>
            <p>Last ${weeks.length} weeks from logged hours</p>
          </div>
        </div>
        <div class="week-chart">
          ${weeks
            .map((w) => {
              const h = Math.max(4, (w.gross / maxWeek) * 100);
              return `
                <div class="week-col" title="${w.label}: ${AUD_EXACT.format(w.gross)}">
                  <div class="week-bar ${w.gross ? "" : "zero"}" style="height:${w.gross ? h : 4}%"></div>
                  <span>${w.label}</span>
                </div>
              `;
            })
            .join("")}
        </div>
      </article>
      <article class="panel">
        <div class="panel-head">
          <div>
            <h2>Month by month</h2>
            <p class="legend"><span><i class="swatch amber"></i> est. gross</span><span><i class="swatch mint"></i> actual net</span></p>
          </div>
        </div>
        <div class="month-rows">
          ${months
            .map((m) => {
              const g = (m.gross / maxMonth) * 100;
              const n = (m.slipNet / maxMonth) * 100;
              return `
                <div class="month-row">
                  <span>${m.label}</span>
                  <div>
                    <div class="track" style="margin-bottom:4px"><div class="fill-gross" style="width:${g}%"></div></div>
                    <div class="track"><div class="fill-net" style="width:${n}%"></div></div>
                  </div>
                  <strong>${AUD_EXACT.format(m.income)}</strong>
                </div>
              `;
            })
            .join("")}
        </div>
      </article>
    </div>
    <div class="split">
      <article class="panel">
        <div class="panel-head">
          <div>
            <h2>Recent shifts</h2>
            <p>Tap a row to edit</p>
          </div>
          <button class="btn" type="button" data-view="hours">All hours</button>
        </div>
        <div class="list">
          ${
            recentShifts.length
              ? recentShifts.map(shiftRow).join("")
              : `<p class="muted">No hours logged yet.</p>`
          }
        </div>
      </article>
      <article class="panel">
        <div class="panel-head">
          <div>
            <h2>Recent payslips</h2>
            <p>Open to view the file</p>
          </div>
          <button class="btn" type="button" data-view="payslips">All slips</button>
        </div>
        <div class="list">
          ${
            recentSlips.length
              ? recentSlips.map(slipRow).join("")
              : `<p class="muted">No payslips uploaded yet.</p>`
          }
        </div>
      </article>
    </div>
  `;
}

function shiftRow(s) {
  const job = jobById(s.jobId);
  const day = dayTypeMeta(s.dayType).label;
  const varText =
    s.variance != null
      ? ` Â· var ${s.variance >= 0 ? "+" : "âˆ’"}${AUD_EXACT.format(Math.abs(s.variance))}`
      : "";
  const netText = s.actualNet != null ? `<small>net ${AUD_EXACT.format(s.actualNet)}</small>` : `<small>est. gross</small>`;
  return `
    <button class="row" type="button" data-edit-shift="${s.id}">
      <span class="dot" style="background:${jobColor(s.jobId)}"></span>
      <span>
        <b>${formatDay(s.date)}</b>
        <small>${escapeHtml(job?.name || "Job")} Â· ${escapeHtml(day)} Â· worked ${formatHours(s.afterBreak ?? s.workedHours)} Â· paid ${formatHours(s.paidHours)} Â· ${formatSplit({ ordinary: s.ordinaryHours, timeAndHalf: s.timeAndHalfHours, double: s.doubleHours })}${varText}</small>
      </span>
      <span class="money">${AUD_EXACT.format(s.estGross)}${netText}</span>
    </button>
  `;
}

function slipRow(p) {
  const job = jobById(p.jobId);
  return `
    <button class="row" type="button" data-edit-slip="${p.id}">
      <span class="dot" style="background:${jobColor(p.jobId)}"></span>
      <span>
        <b>Paid ${formatDayShort(p.payDate)}</b>
        <small>${escapeHtml(job?.name || "Job")}${p.fileId ? " Â· file on record" : ""}</small>
      </span>
      <span class="money">${AUD_EXACT.format(p.net || 0)}<small>net</small></span>
    </button>
  `;
}

function renderHours() {
  const rows = filteredShifts();
  const totalH = sumBy(rows, (s) => s.paidHours);
  const totalG = sumBy(rows, (s) => s.gross);
  els.hours.innerHTML = `
    <div class="toolbar">
      <div>
        <h2 style="font-size:22px;margin:0">Hours</h2>
        <p class="muted">${rows.length} shift${rows.length === 1 ? "" : "s"} Â· ${formatHours(totalH)} paid Â· est. ${AUD_EXACT.format(totalG)}</p>
      </div>
      ${filterBar()}
    </div>
    ${
      rows.length
        ? `<div class="list hours-cards">${rows.map(shiftRow).join("")}</div>
           <div class="panel table-wrap hours-table"><table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Day</th>
                <th>Worked</th>
                <th>Paid</th>
                <th>1.0Ã—</th>
                <th>1.5Ã—</th>
                <th>2Ã—</th>
                <th>Est. gross</th>
                <th>Actual net</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${rows
                .map((s) => {
                  return `
                    <tr>
                      <td>${formatDay(s.date)}</td>
                      <td>${escapeHtml(dayTypeMeta(s.dayType).label)}</td>
                      <td>${formatHours(s.afterBreak ?? s.workedHours)}${s.start && s.end ? ` <small class="muted">${s.start}â€“${s.end}</small>` : ""}</td>
                      <td>${formatHours(s.paidHours)}</td>
                      <td>${s.ordinaryHours ? formatHours(s.ordinaryHours) : "â€”"}</td>
                      <td>${s.timeAndHalfHours ? formatHours(s.timeAndHalfHours) : "â€”"}</td>
                      <td>${s.doubleHours ? formatHours(s.doubleHours) : "â€”"}</td>
                      <td>${AUD_EXACT.format(s.estGross)}</td>
                      <td>${s.actualNet != null ? AUD_EXACT.format(s.actualNet) : "â€”"}</td>
                      <td><button class="row-link" type="button" data-edit-shift="${s.id}">Edit</button></td>
                    </tr>
                  `;
                })
                .join("")}
            </tbody>
          </table></div>`
        : `<div class="empty">
            <h2>No shifts in this filter</h2>
            <p>Log the hours from today. Pick weekday, Saturday overtime, Saturday ordinary, or Sunday. Est. gross is an estimate â€” payslips are take-home.</p>
            <button class="btn primary" type="button" data-open="shift">Log hours</button>
          </div>`
    }
  `;
}

function reconcile(slip) {
  if (!slip.periodStart || !slip.periodEnd) return null;
  const rows = state.shifts.filter(
    (s) =>
      s.jobId === slip.jobId &&
      s.date >= slip.periodStart &&
      s.date <= slip.periodEnd,
  );
  const logged = sumBy(rows, (s) => s.estGross);
  const hours = sumBy(rows, (s) => s.paidHours);
  const delta = roundCents((Number(slip.gross || 0) - logged));
  return { logged, hours, delta, days: rows.length };
}

function renderPayslips() {
  const rows = filteredPayslips();
  els.payslips.innerHTML = `
    <div class="toolbar">
      <div>
        <h2 style="font-size:22px;margin:0">Payslips</h2>
        <p class="muted">${rows.length} on file Â· take-home ${AUD_EXACT.format(sumBy(rows, (p) => p.net))}</p>
      </div>
      ${filterBar()}
    </div>
    ${
      rows.length
        ? `<div class="payslip-grid">
            ${rows
              .map((p) => {
                const job = jobById(p.jobId);
                const rec = reconcile(p);
                let recHtml = "";
                if (rec) {
                  if (!rec.days) {
                    recHtml = `<p class="reconcile">No hours logged in ${formatDayShort(p.periodStart)}â€“${formatDayShort(p.periodEnd)}</p>`;
                  } else if (Math.abs(rec.delta) < 0.5) {
                    recHtml = `<p class="reconcile ok">Actual gross matches ${rec.days} shift${rec.days === 1 ? "" : "s"} est. (${formatHours(rec.hours)})</p>`;
                  } else {
                    recHtml = `<p class="reconcile off">Variance actual âˆ’ est. ${rec.delta >= 0 ? "+" : "âˆ’"}${AUD_EXACT.format(Math.abs(rec.delta))} Â· est. ${AUD_EXACT.format(rec.logged)}</p>`;
                  }
                }
                const period = p.periodStart && p.periodEnd ? `${formatDayShort(p.periodStart)} â€“ ${formatDayShort(p.periodEnd)}` : "Period not set";
                return `
                  <button class="panel slip" type="button" data-edit-slip="${p.id}">
                    <p class="eyebrow">${escapeHtml(job?.name || "Job")}</p>
                    <h3>Paid ${formatDay(p.payDate)}</h3>
                    <p class="muted">${period}</p>
                    <p class="stat-value" style="font-size:28px">${AUD_EXACT.format(p.net || 0)}</p>
                    <p class="muted">actual net Â· actual gross ${AUD_EXACT.format(p.gross || 0)}</p>
                    <p class="muted">tax ${AUD_EXACT.format(p.tax || 0)} Â· super ${AUD_EXACT.format(p.super || 0)}${p.deductions ? ` Â· other ${AUD_EXACT.format(p.deductions)}` : ""}</p>
                    <span class="file-chip ${p.fileId ? "" : "missing"}">${p.fileId ? "PDF / file stored" : "No file attached"}</span>
                    ${recHtml}
                  </button>
                `;
              })
              .join("")}
          </div>`
        : `<div class="empty">
            <h2>Keep the PDF here</h2>
            <p>Upload each payslip when it lands. Enter gross, tax, and net so take-home is tracked against the hours you logged.</p>
            <button class="btn primary" type="button" data-open="payslip">Add payslip</button>
          </div>`
    }
  `;
}

function renderJobs() {
  els.jobs.innerHTML = `
    <div class="toolbar">
      <div>
        <h2 style="font-size:22px;margin:0">Jobs</h2>
        <p class="muted">Ordinary rate and default unpaid break. Weekday 8/10 OT, Saturday OT, rostered Saturday, and Sunday are chosen per shift.</p>
      </div>
      <button class="btn primary" type="button" data-open="job">Add job</button>
    </div>
    <div class="job-grid">
      ${state.jobs
        .map((j) => {
          const shifts = state.shifts.filter((s) => s.jobId === j.id);
          return `
            <button class="panel job-card" type="button" data-edit-job="${j.id}">
              <span class="dot" style="background:${j.color}"></span>
              <h3 style="margin:10px 0 4px">${escapeHtml(j.name)}</h3>
              <p class="stat-value" style="font-size:28px">${AUD_EXACT.format(j.rate)} <span style="font-size:14px;color:var(--muted);font-family:'IBM Plex Sans',sans-serif;letter-spacing:0;font-weight:500">/hr</span></p>
              <p class="muted">${j.breakMins} min unpaid break Â· ${shifts.length} shift${shifts.length === 1 ? "" : "s"}</p>
            </button>
          `;
        })
        .join("")}
    </div>
    <div class="jobs-tools">
      <button class="btn" type="button" id="export-json">Export backup</button>
      <button class="btn" type="button" id="export-csv">Export hours CSV</button>
      <label class="btn" style="cursor:pointer">
        Import backup
        <input id="import-json" type="file" accept="application/json" hidden />
      </label>
    </div>
    <p class="note">Backup includes payslip files. Keep a copy somewhere safe â€” clearing this browser will wipe the ledger.</p>
  `;
}

function fillJobSelects(selected) {
  const html = state.jobs
    .map((j) => `<option value="${j.id}" ${j.id === selected ? "selected" : ""}>${escapeHtml(j.name)}</option>`)
    .join("");
  document.querySelector("#shift-job").innerHTML = html;
  document.querySelector("#slip-job").innerHTML = html;
}

function setShiftMode(mode) {
  state.shiftMode = mode;
  document.querySelectorAll("[data-mode]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.mode === mode));
  });
  document.querySelector("#duration-fields").hidden = mode !== "duration";
  document.querySelector("#clock-fields").hidden = mode !== "clock";
  updateShiftPreview();
}

function setDayType(type, { fromDate = false } = {}) {
  const next = DAY_TYPES.some((t) => t.id === type) ? type : "weekday";
  if (fromDate) {
    const sat = (t) => t === "sat-ot" || t === "sat-ordinary";
    if (sat(next) && sat(state.dayType)) return;
  }
  state.dayType = next;
  document.querySelectorAll("[data-day-type]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.dayType === next));
  });
  updateShiftPreview();
}

function currentWorkedHours() {
  if (state.shiftMode === "clock") {
    return hoursFromClock(
      document.querySelector("#shift-start").value,
      document.querySelector("#shift-end").value,
    );
  }
  return hoursFromParts(
    document.querySelector("#shift-h").value,
    document.querySelector("#shift-m").value,
  );
}

function updateShiftPreview() {
  const worked = currentWorkedHours();
  const brk = Number(document.querySelector("#shift-break").value) || 0;
  const rate = Number(document.querySelector("#shift-rate").value) || 0;
  const calc = shiftPay(worked, brk, rate, state.dayType);
  document.querySelector("#shift-worked").textContent = formatHours(calc.afterBreak);
  document.querySelector("#shift-paid").textContent = formatHours(calc.paidHours);
  document.querySelector("#shift-gross").textContent = AUD_EXACT.format(calc.estGross);
  let note = formatSplit(calc);
  if (calc.minApplied) note += ` Â· ${formatHours(calc.paidHours)} minimum applied (worked ${formatHours(calc.afterBreak)})`;
  document.querySelector("#shift-ot-note").textContent = calc.paidHours
    ? note
    : "1.0Ã— / 1.5Ã— / 2Ã— split";
  return { ...calc, rate, brk };
}

function openShift(shift) {
  fillJobSelects(shift?.jobId || state.jobs[0]?.id);
  document.querySelector("#shift-id").value = shift?.id || "";
  const date = shift?.date || todayISO();
  document.querySelector("#shift-date").value = date;
  document.querySelector("#shift-break").value = shift?.breakMins ?? state.jobs[0]?.breakMins ?? 30;
  document.querySelector("#shift-rate").value = shift?.rate ?? state.jobs[0]?.rate ?? 41.21;
  document.querySelector("#shift-notes").value = shift?.notes || "";
  document.querySelector("#shift-start").value = shift?.start || "";
  document.querySelector("#shift-end").value = shift?.end || "";
  fillMoney("#shift-actual-gross", shift?.actualGross);
  fillMoney("#shift-actual-net", shift?.actualNet);
  fillMoney("#shift-actual-tax", shift?.actualTax);
  fillMoney("#shift-actual-super", shift?.actualSuper);
  fillMoney("#shift-actual-deductions", shift?.actualDeductions);
  const parts = splitHours(shift?.workedHours || 0);
  document.querySelector("#shift-h").value = parts.h;
  document.querySelector("#shift-m").value = parts.m;
  document.querySelector("#shift-delete").hidden = !shift;
  document.querySelector("#shift-kicker").textContent = shift ? "Edit shift" : "New shift";
  document.querySelector("#shift-title").textContent = shift ? formatDay(shift.date) : "Log hours";
  const more = document.querySelector("#shift-form details");
  more.open = Boolean(shift && (shift.actualNet != null || shift.actualGross != null));
  setDayType(shift?.dayType || suggestDayType(date));
  setShiftMode(shift?.start && shift?.end ? "clock" : "duration");
  els.shiftDlg.showModal();
  updateShiftPreview();
}

function openPayslip(slip) {
  fillJobSelects(slip?.jobId || state.jobs[0]?.id);
  document.querySelector("#slip-id").value = slip?.id || "";
  document.querySelector("#slip-paydate").value = slip?.payDate || todayISO();
  document.querySelector("#slip-start").value = slip?.periodStart || toISODate(weekStart(new Date()));
  document.querySelector("#slip-end").value = slip?.periodEnd || toISODate(weekEnd(new Date()));
  fillMoney("#slip-gross", slip?.gross);
  fillMoney("#slip-tax", slip?.tax);
  fillMoney("#slip-net", slip?.net);
  fillMoney("#slip-super", slip?.super);
  fillMoney("#slip-deductions", slip?.deductions);
  document.querySelector("#slip-notes").value = slip?.notes || "";
  document.querySelector("#slip-file").value = "";
  state.pendingFile = null;
  state.existingFileName = slip?.fileName || "";
  els.dropLabel.textContent = slip?.fileName
    ? `On file: ${slip.fileName} â€” drop to replace`
    : "Drop a PDF or photo of the payslip";
  document.querySelector("#slip-delete").hidden = !slip;
  document.querySelector("#slip-view").hidden = !slip?.fileId;
  document.querySelector("#slip-kicker").textContent = slip ? "Edit payslip" : "Payslip vault";
  document.querySelector("#slip-title").textContent = slip ? `Paid ${formatDay(slip.payDate)}` : "Add payslip";
  els.slipDlg.showModal();
}

function openJob(job) {
  document.querySelector("#job-id").value = job?.id || "";
  document.querySelector("#job-name").value = job?.name || "";
  document.querySelector("#job-rate").value = job?.rate ?? 41.21;
  document.querySelector("#job-break").value = job?.breakMins ?? 30;
  document.querySelector("#job-color").value = job?.color || "#e2a336";
  document.querySelector("#job-delete").hidden = !job;
  document.querySelector("#job-title").textContent = job ? job.name : "New job";
  els.jobDlg.showModal();
}

async function saveShift(event) {
  event.preventDefault();
  const preview = updateShiftPreview();
  if (preview.paidHours <= 0) {
    toast("Paid hours came out at zero â€” check time on site and the break.");
    return;
  }
  const id = document.querySelector("#shift-id").value || db.uid();
  const existing = state.shifts.find((s) => s.id === id);
  const record = {
    id,
    jobId: document.querySelector("#shift-job").value,
    date: document.querySelector("#shift-date").value,
    mode: state.shiftMode,
    start: state.shiftMode === "clock" ? document.querySelector("#shift-start").value : "",
    end: state.shiftMode === "clock" ? document.querySelector("#shift-end").value : "",
    dayType: preview.dayType,
    breakMins: preview.brk,
    workedHours: preview.worked,
    paidHours: preview.paidHours,
    ordinaryHours: preview.ordinary,
    timeAndHalfHours: preview.timeAndHalf,
    doubleHours: preview.double,
    rate: preview.rate,
    estGross: preview.estGross,
    gross: preview.estGross,
    actualGross: moneyOrNull("#shift-actual-gross"),
    actualNet: moneyOrNull("#shift-actual-net"),
    actualTax: moneyOrNull("#shift-actual-tax"),
    actualSuper: moneyOrNull("#shift-actual-super"),
    actualDeductions: moneyOrNull("#shift-actual-deductions"),
    notes: document.querySelector("#shift-notes").value.trim(),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await db.put("shifts", record);
  els.shiftDlg.close();
  toast(`Saved ${formatHours(record.paidHours)} Â· est. ${AUD_EXACT.format(record.estGross)}`);
  await reload();
}

async function savePayslip(event) {
  event.preventDefault();
  const id = document.querySelector("#slip-id").value || db.uid();
  const existing = state.payslips.find((p) => p.id === id);
  let fileId = existing?.fileId || null;
  let fileName = existing?.fileName || "";
  if (state.pendingFile) {
    if (existing?.fileId) await db.del("files", existing.fileId);
    fileId = await db.saveFile(state.pendingFile);
    fileName = state.pendingFile.name;
  }
  const net = moneyOrNull("#slip-net");
  if (net == null) {
    toast("Actual net / take-home is required on a payslip.");
    document.querySelector("#slip-net").focus();
    return;
  }
  const record = {
    id,
    jobId: document.querySelector("#slip-job").value,
    payDate: document.querySelector("#slip-paydate").value,
    periodStart: document.querySelector("#slip-start").value,
    periodEnd: document.querySelector("#slip-end").value,
    gross: moneyOrNull("#slip-gross") || 0,
    tax: moneyOrNull("#slip-tax") || 0,
    net,
    super: moneyOrNull("#slip-super") || 0,
    deductions: moneyOrNull("#slip-deductions") || 0,
    notes: document.querySelector("#slip-notes").value.trim(),
    fileId,
    fileName,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await db.put("payslips", record);
  els.slipDlg.close();
  toast(fileId ? "Payslip saved with file" : "Payslip saved");
  await reload();
}

async function saveJob(event) {
  event.preventDefault();
  const id = document.querySelector("#job-id").value || db.uid();
  const existing = state.jobs.find((j) => j.id === id);
  const record = {
    id,
    name: document.querySelector("#job-name").value.trim() || "Job",
    rate: Number(document.querySelector("#job-rate").value) || 0,
    breakMins: Number(document.querySelector("#job-break").value) || 0,
    color: document.querySelector("#job-color").value || "#e2a336",
    createdAt: existing?.createdAt || new Date().toISOString(),
  };
  await db.put("jobs", record);
  els.jobDlg.close();
  toast(`Saved ${record.name}`);
  await reload();
}

async function deleteShift() {
  const id = document.querySelector("#shift-id").value;
  if (!id) return;
  if (!(await confirmDelete("Delete this shift?", "The hours and gross come off the ledger. This cannot be undone."))) return;
  await db.del("shifts", id);
  els.shiftDlg.close();
  toast("Shift deleted");
  await reload();
}

async function deletePayslip() {
  const id = document.querySelector("#slip-id").value;
  const existing = state.payslips.find((p) => p.id === id);
  if (!id) return;
  if (!(await confirmDelete("Delete this payslip?", "The stored file is removed from this browser too."))) return;
  if (existing?.fileId) await db.del("files", existing.fileId);
  await db.del("payslips", id);
  els.slipDlg.close();
  toast("Payslip deleted");
  await reload();
}

async function deleteJob() {
  const id = document.querySelector("#job-id").value;
  if (!id) return;
  const used = state.shifts.some((s) => s.jobId === id) || state.payslips.some((p) => p.jobId === id);
  if (used) {
    toast("Move or delete this jobâ€™s shifts and payslips first.");
    return;
  }
  if (state.jobs.length === 1) {
    toast("Keep at least one job.");
    return;
  }
  if (!(await confirmDelete("Delete this job?", "Rates for this employer will be removed."))) return;
  await db.del("jobs", id);
  els.jobDlg.close();
  toast("Job deleted");
  await reload();
}

async function openViewer(slip) {
  if (!slip?.fileId) {
    openPayslip(slip);
    return;
  }
  const file = await db.get("files", slip.fileId);
  if (!file) {
    toast("The file is missing from this browser.");
    openPayslip(slip);
    return;
  }
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file.blob);
  document.querySelector("#viewer-title").textContent = file.name;
  const link = document.querySelector("#viewer-download");
  link.href = objectUrl;
  link.download = file.name;
  const body = document.querySelector("#viewer-body");
  if (file.type.startsWith("image/")) {
    body.innerHTML = `<img class="viewer-img" alt="${escapeHtml(file.name)}" src="${objectUrl}" />`;
  } else {
    body.innerHTML = `<iframe class="viewer-frame" title="${escapeHtml(file.name)}" src="${objectUrl}"></iframe>`;
  }
  els.viewerDlg.showModal();
}

function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportJson() {
  const payload = await db.exportBackup();
  downloadBlob(
    `pay-ledger-${todayISO()}.json`,
    new Blob([JSON.stringify(payload)], { type: "application/json" }),
  );
  toast("Backup downloaded");
}

function exportCsv() {
  const csv = db.shiftsToCsv(state.shifts, state.jobs);
  downloadBlob(`pay-ledger-hours-${todayISO()}.csv`, new Blob([csv], { type: "text/csv" }));
  toast("Hours CSV downloaded");
}

async function importJson(file) {
  const text = await file.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    toast("That JSON could not be read.");
    return;
  }
  if (
    !(await confirmDelete(
      "Replace this ledger?",
      "Import overwrites jobs, hours, payslips, and files in this browser.",
      "Replace",
    ))
  ) {
    return;
  }
  await db.importBackup(payload);
  toast("Backup imported");
  await reload();
}

function closeDialogs(from) {
  if (from?.id === "dlg-viewer" && objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = "";
    document.querySelector("#viewer-body").innerHTML = "";
  }
}

function onJobChange() {
  const job = jobById(document.querySelector("#shift-job").value);
  if (!job) return;
  document.querySelector("#shift-rate").value = job.rate;
  document.querySelector("#shift-break").value = job.breakMins;
  updateShiftPreview();
}

document.addEventListener("click", (event) => {
  const viewBtn = event.target.closest("[data-view]");
  if (viewBtn) {
    setView(viewBtn.dataset.view);
    return;
  }
  if (event.target.closest("[data-open='shift']")) {
    openShift(null);
    return;
  }
  if (event.target.closest("[data-open='payslip']")) {
    openPayslip(null);
    return;
  }
  if (event.target.closest("[data-open='job']")) {
    openJob(null);
    return;
  }
  if (event.target.closest("[data-close]")) {
    event.target.closest("dialog")?.close();
    return;
  }
  const shiftId = event.target.closest("[data-edit-shift]")?.dataset.editShift;
  if (shiftId) {
    openShift(state.shifts.find((s) => s.id === shiftId));
    return;
  }
  const slipId = event.target.closest("[data-edit-slip]")?.dataset.editSlip;
  if (slipId) {
    const slip = state.payslips.find((p) => p.id === slipId);
    if (event.target.closest("#view-overview") && slip?.fileId) openViewer(slip);
    else openPayslip(slip);
    return;
  }
  const jobId = event.target.closest("[data-edit-job]")?.dataset.editJob;
  if (jobId) {
    openJob(state.jobs.find((j) => j.id === jobId));
    return;
  }
  const mode = event.target.closest("[data-mode]")?.dataset.mode;
  if (mode) {
    setShiftMode(mode);
    return;
  }
  const dayType = event.target.closest("[data-day-type]")?.dataset.dayType;
  if (dayType) setDayType(dayType);
});

document.addEventListener("change", (event) => {
  const filter = event.target.dataset.filter;
  if (filter === "job") {
    state.jobFilter = event.target.value;
    render();
  }
  if (filter === "month") {
    state.monthFilter = event.target.value;
    render();
  }
  if (event.target.id === "shift-job") onJobChange();
  if (event.target.id === "shift-date") {
    setDayType(suggestDayType(event.target.value), { fromDate: true });
  }
  if (event.target.id === "slip-file" && event.target.files[0]) {
    state.pendingFile = event.target.files[0];
    els.dropLabel.textContent = state.pendingFile.name;
  }
  if (event.target.id === "import-json" && event.target.files[0]) {
    importJson(event.target.files[0]);
    event.target.value = "";
  }
});

document.addEventListener("input", (event) => {
  if (event.target.closest("#shift-form") && !event.target.id.startsWith("shift-actual")) {
    updateShiftPreview();
  }
});

document.querySelector("#shift-form").addEventListener("submit", (e) => {
  saveShift(e).catch((err) => toast(err.message));
});
document.querySelector("#payslip-form").addEventListener("submit", (e) => {
  savePayslip(e).catch((err) => toast(err.message));
});
document.querySelector("#job-form").addEventListener("submit", (e) => {
  saveJob(e).catch((err) => toast(err.message));
});
document.querySelector("#shift-delete").addEventListener("click", () => {
  deleteShift().catch((err) => toast(err.message));
});
document.querySelector("#slip-delete").addEventListener("click", () => {
  deletePayslip().catch((err) => toast(err.message));
});
document.querySelector("#job-delete").addEventListener("click", () => {
  deleteJob().catch((err) => toast(err.message));
});
document.querySelector("#slip-view").addEventListener("click", () => {
  const id = document.querySelector("#slip-id").value;
  const slip = state.payslips.find((p) => p.id === id);
  if (slip?.fileId) {
    els.slipDlg.close();
    openViewer(slip).catch((err) => toast(err.message));
  }
});

document.addEventListener("click", (event) => {
  if (event.target.id === "export-json") exportJson().catch((err) => toast(err.message));
  if (event.target.id === "export-csv") exportCsv();
});

["dragenter", "dragover"].forEach((name) => {
  els.drop.addEventListener(name, (e) => {
    e.preventDefault();
    els.drop.classList.add("over");
  });
});
["dragleave", "drop"].forEach((name) => {
  els.drop.addEventListener(name, (e) => {
    e.preventDefault();
    els.drop.classList.remove("over");
  });
});
els.drop.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (!file) return;
  state.pendingFile = file;
  els.dropLabel.textContent = file.name;
});

els.viewerDlg.addEventListener("close", () => closeDialogs(els.viewerDlg));

let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.view === "overview") renderOverview();
  }, 150);
});

window.addEventListener("hashchange", () => {
  const view = location.hash.replace("#/", "") || "overview";
  if (["overview", "hours", "payslips", "jobs"].includes(view)) {
    state.view = view;
    render();
  }
});

const initial = location.hash.replace("#/", "");
if (["overview", "hours", "payslips", "jobs"].includes(initial)) state.view = initial;


async function applyChronaSeed() {
  const params = new URLSearchParams(location.search);
  const raw = params.get("chronaAdd");
  if (!raw) return 0;
  let payload;
  try {
    payload = JSON.parse(decodeURIComponent(raw));
  } catch (err) {
    console.error(err);
    toast("Chrona seed link was invalid.");
    return 0;
  }
  const incoming = Array.isArray(payload?.shifts) ? payload.shifts : [];
  if (!incoming.length) return 0;

  const jobs = await db.ensureDefaultJob();
  let job = jobs.find((j) => /bevchain/i.test(j.name)) || jobs[0];
  if (!job) {
    job = {
      id: db.uid(),
      name: "BevChain",
      rate: 41.21,
      breakMins: 30,
      color: "#e2a336",
      createdAt: new Date().toISOString(),
    };
    await db.put("jobs", job);
  } else if (job.name === "Job 1") {
    job = { ...job, name: "BevChain", rate: job.rate || 41.21, breakMins: job.breakMins ?? 30 };
    await db.put("jobs", job);
  }

  const existing = await db.all("shifts");
  let added = 0;
  for (const row of incoming) {
    const date = row.date;
    const workedHours = Number(row.workedHours);
    const breakMins = Number(row.breakMins ?? 30);
    const rate = Number(row.rate ?? job.rate ?? 41.21);
    const dayType = row.dayType || suggestDayType(date);
    if (!date || !Number.isFinite(workedHours)) continue;
    const dup = existing.some(
      (s) => s.date === date && Number(s.workedHours) === workedHours && Number(s.breakMins) === breakMins,
    );
    if (dup) continue;
    const calc = shiftPay(workedHours, breakMins, rate, dayType);
    const record = {
      id: db.uid(),
      jobId: job.id,
      date,
      mode: "duration",
      start: "",
      end: "",
      dayType: calc.dayType,
      breakMins,
      workedHours,
      paidHours: calc.paidHours,
      ordinaryHours: calc.ordinary,
      timeAndHalfHours: calc.timeAndHalf,
      doubleHours: calc.double,
      rate,
      estGross: calc.estGross,
      gross: calc.estGross,
      actualGross: null,
      actualNet: null,
      notes: row.note || row.notes || "Chrona",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await db.put("shifts", record);
    existing.push(record);
    added += 1;
  }

  params.delete("chronaAdd");
  const qs = params.toString();
  const next = `${location.pathname}${qs ? `?${qs}` : ""}${location.hash || "#/hours"}`;
  history.replaceState(null, "", next);
  if (added) toast(`Chrona added ${added} shift${added === 1 ? "" : "s"}`);
  else toast("Those Chrona shifts were already logged");
  return added;
}

reload()
  .then(() => applyChronaSeed())
  .then((added) => (added ? reload() : null))
  .catch((err) => {
  console.error(err);
  toast("Could not open local storage. Try a normal Chrome/Edge window, not file://.");
});
