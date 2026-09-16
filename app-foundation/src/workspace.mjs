import {stableId} from './preview.mjs';
export const sourceId='synthetic-operational-source';
export const tenantId=stableId('local-application-tenant',sourceId);
export const ownerId=stableId(tenantId,'confirmed-person','marat-owner');
export const ownerRole='kt_workspace_owner';

// Local operator connection, not an employee login/password or public account.
// All web requests still need the temporary owner session and CSRF validation.
export async function ensureWorkspaceOperator(db){
 const tenant=await db.query('SELECT id FROM app.tenants WHERE id=$1',[tenantId]);
 if(!tenant.rows.length)throw new Error('LOCAL_IMPORT_REQUIRED');
 await db.transaction(async tx=>{
  await tx.query('INSERT INTO app.employees(tenant_id,id,name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[tenantId,ownerId,'Пример Владелец']);
  await tx.query("INSERT INTO app.role_grants(tenant_id,employee_id,role) VALUES($1,$2,'owner') ON CONFLICT DO NOTHING",[tenantId,ownerId]);
  if(!(await tx.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[ownerRole])).rows.length)await tx.exec('CREATE ROLE kt_workspace_owner NOLOGIN IN ROLE kaztir_runtime');
  const prior=await tx.query('SELECT tenant_id,employee_id FROM app.principals WHERE database_role=$1',[ownerRole]);
  if(prior.rows.length&&(prior.rows[0].tenant_id!==tenantId||prior.rows[0].employee_id!==ownerId))throw new Error('OPERATOR_IDENTITY_CONFLICT');
  await tx.query('INSERT INTO app.principals(database_role,tenant_id,employee_id,enabled) VALUES($1,$2,$3,true) ON CONFLICT DO NOTHING',[ownerRole,tenantId,ownerId]);
 });
}
export async function asWorkspaceOwner(db,fn){
 return db.transaction(async tx=>{await tx.exec('SET LOCAL ROLE kt_workspace_owner');return fn(tx);});
}
export async function saveEmployee(tx,{id=null,version=0,name,roles,aliases,reason}){
 const result=await tx.query('SELECT app.configure_employee($1,$2,$3,$4,$5,$6) AS result',[id,version,name,roles,JSON.stringify(aliases),reason]);
 return result.rows[0].result;
}
export async function employeeDirectory(tx){
 const employees=(await tx.query(`SELECT e.id,e.name,e.version,e.active,
 COALESCE((SELECT jsonb_agg(g.role ORDER BY g.role) FROM app.role_grants g WHERE g.tenant_id=e.tenant_id AND g.employee_id=e.id AND g.active),'[]') AS roles,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('role',a.source_role,'name',a.source_name,'sourceId',a.source_id) ORDER BY a.source_role,a.source_name) FROM app.employee_aliases a WHERE a.tenant_id=e.tenant_id AND a.employee_id=e.id AND NOT EXISTS(SELECT 1 FROM app.employee_alias_retirements r WHERE r.tenant_id=a.tenant_id AND r.source_id=a.source_id AND r.source_role=a.source_role AND r.normalized_name=a.normalized_name)),'[]') AS aliases,
 (SELECT count(*)::int FROM app.trips t WHERE t.tenant_id=e.tenant_id AND e.id IN(t.manager_id,t.logistician_id,t.dispatcher_id)) AS trips,
 (SELECT jsonb_agg(to_jsonb(v) ORDER BY v.valid_from DESC) FROM app.compensation_versions v WHERE v.tenant_id=e.tenant_id AND v.employee_id=e.id) AS terms,
 (SELECT jsonb_agg(to_jsonb(v) ORDER BY v.revision DESC) FROM app.pay_profiles v WHERE v.tenant_id=e.tenant_id AND v.employee_id=e.id) AS "payProfiles"
 FROM app.employees e ORDER BY e.name`)).rows;
 const unlinked=(await tx.query(`SELECT v.role,v.name,count(*)::int AS trips FROM app.trips t
 CROSS JOIN LATERAL(VALUES('manager',t.record->>'manager_source_name',t.manager_id),('logistician',t.record->>'logistician_source_name',t.logistician_id),('dispatcher',t.record->>'dispatcher_source_name',t.dispatcher_id)) AS v(role,name,employee)
 WHERE v.name IS NOT NULL AND v.name<>'' AND v.employee IS NULL GROUP BY v.role,v.name ORDER BY v.role,v.name`)).rows;
 return {employees,unlinked,sourceId,employeeLoginsEnabled:false};
}
