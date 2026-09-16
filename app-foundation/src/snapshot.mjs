import { readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { parseDate, stableId } from './preview.mjs';

const dateFields = new Set(['B', 'Y', 'Z', 'AD']);
const inputFields = new Set(['A','B','C','D','E','F','I','J','K','L','M','N','O','P','Q','R','S','T','U','Y','Z','AA','AB','AD','AF']);
const blank = v => v === null || v === undefined || v === '';
export function columnLetter(n) {
  let s = ''; for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}
export function cellValue(cell) {
  const v = cell?.effectiveValue;
  if (v?.errorValue) return cell.formattedValue ?? `#${v.errorValue.type}!`;
  return v?.stringValue ?? v?.numberValue ?? v?.boolValue ?? null;
}
export function sourceDate(cell) {
  const value = cellValue(cell);
  if (blank(value)) return null;
  if (typeof value === 'number') {
    // Only the known date columns of a Google Sheets snapshot use this adapter.
    // Date-only target: a hidden time is accepted only when the displayed date
    // explicitly agrees with the serial's calendar day. Raw serial stays in snapshot.
    if (!Number.isFinite(value) || value < 2 || value >= 2958466) return String(value);
    const day = new Date(Date.UTC(1899,11,30) + Math.floor(value) * 86400000).toISOString().slice(0,10);
    if (!Number.isInteger(value)) {
      try { if (parseDate(cell.formattedValue) !== day) return String(value); }
      catch { return String(value); }
    }
    return day;
  }
  try { return parseDate(value); } catch { return value; }
}

// Read-only decoder. Private snapshots stay outside any served web directory.
export function loadSnapshot(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const base = dirname(resolve(manifestPath)), tables = new Map(), controls = [];
  for (const f of manifest.files) {
    const path = resolve(base, f.path), rel = relative(base, path);
    if (rel.startsWith('..') || rel.startsWith('/')) throw new Error('Snapshot file outside snapshot directory');
    const raw = readFileSync(path, 'utf8'), chunk = JSON.parse(raw), p = chunk.request;
    const sha256 = createHash('sha256').update(raw).digest('hex');
    if (f.sha256 && f.sha256 !== sha256) throw new Error('Snapshot checksum mismatch');
    if (p.sheet !== f.sheet || p.range !== f.range) throw new Error('Manifest/chunk mismatch');
    const sheet = chunk.sheets?.find(s => s.properties?.sheetId === p.sheetId);
    if (!sheet) throw new Error(`Missing returned sheet ${p.sheet}`);
    if (!tables.has(p.sheet)) tables.set(p.sheet, new Map());
    const table = tables.get(p.sheet);
    for (const g of sheet.data ?? []) for (let i = 0; i < (g.rowData?.length ?? 0); i++) {
      const rowNumber = (g.startRow ?? 0) + i + 1;
      if (rowNumber < p.start || rowNumber > p.end) throw new Error('Cell outside requested row range');
      if (!table.has(rowNumber)) table.set(rowNumber, {});
      const cells = table.get(rowNumber);
      for (let j = 0; j < (g.rowData[i].values?.length ?? 0); j++) {
        const col = (g.startColumn ?? 0) + j;
        if (col >= p.width) throw new Error('Cell outside requested columns');
        const key = columnLetter(col);
        if (key in cells) throw new Error('Overlapping snapshot ranges');
        cells[key] = g.rowData[i].values[j];
      }
    }
    controls.push({ path: f.path, sheet: p.sheet, start: p.start, end: p.end, width: p.width,
      sha256 });
  }
  // Prove grid coverage from the individual requests, not from a claimed manifest flag.
  for (const s of manifest.source.sheets) {
    const p = s.properties, ranges = controls.filter(c => c.sheet === p.title).sort((a,b)=>a.start-b.start);
    let next = 1;
    for (const r of ranges) {
      if (r.start !== next || r.width !== p.gridProperties.columnCount) throw new Error(`Incomplete coverage: ${p.title}`);
      next = r.end + 1;
    }
    if (next !== p.gridProperties.rowCount + 1) throw new Error(`Incomplete coverage: ${p.title}`);
  }
  return { manifest, tables, controls };
}

export function sourceRecords(table) {
  return [...table.entries()].filter(([n]) => n > 1).map(([rowNumber, metadata]) => ({
    rowNumber, metadata, cells: Object.fromEntries(Object.entries(metadata).map(([k,c]) => [k,cellValue(c)]))
  }));
}

export function makeEnvelope(snapshot) {
  const sourceId = snapshot.manifest.source.spreadsheetId;
  const counts = { trips: { business: 0, templateOrDerived: 0 }, payments: { business: 0, templateOrDerived: 0 } };
  const getRows = sheet => sourceRecords(snapshot.tables.get(sheet)).filter(row => {
    const key = cellValue(row.metadata.A);
    const hardcoded = Object.entries(row.metadata).some(([k,c]) => {
      if (sheet === 'trips' && !inputFields.has(k)) return false;
      if (sheet === 'payments' && k === 'D') return false; // derived carrier column
      const v = c.userEnteredValue;
      if (!v || v.formulaValue !== undefined) return false;
      const raw = v.stringValue ?? v.numberValue ?? v.boolValue;
      return !blank(raw) && !(sheet === 'trips' && k === 'R' && raw === false);
    });
    // Derived rows without business input stay in the raw snapshot, not lost or new trips.
    const business = !blank(key) || hardcoded;
    counts[sheet][business ? 'business' : 'templateOrDerived']++;
    return business;
  }).map(row => {
    const cells = { ...row.cells };
    for (const k of sheet === 'trips' ? dateFields : ['B']) if (k in row.metadata) cells[k] = sourceDate(row.metadata[k]);
    return { rowNumber: row.rowNumber, cells };
  });
  const envelope = {
    schemaVersion: 1, mappingVersion: 2,
    tenantId: stableId('local-preview-not-production-tenant', sourceId),
    sourceSpreadsheetId: sourceId,
    snapshotId: `snapshot-${snapshot.manifest.date}-${snapshot.manifest.fileAfter.modified_time}`,
    defaultCurrency: 'KZT', defaultCurrencyBasis: 'owner_instruction',
    coverage: { trips: 'complete', payments: 'complete' },
    trips: getRows('trips'), payments: getRows('payments')
  };
  return { envelope, counts };
}
