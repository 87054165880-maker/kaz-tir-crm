// Schema/UI release only; does not seed real salary or tax drafts.
import {PGlite} from '@electric-sql/pglite';
import {writeFileSync,mkdirSync,mkdtempSync,cpSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {lockDatabase} from './database-lock.mjs';
import {migrate} from './migrate.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),parent=resolve(root,'.local-data');
async function state(db){
 const names=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='app' ORDER BY tablename")).rows;
 const result={};for(const {tablename}of names){assert.match(tablename,/^[a-z_]+$/);const rows=(await db.query(`SELECT to_jsonb(t) AS row FROM app.${tablename} t ORDER BY to_jsonb(t)::text`)).rows;result[tablename]={count:rows.length,hash:createHash('sha256').update(JSON.stringify(rows)).digest('hex')};}return result;
}
function unchanged(before,after){for(const table of Object.keys(before))assert.deepEqual(after[table],before[table],'DATA_CHANGED: '+table);if(!before.payroll_drafts)assert.equal(after.payroll_drafts.count,0);}
process.umask(0o077);const unlock=lockDatabase(parent);let db;
try{
 mkdirSync(resolve(parent,'backups'),{recursive:true});const backup=mkdtempSync(resolve(parent,'backups/before-payroll-drafts-'));
 cpSync(resolve(parent,'kaztir-workspace-pg'),resolve(backup,'database'),{recursive:true,errorOnExist:true,force:false});
 const rehearsal=mkdtempSync('/private/tmp/kaztir-payroll-restore-');cpSync(resolve(backup,'database'),resolve(rehearsal,'database'),{recursive:true});
 const copy=new PGlite(resolve(rehearsal,'database'));let before;
 try{before=await state(copy);await migrate(copy);unchanged(before,await state(copy));}finally{await copy.close();}
 db=new PGlite(resolve(parent,'kaztir-workspace-pg'));assert.deepEqual(await state(db),before,'BACKUP_RESTORE_MISMATCH');await migrate(db);const after=await state(db);unchanged(before,after);
 const report={verifiedAt:new Date().toISOString(),backupDirectory:backup,restoreRehearsalDirectory:rehearsal,restoreAndMigrationVerified:true,preserved:before,after,realPayrollDraftsCreated:0,employeeConditionsChanged:false,bankOrSalaryPostingsCreated:0};
 writeFileSync(resolve(root,'../planning/import/payroll_drafts_release_verification_2026-09-15.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report,null,2));
}finally{if(db)await db.close();unlock();}
