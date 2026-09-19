/** Hours, dates, and money helpers. Dates are always local (Australia). */

export const AUD = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
});

export const AUD_EXACT = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  minimumFractionDigits: 2,
});

export function roundCents(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function parseISODate(s) {
  if (!s) return null;
  const [y, m, d] = String(s).split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

export function toISODate(d) {
  const date = d instanceof Date ? d : new Date(d);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayISO() {
  return toISODate(new Date());
}

export function addDays(date, days) {
  const d = date instanceof Date ? new Date(date) : parseISODate(date);
  d.setDate(d.getDate() + days);
  return d;
}

/** Monday of the week containing `date`. */
export function weekStart(date) {
  const d = date instanceof Date ? new Date(date) : parseISODate(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

export function weekEnd(date) {
  return addDays(weekStart(date), 6);
}

export function monthStart(date) {
  const d = date instanceof Date ? new Date(date) : parseISODate(date);
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function monthEnd(date) {
  const d = date instanceof Date ? new Date(date) : parseISODate(date);
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

/** Australian financial year starting 1 July. */
export function fyStart(date = new Date()) {
  const d = date instanceof Date ? date : parseISODate(date);
  const year = d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1;
  return new Date(year, 6, 1);
}

export function fyEnd(date = new Date()) {
  const start = fyStart(date);
  return new Date(start.getFullYear() + 1, 5, 30);
}

export function fyLabel(date = new Date()) {
  const start = fyStart(date);
  const a = String(start.getFullYear()).slice(2);
  const b = String(start.getFullYear() + 1).slice(2);
  return `FY ${a}–${b}`;
}

export function formatDay(iso) {
  const d = parseISODate(iso);
  if (!d) return "";
  return d.toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function formatDayShort(iso) {
  const d = parseISODate(iso);
  if (!d) return "";
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

export function formatMonth(date) {
  const d = date instanceof Date ? date : parseISODate(date);
  return d.toLocaleDateString("en-AU", { month: "long", year: "numeric" });
}

export function hoursFromClock(start, end) {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  let mins = eh * 60 + em - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60;
  return roundCents(mins / 60);
}

export function hoursFromParts(h, m) {
  return roundCents((Number(h) || 0) + (Number(m) || 0) / 60);
}

export function splitHours(total) {
  const safe = Math.max(0, Number(total) || 0);
  const h = Math.floor(safe + 1e-9);
  const m = Math.round((safe - h) * 60);
  if (m === 60) return { h: h + 1, m: 0 };
  return { h, m };
}

export function formatHours(n) {
  const { h, m } = splitHours(n);
  if (!h && !m) return "0h";
  if (!m) return `${h}h`;
  if (!h) return `${m}m`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

export function paidHours(timeOnSite, breakMins) {
  const paid = (Number(timeOnSite) || 0) - (Number(breakMins) || 0) / 60;
  return roundCents(Math.max(0, paid));
}

export const WEEKEND_MIN_HOURS = 4;

export const DAY_TYPES = [
  { id: "weekday", label: "Weekday", hint: "Mon–Fri" },
  { id: "sat-ot", label: "Saturday overtime", hint: "BevChain / Road Transport" },
  { id: "sat-ordinary", label: "Saturday ordinary", hint: "Rostered Saturday" },
  { id: "sunday", label: "Sunday", hint: "All hours 2×" },
];

export function dayTypeMeta(id) {
  return DAY_TYPES.find((t) => t.id === id) || DAY_TYPES[0];
}

export function suggestDayType(iso) {
  const d = parseISODate(iso);
  if (!d) return "weekday";
  const day = d.getDay();
  if (day === 0) return "sunday";
  if (day === 6) return "sat-ot";
  return "weekday";
}

/** Weekday bands: ordinary to 8h, 1.5× from 8–10h, 2× after 10h. */
export function splitOt(paid) {
  const p = Math.max(0, Number(paid) || 0);
  return {
    ordinary: roundCents(Math.min(p, 8)),
    timeAndHalf: roundCents(Math.min(Math.max(0, p - 8), 2)),
    double: roundCents(Math.max(0, p - 10)),
  };
}

export function shiftPay(timeOnSite, breakMins, rate, dayType = "weekday") {
  const r = Number(rate) || 0;
  const worked = roundCents(Math.max(0, Number(timeOnSite) || 0));
  const afterBreak = paidHours(worked, breakMins);
  const type = DAY_TYPES.some((t) => t.id === dayType) ? dayType : "weekday";

  let paid = afterBreak;
  let ordinary = 0;
  let timeAndHalf = 0;
  let double = 0;
  let minApplied = false;

  if (afterBreak <= 0) {
    paid = 0;
  } else if (type === "weekday") {
    const split = splitOt(afterBreak);
    ordinary = split.ordinary;
    timeAndHalf = split.timeAndHalf;
    double = split.double;
  } else if (type === "sat-ot") {
    if (afterBreak < WEEKEND_MIN_HOURS) {
      paid = WEEKEND_MIN_HOURS;
      minApplied = true;
      timeAndHalf = 2;
      double = 2;
    } else {
      timeAndHalf = roundCents(Math.min(2, afterBreak));
      double = roundCents(Math.max(0, afterBreak - 2));
    }
  } else if (type === "sat-ordinary") {
    if (afterBreak < WEEKEND_MIN_HOURS) {
      paid = WEEKEND_MIN_HOURS;
      minApplied = true;
    }
    timeAndHalf = paid;
  } else if (type === "sunday") {
    if (afterBreak < WEEKEND_MIN_HOURS) {
      paid = WEEKEND_MIN_HOURS;
      minApplied = true;
    }
    double = paid;
  }

  const estGross = roundCents(ordinary * r + timeAndHalf * r * 1.5 + double * r * 2);
  return {
    dayType: type,
    worked,
    afterBreak,
    paidHours: paid,
    ordinary,
    timeAndHalf,
    double,
    estGross,
    minApplied,
  };
}

export function computeGross(hours, rate, dayType = "weekday") {
  return shiftPay(hours, 0, rate, dayType).estGross;
}

export function formatSplit(parts) {
  const bits = [];
  if (parts.ordinary) bits.push(`${formatHours(parts.ordinary)} @ 1×`);
  if (parts.timeAndHalf) bits.push(`${formatHours(parts.timeAndHalf)} @ 1.5×`);
  if (parts.double) bits.push(`${formatHours(parts.double)} @ 2×`);
  return bits.join(" · ") || "—";
}

export function formatOtLabel(paid, dayType = "weekday") {
  return formatSplit(shiftPay(paid, 0, 0, dayType));
}

export function inRange(iso, start, end) {
  return iso >= toISODate(start) && iso <= toISODate(end);
}

export function sumBy(rows, fn) {
  return roundCents(rows.reduce((acc, row) => acc + (Number(fn(row)) || 0), 0));
}

export function groupWeeks(shifts, count = 12, endDate = new Date()) {
  const end = weekEnd(endDate);
  const weeks = [];
  for (let i = count - 1; i >= 0; i--) {
    const start = addDays(end, -6 - i * 7);
    const stop = addDays(start, 6);
    const startISO = toISODate(start);
    const stopISO = toISODate(stop);
    const rows = shifts.filter((s) => s.date >= startISO && s.date <= stopISO);
    weeks.push({
      start: startISO,
      end: stopISO,
      label: start.toLocaleDateString("en-AU", { day: "numeric", month: "short" }),
      hours: sumBy(rows, (s) => s.paidHours),
      gross: sumBy(rows, (s) => s.estGross ?? s.gross),
      days: rows.length,
    });
  }
  return weeks;
}

export function groupMonths(shifts, payslips, count = 6, endDate = new Date()) {
  const months = [];
  const cursor = monthStart(endDate);
  for (let i = count - 1; i >= 0; i--) {
    const start = new Date(cursor.getFullYear(), cursor.getMonth() - i, 1);
    const stop = monthEnd(start);
    const startISO = toISODate(start);
    const stopISO = toISODate(stop);
    const shiftRows = shifts.filter((s) => s.date >= startISO && s.date <= stopISO);
    const slipRows = payslips.filter((p) => p.payDate >= startISO && p.payDate <= stopISO);
    const estGross = sumBy(shiftRows, (s) => s.estGross ?? s.gross);
    const slipGross = sumBy(slipRows, (p) => p.gross);
    const slipNet = sumBy(slipRows, (p) => p.net);
    months.push({
      start: startISO,
      end: stopISO,
      label: start.toLocaleDateString("en-AU", { month: "short" }),
      hours: sumBy(shiftRows, (s) => s.paidHours),
      gross: estGross,
      slipGross,
      slipNet,
      income: slipRows.length ? slipNet : estGross,
    });
  }
  return months;
}
