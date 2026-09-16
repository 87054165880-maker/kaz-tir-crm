// Source links only: this does not create production identities or merge legal entities.
const norm = v => String(v ?? '').normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ru');
const plate = v => norm(v).replace(/[ -]/g, '');

export function resolveReference(records, value, options = {}) {
  if (!norm(value)) return { state: 'missing', sourceRows: [] };
  let candidates = records.filter(r => norm(r.name) === norm(value));
  if (options.plate && candidates.length > 1) candidates = candidates.filter(r => plate(r.plate) === plate(options.plate));
  if (candidates.length === 1) {
    const c = candidates[0];
    if (options.plate && c.plate && plate(options.plate) !== plate(c.plate)) return { state: 'conflict', sourceRows: [c.rowNumber] };
    return { state: 'matched', sourceRows: [c.rowNumber], sourceKey: c.sourceKey, match: c };
  }
  return { state: candidates.length ? 'ambiguous' : 'unmatched', sourceRows: candidates.map(r=>r.rowNumber) };
}

export function inspectReferences(trips, dictionaries) {
  const byField = {}, issues = [], links = [];
  function add(trip, field, result, required = true) {
    if (!required && result.state === 'missing') result = { state: 'optional_blank', sourceRows: [] };
    byField[field] ??= {}; byField[field][result.state] = (byField[field][result.state] ?? 0) + 1;
    links.push({ tripId: trip.cells.A, field, ...result, match: undefined });
    if (!['matched','optional_blank'].includes(result.state)) issues.push({tripId:trip.cells.A,rowNumber:trip.rowNumber,field,value:trip.cells[field]??null,state:result.state,candidateRows:result.sourceRows});
  }
  for (const trip of trips) {
    const c = trip.cells;
    if (!/^TR-?\d+$/.test(c.A ?? '')) continue;
    add(trip,'C',resolveReference(dictionaries.clients,c.C));
    for (const f of ['E','F']) add(trip,f,resolveReference(dictionaries.cities,c[f]));
    for (const [f,role] of [['L','менеджер'],['M','логист'],['N','диспетчер']]) {
      add(trip,f,resolveReference(dictionaries.employees.filter(r=>r.role===role),c[f]),f==='L'||(f==='M'&&c.D==='expedition'));
    }
    add(trip,'P',resolveReference(dictionaries.carriers,c.P,{plate:c.J}),c.D==='expedition');
    add(trip,'S',resolveReference(dictionaries.trucks,c.S),c.D==='own');
    add(trip,'AF',resolveReference(dictionaries.accounts,c.AF));
  }
  return { byField, issues, links, allProductionPersonIdsResolved: false,
    note: 'Matched means one verified source row, not a new application ID or proof of legal identity.' };
}
