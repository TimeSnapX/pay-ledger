# Pay Ledger

Local hours + payslip tracker. Log a shift when you finish, drop the PDF when pay lands, and watch gross and take-home over the year.

Live page: https://timesnapx.github.io/pay-ledger/

Data stays in **this browser** (IndexedDB). Nothing is uploaded to GitHub.

## Overtime

Paid hours (time on site minus unpaid break):

| Band | Rate |
| --- | --- |
| First 8 hours | 1× ordinary |
| 8–10 hours | 1.5× |
| After 10 hours | 2× |

Example: 11h 45m on site, 30 min unpaid break → **11h 15m paid** at $41.21 = **$556.34** (8h + 2h @ 1.5× + 1h 15m @ 2×).

## Run locally

```powershell
.\start.ps1
```

Or:

```bash
python -m http.server 4174
```

Then open http://localhost:4174

## What it does

- **Log hours** — time on site (duration or clock-in/out), unpaid break, rate. Overtime bands apply automatically.
- **Payslips** — PDF or photo stored on this device, with gross / tax / net / super. Compares the slip to hours logged in that pay period.
- **Overview** — this week, this month, financial-year totals, and charts.
- **Jobs** — more than one employer, each with its own rate and default break.
- **Backup** — export JSON (includes files) or hours CSV. Import replaces the local ledger.

Default job is **Job 1 at $41.21/hr** with a 30-minute unpaid break. Rename it on the Jobs tab.

## Checks

```bash
node test-money.js
```
