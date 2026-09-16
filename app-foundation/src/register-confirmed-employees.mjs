import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {migrate} from './migrate.mjs';
import {lockDatabase} from './database-lock.mjs';
import {stableId} from './preview.mjs';
import {tenantId,sourceId,ensureWorkspaceOperator,asWorkspaceOwner,saveEmployee,employeeDirectory} from './workspace.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),parent=resolve(root,'.local-data');
const decision=JSON.parse(readFileSync(resolve(root,'../planning/import/employee_identity_decisions_2026-09-15.json'),'utf8'));
if(decision.sourceId!==sourceId)throw new Error('WRONG_SOURCE');
const release=lockDatabase(parent),db=new PGlite(resolve(parent,'kaztir-workspace-pg'));const changes=[];
try{
 await migrate(db);await ensureWorkspaceOperator(db);
 const sourceDigest=async()=>createHash('sha256').update(JSON.stringify((await db.query('SELECT id,trip_number,record FROM app.trips WHERE tenant_id=$1 ORDER BY id',[tenantId])).rows)).digest('hex');
 const sourceBefore=await sourceDigest();
 for(const correction of decision.retiredAliases??[]){
  const id=stableId(tenantId,'confirmed-person',correction.key);
  const result=await asWorkspaceOwner(db,async tx=>{
   const prior=(await employeeDirectory(tx)).employees.find(p=>p.id===id);
   if(!prior?.aliases.some(a=>a.sourceId===sourceId&&a.role===correction.role&&a.name===correction.name))return {reused:true,retired:false};
   const {rows}=await tx.query('SELECT app.retire_unused_employee_alias($1,$2,$3,$4,$5,$6) AS result',[id,prior.version,sourceId,correction.role,correction.name,correction.reason]);
   return rows[0].result;
  });changes.push({retiredAlias:correction.name,...result});
 }
 for(const person of decision.profiles){
  const id=stableId(tenantId,'confirmed-person',person.key);
  const result=await asWorkspaceOwner(db,async tx=>{
   const data=await employeeDirectory(tx),prior=data.employees.find(p=>p.id===id);
   const aliases=person.aliases.map(a=>({...a,sourceId}));
   const additionalRoles=person.confirmedAdditionalRoles??[];
   // Do not overwrite an operator's later name/role edits on rerun.
   if(prior&&aliases.every(a=>prior.aliases.some(b=>a.role===b.role&&a.name===b.name&&b.sourceId===sourceId))&&additionalRoles.every(r=>prior.roles.includes(r)))return {id,reused:true,linkedAssignments:0};
   const roles=prior?[...new Set([...prior.roles.filter(r=>['manager','logistician','dispatcher'].includes(r)),...additionalRoles])]:person.roles;
   return saveEmployee(tx,{id,version:prior?.version??0,name:prior?.name??person.name,roles,aliases,reason:person.roleClarification??'Подтверждённые владельцем варианты имени 15.09.2026; без аккаунта и начислений'});
  });changes.push({name:person.name,...result});
 }
 const directory=await asWorkspaceOwner(db,employeeDirectory);
 const {rows:[counts]}=await db.query(`SELECT
  (SELECT count(*)::int FROM app.employees WHERE tenant_id=$1) AS employee_profiles,
  (SELECT count(*)::int FROM app.principals WHERE tenant_id=$1 AND database_role<>'kt_workspace_owner') AS employee_accounts,
  (SELECT count(*)::int FROM app.compensation_versions WHERE tenant_id=$1) AS compensation_versions,
  (SELECT count(*)::int FROM app.trips WHERE tenant_id=$1) AS trips`,[tenantId]);
 const sourceAfter=await sourceDigest();
 if(sourceBefore!==sourceAfter)throw new Error('SOURCE_RECORD_CHANGED_DURING_IDENTITY_UPDATE');
 console.log(JSON.stringify({changes,counts,pendingIdentityQuestions:decision.pending,unlinkedSourceNames:directory.unlinked,
  profiles:directory.employees.map(({id,name,roles,aliases,trips})=>({id,name,roles,aliases,trips})),
  sourceRecordsUnchanged:true,sourceRecordSha256:sourceAfter},null,2));
}finally{await db.close();release();}
