import {mkdirSync,existsSync,lstatSync,readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from './migrate.mjs';
import {loadSnapshot,makeEnvelope,sourceRecords,columnLetter,cellValue} from './snapshot.mjs';
import {stableId} from './preview.mjs';
import {publishSnapshot} from './application.mjs';
import {lockDatabase} from './database-lock.mjs';

// Local, explicitly invoked operator command. No network listener, remote service,
// generated credentials, user accounts, source writes or bank/payroll posting.
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const expectedSource='synthetic-operational-source';
const manifestPath=resolve(root,'../planning/import/snapshots/2026-09-15/manifest.json');
const dataParent=resolve(root,'.local-data'),databasePath=resolve(dataParent,'kaztir-workspace-pg');
const snapshot=loadSnapshot(manifestPath);
if(snapshot.manifest.source.spreadsheetId!==expectedSource)throw new Error('UNEXPECTED_SOURCE');
if(snapshot.controls.some(c=>!snapshot.manifest.files.find(f=>f.path===c.path)?.sha256))throw new Error('CHECKSUM_BASELINE_REQUIRED');
for(const p of [dataParent,databasePath])if(existsSync(p)&&lstatSync(p).isSymbolicLink())throw new Error('SYMLINK_DATA_DIRECTORY_FORBIDDEN');
process.umask(0o077);
mkdirSync(dataParent,{recursive:true,mode:0o700});
const release=lockDatabase(dataParent);
const {envelope}=makeEnvelope(snapshot);
// A deliberate local application tenant, not the preview's synthetic tenant ID.
envelope.tenantId=stableId('local-application-tenant',expectedSource);
let db=new PGlite(databasePath);
try{
 await migrate(db);
 await db.query('INSERT INTO app.tenants(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING',[envelope.tenantId,'KAZ-TIR — локальная база приложения']);
 await db.query('INSERT INTO import_staging.tenants(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING',[envelope.tenantId,'KAZ-TIR — исходные снимки']);
 const publication=await publishSnapshot(db,envelope);
 let sourceCatalogRows=0;
 await db.transaction(async tx=>{
  for(const sheet of ['clients','carriers','cities','routes','trucks','accounts']){
   for(const r of sourceRecords(snapshot.tables.get(sheet))){
    if(typeof r.cells.A!=='string'||!r.cells.A.trim())continue;
    const result=await tx.query(`INSERT INTO app.source_catalog(tenant_id,snapshot_key,source_id,sheet,row_number,values)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING row_number`,
      [envelope.tenantId,envelope.snapshotId,expectedSource,sheet,r.rowNumber,JSON.stringify(r.cells)]);
    sourceCatalogRows+=result.rows.length;
   }
  }
  const employees=JSON.parse(readFileSync(resolve(dirname(manifestPath),'employees_reference.json'),'utf8'));
  const rows=new Map();
  for(const g of employees.data.sheets[0].data)for(let i=0;i<(g.rowData?.length??0);i++){
   const n=(g.startRow??0)+i+1;if(n===1)continue;if(!rows.has(n))rows.set(n,{});
   for(let j=0;j<(g.rowData[i].values?.length??0);j++)rows.get(n)[columnLetter((g.startColumn??0)+j)]=cellValue(g.rowData[i].values[j]);
  }
  for(const [n,values] of rows){
   if(!values.A)continue;
   const result=await tx.query(`INSERT INTO app.source_catalog(tenant_id,snapshot_key,source_id,sheet,row_number,values)
      VALUES($1,$2,$3,'employees',$4,$5) ON CONFLICT DO NOTHING RETURNING row_number`,
      [envelope.tenantId,envelope.snapshotId,employees.data.spreadsheetId,n,JSON.stringify(values)]);
   sourceCatalogRows+=result.rows.length;
  }
 });
 await db.close();db=new PGlite(databasePath);await migrate(db);
 const repeated=await publishSnapshot(db,envelope);
 const {rows:[counts]}=await db.query(`SELECT
  (SELECT count(*)::int FROM app.trips WHERE tenant_id=$1) AS trips,
  (SELECT count(DISTINCT trip_number)::int FROM app.trips WHERE tenant_id=$1) AS unique_trip_ids,
  (SELECT count(*)::int FROM app.source_catalog WHERE tenant_id=$1) AS source_catalog_rows,
  (SELECT count(*)::int FROM import_staging.source_rows WHERE tenant_id=$1) AS private_source_rows,
  (SELECT count(*)::int FROM app.employees WHERE tenant_id=$1) AS employee_profiles,
  (SELECT count(*)::int FROM app.principals WHERE tenant_id=$1 AND database_role<>'kt_workspace_owner') AS employee_accounts,
  (SELECT count(*)::int FROM app.principals WHERE tenant_id=$1 AND database_role='kt_workspace_owner') AS local_operator_principals,
  (SELECT count(*)::int FROM app.principals WHERE tenant_id=$1 AND database_role<>'kt_workspace_owner' AND enabled) AS enabled_employee_accounts,
  (SELECT count(*)::int FROM app.trips t CROSS JOIN LATERAL (VALUES
    (t.manager_id,t.record->>'manager_source_name'),
    (t.logistician_id,t.record->>'logistician_source_name'),
    (t.dispatcher_id,t.record->>'dispatcher_source_name')) AS names(employee_id,source_name)
    WHERE t.tenant_id=$1 AND names.employee_id IS NULL AND btrim(coalesce(names.source_name,''))<>'') AS unresolved_source_assignments,
  (SELECT count(*)::int FROM app.compensation_versions WHERE tenant_id=$1) AS live_compensation_rules`,[envelope.tenantId]);
 const statuses=(await db.query("SELECT record->>'status' AS status,count(*)::int AS n FROM app.trips WHERE tenant_id=$1 GROUP BY record->>'status' ORDER BY status",[envelope.tenantId])).rows;
 if(counts.trips!==366||counts.unique_trip_ids!==366||!repeated.reused)throw new Error('READBACK_OR_REPLAY_CHECK_FAILED');
 console.log(JSON.stringify({mode:'private_local_application_database',sourceSnapshot:envelope.snapshotId,databasePath,
  publication,sourceCatalogRowsAdded:sourceCatalogRows,readback:counts,statuses,durableReopenVerified:true,replayCreatedDuplicates:false,
  realEmployeeAssignmentsResolved:counts.unresolved_source_assignments===0,remoteDeployment:false,
  employeeLoginEnabled:counts.enabled_employee_accounts>0},null,2));
}catch(error){console.error(error.message);process.exitCode=1;}finally{await db.close();release();}
