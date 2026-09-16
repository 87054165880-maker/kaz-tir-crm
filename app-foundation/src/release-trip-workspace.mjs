// Run only with the local server stopped. Never restores over the working DB.
import {PGlite} from '@electric-sql/pglite';
import {cpSync,mkdtempSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {lockDatabase} from './database-lock.mjs';
import {migrate} from './migrate.mjs';
import {stableId} from './preview.mjs';
import {tenantId,sourceId,asWorkspaceOwner,saveEmployee,employeeDirectory} from './workspace.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),parent=resolve(root,'.local-data'),working=resolve(parent,'kaztir-workspace-pg');
process.umask(0o077);const release=lockDatabase(parent);let db;
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
async function baseline(conn){
 const trips=(await conn.query('SELECT id,trip_number,record FROM app.trips WHERE tenant_id=$1 ORDER BY id',[tenantId])).rows;
 const terms=(await conn.query('SELECT * FROM app.compensation_versions WHERE tenant_id=$1 ORDER BY id',[tenantId])).rows;
 const principals=(await conn.query('SELECT * FROM app.principals ORDER BY database_role')).rows;
 return {trips:trips.length,tripRecordHash:digest(trips),compensationVersions:terms.length,compensationHash:digest(terms),principalsHash:digest(principals)};
}
try{
 const backups=resolve(parent,'backups');mkdirSync(backups,{recursive:true});const backup=mkdtempSync(resolve(backups,'before-trip-workspace-'));
 cpSync(working,resolve(backup,'database'),{recursive:true,errorOnExist:true,force:false});
 // Verify restoration on a copy, not on the backup or the user's database.
 const rehearsal=mkdtempSync('/private/tmp/kaztir-restore-check-');cpSync(resolve(backup,'database'),resolve(rehearsal,'database'),{recursive:true});
 const restored=new PGlite(resolve(rehearsal,'database'));let expected;
 try{expected=await baseline(restored);}finally{await restored.close();}
 db=new PGlite(working);const before=await baseline(db);assert.deepEqual(before,expected,'Backup restoration differs');
 await migrate(db);
 const decisions=JSON.parse(readFileSync(resolve(root,'../planning/import/employee_identity_decisions_2026-09-15.json'),'utf8'));
 const person=decisions.profiles.find(p=>p.key==='alexander-manager');assert.ok(person);assert.equal(decisions.sourceId,sourceId);
 const profileId=stableId(tenantId,'confirmed-person',person.key);
 const identity=await asWorkspaceOwner(db,async tx=>{
  const prior=(await employeeDirectory(tx)).employees.find(p=>p.id===profileId);
  if(prior){assert.ok(prior.aliases.some(a=>a.sourceId===sourceId&&a.role==='manager'&&a.name==='Пример Менеджер'));return {id:profileId,reused:true};}
  return saveEmployee(tx,{id:profileId,version:0,name:person.name,roles:person.roles,aliases:person.aliases.map(a=>({...a,sourceId})),reason:person.roleClarification});
 });
 const captured=JSON.parse(readFileSync(resolve(root,'../planning/import/TR0384_edit_draft_2026-09-15.json'),'utf8'));
 const trip=(await db.query('SELECT id,version,record,manager_id FROM app.trips WHERE tenant_id=$1 AND trip_number=$2',[tenantId,captured.tripNumber])).rows[0];assert.ok(trip);assert.equal(trip.manager_id,profileId);
 const draft=await asWorkspaceOwner(db,async tx=>{
  const prior=(await tx.query('SELECT payload FROM app.trip_edit_drafts WHERE trip_id=$1',[trip.id])).rows[0];
  if(prior&&Object.keys(prior.payload).length)return {reused:true};
  await tx.query('SELECT app.save_trip_edit_draft($1,$2,$3)',[trip.id,trip.version,JSON.stringify({fields:captured.fields,reason:captured.reason})]);
  const saved=(await tx.query('SELECT payload FROM app.trip_edit_drafts WHERE trip_id=$1',[trip.id])).rows[0];assert.deepEqual(saved.payload.fields,captured.fields);return {saved:true};
 });
 const after=await baseline(db);assert.deepEqual(after,before,'Release changed trip facts, pay terms or logins');
 const report={verifiedAt:new Date().toISOString(),backupDirectory:backup,restoreRehearsalDirectory:rehearsal,restoreVerified:true,before,after,identity,draft,TR0384:{id:trip.id,status:trip.record.status,managerLinked:true,recordUnchanged:true},scope:'local only; no Google or bank writes'};
 writeFileSync(resolve(root,'../planning/import/trip_workspace_release_verification_2026-09-15.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify(report,null,2));
}finally{if(db)await db.close();release();}
