/*!
 * LocalStatement — statement-parser.js
 * Layout-aware extraction of transaction tables from text-layer PDF statements.
 *
 * This file is framework-agnostic and runs in two places:
 *   - the browser (loaded with a plain <script> tag; attaches window.LocalStatementParser)
 *   - Node.js (required by the test harness; exposed via module.exports)
 *
 * It does NOT depend on pdf.js. The caller extracts text items from pdf.js and
 * hands this module a normalized page model, so the clustering / column-detection
 * logic can be unit-tested in Node without a browser.
 *
 * Input contract — parseStatement(pages, options):
 *   pages: Array<{ width:number, height:number, items: Array<Item> }>
 *   Item:  { str:string, x:number, y:number, width:number, height:number }
 *          x,y are in PDF user space (origin bottom-left, y increases upward),
 *          exactly as derived from a pdf.js text item:
 *            x = transform[4], y = transform[5],
 *            width = item.width, height = item.height || transform[3]
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LocalStatementParser = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ----------------------------------------------------------------------------
  // Token recognition
  // ----------------------------------------------------------------------------

  var MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12
  };

  // Date formats we recognize as a *standalone* token (a single pdf.js item).
  var DATE_PATTERNS = [
    // 2026-01-03  /  2026/01/03
    { re: /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/, order: 'ymd' },
    // 03/01/2026  03-01-26  03.01.2026   (ambiguous d/m vs m/d -> resolved later)
    { re: /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/, order: 'dmy?' },
    // 03 Jan 2026 / 03-Jan-2026 / 3 January 2026
    { re: /^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{2,4})$/, order: 'dMy' },
    // Jan 03, 2026 / January 3 2026
    { re: /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s*(\d{2,4})$/, order: 'Mdy' },
    // 03 Jan (no year — some statements only print day+month)
    { re: /^(\d{1,2})[-\s]([A-Za-z]{3,9})$/, order: 'dM' }
  ];

  // An amount: optional leading sign/paren, optional currency symbol, grouped
  // digits, decimal part, optional trailing CR/DR/-, optional closing paren.
  // Examples: 1,234.56  -1,234.56  (1,234.56)  $1,234.56  1.234,56  123.45-  1,234.56 CR
  var AMOUNT_RE = /^[-+(]?\s*[$£€¥]?\s*\(?\s*[-+]?\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{1,2})?\s*\)?\s*(?:CR|DR|-|\+)?$/i;
  // Must contain at least one digit and look money-ish (has a separator or >=2 digits).
  var HAS_DIGIT_RE = /\d/;

  function isDateToken(s) {
    s = s.trim();
    for (var i = 0; i < DATE_PATTERNS.length; i++) {
      if (DATE_PATTERNS[i].re.test(s)) return true;
    }
    return false;
  }

  function isAmountToken(s) {
    s = s.trim();
    if (!HAS_DIGIT_RE.test(s)) return false;
    if (!AMOUNT_RE.test(s)) return false;
    // Reject bare short integers like "3" or "12" (likely not money / could be a day).
    var digits = s.replace(/[^\d]/g, '');
    var hasSep = /[.,]/.test(s);
    if (!hasSep && digits.length < 3) return false;
    return true;
  }

  // Parse a recognized date token to ISO (YYYY-MM-DD). dayFirst hints ambiguous d/m.
  function parseDate(s, dayFirst) {
    s = s.trim();
    for (var i = 0; i < DATE_PATTERNS.length; i++) {
      var p = DATE_PATTERNS[i];
      var m = p.re.exec(s);
      if (!m) continue;
      var y, mo, d;
      if (p.order === 'ymd') {
        y = +m[1]; mo = +m[2]; d = +m[3];
      } else if (p.order === 'dmy?') {
        var a = +m[1], b = +m[2];
        y = normYear(+m[3]);
        if (dayFirst === false) { mo = a; d = b; }       // m/d
        else if (dayFirst === true) { d = a; mo = b; }    // d/m
        else {
          // auto: if one value > 12 it must be the day
          if (a > 12) { d = a; mo = b; }
          else if (b > 12) { mo = a; d = b; }
          else { d = a; mo = b; }                         // default d/m
        }
      } else if (p.order === 'dMy') {
        d = +m[1]; mo = MONTHS[m[2].toLowerCase().slice(0, m[2].length === 4 && m[2].toLowerCase() === 'sept' ? 4 : 3)] || MONTHS[m[2].toLowerCase()]; y = normYear(+m[3]);
      } else if (p.order === 'Mdy') {
        mo = MONTHS[m[1].toLowerCase().slice(0, 3)] || MONTHS[m[1].toLowerCase()]; d = +m[2]; y = normYear(+m[3]);
      } else if (p.order === 'dM') {
        d = +m[1]; mo = MONTHS[m[2].toLowerCase().slice(0, 3)] || MONTHS[m[2].toLowerCase()]; y = null;
      }
      if (!mo) return null;
      if (y == null) return pad(mo) + '-' + pad(d); // year unknown -> MM-DD
      return y + '-' + pad(mo) + '-' + pad(d);
    }
    return null;
  }

  function normYear(y) { return y < 100 ? (y >= 70 ? 1900 + y : 2000 + y) : y; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // Parse an amount token to a Number. Returns { value, negative } or null.
  // Handles US (1,234.56) and EU (1.234,56) grouping, parentheses & CR/DR signs.
  function parseAmount(s) {
    if (s == null) return null;
    var raw = String(s).trim();
    if (!HAS_DIGIT_RE.test(raw)) return null;
    var negative = false;
    if (/^\(.*\)$/.test(raw.replace(/\s/g, '')) || /\(/.test(raw)) negative = true;
    if (/(^|[^A-Za-z])DR\s*$/i.test(raw)) negative = true;
    if (/(^|[^A-Za-z])CR\s*$/i.test(raw)) negative = false;
    if (/-\s*$/.test(raw) || /^\s*-/.test(raw)) negative = true;

    var body = raw.replace(/[()$£€¥\s]/g, '').replace(/CR|DR/gi, '').replace(/^[+\-]/, '').replace(/[+\-]$/, '');
    if (!body) return null;

    // Decide decimal separator: whichever of . , appears last is the decimal sep.
    var lastDot = body.lastIndexOf('.');
    var lastComma = body.lastIndexOf(',');
    var decSep = null;
    if (lastDot === -1 && lastComma === -1) decSep = null;
    else if (lastDot > lastComma) decSep = '.';
    else decSep = ',';

    var numStr;
    if (decSep === null) {
      numStr = body.replace(/[.,\s]/g, '');
    } else {
      var groupSep = decSep === '.' ? ',' : '.';
      numStr = body.split(groupSep).join('').replace(decSep, '.');
    }
    var v = parseFloat(numStr);
    if (isNaN(v)) return null;
    return { value: negative ? -Math.abs(v) : Math.abs(v), negative: negative };
  }

  // ----------------------------------------------------------------------------
  // Row clustering
  // ----------------------------------------------------------------------------

  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  // Cluster a page's items into rows by y. Returns rows (top -> bottom),
  // each row = { y, items:[...] } with items sorted left -> right.
  function clusterRows(items, opts) {
    opts = opts || {};
    var cleaned = items.filter(function (it) { return it.str && it.str.trim() !== ''; });
    if (!cleaned.length) return [];
    var heights = cleaned.map(function (it) { return it.height || 8; });
    var medH = median(heights) || 8;
    var tol = opts.rowTolerance != null ? opts.rowTolerance : medH * 0.6;

    var byY = cleaned.slice().sort(function (a, b) { return b.y - a.y; }); // top first
    var rows = [];
    var cur = null;
    for (var i = 0; i < byY.length; i++) {
      var it = byY[i];
      if (cur && Math.abs(cur.y - it.y) <= tol) {
        cur.items.push(it);
        // running average y weighted toward the row
        cur.y = (cur.y * (cur.items.length - 1) + it.y) / cur.items.length;
      } else {
        cur = { y: it.y, items: [it] };
        rows.push(cur);
      }
    }
    rows.forEach(function (r) {
      r.items.sort(function (a, b) { return a.x - b.x; });
    });
    return rows;
  }

  // Merge adjacent items in a row that belong to the same logical token
  // (pdf.js sometimes splits "1,234.56" or a word across items). We merge when
  // the horizontal gap is small relative to text height.
  function mergeRowTokens(row, medH) {
    var gaps = medH * 0.4;
    var out = [];
    var prev = null;
    for (var i = 0; i < row.items.length; i++) {
      var it = row.items[i];
      if (prev) {
        var prevRight = prev.x + (prev.width || 0);
        var gap = it.x - prevRight;
        if (gap <= gaps) {
          prev.str += it.str;
          prev.width = (it.x + (it.width || 0)) - prev.x;
          continue;
        }
      }
      prev = { str: it.str, x: it.x, y: it.y, width: it.width || 0, height: it.height || medH };
      out.push(prev);
    }
    return out;
  }

  // ----------------------------------------------------------------------------
  // Column detection
  // ----------------------------------------------------------------------------

  // Cluster anchor positions (right edges of amounts) into vertical bands.
  function clusterPositions(positions, tol) {
    if (!positions.length) return [];
    var sorted = positions.slice().sort(function (a, b) { return a - b; });
    var bands = [];
    var cur = { sum: sorted[0], count: 1, min: sorted[0], max: sorted[0] };
    for (var i = 1; i < sorted.length; i++) {
      if (sorted[i] - cur.max <= tol) {
        cur.sum += sorted[i]; cur.count++; cur.max = sorted[i];
      } else {
        bands.push(cur); cur = { sum: sorted[i], count: 1, min: sorted[i], max: sorted[i] };
      }
    }
    bands.push(cur);
    return bands.map(function (b) { return { center: b.sum / b.count, count: b.count, min: b.min, max: b.max }; });
  }

  var HEADER_WORDS = {
    date: /^(date|fecha|datum|trans(action)?\.?\s*date|posting\s*date|post\s*date)$/i,
    description: /^(description|details?|narrative|transaction|memo|payee|particulars|concepto|detalle)$/i,
    debit: /^(debit|withdrawal|withdrawals|paid\s*out|charges?|cargo|d[ée]bito)$/i,
    credit: /^(credit|deposit|deposits|paid\s*in|cr[ée]dito|abono)$/i,
    amount: /^(amount|value|importe|monto|monto\s*\(?\$?\)?)$/i,
    balance: /^(balance|running\s*balance|saldo|closing\s*balance)$/i
  };

  function classifyHeaderCell(str) {
    var s = str.trim().replace(/[:$]/g, '');
    for (var key in HEADER_WORDS) {
      if (HEADER_WORDS.hasOwnProperty(key) && HEADER_WORDS[key].test(s)) return key;
    }
    return null;
  }

  // Try to find a header row among the given rows. Returns
  // { row, labels:[{type,x,right}] } or null.
  function findHeaderRow(rows, medH) {
    for (var i = 0; i < rows.length; i++) {
      var merged = mergeRowTokens(rows[i], medH);
      var labels = [];
      var hits = 0;
      for (var j = 0; j < merged.length; j++) {
        var t = classifyHeaderCell(merged[j].str);
        if (t) {
          labels.push({ type: t, x: merged[j].x, right: merged[j].x + (merged[j].width || 0), center: merged[j].x + (merged[j].width || 0) / 2 });
          hits++;
        }
      }
      var hasDate = labels.some(function (l) { return l.type === 'date'; });
      var hasMoney = labels.some(function (l) { return l.type === 'amount' || l.type === 'balance' || l.type === 'debit' || l.type === 'credit'; });
      if (hits >= 2 && hasDate && hasMoney) {
        return { index: i, labels: labels };
      }
    }
    return null;
  }

  // ----------------------------------------------------------------------------
  // Profiles
  // ----------------------------------------------------------------------------

  // Each profile is chosen by auto-detection. We first collect all "transaction
  // candidate" rows (a row with a leading date token and >=1 amount token), work
  // out the amount columns, then assign roles.

  var PROFILES = {
    GENERIC_SIGNED: 'generic-signed-amount',          // date | description | amount(signed)
    AMOUNT_BALANCE: 'amount-balance',                 // date | description | amount | balance
    DEBIT_CREDIT_BALANCE: 'debit-credit-balance'      // date | description | debit | credit | balance
  };

  function buildRowModel(rows, medH) {
    return rows.map(function (r) {
      var merged = mergeRowTokens(r, medH);
      var dateTok = null, amounts = [], textToks = [];
      for (var i = 0; i < merged.length; i++) {
        var tk = merged[i];
        var s = tk.str.trim();
        if (!dateTok && isDateToken(s)) { dateTok = tk; continue; }
        if (isAmountToken(s)) { amounts.push(tk); continue; }
        textToks.push(tk);
      }
      return { y: r.y, merged: merged, date: dateTok, amounts: amounts, text: textToks };
    });
  }

  function detectAmountColumns(rowModels, medH) {
    var anchors = [];
    rowModels.forEach(function (rm) {
      rm.amounts.forEach(function (a) { anchors.push(a.x + (a.width || 0)); }); // right edge
    });
    var tol = Math.max(medH * 1.2, 10);
    return clusterPositions(anchors, tol);
  }

  function nearestBand(anchor, bands) {
    var best = 0, bestD = Infinity;
    for (var i = 0; i < bands.length; i++) {
      var d = Math.abs(anchor - bands[i].center);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // ----------------------------------------------------------------------------
  // Main entry
  // ----------------------------------------------------------------------------

  function parseStatement(pages, options) {
    options = options || {};
    var warnings = [];

    // Flatten rows across all pages, tracking page index.
    var allHeights = [];
    pages.forEach(function (pg) {
      (pg.items || []).forEach(function (it) { if (it.height) allHeights.push(it.height); });
    });
    var medH = median(allHeights) || 8;

    var pageRows = pages.map(function (pg) { return clusterRows(pg.items || [], options); });

    // Header detection (search first ~40 rows of first non-empty page).
    var header = null;
    for (var p = 0; p < pageRows.length && !header; p++) {
      header = findHeaderRow(pageRows[p].slice(0, 40), medH);
      if (header) header.page = p;
    }

    // Build row models for every page and keep only transaction candidates.
    var candidates = [];
    pageRows.forEach(function (rows, pi) {
      var models = buildRowModel(rows, medH);
      models.forEach(function (m) {
        if (m.date && m.amounts.length >= 1) {
          m.page = pi;
          candidates.push(m);
        }
      });
    });

    if (!candidates.length) {
      return {
        ok: false,
        profile: null,
        columns: [],
        transactions: [],
        warnings: ['No transaction-like rows were found (a row needs a date and at least one amount). This PDF may use an unusual layout, or it may be a scanned/image-only document with no text layer.'],
        sanity: null
      };
    }

    // Amount columns.
    var bands = detectAmountColumns(candidates, medH);
    var nCols = bands.length;

    // Decide profile. Prefer header labels when available & consistent.
    var profile, columnRoles;
    var headerMoneyTypes = header ? header.labels.filter(function (l) {
      return l.type === 'amount' || l.type === 'balance' || l.type === 'debit' || l.type === 'credit';
    }) : [];

    if (headerMoneyTypes.length >= 1 && headerMoneyTypes.length === nCols) {
      // Map each detected band to the nearest header money label.
      columnRoles = bands.map(function (b) {
        var best = null, bestD = Infinity;
        headerMoneyTypes.forEach(function (l) {
          var d = Math.abs(b.center - l.right);
          if (d < bestD) { bestD = d; best = l.type; }
        });
        return best;
      });
      profile = rolesToProfile(columnRoles);
    } else {
      // Fall back to count-based heuristic.
      if (nCols <= 1) { columnRoles = ['amount']; profile = PROFILES.GENERIC_SIGNED; }
      else if (nCols === 2) { columnRoles = ['amount', 'balance']; profile = PROFILES.AMOUNT_BALANCE; }
      else { columnRoles = ['debit', 'credit', 'balance']; profile = PROFILES.DEBIT_CREDIT_BALANCE; nCols = 3; bands = bands.slice(0, 3); }
      if (header && headerMoneyTypes.length && headerMoneyTypes.length !== nCols) {
        warnings.push('Header labels (' + headerMoneyTypes.map(function (l) { return l.type; }).join(', ') + ') did not match the ' + nCols + ' detected amount column(s); used position-based detection instead.');
      }
    }

    // Manual profile override (from the UI "Layout profile" control).
    if (options.forceProfile && options.forceProfile !== profile) {
      columnRoles = rolesForProfile(options.forceProfile, bands);
      profile = options.forceProfile;
      nCols = bands.length;
    }

    // dayFirst hint: if any ambiguous date has day>12, lock it.
    var dayFirst = options.dayFirst;
    if (dayFirst === undefined) dayFirst = inferDayFirst(candidates);

    // Parse each candidate row.
    var transactions = [];
    candidates.forEach(function (m) {
      var tx = parseRow(m, bands, columnRoles, profile, dayFirst, medH);
      if (tx) transactions.push(tx);
    });

    // Sanity check against balance column if present.
    var sanity = computeSanity(transactions, columnRoles);

    // Column schema for the UI preview.
    var columns = [{ key: 'date', label: 'Date' }, { key: 'description', label: 'Description' }];
    if (profile === PROFILES.DEBIT_CREDIT_BALANCE) {
      columns.push({ key: 'debit', label: 'Debit' }, { key: 'credit', label: 'Credit' });
    } else {
      columns.push({ key: 'amount', label: 'Amount' });
    }
    if (columnRoles.indexOf('balance') !== -1) columns.push({ key: 'balance', label: 'Balance' });

    return {
      ok: true,
      profile: profile,
      profileLabel: profileLabel(profile),
      columns: columns,
      columnRoles: columnRoles,
      amountColumnCount: nCols,
      headerDetected: !!header,
      dayFirst: dayFirst,
      transactions: transactions,
      warnings: warnings,
      sanity: sanity
    };
  }

  function rolesToProfile(roles) {
    var has = {};
    roles.forEach(function (r) { has[r] = true; });
    if (has.debit || has.credit) return PROFILES.DEBIT_CREDIT_BALANCE;
    if (has.balance && has.amount) return PROFILES.AMOUNT_BALANCE;
    if (has.balance && roles.length === 1) return PROFILES.AMOUNT_BALANCE;
    return PROFILES.GENERIC_SIGNED;
  }

  // Map an explicitly requested profile onto the detected amount bands.
  function rolesForProfile(p, bands) {
    var n = bands.length;
    var roles = new Array(n).fill('ignore');
    if (n === 0) return roles;
    if (p === PROFILES.GENERIC_SIGNED) {
      roles[0] = 'amount';
    } else if (p === PROFILES.AMOUNT_BALANCE) {
      if (n === 1) { roles[0] = 'amount'; }
      else { roles[n - 1] = 'balance'; roles[n - 2] = 'amount'; }
    } else if (p === PROFILES.DEBIT_CREDIT_BALANCE) {
      if (n >= 3) { roles[n - 1] = 'balance'; roles[n - 2] = 'credit'; roles[n - 3] = 'debit'; }
      else if (n === 2) { roles[0] = 'debit'; roles[1] = 'credit'; }
      else { roles[0] = 'amount'; }
    }
    return roles;
  }

  function profileLabel(p) {
    if (p === PROFILES.GENERIC_SIGNED) return 'Generic (date · description · signed amount)';
    if (p === PROFILES.AMOUNT_BALANCE) return 'Amount + running balance';
    if (p === PROFILES.DEBIT_CREDIT_BALANCE) return 'Debit / Credit / Balance';
    return p;
  }

  function inferDayFirst(candidates) {
    for (var i = 0; i < candidates.length; i++) {
      var s = candidates[i].date.str.trim();
      var m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);
      if (m) {
        if (+m[1] > 12) return true;
        if (+m[2] > 12) return false;
      }
    }
    return undefined; // leave ambiguous -> parseDate defaults to day-first
  }

  function parseRow(m, bands, roles, profile, dayFirst, medH) {
    var dateRaw = m.date.str.trim();
    var dateISO = parseDate(dateRaw, dayFirst);

    // Assign each amount token to a band/role.
    var slots = {}; // role -> {raw, value}
    m.amounts.forEach(function (a) {
      var bi = nearestBand(a.x + (a.width || 0), bands);
      var role = roles[bi] || 'amount';
      var parsed = parseAmount(a.str);
      if (!parsed) return;
      // if two amounts map to the same slot, keep the right-most (closest to band)
      slots[role] = { raw: a.str.trim(), value: parsed.value, negative: parsed.negative, x: a.x };
    });

    // Description = text tokens left of the first amount column.
    var firstAmountX = m.amounts.length ? Math.min.apply(null, m.amounts.map(function (a) { return a.x; })) : Infinity;
    var descToks = m.text.filter(function (t) {
      return (t.x + (t.width || 0)) <= firstAmountX + medH; // allow slight overlap
    });
    var description = descToks.map(function (t) { return t.str.trim(); }).join(' ')
      .replace(/\s+/g, ' ').trim();

    var tx = { date: dateRaw, dateISO: dateISO, description: description, page: m.page, raw: m.merged.map(function (t) { return t.str; }).join(' | ') };

    if (profile === PROFILES.DEBIT_CREDIT_BALANCE) {
      var debit = slots.debit ? Math.abs(slots.debit.value) : null;
      var credit = slots.credit ? Math.abs(slots.credit.value) : null;
      tx.debit = debit;
      tx.credit = credit;
      tx.amount = (credit || 0) - (debit || 0);
      if (debit == null && credit == null) tx.amount = null;
      if (slots.balance) tx.balance = slots.balance.value;
    } else if (profile === PROFILES.AMOUNT_BALANCE) {
      tx.amount = slots.amount ? slots.amount.value : (slots.balance && Object.keys(slots).length === 1 ? null : null);
      if (slots.balance) tx.balance = slots.balance.value;
      // if only one amount was present but we expected two, it may be amount-only row
      if (tx.amount == null && slots.balance && !('balance' in slots && 'amount' in slots)) {
        // single value present, assume it's the amount if no balance column match
      }
    } else { // GENERIC_SIGNED
      tx.amount = slots.amount ? slots.amount.value : (m.amounts[0] ? (parseAmount(m.amounts[0].str) || {}).value : null);
    }

    return tx;
  }

  function computeSanity(transactions, roles) {
    var hasBalance = roles.indexOf('balance') !== -1;
    var sumAmounts = 0, counted = 0;
    transactions.forEach(function (t) {
      if (typeof t.amount === 'number' && !isNaN(t.amount)) { sumAmounts += t.amount; counted++; }
    });
    sumAmounts = round2(sumAmounts);

    var result = {
      transactionCount: transactions.length,
      amountsParsed: counted,
      sumOfAmounts: sumAmounts,
      hasBalanceColumn: hasBalance,
      balanceConsistent: null,
      balanceChecks: null,
      balanceMatches: null,
      openingBalance: null,
      closingBalance: null,
      netChange: null,
      note: ''
    };

    if (!hasBalance) {
      result.note = 'No balance column detected — cannot cross-check amounts against a running balance.';
      return result;
    }

    var withBal = transactions.filter(function (t) { return typeof t.balance === 'number' && !isNaN(t.balance); });
    if (withBal.length >= 2) {
      var checks = 0, matches = 0;
      for (var i = 1; i < withBal.length; i++) {
        var prev = withBal[i - 1], cur = withBal[i];
        if (typeof cur.amount !== 'number') continue;
        checks++;
        var delta = round2(cur.balance - prev.balance);
        if (Math.abs(delta - round2(cur.amount)) <= 0.011) matches++;
      }
      result.balanceChecks = checks;
      result.balanceMatches = matches;
      result.balanceConsistent = checks > 0 ? (matches === checks) : null;
      result.openingBalance = round2(withBal[0].balance - (typeof withBal[0].amount === 'number' ? withBal[0].amount : 0));
      result.closingBalance = round2(withBal[withBal.length - 1].balance);
      result.netChange = round2(result.closingBalance - result.openingBalance);
      if (checks > 0) {
        result.note = matches + ' of ' + checks + ' balance steps match the transaction amount' +
          (matches === checks ? ' — looks consistent.' : ' — review highlighted rows.');
      }
    }
    return result;
  }

  function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

  // ----------------------------------------------------------------------------
  // CSV helper (used by browser + available to tests)
  // ----------------------------------------------------------------------------

  function toCSV(parseResult) {
    var cols = parseResult.columns;
    var header = cols.map(function (c) { return c.label; });
    var lines = [header.map(csvCell).join(',')];
    parseResult.transactions.forEach(function (t) {
      var row = cols.map(function (c) {
        var v = t[c.key];
        if (v == null) return '';
        if (typeof v === 'number') return String(v);
        return v;
      });
      lines.push(row.map(csvCell).join(','));
    });
    return lines.join('\r\n');
  }

  function csvCell(v) {
    v = v == null ? '' : String(v);
    if (/[",\r\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
    return v;
  }

  // ----------------------------------------------------------------------------
  // Exports
  // ----------------------------------------------------------------------------

  return {
    PROFILES: PROFILES,
    parseStatement: parseStatement,
    clusterRows: clusterRows,
    mergeRowTokens: mergeRowTokens,
    buildRowModel: buildRowModel,
    detectAmountColumns: detectAmountColumns,
    findHeaderRow: findHeaderRow,
    isDateToken: isDateToken,
    isAmountToken: isAmountToken,
    parseDate: parseDate,
    parseAmount: parseAmount,
    toCSV: toCSV
  };
});
