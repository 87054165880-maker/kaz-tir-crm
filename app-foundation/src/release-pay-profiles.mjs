// User-authorized local settings only. Single writer, verified backup/restore.
import {PGlite} from '@electric-sql/pglite';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,cpSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {lockDatabase} from './database-lock.mjs';
import {migrate} from './migrate.mjs';
import {tenantId,asWorkspaceOwner,employeeDirectory} from './workspace.mjs';
import {stableId} from './preview.mjs';
import {initialPayRules,sourceScale,defaultRole} from '../web/pay-rules.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),parent=resolve(root,'.local-data');
const targets=[{key:'alexander-manager',name:'Пример Менеджер',roles:['manager','logistician']},{key:'olga-logistician',name:'Пример Логист',roles:['logistician']}].map(p=>({...p,id:stableId(tenantId,'confirmed-person',p.key)}));
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function preservedState(db){
 const tables=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='app' AND tablename NOT IN ('audit_events','pay_profiles') ORDER BY tablename")).rows;
 const state={};for(const {tablename}of tables){assert.match(tablename,/^[a-z_]+$/);const rows=(await db.query(`SELECT to_jsonb(t) AS row FROM app.${tablename} t ORDER BY to_jsonb(t)::text`)).rows;state[tablename]={count:rows.length,hash:hash(rows)};}return state;
}
async function seed(tx){
 const directory=await employeeDirectory(tx),changes=[];
 for(const target of targets){
  const employee=directory.employees.find(e=>e.id===target.id);assert.ok(employee,'CONFIRMED_EMPLOYEE_MISSING');assert.equal(employee.name,target.name);for(const role of target.roles)assert.ok(employee.roles.includes(role));
  const requestId=stableId(tenantId,'confirmed-2026-09-15-tier-request',target.key);
  const existing=(await tx.query('SELECT * FROM app.pay_profiles WHERE employee_id=$1 ORDER BY revision DESC',[target.id])).rows;
  if(existing.length){assert.equal(existing.length,1,'EXISTING_SETTINGS_REQUIRE_REVIEW');const p=existing[0];assert.equal(p.request_id,requestId,'EXISTING_SETTINGS_REQUIRE_REVIEW');assert.equal(p.effective_basis,'employment_start');assert.equal(p.valid_from,null);for(const role of target.roles){assert.equal(p.terms.roles[role].method,'progressive');assert.deepEqual(p.terms.roles[role].tiers,sourceScale());}changes.push({name:target.name,reused:true,id:p.id});continue;}
  const terms=initialPayRules(employee);for(const role of target.roles)terms.roles[role]={...(terms.roles[role]??defaultRole()),method:'progressive',tiers:sourceScale()};
  // No invented salaries, own-base settings, dispatcher deductions or hiring date.
  const args=[target.id,null,requestId,employee.terms?.[0]?.id??null,'employment_start',null,JSON.stringify(terms),'Владелец подтвердил 10/15/20% при порогах 2/4 млн; Пример Менеджер — обе роли, Пример Логист — логист; с момента приёма, точная дата не сообщена. Ступенчатый метод из сохранённой payroll!E8. Оклады не задавались.'];
  const sql='SELECT app.save_pay_profile($1,$2,$3,$4,$5,$6,$7,$8) AS id',id=(await tx.query(sql,args)).rows[0].id;
  assert.equal((await tx.query(sql,args)).rows[0].id,id,'RETRY_DUPLICATED');changes.push({name:target.name,roles:target.roles,id,reused:false});
 }return changes;
}
process.umask(0o077);const release=lockDatabase(parent);let db;
try{
 mkdirSync(resolve(parent,'backups'),{recursive:true});const backup=mkdtempSync(resolve(parent,'backups/before-pay-profiles-'));
 cpSync(resolve(parent,'kaztir-workspace-pg'),resolve(backup,'database'),{recursive:true,errorOnExist:true,force:false});
 const rehearsal=mkdtempSync('/private/tmp/kaztir-pay-restore-');cpSync(resolve(backup,'database'),resolve(rehearsal,'database'),{recursive:true});
 const restored=new PGlite(resolve(rehearsal,'database'));let before,rehearsed;
 try{before=await preservedState(restored);await migrate(restored);rehearsed=await asWorkspaceOwner(restored,seed);assert.deepEqual(await preservedState(restored),before);}finally{await restored.close();}
 db=new PGlite(resolve(parent,'kaztir-workspace-pg'));assert.deepEqual(await preservedState(db),before,'BACKUP_RESTORE_MISMATCH');await migrate(db);
 const changes=await db.transaction(async tx=>{await tx.exec('SET LOCAL ROLE kt_workspace_owner');const changed=await seed(tx);await tx.exec('RESET ROLE');assert.deepEqual(await preservedState(tx),before,'UNRELATED_DATA_CHANGED');return changed;});
 const profiles=(await db.query('SELECT employee_id,revision,effective_basis,valid_from,terms FROM app.pay_profiles ORDER BY employee_id,revision')).rows;
 assert.ok(profiles.every(p=>targets.some(t=>t.id===p.employee_id)),'UNEXPECTED_PAY_PROFILES');
 const report={verifiedAt:new Date().toISOString(),backupDirectory:backup,restoreRehearsalDirectory:rehearsal,restoreAndMigrationVerified:true,rehearsed,changes,preserved:before,profiles,bankOperationsCreated:0,payrollPostingsCreated:0,employeeAccountsCreated:0,unknownHiringDates:true,sourceFormulaEvidence:'audit_operational_lk/evidence/payroll.json E8 — local historical snapshot, not fresh Sheets verification'};
 writeFileSync(resolve(root,'../planning/import/pay_profiles_release_verification_2026-09-15.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report,null,2));
}finally{if(db)await db.close();release();}
