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

/**
 * BevChain Eagle Farm (Randstad casual) pay rules, from the 14–20 Sep 2026 payslip.
 * OT rates are FIXED dollar rates, not multiples of the ordinary rate: $41.21
 * already includes casual loading, so 1.5× / 2× of it would overpay.
 */
export const BEVCHAIN_RULES = Object.freeze({
  rate: 41.21,
  ot1Rate: 52.75,
  ot2Rate: 69.23,
  ordHours: 7.6,
  ot1Hours: 2,
  mealAllowance: 21.15,
});

/** Pre-v2 behaviour: 8h ordinary, next 2h @ 1.5×, then 2× of the ordinary rate. */
export function legacyRules(rate) {
  const r = Number(rate) || 0;
  return { rate: r, ot1Rate: r * 1.5, ot2Rate: r * 2, ordHours: 8, ot1Hours: 2, mealAllowance: 0 };
}

function num(v, fallback) {
  const n = Number(v);
  return v === "" || v == null || !Number.isFinite(n) ? fallback : n;
}

/**
 * Normalise pay rules. A bare number keeps the old (v1) 8h / 1.5× / 2× behaviour
 * so older callers and saved data compute exactly as before.
 */
export function normalizeRules(input) {
  if (input == null || typeof input !== "object") return legacyRules(input);
  const rate = num(input.rate, 0);
  return {
    rate,
    ot1Rate: num(input.ot1Rate, rate * 1.5),
    ot2Rate: num(input.ot2Rate, rate * 2),
    ordHours: Math.max(0, num(input.ordHours, 8)),
    ot1Hours: Math.max(0, num(input.ot1Hours, 2)),
    mealAllowance: Math.max(0, num(input.mealAllowance, 0)),
  };
}

/** Pull the pay rules stored on a job or a shift record. */
export function rulesOf(record) {
  if (!record) return legacyRules(0);
  if (record.ot1Rate == null && record.ordHours == null) return legacyRules(record.rate);
  return normalizeRules(record);
}

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

/** Weekday bands: ordinary to `ordHours`, OT1 for the next `ot1Hours`, OT2 after that. */
export function splitOt(paid, ordHours = 8, ot1Hours = 2) {
  const p = Math.max(0, Number(paid) || 0);
  return {
    ordinary: roundCents(Math.min(p, ordHours)),
    timeAndHalf: roundCents(Math.min(Math.max(0, p - ordHours), ot1Hours)),
    double: roundCents(Math.max(0, p - ordHours - ot1Hours)),
  };
}

/** One pay line, rounded to cents the way a payslip line is. */
export function lineAmount(hours, rate) {
  return roundCents((Number(hours) || 0) * (Number(rate) || 0));
}

/** Gross from hours per band, each line rounded to cents (as on the payslip). */
export function payFromHours({ ordinary = 0, ot1 = 0, ot2 = 0 }, rules) {
  const r = normalizeRules(rules);
  const lines = [
    { key: "ordinary", hours: ordinary, rate: r.rate, amount: lineAmount(ordinary, r.rate) },
    { key: "ot1", hours: ot1, rate: r.ot1Rate, amount: lineAmount(ot1, r.ot1Rate) },
    { key: "ot2", hours: ot2, rate: r.ot2Rate, amount: lineAmount(ot2, r.ot2Rate) },
  ];
  return { lines, gross: roundCents(lines.reduce((a, l) => a + l.amount, 0)) };
}

/**
 * Estimated pay for one shift.
 * `rules` is either a number (v1: ordinary rate, 8h/10h bands at 1.5×/2×) or an
 * object { rate, ot1Rate, ot2Rate, ordHours, ot1Hours }.
 * Weekday uses the fixed OT1/OT2 dollar rates. Saturday / Sunday keep the
 * original multiplier logic (1.5× / 2× of the ordinary rate) — no better data yet.
 * Meal allowance is NOT part of this: it is tax-free and never in gross.
 */
