import {missingForStatus} from '../web/trip-rules.mjs';
import {employeeDirectory} from './workspace.mjs';
export async function tripDetails(tx,id){
 const row=(await tx.query('SELECT * FROM app.trips WHERE id=$1',[id])).rows[0];
 if(!row)return null;
 const people=(await tx.query('SELECT id,name FROM app.employees WHERE id=ANY($1::uuid[])',[[row.manager_id,row.logistician_id,row.dispatcher_id].filter(Boolean)])).rows;
 row.participant_names=Object.fromEntries(['manager','logistician','dispatcher'].map(role=>[role,people.find(p=>p.id===row[role+'_id'])?.name??null]));
 row.draft=(await tx.query('SELECT base_version,payload,updated_at FROM app.trip_edit_drafts WHERE trip_id=$1',[id])).rows[0]??null;
 return row;
}
export async function tripReferences(tx){
 const rows=(await tx.query("SELECT sheet,values FROM app.source_catalog WHERE sheet IN ('clients','carriers','trucks','cities','accounts') ORDER BY sheet,row_number")).rows;
 const names=sheet=>[...new Set(rows.filter(r=>r.sheet===sheet).map(r=>r.values.A).filter(x=>typeof x==='string'&&x.trim()))];
 const carriers=rows.filter(r=>r.sheet==='carriers'&&typeof r.values.A==='string').map(r=>({name:r.values.A,plate:typeof r.values.G==='string'?r.values.G:null}));
 return {clients:names('clients'),cities:names('cities'),accounts:names('accounts'),carriers,
  trucks:rows.filter(r=>r.sheet==='trucks'&&r.values.A&&(r.values.E??'active')==='active').map(r=>({name:r.values.A,model:r.values.B??''})),
  employees:(await employeeDirectory(tx)).employees.map(({id,name,roles,active})=>({id,name,roles,active}))};
}
export async function saveTrip(tx,id,{version,patch={},assignments={},reason}){
 if(!patch||Array.isArray(patch)||typeof patch!=='object'||!assignments||Array.isArray(assignments)||typeof assignments!=='object')throw new Error('INVALID_PATCH');
 if(Object.values(patch).some(v=>v!==null&&typeof v!=='string'))throw new Error('INVALID_FIELD_TYPE');
 const old=await tripDetails(tx,id);if(!old)throw new Error('ACCESS_DENIED');
 if(old.version!==version)throw new Error('VERSION_CONFLICT');
 let currentVersion=version;
 if(Object.keys(assignments).length){const result=await tx.query('SELECT app.assign_trip_participants($1,$2,$3,$4) AS result',[id,currentVersion,JSON.stringify(assignments),reason]);currentVersion=result.rows[0].result.version;}
 if(Object.keys(patch).length){
  const row=await tripDetails(tx,id);
  if(patch.status){const missing=missingForStatus({...row,record:{...row.record,...patch}},patch.status);if(missing.length)throw new Error('TRIP_NOT_READY: '+missing.join('; '));}
  await tx.query('SELECT app.edit_trip($1,$2,$3,$4)',[id,currentVersion,JSON.stringify(patch),reason]);
 }
 const saved=await tripDetails(tx,id);
 if(saved.version!==version&&old.draft)await tx.query('SELECT app.save_trip_edit_draft($1,$2,$3)',[id,saved.version,'{}']);
 return tripDetails(tx,id);
}
