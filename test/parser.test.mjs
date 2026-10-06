import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pdfToPages } from './extract-pdf.mjs';
import { BANK_ROWS, CARD_ROWS } from './generate-fixtures.mjs';

const require = createRequire(import.meta.url);
const parser = require('../statement-parser.js'); // same UMD file the browser loads
const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = (name) => join(__dirname, 'fixtures', name);

function load(name) { return new Uint8Array(readFileSync(fx(name))); }
const approx = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

// --- Unit tests for token recognition ---------------------------------------
test('isDateToken / isAmountToken classification', () => {
  for (const d of ['01/03/2026', '2026-01-03', '03 Jan 2026', 'Jan 03, 2026', '03-Jan-26'])
    assert.ok(parser.isDateToken(d), `date: ${d}`);
  for (const nd of ['hello', 'ACME', '123'])
    assert.ok(!parser.isDateToken(nd), `not date: ${nd}`);

  for (const a of ['1,234.56', '-1,234.56', '(1,234.56)', '$1,234.56', '12.55', '129.99', '1.234,56'])
    assert.ok(parser.isAmountToken(a), `amount: ${a}`);
  for (const na of ['ACME', '3', 'Jan'])
    assert.ok(!parser.isAmountToken(na), `not amount: ${na}`);
});

test('parseAmount handles US/EU grouping, parentheses, CR/DR', () => {
  assert.ok(approx(parser.parseAmount('1,234.56').value, 1234.56));
  assert.ok(approx(parser.parseAmount('1.234,56').value, 1234.56));
  assert.ok(approx(parser.parseAmount('(300.00)').value, -300));
  assert.ok(approx(parser.parseAmount('300.00-').value, -300));
  assert.ok(approx(parser.parseAmount('84.21 DR').value, -84.21));
  assert.ok(approx(parser.parseAmount('12.55 CR').value, 12.55));
  assert.ok(approx(parser.parseAmount('$0.00').value, 0));
});

test('parseDate -> ISO', () => {
  assert.equal(parser.parseDate('2026-01-03'), '2026-01-03');
  assert.equal(parser.parseDate('01/03/2026', false), '2026-01-03'); // m/d
  assert.equal(parser.parseDate('13/03/2026'), '2026-03-13');        // day>12 => d/m
  assert.equal(parser.parseDate('03 Jan 2026'), '2026-01-03');
  assert.equal(parser.parseDate('Jan 03, 2026'), '2026-01-03');
});

// --- End-to-end: bank statement (debit/credit/balance, multi-page) ----------
test('bank statement: detects debit/credit/balance profile and extracts all rows', async () => {
  const pages = await pdfToPages(load('bank-debit-credit-balance.pdf'));
  assert.ok(pages.length >= 2, 'fixture should span multiple pages');

  const res = parser.parseStatement(pages, { dayFirst: false });
  assert.equal(res.ok, true);
  assert.equal(res.profile, parser.PROFILES.DEBIT_CREDIT_BALANCE);
  assert.equal(res.transactions.length, BANK_ROWS.length, 'row count across pages');

  res.transactions.forEach((tx, i) => {
    const exp = BANK_ROWS[i];
    assert.equal(tx.date, exp.date, `row ${i} date`);
    assert.ok(tx.description.includes(exp.desc.split(' ')[0]), `row ${i} desc "${tx.description}" ~ "${exp.desc}"`);
    assert.equal(tx.description, exp.desc, `row ${i} full description`);
    if (exp.debit != null) assert.ok(approx(tx.debit, exp.debit), `row ${i} debit`);
    if (exp.credit != null) assert.ok(approx(tx.credit, exp.credit), `row ${i} credit`);
    assert.ok(approx(tx.balance, exp.balance), `row ${i} balance ${tx.balance} vs ${exp.balance}`);
  });

  // Sanity: every balance step should match the signed amount.
  assert.equal(res.sanity.hasBalanceColumn, true);
  assert.equal(res.sanity.balanceConsistent, true, res.sanity.note);
  assert.equal(res.sanity.balanceMatches, res.sanity.balanceChecks);
});

// --- End-to-end: credit card (amount + balance, signed) ---------------------
test('credit card statement: detects amount+balance profile, signed amounts', async () => {
  const pages = await pdfToPages(load('card-amount-balance.pdf'));
  const res = parser.parseStatement(pages, { dayFirst: false });

  assert.equal(res.ok, true);
  assert.equal(res.profile, parser.PROFILES.AMOUNT_BALANCE);
  assert.equal(res.transactions.length, CARD_ROWS.length);

  res.transactions.forEach((tx, i) => {
    const exp = CARD_ROWS[i];
    assert.equal(tx.dateISO, exp.date, `row ${i} ISO date`);
    assert.equal(tx.description, exp.desc, `row ${i} description`);
    assert.ok(approx(tx.amount, exp.amount), `row ${i} amount ${tx.amount} vs ${exp.amount}`);
    assert.ok(approx(tx.balance, exp.balance), `row ${i} balance`);
  });

  // The payment row must come through NEGATIVE.
  const payment = res.transactions.find((t) => /PAYMENT/.test(t.description));
  assert.ok(payment && payment.amount < 0, 'payment should be negative');

  // Balance running-total check.
  assert.equal(res.sanity.balanceConsistent, true, res.sanity.note);
});

// --- CSV export shape -------------------------------------------------------
test('toCSV produces a header + one line per transaction, quoting as needed', async () => {
  const pages = await pdfToPages(load('card-amount-balance.pdf'));
  const res = parser.parseStatement(pages, { dayFirst: false });
  const csv = parser.toCSV(res);
  const lines = csv.split('\r\n');
  assert.equal(lines.length, CARD_ROWS.length + 1);
  assert.equal(lines[0], 'Date,Description,Amount,Balance');
  assert.ok(lines[1].startsWith('2026-02-01,'));
});

// --- Manual profile override ------------------------------------------------
test('forceProfile override: card forced to generic drops the balance column', async () => {
  const pages = await pdfToPages(load('card-amount-balance.pdf'));
  const res = parser.parseStatement(pages, { dayFirst: false, forceProfile: parser.PROFILES.GENERIC_SIGNED });
  assert.equal(res.profile, parser.PROFILES.GENERIC_SIGNED);
  assert.ok(!res.columns.some((c) => c.key === 'balance'), 'generic profile should expose no balance column');
  assert.equal(res.transactions.length, CARD_ROWS.length);
  // amount still parsed from the first amount band
  assert.ok(approx(res.transactions[1].amount, CARD_ROWS[1].amount));
});

// --- Scanned / no text layer ------------------------------------------------
test('scanned PDF (no text layer): reports not-ok with a clear OCR message', async () => {
  const pages = await pdfToPages(load('scanned-no-text-layer.pdf'));
  const totalItems = pages.reduce((n, p) => n + p.items.length, 0);
  assert.equal(totalItems, 0, 'scanned fixture must have no text items');

  const res = parser.parseStatement(pages, {});
  assert.equal(res.ok, false);
  assert.match(res.warnings.join(' '), /scanned|image-only|no text/i);
});
