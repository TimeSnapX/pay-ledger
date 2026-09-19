# Pay Ledger

Local hours + payslip tracker. Log a shift when you finish, drop the PDF when pay lands, and watch gross and take-home over the year.

Live page: https://timesnapx.github.io/pay-ledger/

Data stays in **this browser** (IndexedDB). Nothing is uploaded to GitHub. Payslip files stay on this device.

Hours calc is an **estimate only**. Payslips are the source of truth for take-home. Actual net is never overwritten by the hours calculator.

## Rates

Default ordinary rate **$41.21**.

| | 1.0× | 1.5× | 2.0× |
| --- | ---: | ---: | ---: |
| Hourly | $41.21 | $61.815 | $82.42 |

### Weekday (Mon–Fri)

Paid hours = time on site minus unpaid break.

- First 8 paid hours @ 1.0×
- Next 2 hours @ 1.5×
- After 10 hours @ 2×

### Saturday overtime (BevChain / Road Transport)

- First 2 worked hours @ 1.5×
- Every hour after that @ 2×
- Standalone Saturday: **minimum 4 paid hours**
- Minimum is **not** “first 4 hours at 1.5×”
- If worked &lt; 4h, pay 4h as **2h @ 1.5× + 2h @ 2×**

### Saturday ordinary (rostered Saturday)

- All hours @ 1.5×
- 4-hour minimum

### Sunday

- All hours @ 2× ($82.42)
- Minimum 4 paid hours
- No 1.5× band
- 2 hours worked → 4 hours @ 2×
- 8, 10 or 12 hours → every hour is 2×

Do not use weekday 8/10 OT on Saturday or Sunday.

## Run locally

```powershell
.\start.ps1
```

Or:

```bash
python -m http.server 4174
```

Then open http://localhost:4174

## Revert

If this update is wrong, restore the previous live version:

```bash
git checkout master
git reset --hard pre-weekend-rates
git push --force origin master
```

The tag `pre-weekend-rates` is the last commit before Saturday/Sunday rates and the actual-net split.

## Checks

```bash
node test-money.js
```
