import * as db from "./db.js";
import {
  AUD_EXACT,
  addDays,
  computeGross,
  formatDay,
  formatDayShort,
  formatHours,
  formatMonth,
  formatOtLabel,
  fyEnd,
  fyLabel,
  fyStart,
  groupMonths,
  groupWeeks,
  hoursFromClock,
  hoursFromParts,
  inRange,
  paidHours,
  splitHours,
  splitOt,
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
  state.shifts = shifts
    .map((s) => {
      const ot = splitOt(s.paidHours);
      return {
        ...s,
        ordinaryHours: ot.ordinary,
        timeAndHalfHours: ot.timeAndHalf,
        doubleHours: ot.double,
        gross: computeGross(s.paidHours, s.rate),
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  state.payslips = payslips.sort((a, b) => b.payDate.localeCompare(a.payDate));
  render();
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
  const maxMonth = Math.max(1, ...months.map((m) => Math.max(m.gross, m.slipNet)));

  if (!state.shifts.length && !state.payslips.length) {
    els.overview.innerHTML = `
      <div class="empty">
        <p class="eyebrow">Start the record</p>
        <h2>Log a shift or drop in a payslip</h2>
        <p>Track hours as you work, keep the PDF on file, and watch gross and take-home over the year. Default rate is $41.21. Paid hours over 8 are 1.5×, over 10 are 2×.</p>
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
        <p class="label">This week · ${formatDayShort(toISODate(ws))}–${formatDayShort(toISODate(we))}</p>
        <p class="stat-value">${AUD_EXACT.format(sumBy(week, (s) => s.gross))}</p>
        <p class="sub">${formatHours(sumBy(week, (s) => s.paidHours))} paid · ${week.length} shift${week.length === 1 ? "" : "s"}</p>
      </article>
      <article class="stat-card">
        <p class="label">${formatMonth(now)}</p>
        <p class="stat-value">${AUD_EXACT.format(sumBy(month, (s) => s.gross))}</p>
        <p class="sub">${formatHours(sumBy(month, (s) => s.paidHours))} logged</p>
      </article>
      <article class="stat-card">
        <p class="label">${fyLabel(now)} logged gross</p>
        <p class="stat-value">${AUD_EXACT.format(sumBy(fy, (s) => s.gross))}</p>
        <p class="sub">${formatHours(sumBy(fy, (s) => s.paidHours))} · ${fy.length} shift${fy.length === 1 ? "" : "s"}</p>
      </article>
      <article class="stat-card">
        <p class="label">${fyLabel(now)} payslip take-home</p>
        <p class="stat-value">${AUD_EXACT.format(sumBy(fySlips, (p) => p.net))}</p>
        <p class="sub">${fySlips.length} slip${fySlips.length === 1 ? "" : "s"} · gross ${AUD_EXACT.format(sumBy(fySlips, (p) => p.gross))}</p>
      </article>
    </div>
    <div class="charts">
      <article class="panel">
        <div class="panel-head">
          <div>
            <h2>Weekly gross</h2>
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
            <p class="legend"><span><i class="swatch amber"></i> logged gross</span><span><i class="swatch mint"></i> payslip net</span></p>
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
                  <strong>${AUD_EXACT.format(m.gross)}</strong>
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
  return `
    <button class="row" type="button" data-edit-shift="${s.id}">
      <span class="dot" style="background:${jobColor(s.jobId)}"></span>
      <span>
        <b>${formatDay(s.date)}</b>
        <small>${escapeHtml(job?.name || "Job")} · ${formatHours(s.paidHours)} · ${formatOtLabel(s.paidHours)}</small>
      </span>
      <span class="money">${AUD_EXACT.format(s.gross)}</span>
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
        <small>${escapeHtml(job?.name || "Job")}${p.fileId ? " · file on record" : ""}</small>
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
        <p class="muted">${rows.length} shift${rows.length === 1 ? "" : "s"} · ${formatHours(totalH)} · ${AUD_EXACT.format(totalG)}</p>
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
                <th>Job</th>
                <th>On site</th>
                <th>Break</th>
                <th>Paid</th>
                <th>1.5×</th>
                <th>2×</th>
                <th>Rate</th>
                <th>Gross</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${rows
                .map((s) => {
                  const job = jobById(s.jobId);
                  return `
                    <tr>
                      <td>${formatDay(s.date)}</td>
                      <td>${escapeHtml(job?.name || "")}</td>
                      <td>${formatHours(s.workedHours)}${s.start && s.end ? ` <small class="muted">${s.start}–${s.end}</small>` : ""}</td>
                      <td>${s.breakMins}m</td>
                      <td>${formatHours(s.paidHours)}</td>
                      <td>${s.timeAndHalfHours ? formatHours(s.timeAndHalfHours) : "—"}</td>
                      <td>${s.doubleHours ? formatHours(s.doubleHours) : "—"}</td>
                      <td>${AUD_EXACT.format(s.rate)}</td>
                      <td>${AUD_EXACT.format(s.gross)}</td>
                      <td><button class="row-link" type="button" data-edit-shift="${s.id}">Edit</button></td>
                    </tr>
                  `;
                })
                .join("")}
            </tbody>
          </table></div>`
        : `<div class="empty">
            <h2>No shifts in this filter</h2>
            <p>Log the hours from today — time on site, unpaid break, rate. Overtime is applied for you: 1.5× after 8h, 2× after 10h.</p>
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
  const logged = sumBy(rows, (s) => s.gross);
  const hours = sumBy(rows, (s) => s.paidHours);
  const delta = Math.round((Number(slip.gross || 0) - logged) * 100) / 100;
  return { logged, hours, delta, days: rows.length };
}

function renderPayslips() {
  const rows = filteredPayslips();
  els.payslips.innerHTML = `
    <div class="toolbar">
      <div>
        <h2 style="font-size:22px;margin:0">Payslips</h2>
        <p class="muted">${rows.length} on file · take-home ${AUD_EXACT.format(sumBy(rows, (p) => p.net))}</p>
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
                    recHtml = `<p class="reconcile">No hours logged in ${formatDayShort(p.periodStart)}–${formatDayShort(p.periodEnd)}</p>`;
                  } else if (Math.abs(rec.delta) < 0.5) {
                    recHtml = `<p class="reconcile ok">Matches ${rec.days} logged shift${rec.days === 1 ? "" : "s"} (${formatHours(rec.hours)})</p>`;
                  } else {
                    const dir = rec.delta > 0 ? "more on the slip" : "more in your hours log";
                    recHtml = `<p class="reconcile off">Logged ${AUD_EXACT.format(rec.logged)} vs slip ${AUD_EXACT.format(p.gross || 0)} · ${AUD_EXACT.format(Math.abs(rec.delta))} ${dir}</p>`;
                  }
                }
                return `
                  <button class="panel slip" type="button" data-edit-slip="${p.id}">
                    <p class="eyebrow">${escapeHtml(job?.name || "Job")}</p>
                    <h3>Paid ${formatDay(p.payDate)}</h3>
                    <p class="muted">${p.periodStart && p.periodEnd ? `${formatDayShort(p.periodStart)} – ${formatDayShort(p.periodEnd)}` : "Period not set"}</p>
                    <p class="stat-value" style="font-size:28px">${AUD_EXACT.format(p.net || 0)}</p>
                    <p class="muted">net · gross ${AUD_EXACT.format(p.gross || 0)}</p>
                    <span class="file-chip ${p.fileId ? "" : "missing"}">${p.fileId ? "File stored" : "No file attached"}</span>
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
        <p class="muted">Rates and default unpaid break. Overtime is 1.5× after 8 paid hours and 2× after 10, on every job.</p>
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
              <p class="muted">${j.breakMins} min unpaid break · ${shifts.length} shift${shifts.length === 1 ? "" : "s"}</p>
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
    <p class="note">Backup includes payslip files. Keep a copy somewhere safe — clearing this browser will wipe the ledger.</p>
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
  const paid = paidHours(worked, brk);
  const rate = Number(document.querySelector("#shift-rate").value) || 0;
  const ot = splitOt(paid);
  const gross = computeGross(paid, rate);
  document.querySelector("#shift-paid").textContent = formatHours(paid);
  document.querySelector("#shift-gross").textContent = AUD_EXACT.format(gross);
  document.querySelector("#shift-ot-note").textContent = paid
    ? formatOtLabel(paid)
    : "Ordinary to 8h, then 1.5× to 10h, then 2×.";
  return { worked, paid, gross, rate, brk, ...ot };
}

function openShift(shift) {
  fillJobSelects(shift?.jobId || state.jobs[0]?.id);
  document.querySelector("#shift-id").value = shift?.id || "";
  document.querySelector("#shift-date").value = shift?.date || todayISO();
  document.querySelector("#shift-break").value = shift?.breakMins ?? state.jobs[0]?.breakMins ?? 30;
  document.querySelector("#shift-rate").value = shift?.rate ?? state.jobs[0]?.rate ?? 41.21;
  document.querySelector("#shift-notes").value = shift?.notes || "";
  document.querySelector("#shift-start").value = shift?.start || "";
  document.querySelector("#shift-end").value = shift?.end || "";
  const parts = splitHours(shift?.workedHours || 0);
  document.querySelector("#shift-h").value = parts.h;
  document.querySelector("#shift-m").value = parts.m;
  document.querySelector("#shift-delete").hidden = !shift;
  document.querySelector("#shift-kicker").textContent = shift ? "Edit shift" : "New shift";
  document.querySelector("#shift-title").textContent = shift ? formatDay(shift.date) : "Log hours";
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
  document.querySelector("#slip-gross").value = slip?.gross ?? "";
  document.querySelector("#slip-tax").value = slip?.tax ?? "";
  document.querySelector("#slip-net").value = slip?.net ?? "";
  document.querySelector("#slip-super").value = slip?.super ?? "";
  document.querySelector("#slip-notes").value = slip?.notes || "";
  document.querySelector("#slip-file").value = "";
  state.pendingFile = null;
  state.existingFileName = slip?.fileName || "";
  els.dropLabel.textContent = slip?.fileName
    ? `On file: ${slip.fileName} — drop to replace`
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
  if (preview.paid <= 0) {
    toast("Paid hours came out at zero — check time on site and the break.");
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
    breakMins: preview.brk,
    workedHours: preview.worked,
    paidHours: preview.paid,
    ordinaryHours: preview.ordinary,
    timeAndHalfHours: preview.timeAndHalf,
    doubleHours: preview.double,
    rate: preview.rate,
    gross: preview.gross,
    notes: document.querySelector("#shift-notes").value.trim(),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await db.put("shifts", record);
  els.shiftDlg.close();
  toast(`Saved ${formatHours(record.paidHours)} · ${AUD_EXACT.format(record.gross)}`);
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
  const gross = Number(document.querySelector("#slip-gross").value) || 0;
  const tax = Number(document.querySelector("#slip-tax").value) || 0;
  let net = document.querySelector("#slip-net").value;
  net = net === "" ? Math.round((gross - tax) * 100) / 100 : Number(net) || 0;
  const record = {
    id,
    jobId: document.querySelector("#slip-job").value,
    payDate: document.querySelector("#slip-paydate").value,
    periodStart: document.querySelector("#slip-start").value,
    periodEnd: document.querySelector("#slip-end").value,
    gross,
    tax,
    net,
    super: Number(document.querySelector("#slip-super").value) || 0,
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
    toast("Move or delete this job’s shifts and payslips first.");
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

function autoNet() {
  const gross = Number(document.querySelector("#slip-gross").value);
  const tax = Number(document.querySelector("#slip-tax").value);
  const netEl = document.querySelector("#slip-net");
  if (document.activeElement === netEl) return;
  if (!Number.isNaN(gross) && !Number.isNaN(tax) && (gross || tax)) {
    if (netEl.value === "" || netEl.dataset.auto === "1") {
      netEl.value = (Math.round((gross - tax) * 100) / 100).toFixed(2);
      netEl.dataset.auto = "1";
    }
  }
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
  if (mode) setShiftMode(mode);
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
  if (event.target.closest("#shift-form")) updateShiftPreview();
  if (event.target.id === "slip-gross" || event.target.id === "slip-tax") {
    document.querySelector("#slip-net").dataset.auto = "1";
    autoNet();
  }
  if (event.target.id === "slip-net") {
    event.target.dataset.auto = "0";
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

reload().catch((err) => {
  console.error(err);
  toast("Could not open local storage. Try a normal Chrome/Edge window, not file://.");
});
