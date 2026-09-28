import * as db from "./db.js?v=4";
import {
  AUD_EXACT,
  BEVCHAIN_RULES,
  DAY_TYPES,
  dayTypeMeta,
  formatClock,
  formatDay,
  formatDayShort,
  formatHM,
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
  mealAmount,
  mealDefault,
  normalizeRules,
  roundCents,
  rulesOf,
  shiftPay,
  formatShiftTimes,
  splitHours,
  suggestDayType,
  sumBy,
  toISODate,
  todayISO,
  weekEnd,
  weekStart,
} from "./money.js?v=4";
import { withPay } from "./migrate.js?v=4";
import { buildSummaryHtml } from "./exporters.js?v=4";
import { downloadFile, pickShareableFiles, shareOrDownload } from "./share.js?v=4";
import { copyText, detectInAppBrowser, inAppLabel, kb, parseBackupText, plural, readClipboard } from "./transfer.js?v=4";
import { GOOGLE_CLIENT_ID } from "./drive-config.js?v=4";
import { DRIVE_FILES, FOLDER_NAME, createDriveSync, describeDriveStatus } from "./drive-sync.js?v=4";

/** Messenger / Facebook / Instagram etc. open links in their own browser with its own storage. */
const IAB = detectInAppBrowser();

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
  mealTouched: false,
  driveFiles: null,
  copyText: "",
  preImport: null,
  drive: null,
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
  driveDlg: document.querySelector("#dlg-drive"),
  copyDlg: document.querySelector("#dlg-copy"),
  pasteDlg: document.querySelector("#dlg-paste"),
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
  const [jobs, shifts, payslips, preImport] = await Promise.all([
    db.ensureDefaultJob(),
    db.all("shifts"),
    db.all("payslips"),
    db.getPreImportCopy().catch(() => null),
  ]);
  state.preImport = preImport ? { savedAt: preImport.savedAt, counts: preImport.counts } : null;
  state.jobs = jobs.sort((a, b) => a.name.localeCompare(b.name));
  state.shifts = shifts.map(enrichShift).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  state.payslips = payslips.sort((a, b) => b.payDate.localeCompare(a.payDate));
  render();
  if (upgradeWasBlocked) {
    upgradeWasBlocked = false;
    toast("Ledger updated · all shifts and payslips kept");
  }
}

