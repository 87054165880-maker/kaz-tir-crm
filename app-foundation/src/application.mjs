import { canonical, stableId, buildPreview } from './preview.mjs';
import { stageSnapshot } from './stage.mjs';

// Only operational, trip-scoped fields. Complete source/financial formulas stay in
// private staging; a trip read must not reveal the workbook or bank statement.
export function applicationRecord(trip, raw) {
  const f=trip.facts,c=raw.cells;
  return {
    status:f.status,trip_type:f.type,trip_date:f.tripDate,unload_date:f.unloadDate,
    expected_payment_date:f.expectedPaymentDate,client_name:c.C??null,
    start_city:c.E??null,end_city:c.F??null,vehicle_plate:c.J??null,
    carrier_name:c.P??null,own_truck_name:c.S??null,expected_account:c.AF??null,
    revenue_minor:f.revenue.minor,revenue_currency:f.revenue.currency,
    carrier_cost_minor:f.carrierCost.minor,carrier_currency:f.carrierCost.currency,
    manager_source_name:f.managerSourceName,logistician_source_name:f.logisticianSourceName,
    dispatcher_source_name:f.dispatcherSourceName,source_comment:c.I??null,
    manager_comment:null,logistician_comment:null,dispatcher_comment:null,actual_km:null
  };
}

// Three-way comparison. Never wipe an employee edit with a repeated export.
// Keys absent from the incoming import are not deletions.
export function mergeRecord(baseline,local,incoming,{locked=false,protectedFields=[]}={}) {
  const next={...local},conflicts=[];
  for(const [field,value] of Object.entries(incoming)) {
    const before=baseline[field]??null,now=local[field]??null;
    if(canonical(value)===canonical(before)||canonical(value)===canonical(now))continue;
    if(locked||protectedFields.includes(field)||canonical(now)!==canonical(before))conflicts.push({field,baseline:before,local:now,incoming:value});
    else next[field]=value;
  }
  return {next,conflicts,changed:canonical(next)!==canonical(local)};
}

