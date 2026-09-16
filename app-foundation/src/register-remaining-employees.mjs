// Bounded local onboarding. Requires the workspace server to be stopped.
// No login, pay-term, source-record or Google changes. Exact source aliases only.
import {PGlite} from '@electric-sql/pglite';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,cpSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {lockDatabase} from './database-lock.mjs';
import {migrate} from './migrate.mjs';
import {stableId} from './preview.mjs';
import {tenantId,sourceId,employeeDirectory,saveEmployee} from './workspace.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),parent=resolve(root,'.local-data');
const decisions=JSON.parse(readFileSync(resolve(root,'../planning/import/employee_identity_decisions_2026-09-15.json'),'utf8'));
assert.equal(decisions.sourceId,sourceId);
const keys=['alexander-manager','olga-logistician','serik-s-logistician'];
const targets=keys.map(key=>{const p=decisions.profiles.find(p=>p.key===key);assert.ok(p);return {...p,id:stableId(tenantId,'confirmed-person',key)};});
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
async function state(conn){
 const trips=(await conn.query('SELECT id,trip_number,record,manager_id,logistician_id,dispatcher_id,version FROM app.trips WHERE tenant_id=$1 ORDER BY id',[tenantId])).rows;
 const rows=async sql=>(await conn.query(sql,[tenantId])).rows;
 const terms=await rows('SELECT * FROM app.compensation_versions WHERE tenant_id=$1 ORDER BY id');
 const logins=await rows('SELECT * FROM app.principals WHERE tenant_id=$1 ORDER BY database_role');
 const drafts=await rows('SELECT * FROM app.trip_edit_drafts WHERE tenant_id=$1 ORDER BY employee_id,trip_id');
 return {trips,summary:{tripCount:trips.length,tripRecordHash:hash(trips.map(({id,trip_number,record})=>({id,trip_number,record}))),termsCount:terms.length,termsHash:hash(terms),loginsCount:logins.length,loginsHash:hash(logins),draftsHash:hash(drafts)}};
}
async function register(tx){
 const changes=[];
 for(const person of targets){
  const directory=await employeeDirectory(tx),prior=directory.employees.find(p=>p.id===person.id);
  // Reject a separately created card rather than making a duplicate by display name.
  const sameName=directory.employees.filter(p=>p.name.trim().toLowerCase()===person.name.trim().toLowerCase()&&p.id!==person.id);
  assert.equal(sameName.length,0,'EXISTING_PERSON_REQUIRES_REVIEW: '+person.name);
  const aliases=person.aliases.map(a=>({...a,sourceId}));
  const desiredRoles=prior?[...new Set([...prior.roles.filter(r=>['manager','logistician','dispatcher'].includes(r)),...(person.confirmedAdditionalRoles??[])])]:person.roles;
  if(prior&&aliases.every(a=>prior.aliases.some(b=>a.sourceId===b.sourceId&&a.role===b.role&&a.name===b.name))&&desiredRoles.every(r=>prior.roles.includes(r))){changes.push({name:person.name,reused:true,linkedAssignments:0});continue;}
  const result=await saveEmployee(tx,{id:person.id,version:prior?.version??0,name:prior?.name??person.name,roles:desiredRoles,aliases,reason:person.roleClarification});
  changes.push({name:person.name,...result});
 }
 return changes;
}
process.umask(0o077);const release=lockDatabase(parent);let db;
try{
 const backups=resolve(parent,'backups');mkdirSync(backups,{recursive:true});const backup=mkdtempSync(resolve(backups,'before-remaining-employees-'));
 cpSync(resolve(parent,'kaztir-workspace-pg'),resolve(backup,'database'),{recursive:true,errorOnExist:true,force:false});
 const rehearsal=mkdtempSync('/private/tmp/kaztir-employees-restore-');cpSync(resolve(backup,'database'),resolve(rehearsal,'database'),{recursive:true});
 const restored=new PGlite(resolve(rehearsal,'database'));let restoredState;
 try{restoredState=await state(restored);}finally{await restored.close();}
 db=new PGlite(resolve(parent,'kaztir-workspace-pg'));const before=await state(db);assert.deepEqual(before,restoredState,'BACKUP_RESTORE_MISMATCH');await migrate(db);
 const result=await db.transaction(async tx=>{
  await tx.exec('SET LOCAL ROLE kt_workspace_owner');
  const oldDirectory=await employeeDirectory(tx),changes=await register(tx),repeat=await register(tx);
  assert.ok(repeat.every(x=>x.reused&&x.linkedAssignments===0),'REPEAT_NOT_IDEMPOTENT');
  const directory=await employeeDirectory(tx);
  // All writes used the existing owner-checked RPC. Privileged inspection below
  // is read-only and checks even tables the web runtime must not be able to read.
  await tx.exec('RESET ROLE');
  const after=await state(tx);assert.deepEqual(after.summary,before.summary,'NON_IDENTITY_DATA_CHANGED');
  const oldById=new Map(before.trips.map(t=>[t.id,t]));let bound=0;
  for(const trip of after.trips){const old=oldById.get(trip.id);let changed=0;
   for(const role of ['manager','logistician','dispatcher']){
    if(trip[role+'_id']===old[role+'_id'])continue;
    assert.equal(old[role+'_id'],null,'EXISTING_ASSIGNMENT_CHANGED');
    assert.ok(targets.some(p=>p.id===trip[role+'_id']&&p.aliases.some(a=>a.role===role&&a.name===old.record[role+'_source_name'])),'UNEXPECTED_ASSIGNMENT');changed++;bound++;
   }
   assert.equal(trip.version,old.version+changed,'UNEXPECTED_TRIP_VERSION');
  }
  for(const old of oldDirectory.employees.filter(p=>!targets.some(t=>t.id===p.id)))assert.deepEqual(directory.employees.find(p=>p.id===old.id),old,'UNRELATED_EMPLOYEE_CHANGED');
  return {changes,repeat,bound,after:after.summary,profiles:directory.employees.map(({id,name,roles,aliases,trips})=>({id,name,roles,aliases,trips})),unlinked:directory.unlinked};
 });
 const report={verifiedAt:new Date().toISOString(),backupDirectory:backup,restoreRehearsalDirectory:rehearsal,restoreVerified:true,before:before.summary,...result,employeeAccountsCreated:0,compensationVersionsCreated:0,sourceRecordsChanged:0};
 writeFileSync(resolve(root,'../planning/import/remaining_employees_verification_2026-09-15.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report,null,2));
}finally{if(db)await db.close();release();}
