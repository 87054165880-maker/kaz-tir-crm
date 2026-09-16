import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const files=['001_import_staging.sql','002_source_trip_ids.sql','003_application_core.sql','004_operational_guards.sql','005_individual_rule_patches.sql','006_employee_aliases.sql','007_retire_unused_alias.sql','008_trip_workspace.sql','009_pay_profiles.sql','010_payroll_drafts.sql'];
export async function migrate(db){
 await db.exec('CREATE TABLE IF NOT EXISTS public.kaztir_migrations(name text PRIMARY KEY,sha256 text NOT NULL);REVOKE ALL ON public.kaztir_migrations FROM PUBLIC;');
 for(const name of files){
  const sql=readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'),hash=createHash('sha256').update(sql).digest('hex');
  const prior=await db.query('SELECT sha256 FROM public.kaztir_migrations WHERE name=$1',[name]);
  if(prior.rows.length){if(prior.rows[0].sha256!==hash)throw new Error(`MIGRATION_CHANGED: ${name}`);continue;}
  await db.transaction(async tx=>{
   await tx.exec(sql.replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,''));
   await tx.query('INSERT INTO public.kaztir_migrations(name,sha256) VALUES($1,$2)',[name,hash]);
  });
 }
}
