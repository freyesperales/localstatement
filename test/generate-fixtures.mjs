// Generates synthetic text-layer PDF statement fixtures with KNOWN data,
// so the extraction core can be asserted against ground truth.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'fixtures');
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// Fixture 1 — Bank statement: Date | Description | Debit | Credit | Balance
// ---------------------------------------------------------------------------
export const BANK_ROWS = [
  { date: '01/03/2026', desc: 'OPENING BALANCE',        debit: null,    credit: null,    balance: 2000.00 },
  { date: '01/05/2026', desc: 'ACME PAYROLL DEPOSIT',   debit: null,    credit: 3200.00, balance: 5200.00 },
  { date: '01/06/2026', desc: 'WHOLE FOODS MARKET',     debit: 84.21,   credit: null,    balance: 5115.79 },
  { date: '01/09/2026', desc: 'SHELL OIL 4455',         debit: 52.40,   credit: null,    balance: 5063.39 },
  { date: '01/12/2026', desc: 'RENT TRANSFER',          debit: 1450.00, credit: null,    balance: 3613.39 },
  { date: '01/15/2026', desc: 'INTEREST PAYMENT',       debit: null,    credit: 12.55,   balance: 3625.94 },
  { date: '01/22/2026', desc: 'AMAZON MKTPLACE PMTS',   debit: 129.99,  credit: null,    balance: 3495.95 }
];

// ---------------------------------------------------------------------------
// Fixture 2 — Credit card: Date | Description | Amount | Balance  (signed)
// ---------------------------------------------------------------------------
export const CARD_ROWS = [
  { date: '2026-02-01', desc: 'Previous balance',       amount: 0.00,    balance: 540.00 },
  { date: '2026-02-03', desc: 'NETFLIX.COM',            amount: 15.99,   balance: 555.99 },
  { date: '2026-02-07', desc: 'UBER TRIP HELP.UBER',    amount: 23.40,   balance: 579.39 },
  { date: '2026-02-11', desc: 'PAYMENT THANK YOU',      amount: -300.00, balance: 279.39 },
  { date: '2026-02-14', desc: 'TRADER JOES #221',       amount: 61.18,   balance: 340.57 },
  { date: '2026-02-20', desc: 'DELTA AIR 0062334455',   amount: 412.30,  balance: 752.87 }
];

const PAGE_W = 612, PAGE_H = 792;

async function buildTable({ title, columns, rows, cellOf, multiPage }) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const size = 10;

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - 60;

  function text(str, x, yy, f = font, rightAlignAt = null) {
    if (str == null || str === '') return;
    let drawX = x;
    if (rightAlignAt != null) {
      const w = f.widthOfTextAtSize(String(str), size);
      drawX = rightAlignAt - w;
    }
    page.drawText(String(str), { x: drawX, y: yy, size, font: f, color: rgb(0.1, 0.1, 0.12) });
  }

  // Title + bank blurb (noise lines that must be ignored).
  page.drawText(title, { x: 50, y: y + 20, size: 16, font: bold });
  page.drawText('Statement period: see transactions below', { x: 50, y: y + 6, size: 8, font });

  // Header row
  columns.forEach(c => text(c.label, c.x, y, bold, c.rightAlignAt));
  y -= 22;

  let rowsOnPage = 0;
  rows.forEach((r, idx) => {
    if (multiPage && rowsOnPage >= Math.ceil(rows.length / 2)) {
      // page break: new page, repeat header
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - 60;
      page.drawText('Account statement (continued)', { x: 50, y: y + 20, size: 12, font: bold });
      columns.forEach(c => text(c.label, c.x, y, bold, c.rightAlignAt));
      y -= 22;
      rowsOnPage = 0;
    }
    const cells = cellOf(r);
    columns.forEach(c => text(cells[c.key], c.x, y, font, c.rightAlignAt));
    y -= 18;
    rowsOnPage++;
  });

  // Footer noise
  page.drawText('Thank you for banking with us. This is page footer text.', { x: 50, y: 40, size: 8, font });

  return doc.save();
}

function fmt(n) { return n == null ? '' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

const bankPdf = await buildTable({
  title: 'NORTHWIND BANK — CHECKING ACCOUNT',
  columns: [
    { key: 'date', label: 'Date', x: 50 },
    { key: 'desc', label: 'Description', x: 115 },
    { key: 'debit', label: 'Debit', x: 0, rightAlignAt: 390 },
    { key: 'credit', label: 'Credit', x: 0, rightAlignAt: 470 },
    { key: 'balance', label: 'Balance', x: 0, rightAlignAt: 555 }
  ],
  rows: BANK_ROWS,
  cellOf: r => ({ date: r.date, desc: r.desc, debit: fmt(r.debit), credit: fmt(r.credit), balance: fmt(r.balance) }),
  multiPage: true
});
writeFileSync(join(OUT, 'bank-debit-credit-balance.pdf'), bankPdf);

const cardPdf = await buildTable({
  title: 'EVERGREEN CARD — MONTHLY STATEMENT',
  columns: [
    { key: 'date', label: 'Date', x: 50 },
    { key: 'desc', label: 'Description', x: 130 },
    { key: 'amount', label: 'Amount', x: 0, rightAlignAt: 440 },
    { key: 'balance', label: 'Balance', x: 0, rightAlignAt: 545 }
  ],
  rows: CARD_ROWS,
  cellOf: r => ({ date: r.date, desc: r.desc, amount: (r.amount < 0 ? '-' : '') + fmt(Math.abs(r.amount)), balance: fmt(r.balance) }),
  multiPage: false
});
writeFileSync(join(OUT, 'card-amount-balance.pdf'), cardPdf);

// ---------------------------------------------------------------------------
// Fixture 3 — Image-only / no text layer (only a drawn rectangle, no drawText).
// Simulates a scanned statement: getTextContent() returns no items.
// ---------------------------------------------------------------------------
const scanDoc = await PDFDocument.create();
const sp = scanDoc.addPage([PAGE_W, PAGE_H]);
sp.drawRectangle({ x: 50, y: 400, width: 500, height: 300, color: rgb(0.85, 0.85, 0.85) });
sp.drawRectangle({ x: 80, y: 430, width: 440, height: 2, color: rgb(0.4, 0.4, 0.4) });
writeFileSync(join(OUT, 'scanned-no-text-layer.pdf'), await scanDoc.save());

console.log('Fixtures written to', OUT);
console.log(' - bank-debit-credit-balance.pdf (' + BANK_ROWS.length + ' rows, multi-page)');
console.log(' - card-amount-balance.pdf (' + CARD_ROWS.length + ' rows)');
console.log(' - scanned-no-text-layer.pdf (no text layer)');