function enrichShift(s) {
  const dayType = s.dayType || suggestDayType(s.date);
  const calc = shiftPay(s.workedHours, s.breakMins, rulesOf(s), dayType);
  const actualGross = s.actualGross ?? null;
  return {
    ...s,
    dayType,
    calc,
    meal: Boolean(s.meal),
    mealAmount: mealAmount(s),
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
  const fyMeal = sumBy(fy, (s) => s.mealAmount);
  const weekMeal = sumBy(week, (s) => s.mealAmount);
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
        <p>Track hours as you work, keep the PDF on file, and watch take-home from payslips. Weekday: $41.21 for the first 7.6h, then $52.75 for 2h, then $69.23. Meal allowance is tracked separately, tax-free. Saturday and Sunday use their own rates.</p>
        <div class="top-actions" style="justify-content:center">
          <button class="btn" type="button" data-open="payslip">Add payslip</button>
          <button class="btn primary" type="button" data-open="shift">Log hours</button>
        </div>
        <div class="empty-transfer">
          <p><b>Already using Pay Ledger in Messenger or another browser?</b> Tap <b>Copy backup</b> there, then tap <b>Paste backup</b> here.</p>
          <button class="btn primary" type="button" data-paste-backup>Paste backup</button>
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
        <p class="sub">${fySlips.length ? "payslip take-home · source of truth" : "no payslip yet · hours estimate"}</p>
      </article>
      <article class="stat-card">
        <p class="label">This week · est. gross</p>
        <p class="stat-value">${AUD_EXACT.format(sumBy(week, (s) => s.estGross))}</p>
        <p class="sub">${formatHours(sumBy(week, (s) => s.paidHours))} paid · ${week.length} shift${week.length === 1 ? "" : "s"}</p>
        ${mealLine(weekMeal, week)}
      </article>
      <article class="stat-card">
        <p class="label">${fyLabel(now)} est. gross</p>
        <p class="stat-value">${AUD_EXACT.format(fyEst)}</p>
        <p class="sub">${formatHours(sumBy(fy, (s) => s.paidHours))} logged · ${fy.length} shift${fy.length === 1 ? "" : "s"}</p>
        ${mealLine(fyMeal, fy)}
      </article>
      <article class="stat-card">
        <p class="label">${fyLabel(now)} actual gross</p>
        <p class="stat-value">${AUD_EXACT.format(fyActualGross)}</p>
        <p class="sub">${fySlips.length} slip${fySlips.length === 1 ? "" : "s"} · tax ${AUD_EXACT.format(fyTax)} · super ${AUD_EXACT.format(fySuper)}${fyDed ? ` · other ${AUD_EXACT.format(fyDed)}` : ""}</p>
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
    ${drivePanel()}
  `;
}

function mealLine(amount, rows) {
  const n = rows.filter((s) => s.mealAmount).length;
  if (!n) return "";
  return `<p class="sub meal-sub">+ meal ${AUD_EXACT.format(amount)} tax-free · ${n} × · not in gross</p>`;
}

function drivePanel() {
  return `
    <article class="panel drive-panel">
      <div class="panel-head">
        <div>
          <h2>Private copy</h2>
          <p>Saves a private copy to your Drive. Nothing is uploaded to the website.</p>
          ${
            state.shifts.length
              ? ""
              : `<p class="helper">Moving from Messenger or another browser? Tap <b>Copy backup</b> there, then <b>Paste backup</b> here.</p>`
          }
        </div>
        <button class="btn drive-btn" type="button" data-drive>Save to Google Drive</button>
      </div>
      ${autoSaveBlock()}
      ${transferButtons()}
    </article>
  `;
}

/* ---------- Auto-save to Drive (Google sign-in, drive.file scope) ---------- */

function autoSaveBlock() {
  const s = state.drive || drive.snapshot();
  return `<div class="auto-save" data-drive-auto data-status="${s.status}">${autoSaveInner(s)}</div>`;
}

function autoSaveInner(s) {
  const text = describeDriveStatus(s, { inAppName: inAppLabel(IAB) });
  const connected = s.connected && s.configured && !s.inApp;
  let buttons = "";
  if (s.status === "unconfigured") {
    buttons = `<button class="btn" type="button" disabled>Connect Google Drive</button>`;
  } else if (s.status === "inapp") {
    buttons = "";
  } else if (!connected) {
    buttons = `<button class="btn primary" type="button" data-drive-connect ${s.status === "connecting" ? "disabled" : ""}>Connect Google Drive</button>`;
  } else if (s.status === "reconnect") {
    buttons = `<button class="btn primary" type="button" data-drive-connect>Tap to reconnect</button>
      <button class="btn ghost" type="button" data-drive-disconnect>Disconnect</button>`;
  } else {
    buttons = `<button class="btn" type="button" data-drive-now ${s.status === "saving" || s.status === "connecting" ? "disabled" : ""}>Save now</button>
      <button class="btn ghost" type="button" data-drive-disconnect>Disconnect</button>`;
  }
  const where = connected
    ? `<p class="helper">Folder <b>${escapeHtml(FOLDER_NAME)}</b> in My Drive: ${DRIVE_FILES.map((f) => escapeHtml(f.name)).join(", ")}, plus one dated backup a week.${s.email ? ` Signed in as ${escapeHtml(s.email)}.` : ""}</p>`
    : "";
  return `
    <div class="auto-head">
      <b>Auto-save to Drive</b>
      <span class="auto-dot" aria-hidden="true"></span>
    </div>
    <p class="auto-status" data-drive-status role="status">${escapeHtml(text)}</p>
    ${where}
    ${buttons ? `<div class="auto-actions">${buttons}</div>` : ""}
  `;
}

function renderAutoSave(snap) {
  state.drive = snap;
  for (const el of document.querySelectorAll("[data-drive-auto]")) {
    el.dataset.status = snap.status;
    el.innerHTML = autoSaveInner(snap);
  }
}

/** File contents for Drive, from the same generators as Save to Google Drive / Export. */
async function driveContents() {
  const payload = await db.exportBackup();
  const [rawShifts, jobs, payslips] = await Promise.all([db.all("shifts"), db.all("jobs"), db.all("payslips")]);
  return {
    json: JSON.stringify(payload),
    // No BOM here: other tools read this CSV straight from Drive.
    csv: db.shiftsToCsv(rawShifts, jobs),
    html: buildSummaryHtml({ jobs, shifts: rawShifts, payslips, now: new Date() }),
  };
}

const drive = createDriveSync({
  clientId: GOOGLE_CLIENT_ID,
  inApp: IAB.inApp,
  getMeta: async (key) => (await db.get("meta", key))?.value ?? null,
  setMeta: (key, value) => db.put("meta", { key, value }),
  buildFiles: driveContents,
  onChange: renderAutoSave,
});

function transferButtons() {
  return `
    <div class="transfer-tools">
      <button class="btn" type="button" data-copy-backup>Copy backup</button>
      <button class="btn" type="button" data-paste-backup>Paste backup</button>
    </div>
  `;
}

function shiftRow(s) {
  const job = jobById(s.jobId);
  const day = dayTypeMeta(s.dayType).label;
  const varText =
    s.variance != null
      ? ` · var ${s.variance >= 0 ? "+" : "−"}${AUD_EXACT.format(Math.abs(s.variance))}`
      : "";
  const netText = s.actualNet != null ? `<small>net ${AUD_EXACT.format(s.actualNet)}</small>` : `<small>est. gross</small>`;
  const mealRate = Number(s.mealRate) || 0;
  const mealText = mealRate
    ? `<small class="meal-flag ${s.meal ? "on" : ""}"><i class="tick" aria-hidden="true"></i>Meal ${AUD_EXACT.format(mealRate)} ${s.meal ? "· tax-free" : "not claimed"}</small>`
    : "";
  return `
    <button class="row" type="button" data-edit-shift="${s.id}">
      <span class="dot" style="background:${jobColor(s.jobId)}"></span>
      <span>
        <b>${formatDay(s.date)}</b>
        <small class="shift-times">${escapeHtml(formatShiftTimes(s, s.paidHours))}</small>
        <small>${escapeHtml(job?.name || "Job")} · ${escapeHtml(day)} · ${formatSplit(s.calc)}${varText}</small>
        ${mealText}
      </span>
      <span class="money">${AUD_EXACT.format(s.estGross)}${netText}${s.mealAmount ? `<small class="meal-amt">+ ${AUD_EXACT.format(s.mealAmount)} meal</small>` : ""}</span>
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
  const totalG = sumBy(rows, (s) => s.estGross);
  const totalMeal = sumBy(rows, (s) => s.mealAmount);
  const mealCount = rows.filter((s) => s.mealAmount).length;
  els.hours.innerHTML = `
    <div class="toolbar">
      <div>
        <h2 style="font-size:22px;margin:0">Hours</h2>
        <p class="muted">${rows.length} shift${rows.length === 1 ? "" : "s"} · ${formatHours(totalH)} paid · est. gross ${AUD_EXACT.format(totalG)}</p>
        <p class="muted meal-sub">Meal allowance ${AUD_EXACT.format(totalMeal)} tax-free${mealCount ? ` · ${mealCount} × ` : " "}· not in gross</p>
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
                <th>Clock</th>
                <th>On site</th>
                <th>Paid</th>
                <th>Ordinary</th>
                <th>OT1</th>
                <th>OT2</th>
                <th>Est. gross</th>
                <th>Meal</th>
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
                      <td>${s.start && s.end ? `${formatClock(s.start)}–${formatClock(s.end)}` : "—"}</td>
                      <td>${formatHM(s.workedHours)}</td>
                      <td>${formatHM(s.paidHours)}</td>
                      <td>${s.ordinaryHours ? formatHM(s.ordinaryHours) : "—"}</td>
                      <td>${s.timeAndHalfHours ? formatHM(s.timeAndHalfHours) : "—"}</td>
                      <td>${s.doubleHours ? formatHM(s.doubleHours) : "—"}</td>
                      <td>${AUD_EXACT.format(s.estGross)}</td>
                      <td>${s.mealAmount ? AUD_EXACT.format(s.mealAmount) : "—"}</td>
                      <td>${s.actualNet != null ? AUD_EXACT.format(s.actualNet) : "—"}</td>
                      <td><button class="row-link" type="button" data-edit-shift="${s.id}">Edit</button></td>
                    </tr>
                  `;
                })
                .join("")}
            </tbody>
          </table></div>`
        : `<div class="empty">
            <h2>No shifts in this filter</h2>
            <p>Log the hours from today. Pick weekday, Saturday overtime, Saturday ordinary, or Sunday. Est. gross is an estimate — payslips are take-home.</p>
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
  const meal = sumBy(rows, (s) => s.mealAmount);
  // Gross to gross: payslip gross vs est. gross. Meal allowance is never in either.
  const delta = roundCents((Number(slip.gross || 0) - logged));
  return { logged, hours, delta, meal, meals: rows.filter((s) => s.mealAmount).length, days: rows.length };
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
                    recHtml = `<p class="reconcile ok">Actual gross matches ${rec.days} shift${rec.days === 1 ? "" : "s"} est. (${formatHours(rec.hours)})</p>`;
                  } else {
                    recHtml = `<p class="reconcile off">Gross variance (slip − est.) ${rec.delta >= 0 ? "+" : "−"}${AUD_EXACT.format(Math.abs(rec.delta))} · est. gross ${AUD_EXACT.format(rec.logged)} · ${formatHours(rec.hours)} logged</p>`;
                  }
                  if (rec.days && rec.meals) {
                    recHtml += `<p class="reconcile">Meal logged ${rec.meals} × = ${AUD_EXACT.format(rec.meal)} tax-free (not in gross)</p>`;
                  }
                }
                const period = p.periodStart && p.periodEnd ? `${formatDayShort(p.periodStart)} – ${formatDayShort(p.periodEnd)}` : "Period not set";
                return `
                  <button class="panel slip" type="button" data-edit-slip="${p.id}">
                    <p class="eyebrow">${escapeHtml(job?.name || "Job")}</p>
                    <h3>Paid ${formatDay(p.payDate)}</h3>
                    <p class="muted">${period}</p>
                    <p class="stat-value" style="font-size:28px">${AUD_EXACT.format(p.net || 0)}</p>
                    <p class="muted">actual net · actual gross ${AUD_EXACT.format(p.gross || 0)}</p>
                    <p class="muted">tax ${AUD_EXACT.format(p.tax || 0)} · super ${AUD_EXACT.format(p.super || 0)}${p.deductions ? ` · other ${AUD_EXACT.format(p.deductions)}` : ""}</p>
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
        <p class="muted">Ordinary rate, fixed overtime rates, meal allowance and default unpaid break. Weekday, Saturday OT, rostered Saturday, and Sunday are chosen per shift.</p>
      </div>
      <button class="btn primary" type="button" data-open="job">Add job</button>
    </div>
    <div class="job-grid">
      ${state.jobs
        .map((j) => {
          const shifts = state.shifts.filter((s) => s.jobId === j.id);
          const r = rulesOf(j);
          return `
            <button class="panel job-card" type="button" data-edit-job="${j.id}">
              <span class="dot" style="background:${j.color}"></span>
              <h3 style="margin:10px 0 4px">${escapeHtml(j.name)}</h3>
              <p class="stat-value" style="font-size:28px">${AUD_EXACT.format(j.rate)} <span style="font-size:14px;color:var(--muted);font-family:'IBM Plex Sans',sans-serif;letter-spacing:0;font-weight:500">/hr</span></p>
              <p class="muted">First ${r.ordHours}h ordinary · next ${r.ot1Hours}h @ ${rateText(r.ot1Rate)} · then ${rateText(r.ot2Rate)}</p>
              <p class="muted">Meal ${r.mealAllowance ? `${AUD_EXACT.format(r.mealAllowance)} tax-free` : "none"} · ${j.breakMins} min unpaid break · ${shifts.length} shift${shifts.length === 1 ? "" : "s"}</p>
            </button>
          `;
        })
        .join("")}
    </div>
    <article class="panel drive-panel" style="margin-top:16px">
      <div class="panel-head">
        <div>
          <h2>Save to Google Drive</h2>
          <p>Saves a private copy to your Drive. Nothing is uploaded to the website.</p>
          <p class="helper">Shares 3 files from this phone: the full backup, the hours CSV and a readable summary. Pick <b>Drive</b> in the share sheet.</p>
        </div>
        <button class="btn primary drive-btn" type="button" data-drive>Save to Google Drive</button>
      </div>
      ${autoSaveBlock()}
      <p class="helper">Moving between browsers on this phone (e.g. Messenger → Chrome)? <b>Copy backup</b> in one, <b>Paste backup</b> in the other.</p>
      ${transferButtons()}
    </article>
    <div class="jobs-tools">
      <button class="btn" type="button" id="export-json">Export backup</button>
      <button class="btn" type="button" id="export-csv">Export hours CSV</button>
      <label class="btn" style="cursor:pointer">
        Import backup
        <input id="import-json" type="file" accept="application/json,.json,text/plain,.txt" hidden />
      </label>
    </div>
    ${
      state.preImport
        ? `<p class="note">The ledger from before your last import (${plural(state.preImport.counts?.shifts ?? 0, "shift")}, saved ${escapeHtml(new Date(state.preImport.savedAt).toLocaleString("en-AU"))}) is kept on this phone. <button class="btn" type="button" data-undo-import>Undo last import</button></p>`
        : ""
    }
    <p class="note">Backup includes payslip files. Keep a copy somewhere safe — clearing this browser will wipe the ledger.</p>
  `;
}

