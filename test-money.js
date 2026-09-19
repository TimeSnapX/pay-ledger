import {
  hoursFromClock,
  hoursFromParts,
  paidHours,
  computeGross,
  splitOt,
  splitHours,
  formatHours,
  formatOtLabel,
  formatSplit,
  shiftPay,
  suggestDayType,
  weekStart,
  fyStart,
  toISODate,
} from "./js/money.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(hoursFromParts(11, 45) === 11.75, "11h 45m should be 11.75");
assert(paidHours(11.75, 30) === 11.25, "unpaid 30 min break");
assert(hoursFromClock("05:30", "17:15") === 11.75, "clock span");
assert(hoursFromClock("22:00", "06:00") === 8, "overnight");
assert(formatHours(11.25) === "11h 15m", "format paid hours");
assert(splitHours(11.75).h === 11 && splitHours(11.75).m === 45, "split");

const monday = weekStart(new Date(2026, 8, 17));
assert(toISODate(monday) === "2026-09-14", "week starts Monday");
assert(toISODate(fyStart(new Date(2026, 8, 17))) === "2026-07-01", "FY start 1 July");

assert(suggestDayType("2026-09-17") === "weekday", "Thu is weekday");
assert(suggestDayType("2026-09-19") === "sat-ot", "Sat suggests Saturday OT");
assert(suggestDayType("2026-09-20") === "sunday", "Sun suggests Sunday");

assert(computeGross(8, 41.21) === 329.68, `8h ordinary was ${computeGross(8, 41.21)}`);
assert(computeGross(10, 41.21) === 453.31, `10h was ${computeGross(10, 41.21)}`);
assert(computeGross(11.25, 41.21) === 556.34, `11.25h ot was ${computeGross(11.25, 41.21)}`);

const split = splitOt(11.25);
assert(split.ordinary === 8, "ordinary cap 8");
assert(split.timeAndHalf === 2, "1.5x band is 2h");
assert(split.double === 1.25, "double is the rest");
assert(
  formatOtLabel(11.25) === "8h @ 1× · 2h @ 1.5× · 1h 15m @ 2×",
  formatOtLabel(11.25),
);

const satCases = [
  [2, 4, 288.47],
  [4, 4, 288.47],
  [6, 6, 453.31],
  [8, 8, 618.15],
  [10, 10, 782.99],
  [12, 12, 947.83],
];
for (const [worked, paid, gross] of satCases) {
  const p = shiftPay(worked, 0, 41.21, "sat-ot");
  assert(p.paidHours === paid, `sat OT ${worked}h paid ${p.paidHours} expected ${paid}`);
  assert(p.estGross === gross, `sat OT ${worked}h gross ${p.estGross} expected ${gross}`);
  if (worked < 4) {
    assert(p.timeAndHalf === 2 && p.double === 2, `sat OT min composition for ${worked}h`);
    assert(p.ordinary === 0, "sat OT has no 1.0× band");
  } else {
    assert(p.timeAndHalf === 2, `sat OT ${worked}h first 2 at 1.5×`);
    assert(p.double === worked - 2, `sat OT ${worked}h rest at 2×`);
  }
}

const sunCases = [
  [2, 4, 329.68],
  [4, 4, 329.68],
  [6, 6, 494.52],
  [8, 8, 659.36],
  [10, 10, 824.2],
  [12, 12, 989.04],
];
for (const [worked, paid, gross] of sunCases) {
  const p = shiftPay(worked, 0, 41.21, "sunday");
  assert(p.paidHours === paid, `sun ${worked}h paid ${p.paidHours} expected ${paid}`);
  assert(p.estGross === gross, `sun ${worked}h gross ${p.estGross} expected ${gross}`);
  assert(p.timeAndHalf === 0, `sun ${worked}h must not use 1.5×`);
  assert(p.double === paid, `sun ${worked}h all 2×`);
}

const satOrd = shiftPay(2, 0, 41.21, "sat-ordinary");
assert(satOrd.paidHours === 4, "sat ordinary min 4h");
assert(satOrd.timeAndHalf === 4 && satOrd.double === 0, "sat ordinary all 1.5×");
assert(satOrd.estGross === 247.26, `sat ordinary 2h min gross ${satOrd.estGross}`);

assert(
  formatSplit(shiftPay(2, 0, 41.21, "sat-ot")) === "2h @ 1.5× · 2h @ 2×",
  formatSplit(shiftPay(2, 0, 41.21, "sat-ot")),
);

console.log("ok");