export function shiftPay(timeOnSite, breakMins, rules, dayType = "weekday") {
  const r = normalizeRules(rules);
  const worked = roundCents(Math.max(0, Number(timeOnSite) || 0));
  const afterBreak = paidHours(worked, breakMins);
  const type = DAY_TYPES.some((t) => t.id === dayType) ? dayType : "weekday";

  let paid = afterBreak;
  let ordinary = 0;
  let timeAndHalf = 0;
  let double = 0;
  let minApplied = false;
  let ot1Rate = r.ot1Rate;
  let ot2Rate = r.ot2Rate;

  if (afterBreak <= 0) {
    paid = 0;
  } else if (type === "weekday") {
    const split = splitOt(afterBreak, r.ordHours, r.ot1Hours);
    ordinary = split.ordinary;
    timeAndHalf = split.timeAndHalf;
    double = split.double;
  } else {
    ot1Rate = r.rate * 1.5;
    ot2Rate = r.rate * 2;
    if (type === "sat-ot") {
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
  }

  const pay = payFromHours(
    { ordinary, ot1: timeAndHalf, ot2: double },
    { rate: r.rate, ot1Rate, ot2Rate },
  );
  return {
    dayType: type,
    worked,
    afterBreak,
    paidHours: paid,
    ordinary,
    timeAndHalf,
    double,
    ordinaryRate: r.rate,
    ot1Rate,
    ot2Rate,
    lines: pay.lines,
    estGross: pay.gross,
    minApplied,
  };
}

export function computeGross(hours, rules, dayType = "weekday") {
  return shiftPay(hours, 0, rules, dayType).estGross;
}

/** Meal allowance defaults on when paid hours are over the ordinary day. */
export function mealDefault(paid, rules) {
  const r = normalizeRules(rules);
  return r.mealAllowance > 0 && (Number(paid) || 0) > r.ordHours + 1e-9;
}

/** Tax-free meal allowance for a stored shift. Never part of gross. */
export function mealAmount(shift) {
  if (!shift || !shift.meal) return 0;
  return roundCents(Number(shift.mealRate) || 0);
}

function money2(n) {
  const v = Number(n) || 0;
  const s = v.toFixed(4).replace(/0{1,2}$/, "");
  return `$${s}`;
}

/**
 * "7h36 @ $41.21 · 2h @ $52.75 · 1h39 @ $69.23" when rates are known,
 * "2h @ 1.5× · 2h @ 2×" for multiplier-based (weekend / v1) splits.
 */
export function formatSplit(parts) {
  const bits = [];
  const useDollars = parts.dayType === "weekday" && parts.ot1Rate != null && parts.ordinaryRate;
  if (useDollars) {
    if (parts.ordinary) bits.push(`${formatHM(parts.ordinary)} @ ${money2(parts.ordinaryRate)}`);
    if (parts.timeAndHalf) bits.push(`${formatHM(parts.timeAndHalf)} @ ${money2(parts.ot1Rate)}`);
    if (parts.double) bits.push(`${formatHM(parts.double)} @ ${money2(parts.ot2Rate)}`);
  } else {
    if (parts.ordinary) bits.push(`${formatHours(parts.ordinary)} @ 1×`);
    if (parts.timeAndHalf) bits.push(`${formatHours(parts.timeAndHalf)} @ 1.5×`);
    if (parts.double) bits.push(`${formatHours(parts.double)} @ 2×`);
  }
  return bits.join(" · ") || "—";
}

export function formatOtLabel(paid, dayType = "weekday") {
  const { ordinary, timeAndHalf, double } = shiftPay(paid, 0, 0, dayType);
  return formatSplit({ ordinary, timeAndHalf, double });
}

/** "05:00" -> "5:00". */
export function formatClock(t) {
  if (!t) return "";
  const [h, m] = String(t).split(":");
  return `${Number(h)}:${m}`;
}

/** Compact hours: 9.5 -> "9h30", 9 -> "9h", 0.5 -> "30m". */
export function formatHM(n) {
  const { h, m } = splitHours(n);
  if (!h && !m) return "0h";
  if (!m) return `${h}h`;
  if (!h) return `${m}m`;
  return `${h}h${String(m).padStart(2, "0")}`;
}

/** "5:00–14:30 · 9h30 on site · 9h paid", or "11h45 on site · 11h15 paid" without clock times. */
export function formatShiftTimes(shift, paid) {
  const onSite = Number(shift.workedHours) || 0;
  const bits = [];
  if (shift.start && shift.end) bits.push(`${formatClock(shift.start)}–${formatClock(shift.end)}`);
  bits.push(`${formatHM(onSite)} on site`);
  bits.push(`${formatHM(paid ?? shift.paidHours)} paid`);
  return bits.join(" · ");
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
