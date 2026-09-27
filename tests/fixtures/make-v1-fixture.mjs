// Regenerate: mkdir -p /tmp/old && git archive 2cceff3 | tar -x -C /tmp/old && node tests/fixtures/make-v1-fixture.mjs tests/fixtures/v1-backup.json
// Builds a v1 backup exactly as the pre-update app (commit 2cceff3) would store it.
import { shiftPay, hoursFromClock } from "/tmp/old/js/money.js";
import { writeFileSync } from "node:fs";
const jobId = "8f1c2d4e-0b7a-4c1e-9a55-bevchain0001";
const created = (d, t) => new Date(`${d}T${t}+10:00`).toISOString();
const rows = [
  { id: "s-0917", date: "2026-09-17", mode: "duration", start: "", end: "", worked: 11.75, notes: "Chrona: gate-to-gate", c: "2026-09-20T14:44:00" },
  { id: "s-0918", date: "2026-09-18", start: "05:00", end: "14:30", notes: "", c: "2026-09-18T15:02:00" },
  { id: "s-0921", date: "2026-09-21", start: "05:00", end: "13:30", notes: "", c: "2026-09-21T13:50:00" },
  { id: "s-0922", date: "2026-09-22", start: "05:00", end: "18:15", notes: "Long run", c: "2026-09-22T18:40:00" },
  { id: "s-0923", date: "2026-09-23", start: "05:00", end: "17:00", notes: "", c: "2026-09-23T17:20:00" },
  { id: "s-0924", date: "2026-09-24", start: "05:00", end: "14:30", notes: "", c: "2026-09-24T14:45:00" },
  { id: "s-0925", date: "2026-09-25", start: "05:00", end: "16:00", notes: "", c: "2026-09-25T16:15:00" },
];
const shifts = rows.map((r) => {
  const mode = r.mode || "clock";
  const worked = r.worked ?? hoursFromClock(r.start, r.end);
  const calc = shiftPay(worked, 30, 41.21, "weekday");
  const at = new Date(r.c + "+10:00").toISOString();
  return {
    id: r.id, jobId, date: r.date, mode, start: r.start, end: r.end, dayType: "weekday",
    breakMins: 30, workedHours: worked, paidHours: calc.paidHours,
    ordinaryHours: calc.ordinary, timeAndHalfHours: calc.timeAndHalf, doubleHours: calc.double,
    rate: 41.21, estGross: calc.estGross, gross: calc.estGross,
    actualGross: null, actualNet: null, actualTax: null, actualSuper: null, actualDeductions: null,
    notes: r.notes, createdAt: at, updatedAt: at,
  };
});
const pdf = Buffer.from("%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const backup = {
  app: "pay-ledger", version: 1, exportedAt: "2026-09-26T08:00:00.000Z",
  jobs: [{ id: jobId, name: "BevChain", rate: 41.21, breakMins: 30, color: "#e2a336", createdAt: "2026-09-17T12:10:00.000Z" }],
  shifts,
  payslips: [{
    id: "p-0924", jobId, payDate: "2026-09-24", periodStart: "2026-09-14", periodEnd: "2026-09-20",
    gross: 1065.86, tax: 159, net: 949.16, super: 75.16, deductions: 0,
    notes: "Randstad · BevChain Eagle Farm", fileId: "f-0924", fileName: "Randstad payslip 24-09-2026.pdf",
    createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-24T09:00:00.000Z",
  }],
  files: [{ id: "f-0924", name: "Randstad payslip 24-09-2026.pdf", type: "application/pdf", size: pdf.length,
    uploadedAt: "2026-09-24T09:00:00.000Z", dataUrl: "data:application/pdf;base64," + pdf.toString("base64") }],
  meta: [{ key: "defaultJobId", value: jobId }],
};
writeFileSync(process.argv[2], JSON.stringify(backup, null, 2) + "\n");
for (const s of shifts) console.log(s.date, s.workedHours, s.paidHours, s.estGross);
