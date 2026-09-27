/**
 * Data migrations. Pure functions (no IndexedDB / DOM) so they run in the
 * IndexedDB upgrade transaction, on backup import, and in Node tests.
 *
 * v1 -> v2
 *  - Jobs gain ot1Rate, ot2Rate, ordHours, ot1Hours, mealAllowance.
 *    The BevChain job gets the fixed BevChain rates (7.6h day, $52.75 / $69.23, $21.15 meal).
 *    Any other job keeps its old behaviour (8h, 1.5×, 2×, no meal) so its estimates don't move.
 *  - Shifts snapshot those rules, and gain meal (bool) + mealRate.
 *    meal defaults to ticked when paid hours > ordinary hours and the job pays a meal.
 *  - Nothing is deleted. Payslips are untouched.
 */
import {
  BEVCHAIN_RULES,
  legacyRules,
  mealDefault,
  normalizeRules,
  shiftPay,
  suggestDayType,
} from "./money.js?v=2";

export const SCHEMA_VERSION = 2;

const BEVCHAIN_NAME = /bev\s*chain|eagle\s*farm|randstad/i;

/** The BevChain job: matched by name, or the only job in the ledger. */
export function isBevChainJob(job, jobs = []) {
  if (!job) return false;
  if (BEVCHAIN_NAME.test(job.name || "")) return true;
  const anyNamed = jobs.some((j) => BEVCHAIN_NAME.test(j.name || ""));
  return !anyNamed && jobs.length === 1 && jobs[0].id === job.id;
}

function hasV2Rules(record) {
  return record && record.ot1Rate != null && record.ordHours != null;
}

export function migrateJob(job, jobs) {
  if (hasV2Rules(job)) return { ...job, mealAllowance: Number(job.mealAllowance) || 0 };
  const rate = Number(job.rate) || 0;
  if (isBevChainJob(job, jobs)) {
    return {
      ...job,
      rate: rate || BEVCHAIN_RULES.rate,
      ot1Rate: BEVCHAIN_RULES.ot1Rate,
      ot2Rate: BEVCHAIN_RULES.ot2Rate,
      ordHours: BEVCHAIN_RULES.ordHours,
      ot1Hours: BEVCHAIN_RULES.ot1Hours,
      mealAllowance: BEVCHAIN_RULES.mealAllowance,
    };
  }
  const legacy = legacyRules(rate);
  return { ...job, ...legacy, rate };
}

/** Recompute the derived pay fields stored on a shift record. */
export function withPay(shift) {
  const dayType = shift.dayType || suggestDayType(shift.date);
  const calc = shiftPay(shift.workedHours, shift.breakMins, normalizeRules(shift), dayType);
  return {
    ...shift,
    dayType: calc.dayType,
    paidHours: calc.paidHours,
    ordinaryHours: calc.ordinary,
    timeAndHalfHours: calc.timeAndHalf,
    doubleHours: calc.double,
    estGross: calc.estGross,
    gross: calc.estGross,
  };
}

export function migrateShift(shift, job) {
  if (hasV2Rules(shift) && typeof shift.meal === "boolean") return shift;
  const rules = normalizeRules(job || legacyRules(shift.rate));
  const rate = shift.rate != null && shift.rate !== "" ? Number(shift.rate) : rules.rate;
  const next = {
    ...shift,
    rate,
    ot1Rate: rules.ot1Rate,
    ot2Rate: rules.ot2Rate,
    ordHours: rules.ordHours,
    ot1Hours: rules.ot1Hours,
    v1EstGross: shift.estGross ?? shift.gross ?? null,
  };
  const priced = withPay(next);
  priced.mealRate = rules.mealAllowance;
  priced.meal = mealDefault(priced.paidHours, rules);
  return priced;
}

/**
 * Migrate a whole dataset ({ jobs, shifts, payslips, meta }) to the current schema.
 * Idempotent: running it on v2 data changes nothing.
 */
export function migrateDataset(data) {
  const jobsIn = Array.isArray(data?.jobs) ? data.jobs : [];
  const shiftsIn = Array.isArray(data?.shifts) ? data.shifts : [];
  const payslips = Array.isArray(data?.payslips) ? data.payslips : [];
  const metaIn = Array.isArray(data?.meta) ? data.meta : [];

  const jobs = jobsIn.map((j) => migrateJob(j, jobsIn));
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const shifts = shiftsIn.map((s) => migrateShift(s, byId.get(s.jobId)));

  const meta = metaIn.filter((m) => m.key !== "schemaVersion");
  meta.push({ key: "schemaVersion", value: SCHEMA_VERSION });

  if (shifts.length !== shiftsIn.length || jobs.length !== jobsIn.length) {
    throw new Error("Migration lost records; aborting.");
  }
  return {
    jobs,
    shifts,
    payslips,
    meta,
    report: {
      jobs: jobs.length,
      shifts: shifts.length,
      payslips: payslips.length,
      bevchainJobs: jobs.filter((j, i) => !hasV2Rules(jobsIn[i]) && isBevChainJob(jobsIn[i], jobsIn)).map((j) => j.name),
      mealsTicked: shifts.filter((s) => s.meal).length,
    },
  };
}