function rateText(n) {
  const v = Number(n) || 0;
  return `$${v.toFixed(4).replace(/0{1,2}$/, "")}`;
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

const RULE_FIELDS = [
  ["rate", "#shift-rate"],
  ["ot1Rate", "#shift-ot1-rate"],
  ["ot2Rate", "#shift-ot2-rate"],
  ["ordHours", "#shift-ord-hours"],
  ["ot1Hours", "#shift-ot1-hours"],
  ["mealAllowance", "#shift-meal-rate"],
];

function fillShiftRules(rules) {
  const r = normalizeRules(rules);
  for (const [key, sel] of RULE_FIELDS) document.querySelector(sel).value = roundRule(r[key]);
}

function roundRule(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

function readShiftRules() {
  const out = {};
  for (const [key, sel] of RULE_FIELDS) out[key] = Number(document.querySelector(sel).value) || 0;
  return normalizeRules(out);
}

function updateShiftPreview() {
  const worked = currentWorkedHours();
  const brk = Number(document.querySelector("#shift-break").value) || 0;
  const rules = readShiftRules();
  const calc = shiftPay(worked, brk, rules, state.dayType);
  const mealBox = document.querySelector("#shift-meal");
  if (!state.mealTouched) mealBox.checked = mealDefault(calc.paidHours, rules);
  const mealOn = mealBox.checked && rules.mealAllowance > 0;
  document.querySelector("#shift-meal-label").textContent = `Meal allowance ${AUD_EXACT.format(rules.mealAllowance)}`;
  document.querySelector("#shift-onsite").textContent = formatHM(calc.worked);
  document.querySelector("#shift-paid").textContent = formatHM(calc.paidHours);
  document.querySelector("#shift-gross").textContent = AUD_EXACT.format(calc.estGross);
  document.querySelector("#shift-meal-preview").textContent = mealOn
    ? `+ ${AUD_EXACT.format(rules.mealAllowance)} meal (tax-free, not in gross)`
    : "No meal allowance";
  let note = formatSplit(calc);
  if (calc.minApplied) note += ` · ${formatHours(calc.paidHours)} minimum applied (worked ${formatHours(calc.afterBreak)})`;
  document.querySelector("#shift-ot-note").textContent = calc.paidHours
    ? note
    : "Ordinary / OT1 / OT2 split";
  document.querySelector("#shift-rules-summary").textContent =
    `First ${rules.ordHours}h @ ${rateText(rules.rate)} · next ${rules.ot1Hours}h @ ${rateText(rules.ot1Rate)} · then ${rateText(rules.ot2Rate)}`;
  return { ...calc, rules, rate: rules.rate, brk, meal: mealOn };
}

function openShift(shift) {
  fillJobSelects(shift?.jobId || state.jobs[0]?.id);
  document.querySelector("#shift-id").value = shift?.id || "";
  const date = shift?.date || todayISO();
  document.querySelector("#shift-date").value = date;
  const job = jobById(shift?.jobId) || state.jobs[0];
  document.querySelector("#shift-break").value = shift?.breakMins ?? job?.breakMins ?? 30;
  // Existing shifts keep the rates they were logged with; new shifts take the job's.
  const rules = shift ? { ...rulesOf(shift), mealAllowance: Number(shift.mealRate) || 0 } : rulesOf(job);
  fillShiftRules(rules);
  state.mealTouched = Boolean(shift);
  document.querySelector("#shift-meal").checked = Boolean(shift?.meal);
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
  const r = job ? rulesOf(job) : normalizeRules(BEVCHAIN_RULES);
  document.querySelector("#job-rate").value = roundRule(r.rate);
  document.querySelector("#job-ot1-rate").value = roundRule(r.ot1Rate);
  document.querySelector("#job-ot2-rate").value = roundRule(r.ot2Rate);
  document.querySelector("#job-ord-hours").value = roundRule(r.ordHours);
  document.querySelector("#job-ot1-hours").value = roundRule(r.ot1Hours);
  document.querySelector("#job-meal").value = roundRule(r.mealAllowance);
  document.querySelector("#job-apply").checked = false;
  document.querySelector("#job-apply-wrap").hidden = !job;
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
    dayType: preview.dayType,
    breakMins: preview.brk,
    workedHours: preview.worked,
    paidHours: preview.paidHours,
    ordinaryHours: preview.ordinary,
    timeAndHalfHours: preview.timeAndHalf,
    doubleHours: preview.double,
    rate: preview.rules.rate,
    ot1Rate: preview.rules.ot1Rate,
    ot2Rate: preview.rules.ot2Rate,
    ordHours: preview.rules.ordHours,
    ot1Hours: preview.rules.ot1Hours,
    estGross: preview.estGross,
    gross: preview.estGross,
    meal: preview.meal,
    mealRate: preview.rules.mealAllowance,
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
  toast(`Saved ${formatHours(record.paidHours)} · est. ${AUD_EXACT.format(record.estGross)}${record.meal ? ` + ${AUD_EXACT.format(record.mealRate)} meal` : ""}`);
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
    ot1Rate: Number(document.querySelector("#job-ot1-rate").value) || 0,
    ot2Rate: Number(document.querySelector("#job-ot2-rate").value) || 0,
    ordHours: Number(document.querySelector("#job-ord-hours").value) || 0,
    ot1Hours: Number(document.querySelector("#job-ot1-hours").value) || 0,
    mealAllowance: Number(document.querySelector("#job-meal").value) || 0,
    breakMins: Number(document.querySelector("#job-break").value) || 0,
    color: document.querySelector("#job-color").value || "#e2a336",
    createdAt: existing?.createdAt || new Date().toISOString(),
  };
  await db.put("jobs", record);
  let applied = 0;
  if (existing && document.querySelector("#job-apply").checked) {
    const raw = await db.all("shifts");
    for (const shift of raw.filter((x) => x.jobId === id)) {
      const next = withPay({
        ...shift,
        rate: record.rate,
        ot1Rate: record.ot1Rate,
        ot2Rate: record.ot2Rate,
        ordHours: record.ordHours,
        ot1Hours: record.ot1Hours,
        mealRate: record.mealAllowance,
        updatedAt: new Date().toISOString(),
      });
      await db.put("shifts", next);
      applied += 1;
    }
  }
  els.jobDlg.close();
  toast(applied ? `Saved ${record.name} · rates applied to ${applied} shift${applied === 1 ? "" : "s"}` : `Saved ${record.name}`);
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

/* ---------- Save to Google Drive (Web Share API, no upload to the website) ---------- */

async function buildDriveFiles() {
  const stamp = todayISO();
  const payload = await db.exportBackup();
  const [rawShifts, jobs, payslips] = await Promise.all([db.all("shifts"), db.all("jobs"), db.all("payslips")]);
  const json = new File([JSON.stringify(payload)], `pay-ledger-backup-${stamp}.json`, { type: "application/json" });
  const csv = new File(["\ufeff" + db.shiftsToCsv(rawShifts, jobs)], `pay-ledger-hours-${stamp}.csv`, { type: "text/csv" });
  const html = new File([buildSummaryHtml({ jobs, shifts: rawShifts, payslips, now: new Date() })], `pay-ledger-summary-${stamp}.html`, {
    type: "text/html",
  });
  return [json, csv, html];
}

function driveStatus(html) {
  document.querySelector("#drive-status").innerHTML = html;
}

function driveFileList(files) {
  document.querySelector("#drive-files").innerHTML = files
    .map((f) => `<li><b>${escapeHtml(f.name)}</b> <small class="muted">${Math.max(1, Math.round(f.size / 1024))} KB</small></li>`)
    .join("");
}

const DRIVE_FALLBACK_NOTE =
  "This browser can’t share files, so they were downloaded instead. Open the Google Drive app, make a folder called <b>Pay Ledger</b>, and upload these files into it.";

function driveButtons({ retry = false, copy = false, download = false } = {}) {
  document.querySelector("#drive-retry").hidden = !retry;
  document.querySelector("#drive-copy").hidden = !copy;
  document.querySelector("#drive-download").hidden = !download;
}

const DRIVE_INAPP_NOTE = () =>
  `You’re inside ${escapeHtml(inAppLabel(IAB))}. It can’t send files to Google Drive, and downloads from here are hard to find. ` +
  `Tap <b>Copy backup</b>, open this page in Chrome, tap <b>Paste backup</b>, then tap <b>Save to Google Drive</b> in Chrome.`;

async function saveToDrive() {
  els.driveDlg.showModal();
  driveButtons();
  driveStatus("Preparing your files…");
  driveFileList([]);
  const files = await buildDriveFiles();
  state.driveFiles = files;
  driveFileList(files);
  if (IAB.inApp && !pickShareableFiles(files)) {
    // Don't silently download inside an in-app browser: offer the clipboard instead.
    handleDriveResult({ method: "inapp", files });
    return;
  }
  const result = await shareOrDownload(files, {
    title: "Pay Ledger backup",
    text: "Pay Ledger private copy. Save to Google Drive → Pay Ledger folder.",
  });
  handleDriveResult(result);
}

function handleDriveResult(result) {
  if (result.method === "share") {
    driveFileList(result.files);
    driveStatus("Sent to the share sheet. If you picked Drive, choose the <b>Pay Ledger</b> folder and tap Upload.");
    toast("Shared · pick Drive to save");
  } else if (result.method === "cancelled") {
    driveStatus("Share cancelled. Nothing was saved.");
    driveButtons({ retry: true });
  } else if (result.method === "retry") {
    driveStatus("Files are ready. Tap <b>Share now</b> to open the share sheet.");
    driveButtons({ retry: true });
  } else if (result.method === "inapp") {
    driveStatus(DRIVE_INAPP_NOTE());
    driveButtons({ copy: true, download: true });
  } else {
    driveStatus(
      IAB.inApp
        ? `${DRIVE_FALLBACK_NOTE}<br /><br />${DRIVE_INAPP_NOTE()}`
        : `${DRIVE_FALLBACK_NOTE} Can’t find the downloads? Tap <b>Copy backup</b> and use <b>Paste backup</b> in another browser.`,
    );
    driveButtons({ copy: true });
    toast("Files downloaded");
  }
  els.driveDlg.dataset.result = result.method;
}

async function retryDriveShare() {
  const files = state.driveFiles || (await buildDriveFiles());
  const result = await shareOrDownload(files, { title: "Pay Ledger backup" });
  if (result.method === "retry") {
    for (const f of files) downloadFile(f);
    handleDriveResult({ method: "download", files });
    return;
  }
  handleDriveResult(result);
}

function downloadDriveFiles() {
  const files = state.driveFiles || [];
  for (const f of files) downloadFile(f);
  driveStatus(DRIVE_FALLBACK_NOTE);
  driveButtons({ copy: true });
  els.driveDlg.dataset.result = "download";
}

/* ---------- Copy / Paste backup (move between browsers on one phone) ---------- */

function pageUrl() {
  return `${location.origin}${location.pathname}`;
}

function closeOtherDialogs(keep) {
  for (const dlg of document.querySelectorAll("dialog[open]")) if (dlg !== keep) dlg.close();
}

function copyStatus(html) {
  document.querySelector("#copy-status").innerHTML = html;
}

function showCopyManual(show) {
  const ta = document.querySelector("#copy-text");
  document.querySelector("#copy-manual").hidden = !show;
  document.querySelector("#copy-select").hidden = !show;
  els.copyDlg.classList.toggle("full", show);
  if (show) {
    ta.value = state.copyText;
    selectCopyText();
  } else {
    ta.value = "";
  }
}

function selectCopyText() {
  const ta = document.querySelector("#copy-text");
  ta.focus({ preventScroll: true });
  ta.select();
  ta.setSelectionRange(0, ta.value.length);
}

function copiedMessage(counts, text) {
  return `Copied backup · ${plural(counts.shifts, "shift")}, ${plural(counts.payslips, "payslip")} (${kb(text)}).`;
}

async function copyBackup() {
  closeOtherDialogs(els.copyDlg);
  if (!els.copyDlg.open) els.copyDlg.showModal();
  delete els.copyDlg.dataset.method;
  showCopyManual(false);
  document.querySelector("#copy-next").hidden = true;
  document.querySelector("#copy-again").hidden = true;
  document.querySelector("#copy-share").hidden = true;
  copyStatus("Preparing your backup…");
  // Same payload and JSON as Export backup.
  const payload = await db.exportBackup();
  const text = JSON.stringify(payload);
  state.copyText = text;
  state.copyCounts = { shifts: payload.shifts.length, payslips: payload.payslips.length };
  document.querySelector("#copy-share").hidden = typeof navigator.share !== "function";
  await tryCopy();
}

async function tryCopy() {
  const text = state.copyText;
  const method = await copyText(text);
  els.copyDlg.dataset.method = method || "manual";
  if (method) {
    showCopyManual(false);
    copyStatus(`<b>${copiedMessage(state.copyCounts, text)}</b>`);
    document.querySelector("#copy-next").hidden = false;
    document.querySelector("#copy-again").hidden = false;
    toast(`Copied ${plural(state.copyCounts.shifts, "shift")}`);
  } else {
    copyStatus(`Your backup is ready: ${plural(state.copyCounts.shifts, "shift")}, ${plural(state.copyCounts.payslips, "payslip")} (${kb(text)}).`);
    showCopyManual(true);
    document.querySelector("#copy-next").hidden = false;
    document.querySelector("#copy-again").hidden = false;
  }
}

async function shareBackupText() {
  try {
    await navigator.share({ title: "Pay Ledger backup", text: state.copyText });
  } catch (err) {
    if (err?.name === "AbortError") return;
    toast("Too big to share as text. Use Copy backup instead.");
  }
}

async function copyLink() {
  const method = await copyText(pageUrl());
  toast(method ? "Link copied · paste it into Chrome" : `Couldn’t copy. The link is ${pageUrl()}`);
}

function pasteStatus(html, isError = false) {
  const el = document.querySelector("#paste-status");
  el.innerHTML = html;
  el.classList.toggle("error", isError);
}

function openPaste() {
  closeOtherDialogs(els.pasteDlg);
  document.querySelector("#paste-text").value = "";
  pasteStatus("");
  document.querySelector("#paste-clipboard").hidden = !(navigator.clipboard && typeof navigator.clipboard.readText === "function");
  if (!els.pasteDlg.open) els.pasteDlg.showModal();
}

async function pasteFromClipboard() {
  try {
    const text = await readClipboard();
    if (!text || !text.trim()) {
      pasteStatus("The clipboard is empty. Go back to the other browser and tap <b>Copy backup</b>.", true);
      return;
    }
    document.querySelector("#paste-text").value = text;
    pasteStatus(`Pasted ${kb(text)}. Tap <b>Import backup</b>.`);
  } catch {
    pasteStatus("This browser won’t let the page read the clipboard. Press and hold in the box and tap <b>Paste</b>.", true);
  }
}

async function importPasted() {
  let payload;
  let prepared;
  try {
    payload = parseBackupText(document.querySelector("#paste-text").value);
    prepared = db.prepareImport(payload);
  } catch (err) {
    pasteStatus(escapeHtml(err.message), true);
    return;
  }
  pasteStatus(`Backup OK: ${plural(prepared.counts.shifts, "shift")}, ${plural(prepared.counts.payslips, "payslip")}.`);
  const done = await confirmAndImport(payload, prepared.counts, els.pasteDlg);
  if (done) els.pasteDlg.close();
}

function ledgerHasData(c) {
  return c.shifts > 0 || c.payslips > 0 || c.files > 0 || c.jobs > 1 || (c.jobs === 1 && c.jobNames[0] !== "Job 1");
}

/**
 * Shared by Import backup (file) and Paste backup. Shows counts, keeps a
 * pre-import copy when this browser already has data, then imports in one
 * transaction. Returns true when imported.
 */
async function confirmAndImport(payload, incoming, fromDlg = null) {
  const current = await db.currentCounts();
  const hasData = ledgerHasData(current);
  if (hasData) {
    const fewer = incoming.shifts < current.shifts ? " ⚠ The backup has FEWER shifts than this browser." : "";
    const ok = await confirmDelete(
      "Replace this ledger?",
      `This browser has ${plural(current.shifts, "shift")} and ${plural(current.payslips, "payslip")}. ` +
        `The backup has ${plural(incoming.shifts, "shift")} and ${plural(incoming.payslips, "payslip")}.${fewer} ` +
        "Everything here will be replaced. A copy of this browser’s ledger is kept on this phone so you can undo it.",
      "Replace",
    );
    if (!ok) {
      if (fromDlg) pasteStatus("Import cancelled. Nothing was changed.");
      return false;
    }
  }
  try {
    await db.importBackup(payload, { keepCurrent: hasData });
  } catch (err) {
    console.warn("Import failed, ledger unchanged", err);
    const msg = `Import failed, nothing was changed: ${escapeHtml(err.message)}`;
    if (fromDlg) pasteStatus(msg, true);
    else toast(`Import failed, nothing was changed: ${err.message}`);
    return false;
  }
  const after = await db.currentCounts();
  await reload();
  toast(
    after.shifts === incoming.shifts
      ? `Backup imported · ${plural(after.shifts, "shift")}, ${plural(after.payslips, "payslip")}`
      : `Imported, but found ${after.shifts} of ${incoming.shifts} shifts. Check the Hours tab.`,
  );
  return true;
}

async function undoImport() {
  const copy = await db.getPreImportCopy();
  if (!copy) {
    toast("No earlier ledger saved.");
    return;
  }
  const payload = JSON.parse(copy.backup);
  const counts = db.prepareImport(payload).counts;
  const ok = await confirmDelete(
    "Undo last import?",
    `Puts back the ledger from before the last import (${plural(counts.shifts, "shift")}, ${plural(counts.payslips, "payslip")}). ` +
      "What is here now is kept as the undo copy.",
    "Undo import",
  );
  if (!ok) return;
  await db.importBackup(payload, { keepCurrent: true });
  await reload();
  toast(`Restored ${plural(counts.shifts, "shift")}`);
}

async function exportJson() {
  const payload = await db.exportBackup();
  downloadBlob(
    `pay-ledger-${todayISO()}.json`,
    new Blob([JSON.stringify(payload)], { type: "application/json" }),
  );
  toast("Backup downloaded");
}

async function exportCsv() {
  const csv = "\ufeff" + db.shiftsToCsv(await db.all("shifts"), state.jobs);
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
  let prepared;
  try {
    prepared = db.prepareImport(payload);
  } catch (err) {
    toast(err.message);
    return;
  }
  await confirmAndImport(payload, prepared.counts);
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
  fillShiftRules(rulesOf(job));
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
  if (event.target.id === "shift-meal") state.mealTouched = true;
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
  if (event.target.id === "export-csv") exportCsv().catch((err) => toast(err.message));
  if (event.target.closest("[data-drive]")) saveToDrive().catch((err) => {
    console.error(err);
    driveStatus(`Could not prepare the files: ${escapeHtml(err.message)}`);
  });
  if (event.target.id === "drive-retry") retryDriveShare().catch((err) => toast(err.message));
  if (event.target.id === "drive-download") downloadDriveFiles();
  if (event.target.closest("[data-copy-backup]")) copyBackup().catch((err) => {
    console.error(err);
    copyStatus(`Could not prepare the backup: ${escapeHtml(err.message)}`);
  });
  if (event.target.id === "copy-again") tryCopy().catch((err) => toast(err.message));
  if (event.target.id === "copy-select") selectCopyText();
  if (event.target.id === "copy-share") shareBackupText();
  if (event.target.closest("[data-copy-link]")) copyLink();
  if (event.target.closest("[data-paste-backup]")) openPaste();
  if (event.target.id === "paste-clipboard") pasteFromClipboard();
  if (event.target.id === "paste-import") importPasted().catch((err) => pasteStatus(escapeHtml(err.message), true));
  if (event.target.closest("[data-undo-import]")) undoImport().catch((err) => toast(err.message));
  // Auto-save to Drive: never blocks the UI, problems only show in the status line.
  if (event.target.closest("[data-drive-connect]")) drive.connect().catch((err) => console.warn(err));
  if (event.target.closest("[data-drive-disconnect]")) drive.disconnect().catch((err) => console.warn(err));
  if (event.target.closest("[data-drive-now]")) drive.syncNow().catch((err) => console.warn(err));
});

for (const el of document.querySelectorAll("[data-page-url]")) el.textContent = pageUrl();
if (IAB.inApp) {
  for (const el of document.querySelectorAll("[data-iab-name]")) el.textContent = inAppLabel(IAB);
  document.querySelector("#iab-banner").hidden = false;
  document.documentElement.classList.add("in-app-browser");
}

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

let upgradeWasBlocked = false;
window.addEventListener("pay-ledger:upgrade-blocked", () => {
  upgradeWasBlocked = true;
  els.toast.textContent = "Updating your ledger… close any other Pay Ledger tabs to finish.";
  els.toast.hidden = false;
});

window.addEventListener("pay-ledger:upgraded-elsewhere", () => {
  toast("Pay Ledger was updated in another tab. Reload this page.");
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
      ...BEVCHAIN_RULES,
      breakMins: 30,
      color: "#e2a336",
      createdAt: new Date().toISOString(),
    };
    await db.put("jobs", job);
  } else if (job.name === "Job 1") {
    job = { ...BEVCHAIN_RULES, ...job, name: "BevChain", rate: job.rate || 41.21, breakMins: job.breakMins ?? 30 };
    await db.put("jobs", job);
  }

  const existing = await db.all("shifts");
  let added = 0;
  for (const row of incoming) {
    const date = row.date;
    const workedHours = Number(row.workedHours);
    const breakMins = Number(row.breakMins ?? 30);
    const rules = { ...rulesOf(job), rate: Number(row.rate ?? job.rate ?? 41.21) };
    const dayType = row.dayType || suggestDayType(date);
    if (!date || !Number.isFinite(workedHours)) continue;
    const dup = existing.some(
      (s) => s.date === date && Number(s.workedHours) === workedHours && Number(s.breakMins) === breakMins,
    );
    if (dup) continue;
    const calc = shiftPay(workedHours, breakMins, rules, dayType);
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
      rate: rules.rate,
      ot1Rate: rules.ot1Rate,
      ot2Rate: rules.ot2Rate,
      ordHours: rules.ordHours,
      ot1Hours: rules.ot1Hours,
      estGross: calc.estGross,
      gross: calc.estGross,
      meal: mealDefault(calc.paidHours, rules),
      mealRate: rules.mealAllowance,
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

drive.init().catch((err) => console.warn("Drive auto-save unavailable", err));

reload()
  .then(() => applyChronaSeed())
  .then((added) => (added ? reload() : null))
  .catch((err) => {
  console.error(err);
  toast("Could not open local storage. Try a normal Chrome/Edge window, not file://.");
});

// Installable app (Chrome "Install" -> WebAPK) + offline open. The service
// worker only handles this site's own files; Google sign-in / Drive requests
// are never intercepted. See sw.js.
if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js", { scope: "./" }).catch((err) => console.warn("Service worker not registered", err));
  });
}
