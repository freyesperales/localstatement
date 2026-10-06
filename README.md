# LocalStatement

**PDF bank & credit-card statements → clean CSV/Excel, 100% in your browser. Nothing uploaded, no page limits, no account.**

LocalStatement reads the *text layer* of a digital PDF statement with [pdf.js](https://mozilla.github.io/pdf.js/), figures out the transaction table from the x/y positions of the text, and lets you export tidy CSV or Excel — all on your own machine. The file never leaves the tab. You can pull your network cable after the page loads and it still works.

---

## Demo — before / after

**Before** — a slice of a digital statement (what you see in the PDF):

```
EVERGREEN CARD — MONTHLY STATEMENT
Date        Description              Amount     Balance
2026-02-01  Previous balance           0.00      540.00
2026-02-03  NETFLIX.COM               15.99      555.99
2026-02-07  UBER TRIP HELP.UBER       23.40      579.39
2026-02-11  PAYMENT THANK YOU        -300.00      279.39
2026-02-14  TRADER JOES #221          61.18      340.57
```

**After** — `evergreen-card.csv`, downloaded locally:

```csv
Date,Description,Amount,Balance
2026-02-01,Previous balance,0,540
2026-02-03,NETFLIX.COM,15.99,555.99
2026-02-07,UBER TRIP HELP.UBER,23.4,579.39
2026-02-11,PAYMENT THANK YOU,-300,279.39
2026-02-14,TRADER JOES #221,61.18,340.57
```

LocalStatement auto-detected the *Amount + running balance* layout, parsed the signed payment correctly, and cross-checked every balance step against the amount before letting you export.

---

## Run it

**Open `index.html` in any modern browser.** That's the whole install. (It loads pdf.js and SheetJS from a pinned CDN, so you need internet access once to load the page — after that, parsing is fully local.)

---

## Why it exists

Bookkeepers, freelancers and small businesses constantly need statement data in a spreadsheet. The "PDF statement → CSV" category is big and heavily monetized: the popular converters charge per-page or impose monthly quotas, **and they make you upload a document that exposes your name, your balances and everything you spend money on** to someone else's server.

There is no technical reason for that. A digital statement already contains the text — it just needs to be laid back out into rows and columns. LocalStatement does exactly that, in the browser, for free, with no page limits and no sign-up. Your statement stays on your device.

---

## Features

- **Fully local.** Parsing runs in your browser via pdf.js. No upload, no backend, no account, no telemetry.
- **No page limits.** Multi-page statements are read end to end; page headers/footers are ignored automatically.
- **Layout auto-detection.** Three bundled profiles are scored against your file and the best fit is chosen:
  1. *Generic* — `date · description · signed amount`
  2. *Amount + running balance*
  3. *Debit / Credit / Balance* (common bank-account shape)
- **Header-aware.** If the statement has a header row (Date / Description / Debit / Credit / Balance, incl. common Spanish labels), those labels anchor the columns.
- **Editable preview — your safety net.** Every cell is editable, you can delete junk rows or add a missing one, and amounts re-parse as you type.
- **Built-in sanity check.** When a balance column exists, each step is checked (`balanceₙ − balanceₙ₋₁ ≈ amountₙ`); rows that don't reconcile are highlighted so you catch mis-parses before exporting.
- **Clean CSV + Excel export.** CSV is UTF-8 with a BOM (opens correctly in Excel) and uses dot decimals regardless of your locale; XLSX via SheetJS.
- **Handles the awkward cases.** Scanned/image-only PDFs are detected and reported clearly; US (`1,234.56`) and EU (`1.234,56`) number formats, parentheses/`CR`/`DR`/trailing-minus negatives, and several date formats are supported.
- **Light & dark theme**, keyboard-accessible dropzone, no build step.

---

## How it works

1. **Extract.** pdf.js returns every text fragment on every page together with its position (`transform`), width and height.
2. **Cluster into rows.** Fragments are grouped by their `y` coordinate (tolerance scaled to the median text height) and sorted left-to-right within each row.
3. **Find the columns.** The right edges of all amount-like tokens are clustered into vertical bands → that's how many money columns there are. A date at the left + ≥1 amount marks a transaction row.
4. **Pick a profile.** The number of amount bands (and the header labels, if present) select one of the three layout profiles. You can override it from the UI.
5. **Reconcile.** If there's a balance column, consecutive balances are checked against the amounts and mismatches are flagged.
6. **Export.** The (possibly edited) table is written to CSV or XLSX in-browser and downloaded.

The parsing/clustering logic lives in [`statement-parser.js`](statement-parser.js) as a dependency-free module. The browser loads it with a plain `<script>` tag; the Node test suite `require()`s **the exact same file**, so a green test means the browser parses the same bytes the same way.

---

## Tests

```bash
npm install      # dev deps: pdf-lib (fixtures) + pdfjs-dist (extraction)
npm test         # generates synthetic PDFs, then asserts parsed rows == ground truth
```

The suite builds real text-layer PDF fixtures with `pdf-lib`, extracts them with `pdfjs-dist` (the same pdf.js API the browser uses), and asserts the parsed date/description/amount/balance match known values. See [TESTS.md](TESTS.md) for the full plan, including the manual browser checklist for the UI-only parts.

---

## Limitations (read this)

- **v1 targets digital (text-layer) PDFs, not scans.** If your statement is a scan or a photo (image-only, no selectable text), LocalStatement will tell you it can't read it — **OCR is deliberately out of scope for v1.** Download the original PDF from your bank's website rather than scanning a paper copy.
- **Accuracy varies by layout.** Statement designs are wildly inconsistent. The three profiles cover a lot, but not everything. **The editable preview and the balance sanity-check are the safety net — always reconcile before you trust the output.** This tool does not overclaim 100% accuracy and never will.
- **Ambiguous dates.** `03/04/2026` could be March 4 or April 3. LocalStatement guesses (and locks on once it sees a day > 12), but you can force Month/Day or Day/Month from the UI.
- **Multi-account files** are read as one combined transaction list; LocalStatement does not yet split them into separate accounts.
- **Not financial advice and not a reconciliation system of record.** It's a format converter. Verify against your actual statement.

---

*Development Experiment 062 of dev-experiments-365.*
