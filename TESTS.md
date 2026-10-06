# Tests

LocalStatement is tested at two levels: an **automated** suite that proves the
parsing/clustering core against real PDF bytes, and a **manual** checklist for
the browser-only UI pieces (drag & drop, file download, theming).

## Automated tests

```bash
npm install
npm test
```

What happens:

1. `test/generate-fixtures.mjs` uses **pdf-lib** to render three synthetic
   text-layer PDFs with **known** content into `test/fixtures/`:
   - `bank-debit-credit-balance.pdf` — 7 rows, `Date · Description · Debit · Credit · Balance`, **split across two pages** (header repeated) to exercise multi-page handling.
   - `card-amount-balance.pdf` — 6 rows, `Date · Description · Amount · Balance`, includes a **negative** payment.
   - `scanned-no-text-layer.pdf` — only drawn rectangles, **no text layer** (simulates a scan).
2. `test/extract-pdf.mjs` turns a PDF into the page model via **pdfjs-dist**
   (the same pdf.js `getTextContent` API `index.html` uses in the browser).
3. `test/parser.test.mjs` runs the core (`statement-parser.js`, the very file
   the browser loads) and asserts the parsed rows equal the ground truth.

Coverage:

| Test | Asserts |
|------|---------|
| token classification | dates vs amounts recognized; short ints / words rejected |
| `parseAmount` | US `1,234.56` & EU `1.234,56`, `(x)`/`x-`/`DR`/`CR` negatives |
| `parseDate` | ISO output, m/d vs d/m resolution, textual months |
| bank statement | debit/credit/balance profile auto-detected; **all 7 rows across 2 pages** match; balance reconciles |
| credit card | amount+balance profile; signed amounts; **payment is negative**; balance reconciles |
| `toCSV` | header + one line per row, correct quoting |
| forceProfile | manual override reshapes columns (generic drops balance) |
| scanned PDF | no text items → `ok:false` with a clear "scanned/image-only / OCR out of scope" message |

### Last run (verbatim)

```
ok 1 - isDateToken / isAmountToken classification
ok 2 - parseAmount handles US/EU grouping, parentheses, CR/DR
ok 3 - parseDate -> ISO
ok 4 - bank statement: detects debit/credit/balance profile and extracts all rows
ok 5 - credit card statement: detects amount+balance profile, signed amounts
ok 6 - toCSV produces a header + one line per transaction, quoting as needed
ok 7 - forceProfile override: card forced to generic drops the balance column
ok 8 - scanned PDF (no text layer): reports not-ok with a clear OCR message
# tests 8
# pass 8
# fail 0
```

### Browser parity check (automated, performed during development)

The same two fixtures were loaded through the real `index.html` served over
HTTP and driven with Playwright. The bank fixture produced **7 transactions,
"Debit / Credit / Balance" layout, balance check ✓ consistent, 0 false flags**,
every cell matching ground truth; the exported CSV used locale-independent dot
decimals (`...,NETFLIX.COM,15.99,555.99`); the scanned fixture surfaced the
not-ok OCR message. This confirms the Node test path and the browser path parse
identically.

## Manual test plan (UI-only parts)

Open `index.html` in a browser (or serve the folder and visit it). Use the PDFs
in `test/fixtures/` — or, better, a **real** digital statement from your own bank.

1. **Privacy claim visible.** The green "Runs entirely in your browser…" banner is above the fold.
2. **Drag & drop.** Drag a PDF onto the dropzone → it highlights → results render. Also test the click-to-choose path and keyboard (Tab to the dropzone, press Enter).
3. **Summary cards.** Transaction count, detected layout, sum of amounts, and balance-check pill all populate.
4. **Editable preview.**
   - Click a description cell, edit text, click away → value persists.
   - Edit an amount with a currency symbol (e.g. `$1,200.50`) → re-parses to a number; a negative in parentheses `(50.00)` shows red.
   - Delete a junk row with the `×` button → row count card updates.
   - "+ Add row" appends an editable blank row.
5. **Layout override.** Change the "Layout profile" dropdown → table re-renders with the forced shape; a warning notes the override. Change "Date order" between M/D and D/M → dates reinterpret.
6. **Sanity flagging.** Edit one balance cell to a wrong number → that row (and the next) highlight red and the balance-check pill flips to "n/m match".
7. **CSV export.** Click "Download CSV" → a `.csv` downloads, opens cleanly in Excel/Sheets (UTF-8 BOM, dot decimals).
8. **XLSX export.** Click "Download Excel" → a `.xlsx` downloads and opens with a "Transactions" sheet.
9. **Scanned PDF.** Load `scanned-no-text-layer.pdf` → a clear error explains it's image-only and OCR is out of scope (no crash).
10. **Bad input.** Load a non-PDF → friendly error, no crash.
11. **Offline after load.** Load the page, disconnect from the network, then parse a PDF → still works (only XLSX export needs the SheetJS script, which is already cached).
12. **Theme toggle.** Toggle light/dark; layout stays legible in both.