// Trusted local migration adapter; NOT an endpoint callable by an employee.
// Authorization is the explicit operator CLI. The runtime role has no INSERT/UPDATE
// rights to staging, memberships, import bindings, or trips.
export async function publishSnapshot(db,input) {
  const preview=buildPreview(input),t=input.tenantId,b=preview.batchId;
  await stageSnapshot(db,input);
  return db.transaction(async tx=>{
    const tenant=await tx.query('SELECT id FROM app.tenants WHERE id=$1 AND active FOR UPDATE',[t]);
    if(!tenant.rows.length)throw new Error('APPLICATION_TENANT_NOT_APPROVED');
    const prior=await tx.query('SELECT report FROM app.import_runs WHERE tenant_id=$1 AND batch_id=$2',[t,b]);
    if(prior.rows.length)return {...prior.rows[0].report,reused:true};
    const report={batchId:b,mode:'local_application_import',inserted:0,updated:0,unchanged:0,
      conflicts:0,unresolvedIdentityRows:0,sourceRows:preview.rows.length,
      unresolvedTripRows:preview.rows.filter(r=>r.sheet==='trips'&&r.outcome==='blocked').length,
      bankPaymentsCreated:0,payrollCreated:0,employeeAccountsCreated:0,reused:false};
    for(const trip of preview.trips){
      const raw=preview.rows.find(r=>r.id===trip.sourceRowId).raw,incoming=applicationRecord(trip,raw);
      const hasFinancialLinks=BigInt(trip.facts.customerReceivedSummary.minor??'0')>0n ||
        (trip.facts.type==='expedition'&&trip.facts.manualPaidFlag===true) || !!raw.cells.AA ||
        input.payments.some(p=>p.cells.C===trip.tripId);
      const bindings=await tx.query('SELECT * FROM app.import_bindings WHERE tenant_id=$1 AND source_id=$2 AND source_key=$3',[t,input.sourceSpreadsheetId,trip.tripId]);
      const binding=bindings.rows[0];
      if(!binding){
        const existing=await tx.query('SELECT id FROM app.trips WHERE tenant_id=$1 AND trip_number=$2',[t,trip.tripId]);
        if(existing.rows.length){
          await tx.query(`INSERT INTO app.import_conflicts(tenant_id,batch_id,source_key,field,local_value,incoming)
            VALUES($1,$2,$3,'__identity__',$4,$5)`,[t,b,trip.tripId,JSON.stringify(existing.rows[0]),JSON.stringify(incoming)]);
          report.conflicts++;report.unresolvedIdentityRows++;continue;
        }
        const id=stableId(t,'application-trip',input.sourceSpreadsheetId,trip.tripId);
        await tx.query(`INSERT INTO app.trips(tenant_id,id,trip_number,record,imported,created_by,commercial_review_required)
          VALUES($1,$2,$3,$4,true,'service:source-import',$5)`,[t,id,trip.tripId,JSON.stringify(incoming),hasFinancialLinks]);
        await tx.query(`INSERT INTO app.import_bindings(tenant_id,source_id,source_key,trip_id,last_batch_id,baseline)
          VALUES($1,$2,$3,$4,$5,$6)`,[t,input.sourceSpreadsheetId,trip.tripId,id,b,JSON.stringify(incoming)]);
        await tx.query(`INSERT INTO app.audit_events(tenant_id,entity,entity_id,actor,reason,after_value)
          VALUES($1,'trip',$2,'service:source-import',$3,$4)`,[t,id,`Initial source import ${b}`,JSON.stringify(incoming)]);
        report.inserted++;
      }else{
        const {rows:[current]}=await tx.query('SELECT * FROM app.trips WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[t,binding.trip_id]);
        const protectedFields=[['manager_id','manager_source_name'],['logistician_id','logistician_source_name'],['dispatcher_id','dispatcher_source_name']].filter(([id])=>current[id]).map(([,name])=>name);
        const merged=mergeRecord(binding.baseline,current.record,incoming,{locked:!!(current.confirmed_at||current.archived_at),protectedFields});
        for(const c of merged.conflicts)await tx.query(`INSERT INTO app.import_conflicts(tenant_id,batch_id,source_key,field,baseline,local_value,incoming)
          VALUES($1,$2,$3,$4,$5,$6,$7)`,[t,b,trip.tripId,c.field,JSON.stringify(c.baseline),JSON.stringify(c.local),JSON.stringify(c.incoming)]);
        report.conflicts+=merged.conflicts.length;
        if(merged.changed||(!current.commercial_review_required&&hasFinancialLinks)){
          await tx.query('UPDATE app.trips SET record=$1,commercial_review_required= commercial_review_required OR $4,version=version+1,updated_at=now() WHERE tenant_id=$2 AND id=$3',[JSON.stringify(merged.next),t,current.id,hasFinancialLinks]);
          await tx.query(`INSERT INTO app.audit_events(tenant_id,entity,entity_id,actor,reason,before_value,after_value)
            VALUES($1,'trip',$2,'service:source-import',$3,$4,$5)`,[t,current.id,`Source update ${b}`,JSON.stringify(current.record),JSON.stringify(merged.next)]);
          report.updated++;
        }else report.unchanged++;
        // A conflicting field keeps its old baseline until an explicit resolution.
        const nextBaseline={...incoming};for(const c of merged.conflicts)nextBaseline[c.field]=c.baseline;
        await tx.query('UPDATE app.import_bindings SET baseline=$1,last_batch_id=$2 WHERE tenant_id=$3 AND source_id=$4 AND source_key=$5',
          [JSON.stringify(nextBaseline),b,t,input.sourceSpreadsheetId,trip.tripId]);
      }
    }
    await tx.query('INSERT INTO app.import_runs(tenant_id,batch_id,report) VALUES($1,$2,$3)',[t,b,JSON.stringify(report)]);
    return report;
  });
}

// Splits already calculated bonus components, NOT margin, salary or bank receipts.
// The rule belongs to this employee's version. No tenant-wide default share.
export function splitBonus({managerMinor,logisticianMinor,shareBps,basis,dispatcherAssigned}) {
  if(![managerMinor,logisticianMinor].every(v=>typeof v==='string'&&/^\d{1,24}$/.test(v)))throw new Error('BONUS_MUST_BE_NONNEGATIVE_MINOR_UNITS');
  if(!Number.isInteger(shareBps)||shareBps<0||shareBps>10000)throw new Error('INVALID_SHARE');
  if(!['manager','logistician','combined'].includes(basis))throw new Error('INDIVIDUAL_SHARE_BASIS_REQUIRED');
  if(typeof dispatcherAssigned!=='boolean')throw new Error('ASSIGNMENT_REQUIRED');
  const manager=BigInt(managerMinor),logistician=BigInt(logisticianMinor),total=manager+logistician;
  const base=basis==='manager'?manager:basis==='logistician'?logistician:total;
  // Half up to one minor unit; subtract from the donor, never add a second expense.
  const dispatcher=dispatcherAssigned?(base*BigInt(shareBps)+5000n)/10000n:0n;
  return {universalMinor:(total-dispatcher).toString(),dispatcherMinor:dispatcher.toString(),totalMinor:total.toString()};
}
