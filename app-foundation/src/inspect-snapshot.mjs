import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildPreview } from './preview.mjs';
import { loadSnapshot, makeEnvelope, sourceRecords, cellValue, columnLetter } from './snapshot.mjs';
import { inspectReferences } from './references.mjs';

export function sourceDictionary(table, sheet, idColumn) {
  return sourceRecords(table).filter(r => typeof r.cells.A === 'string' && r.cells.A.trim() !== '').map(r => ({
    rowNumber: r.rowNumber, name: r.cells.A, sourceKey: `${sheet}:row:${r.rowNumber}`,
    sourceId: idColumn ? r.cells[idColumn] ?? null : null,
    plate: sheet === 'carriers' ? r.cells.G : null
  }));
}

export function analyzeSnapshot(path) {
  const snapshot = loadSnapshot(path), { envelope, counts } = makeEnvelope(snapshot);
  const preview = buildPreview(envelope);
  function dictionary(sheet, idColumn) {
    return sourceDictionary(snapshot.tables.get(sheet), sheet, idColumn);
  }
  const employeeFile = JSON.parse(readFileSync(resolve(dirname(path),'employees_reference.json'),'utf8'));
  const employeeRows = new Map();
  for (const g of employeeFile.data.sheets[0].data) for (let i=0;i<(g.rowData?.length??0);i++) {
    const n=(g.startRow??0)+i+1;
    if (n===1) continue;
    if (!employeeRows.has(n)) employeeRows.set(n,{});
    for(let j=0;j<(g.rowData[i].values?.length??0);j++) employeeRows.get(n)[columnLetter((g.startColumn??0)+j)]=cellValue(g.rowData[i].values[j]);
  }
  const employees=[...employeeRows].filter(([,r])=>r.A).map(([rowNumber,r])=>({
    rowNumber,name:r.A,role:r.B,status:r.E,sourceKey:`employees:${r.B}:${r.A}`
  }));
  const dictionaries={clients:dictionary('clients','F'),carriers:dictionary('carriers','J'),
    cities:dictionary('cities'),trucks:dictionary('trucks'),accounts:dictionary('accounts'),employees};
  const refs=inspectReferences(envelope.trips,dictionaries);
  const issues=preview.rows.filter(r=>r.issues.length).map(r=>({sheet:r.sheet,rowNumber:r.rowNumber,id:r.sourceKey,issues:r.issues}));
  const issueCounts={}; for(const r of issues) for(const i of r.issues)issueCounts[i.code]=(issueCounts[i.code]??0)+1;
  const missingManagers=envelope.trips.filter(r=>!r.cells.L).map(r=>({tripId:r.cells.A,rowNumber:r.rowNumber,dispatcher:r.cells.N??null,status:r.cells.K}));
  const activeIds=new Set(envelope.trips.filter(r=>['Планируется','В работе','В пути'].includes(r.cells.K)).map(r=>r.cells.A));
  const errorCells=[];
  for(const [sheet,table] of snapshot.tables) for(const [rowNumber,cells] of table) for(const [column,c] of Object.entries(cells))
    if(c.effectiveValue?.errorValue)errorCells.push({sheet,rowNumber,column,type:c.effectiveValue.errorValue.type});
  return {
    kind:'live_source_read_only_preview',date:snapshot.manifest.date,
    source:snapshot.manifest.source.spreadsheetUrl,
    sheets:snapshot.manifest.source.sheets.length,chunks:snapshot.controls.length,
    modifiedBefore:snapshot.manifest.fileBefore.modified_time,modifiedAfter:snapshot.manifest.fileAfter.modified_time,
    snapshotIsAtomic:false,classification:counts,preview:preview.summary,
    dictionaryRows:Object.fromEntries(Object.entries(dictionaries).map(([k,v])=>[k,v.length])),
    dictionaryRowsWithoutSourceId:Object.fromEntries(['clients','carriers'].map(k=>[k,dictionaries[k].filter(r=>!r.sourceId).map(r=>r.rowNumber)])),
    sourceReferenceCounts:refs.byField,sourceReferenceIssues:refs.issues,
    sourceReferenceLinks:refs.links,
    activeSourceReferenceIssues:refs.issues.filter(i=>activeIds.has(i.tripId)),
    distinctTripsWithReferenceIssues:new Set(refs.issues.map(i=>i.tripId)).size,
    missingManagers,issueCounts,issues,
    observations:{ownFlagsWithoutCarrierPayment:preview.trips.filter(t=>t.facts.manualFlagApplicability==='not_a_carrier_payment').map(t=>t.tripId)},
    manualSettlementCandidates:preview.manualSettlements.map(s=>({tripId:s.tripId,currency:s.currency,hasAmount:s.amountMinor!==null})),
    agentPaymentCandidates:preview.agentPayments.length,
    sourceFormulaErrors:{count:errorCells.length,bySheet:errorCells.reduce((a,c)=>(a[c.sheet]=(a[c.sheet]??0)+1,a),{}),sample:errorCells.slice(0,20)},
    applicationDataWritten:false,financialConfirmation:false,employeeAccessChanged:false,
    integrity:snapshot.controls.map(c=>({path:c.path,sha256:c.sha256}))
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  try {
    if(process.argv.length!==3)throw new Error('Usage: node src/inspect-snapshot.mjs /absolute/path/to/manifest.json');
    console.log(JSON.stringify(analyzeSnapshot(resolve(process.argv[2])),null,2));
  } catch(error) { console.error(error.message); process.exitCode=1; }
}
