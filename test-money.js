import {
  hoursFromClock,
  hoursFromParts,
  paidHours,
  computeGross,
  splitOt,
  splitHours,
  formatHours,
  formatOtLabel,
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

console.log("ok");
