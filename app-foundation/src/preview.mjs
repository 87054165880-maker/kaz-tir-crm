import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const mapping = JSON.parse(readFileSync(new URL('../../planning/import/operational_field_map.json', import.meta.url), 'utf8'));
const CURRENCIES = new Set(['KZT', 'RUB', 'USD']);
const STATUSES = new Set(['Черновик', 'Планируется', 'В работе', 'В пути', 'Доставлен', 'Отменено']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Live source uses TR0077; hyphenated IDs remain valid for older test/import sources.
// Never rewrite the source ID or strip leading zeros.
const TRIP_ID = /^TR-?\d+$/;
const empty = value => value === null || value === undefined || value === '';
const label = value => empty(value) ? null : String(value).trim() || null;
const issue = (code, field = null) => ({ code, field });

// Stable serialization for a JSON-only import envelope. Reject non-JSON data.
export function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  throw new Error('Input must contain only finite JSON values');
}
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
export function stableId(...parts) {
  const h = hash(parts);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// The pilot supports currencies with 2 decimal places. No binary-float arithmetic.
export function parseMoney(value) {
  if (empty(value)) return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Invalid money type');
  if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) {
    throw new Error('Unsafe numeric source amount; export as an exact decimal string');
  }
  let text = String(value).trim();
  if (/[ \u00a0\u202f]/u.test(text)) {
    if (!/^\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d{1,2})?$/u.test(text)) throw new Error('Invalid thousands grouping');
    text = text.replace(/[ \u00a0\u202f]/gu, '');
  }
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(text)) throw new Error('Invalid nonnegative decimal money');
  const [whole, fraction = ''] = text.replace(',', '.').split('.');
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (minor >= 10n ** 24n) throw new Error('Source amount too large');
  return minor.toString();
}

