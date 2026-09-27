# Pay Ledger

Local hours + payslip tracker. Log a shift when you finish, drop the PDF when pay lands, and watch gross and take-home over the year.

Live page: https://timesnapx.github.io/pay-ledger/

Data stays in **this browser** (IndexedDB). Nothing is uploaded to GitHub. Payslip files stay on this device.

Hours calc is an **estimate only**. Payslips are the source of truth for take-home. Actual net is never overwritten by the hours calculator.

## Rates

Each job stores its own rules (Jobs → tap the job). BevChain Eagle Farm (Randstad casual):

| Field | BevChain |
| --- | ---: |
| Ordinary rate | $41.21/h (includes casual loading) |
| Ordinary hours per day | 7.6h |
| OT1 rate | $52.75/h |
| OT1 hours | 2h |
| OT2 rate | $69.23/h |
| Meal allowance | $21.15 per shift, tax-free |

OT1/OT2 are **fixed dollar rates**, not 1.5× / 2× of $41.21.
Each shift keeps a copy of the rates it was logged with. Changing a job only affects existing
shifts if you tick "Apply these rates to this job's existing shifts".

Each pay line is rounded to cents per shift, like the payslip: two 11.25h shifts =
2 × ($313.20 + $105.50 + $114.23) = **$1,065.86**.

### Weekday (Mon–Fri)

Paid hours = time on site minus unpaid break.

- First 7.6 paid hours @ ordinary rate
- Next 2 hours @ OT1 rate
- After that @ OT2 rate

### Meal allowance

- Tick box on every shift, on by default when paid hours are over the ordinary day (7.6h)
- Shown as its own tax-free line on the shift card, this week, FY and Hours totals
- **Never** added to estimated gross; payslip variance is gross vs gross

### Saturday / Sunday (unchanged, multipliers of the ordinary rate)

No payslip data yet for weekend rates, so these still use 1.5× / 2× of the ordinary rate.

- **Saturday overtime:** first 2 worked hours @ 1.5×, then 2×. Standalone Saturday minimum 4 paid hours,
  paid as 2h @ 1.5× + 2h @ 2× if worked < 4h
- **Saturday ordinary (rostered):** all hours @ 1.5×, 4-hour minimum
- **Sunday:** all hours @ 2×, minimum 4 paid hours

Weekday OT bands never apply on Saturday or Sunday.

## Save to Google Drive

Jobs (and Overview) → **Save to Google Drive**. Uses the Web Share API: on Android the share
sheet opens and you pick Drive. Nothing is uploaded to the website. Shares:

- `pay-ledger-backup-YYYY-MM-DD.json` — full backup (same as Export backup). Chrome won't share
  `.json`, so on Android it goes as `….json.txt`; Import backup accepts either.
- `pay-ledger-hours-YYYY-MM-DD.csv` — hours with clock in/out, on site, paid, ordinary/OT1/OT2, est. gross, meal
- `pay-ledger-summary-YYYY-MM-DD.html` — readable summary (totals, shifts, payslips)

If the browser can't share files, the three files are downloaded instead; upload them to a
"Pay Ledger" folder in Drive.

## Move between browsers (Messenger → Chrome)

Each browser keeps its own copy of the ledger. Links opened from Facebook Messenger, Facebook,
Instagram, LINE etc. run in that app's in-app browser, which has separate storage, can't share
files and hides downloads. In an in-app browser a banner at the top says so and offers:

- **Copy backup** — puts the full backup (same JSON as Export backup) on the clipboard. If the
  clipboard is blocked, the text is shown full-screen, pre-selected, to copy by hand.
- **Paste backup** — in the other browser: paste (or **Paste from clipboard**) and **Import backup**.
  Same validation/migration as Import backup, one transaction (all-or-nothing). If this browser
  already has data it asks first, showing both shift counts, and keeps the old ledger in
  `meta.preImportBackup` (**Undo last import** on the Jobs tab). That copy is never put into backups.
- **Copy link** — the page URL, to paste into Chrome.

Copy backup / Paste backup are also on Overview and Jobs in every browser. In an in-app browser
**Save to Google Drive** offers Copy backup instead of downloading (downloads stay as a secondary
button).

## Data and upgrades

Storage is IndexedDB `pay-ledger`, schema **v2**. Opening the new version migrates v1 data in the
IndexedDB upgrade transaction (all-or-nothing): the BevChain job gets the rates above, every shift
gets the rules and a meal tick (ticked when paid > 7.6h), payslips and files are untouched. A copy of
the v1 records is kept in `meta.preMigrationV1`. Old v1 backup files are migrated on import.

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
Commit `2cceff3` is the last version before the meal / Drive / BevChain-rates update. Note: rolling the
code back does **not** roll back a phone that already opened v2 — the old code can't open a v2 database.
Export a backup first.

## Checks

```bash
npm test          # encoding guard + pay rules + migration + exports + share logic
# headless Chrome (390x844): serve this folder at /pay-ledger/ and commit 2cceff3 at /old/ on one origin
BASE=http://127.0.0.1:4174 PLAYWRIGHT_DIR=<dir with playwright-core> CHROME=/usr/bin/google-chrome npm run test:e2e
BASE=http://127.0.0.1:4174 PLAYWRIGHT_DIR=<dir with playwright-core> npm run test:transfer   # copy/paste between browsers
```

Files are UTF-8 without BOM (`.editorconfig`, `.gitattributes`). On Windows PowerShell 5, don't
round-trip files through `Get-Content`/`Set-Content`: that is what double-encoded `app.js` before.