export function parseDate(value) {
  if (empty(value)) return null;
  if (typeof value !== 'string') throw new Error('Use explicit ISO or DD.MM.YYYY dates, not sheet serial numbers');
  let text = value.trim();
  const ru = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
  if (ru) text = `${ru[3]}-${ru[2]}-${ru[1]}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number(text.slice(0, 4)) < 1900) throw new Error('Invalid date');
  const date = new Date(`${text}T00:00:00Z`);
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== text) throw new Error('Invalid calendar date');
  return text;
}

function booleanFlag(value, issues) {
  if (empty(value) || value === false || value === 'FALSE') return false;
  if (value === true || value === 'TRUE') return true;
  issues.push(issue('INVALID_MANUAL_FLAG', 'R'));
  return null;
}

function money(row, field, defaultCurrency, issues) {
  const override = row.currencyOverrides?.[field];
  const currency = override ?? defaultCurrency;
  const result = { minor: null, currency, currencyBasis: override ? 'explicit_source' : 'owner_default' };
  if (!CURRENCIES.has(currency)) {
    issues.push(issue('UNSUPPORTED_CURRENCY', field));
    return { ...result, currency: null };
  }
  try { result.minor = parseMoney(row.cells[field]); }
  catch { issues.push(issue('INVALID_AMOUNT', field)); }
  return result;
}

function dateField(cells, field, issues) {
  try { return parseDate(cells[field]); }
  catch { issues.push(issue('INVALID_DATE', field)); return null; }
}

function validateEnvelope(input) {
  canonical(input);
  if (input.schemaVersion !== 1 || input.mappingVersion !== mapping.schema_version) throw new Error('Unsupported input or mapping version');
  if (!UUID.test(input.tenantId ?? '') || !label(input.sourceSpreadsheetId) || !label(input.snapshotId)) throw new Error('Missing tenant/source/snapshot identity');
  if (!CURRENCIES.has(input.defaultCurrency) || input.defaultCurrencyBasis !== 'owner_instruction') throw new Error('Owner-approved default currency required');
  for (const sheet of ['trips', 'payments']) {
    if (!['complete', 'partial'].includes(input.coverage?.[sheet]) || !Array.isArray(input[sheet])) throw new Error(`Missing coverage or rows: ${sheet}`);
    const rows = new Set();
    for (const row of input[sheet]) {
      if (!Number.isSafeInteger(row.rowNumber) || row.rowNumber < 2 || rows.has(row.rowNumber)) throw new Error(`Invalid/repeated row position: ${sheet}`);
      rows.add(row.rowNumber);
      if (!row.cells || Array.isArray(row.cells) || typeof row.cells !== 'object') throw new Error('Row cells must be an object');
      if (Object.values(row.cells).some(v => v !== null && !['string', 'boolean', 'number'].includes(typeof v))) throw new Error('Cells must be scalar JSON values');
      if (row.currencyOverrides !== undefined) {
        if (!row.currencyOverrides || Array.isArray(row.currencyOverrides) || typeof row.currencyOverrides !== 'object') throw new Error('Invalid currency overrides');
        const allowed = sheet === 'trips' ? ['O', 'Q', 'AB'] : ['E'];
        if (Object.keys(row.currencyOverrides).some(k => !allowed.includes(k))) throw new Error('Unknown currency override column');
      }
    }
  }
}

function duplicates(rows, column) {
  const counts = new Map();
  for (const row of rows) {
    const key = label(row.cells[column]);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n > 1).map(([key]) => key));
}

// Pure preview. No network, filesystem writes, production database or side effects.
export function buildPreview(source) {
  validateEnvelope(source);
  const input = JSON.parse(canonical(source));
  const contentHash = hash(input);
  const batchId = stableId(input.tenantId, input.sourceSpreadsheetId, input.snapshotId, input.mappingVersion);
  const rows = [], trips = [], manualSettlements = [], agentPayments = [];
  const duplicateTrips = duplicates(input.trips, 'A');
  const duplicatePayments = duplicates(input.payments, 'A');
  const allTripIds = new Set(input.trips.map(r => label(r.cells.A)).filter(id => TRIP_ID.test(id ?? '') && !duplicateTrips.has(id)));
  const suspiciousPaymentKeys = new Map();

  // Tuple equality is an exception, NOT proof that two real payments are identical.
  for (const row of input.payments) {
    try {
      const currency = row.currencyOverrides?.E ?? input.defaultCurrency;
      const key = canonical([parseDate(row.cells.B), label(row.cells.C), row.cells.F, parseMoney(row.cells.E), currency]);
      suspiciousPaymentKeys.set(key, (suspiciousPaymentKeys.get(key) ?? 0) + 1);
    } catch { /* Validation below retains the invalid row and explains it. */ }
  }

  function startRow(sheet, row) {
    const result = {
      id: stableId(batchId, sheet, row.rowNumber), sheet, rowNumber: row.rowNumber,
      sourceKey: label(row.cells.A), raw: row, outcome: 'candidate', issues: []
    };
    if (Object.values(row.cells).every(empty)) result.outcome = 'empty';
    rows.push(result);
    return result;
  }

  for (const row of input.trips) {
    const result = startRow('trips', row), c = row.cells, id = label(c.A), problems = result.issues;
    if (result.outcome === 'empty') continue;
    if (!TRIP_ID.test(id ?? '')) problems.push(issue('MISSING_OR_INVALID_TRIP_ID', 'A'));
    if (duplicateTrips.has(id)) problems.push(issue('DUPLICATE_TRIP_ID', 'A'));
    if (problems.length) { result.outcome = 'blocked'; continue; }

    const status = label(c.K);
    const revenue = money(row, 'O', input.defaultCurrency, problems);
    const carrierCost = money(row, 'Q', input.defaultCurrency, problems);
    const received = money(row, 'AB', input.defaultCurrency, problems);
    const manualFlag = booleanFlag(c.R, problems);
    const type = label(c.D);
    if (!STATUSES.has(status)) problems.push(issue('UNKNOWN_OR_MISSING_STATUS', 'K'));
    if (!['own', 'expedition'].includes(type) && !(['Черновик', 'Планируется'].includes(status) && type === null)) problems.push(issue('UNKNOWN_OR_MISSING_TRIP_TYPE', 'D'));
    if (!label(c.L)) problems.push(issue('MISSING_MANAGER', 'L'));
    for (const field of ['C', 'E', 'F']) if (!label(c[field])) problems.push(issue('MISSING_OPERATIONAL_FIELD', field));
    if (revenue.minor === null || revenue.minor === '0') problems.push(issue('MISSING_POSITIVE_REVENUE', 'O'));
    const facts = {
      status, type,
      tripDate: dateField(c, 'B', problems), unloadDate: dateField(c, 'Y', problems),
      expectedPaymentDate: dateField(c, 'Z', problems), reportedFullPaymentDate: dateField(c, 'AD', problems),
      managerSourceName: label(c.L), logisticianSourceName: label(c.M), dispatcherSourceName: label(c.N),
      employeeIdsResolved: false, referenceIdsResolved: false,
      revenue, carrierCost, customerReceivedSummary: received, manualPaidFlag: manualFlag,
      // All 40 source values survive, including blank-header J and unknown fields in raw.
      mappedSource: Object.fromEntries(mapping.fields.map(f => [f.target, c[f.source_column] ?? null])),
      paymentSummaryIsNotBankHistory: true, financialConfirmation: false, payrollConfirmation: false
    };
    if (!facts.tripDate) problems.push(issue('MISSING_TRIP_DATE', 'B'));
    if (status === 'Доставлен' && !facts.unloadDate) problems.push(issue('MISSING_UNLOAD_DATE', 'Y'));
    const linked = input.payments.filter(p => label(p.cells.C) === id);
    if (manualFlag === true) {
      if (type === 'own') {
        if (label(c.P) || (carrierCost.minor !== null && carrierCost.minor !== '0') || linked.length ||
            problems.some(p=>p.field==='Q')) problems.push(issue('OWN_CARRIER_PAYMENT_CONFLICT', 'R'));
        else facts.manualFlagApplicability = 'not_a_carrier_payment';
      }
      else if (linked.length) problems.push(issue('MANUAL_AND_AGENT_RECONCILIATION_REQUIRED', 'R'));
      else if (input.coverage.payments !== 'complete') problems.push(issue('PAYMENT_COVERAGE_INCOMPLETE', 'R'));
      else if (carrierCost.currency) {
        const amount = carrierCost.minor && carrierCost.minor !== '0' ? carrierCost.minor : null;
        if (amount === null) problems.push(issue('MANUAL_PAYMENT_AMOUNT_REQUIRED', 'Q'));
        manualSettlements.push({ tripId: id, amountMinor: amount, currency: carrierCost.currency,
          origin: 'manual_operational', bankDate: null, bankAccountId: null, bankOperationId: null });
      }
    }
    trips.push({ tripId: id, sourceRowId: result.id, createdBy: 'service:import-preview', facts });
    if (problems.length) result.outcome = 'review';
  }

  for (const row of input.payments) {
    const result = startRow('payments', row), c = row.cells, problems = result.issues;
    if (result.outcome === 'empty') continue;
    const paymentId = label(c.A), tripId = label(c.C);
    const paymentDate = dateField(c, 'B', problems);
    const amount = money(row, 'E', input.defaultCurrency, problems);
    if (!paymentId) problems.push(issue('MISSING_PAYMENT_ID', 'A'));
    if (duplicatePayments.has(paymentId)) problems.push(issue('DUPLICATE_PAYMENT_ID', 'A'));
    if (!allTripIds.has(tripId)) problems.push(issue('UNRESOLVED_TRIP_ID', 'C'));
    if (!paymentDate) problems.push(issue('MISSING_PAYMENT_DATE', 'B'));
    if (amount.minor === null || amount.minor === '0') problems.push(issue('MISSING_POSITIVE_PAYMENT_AMOUNT', 'E'));
    if (!['carrier_payment', 'carrier_refund'].includes(c.F)) problems.push(issue('INVALID_PAYMENT_TYPE', 'F'));
    if (paymentDate && amount.minor) {
      const key = canonical([paymentDate, tripId, c.F, amount.minor, amount.currency]);
      if (suspiciousPaymentKeys.get(key) > 1) problems.push(issue('POSSIBLE_DUPLICATE_PAYMENT', null));
    }
    if (problems.length) { result.outcome = 'blocked'; continue; }
    const linkedTrip = trips.find(t => t.tripId === tripId);
    if (linkedTrip?.facts.manualPaidFlag === true) problems.push(issue('MANUAL_AND_AGENT_RECONCILIATION_REQUIRED', 'C'));
    if (linkedTrip?.facts.type === 'own') problems.push(issue('OWN_CARRIER_PAYMENT_CONFLICT', 'C'));
    const contractCurrency = linkedTrip?.facts.carrierCost.currency;
    if (contractCurrency !== amount.currency) problems.push(issue('FX_SETTLEMENT_REVIEW_REQUIRED', 'E'));
    problems.push(issue('BANK_EVENT_RECONCILIATION_REQUIRED', null));
    result.outcome = 'review';
    agentPayments.push({ sourceRowId: result.id, sourcePaymentId: paymentId, tripId,
      paymentDate, paymentType: c.F, amountMinor: amount.minor, currency: amount.currency,
      origin: 'agent_loaded', requiresBankReconciliation: true, kztEquivalent: null });
  }

  return {
    schemaVersion: 1, mode: 'preview_only', batchId, tenantId: input.tenantId,
    sourceSpreadsheetId: input.sourceSpreadsheetId, snapshotId: input.snapshotId,
    mappingVersion: input.mappingVersion, contentHash, defaultCurrency: input.defaultCurrency,
    coverage: input.coverage,
    rows, trips, manualSettlements, agentPayments,
    summary: {
      sourceRows: rows.length,
      byOutcome: Object.fromEntries(['candidate', 'review', 'blocked', 'empty'].map(s => [s, rows.filter(r => r.outcome === s).length])),
      tripCandidates: trips.length, manualPaymentCandidates: manualSettlements.length,
      agentPaymentCandidates: agentPayments.length, bankPaymentsCreated: 0, applicationTripsCreated: 0,
      noticesSent: 0, payrollAccrualsCreated: 0,
      readyForProduction: false, referenceResolutionPending: trips.length > 0
    }
  };
}
