import {createServer} from 'node:http';
import {randomBytes,timingSafeEqual,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {asWorkspaceOwner,employeeDirectory,saveEmployee} from './workspace.mjs';
import {tripDetails,tripReferences,saveTrip} from './trip-workspace.mjs';
import {bonusPolicy} from '../web/payroll-rules.mjs';

const digest=v=>createHash('sha256').update(v).digest();
const same=(a,b)=>typeof a==='string'&&timingSafeEqual(digest(a),digest(b));
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statuses=new Set(['Черновик','Планируется','В работе','В пути','Доставлен','Отменено']);
const assets=new Map([
 ['/bank-preview.html',['text/html; charset=utf-8',readFileSync(new URL('../web/bank-preview.html',import.meta.url))]],
 ['/bank-preview.mjs',['text/javascript; charset=utf-8',readFileSync(new URL('../web/bank-preview.mjs',import.meta.url))]],
 ['/bank-preview.css',['text/css; charset=utf-8',readFileSync(new URL('../web/bank-preview.css',import.meta.url))]],
 ['/', ['text/html; charset=utf-8',readFileSync(new URL('../web/index.html',import.meta.url))]],
 ['/app.js',['text/javascript; charset=utf-8',readFileSync(new URL('../web/app.js',import.meta.url))]],
 ['/trip-editor.mjs',['text/javascript; charset=utf-8',readFileSync(new URL('../web/trip-editor.mjs',import.meta.url))]],
 ['/trip-rules.mjs',['text/javascript; charset=utf-8',readFileSync(new URL('../web/trip-rules.mjs',import.meta.url))]],
 ['/pay-editor.mjs',['text/javascript; charset=utf-8',readFileSync(new URL('../web/pay-editor.mjs',import.meta.url))]],
 ['/pay-rules.mjs',['text/javascript; charset=utf-8',readFileSync(new URL('../web/pay-rules.mjs',import.meta.url))]],
 ['/payroll-editor.mjs',['text/javascript; charset=utf-8',readFileSync(new URL('../web/payroll-editor.mjs',import.meta.url))]],
 ['/payroll-rules.mjs',['text/javascript; charset=utf-8',readFileSync(new URL('../web/payroll-rules.mjs',import.meta.url))]],
 ['/app.css',['text/css; charset=utf-8',readFileSync(new URL('../web/app.css',import.meta.url))]],
 ['/pay.css',['text/css; charset=utf-8',readFileSync(new URL('../web/pay.css',import.meta.url))]],
 ['/payroll.css',['text/css; charset=utf-8',readFileSync(new URL('../web/payroll.css',import.meta.url))]]
]);
class HttpError extends Error{constructor(status,message){super(message);this.status=status;}}
async function jsonBody(req){
 if(!req.headers['content-type']?.startsWith('application/json'))throw new HttpError(415,'Ожидается JSON');
 let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>32768)throw new HttpError(413,'Слишком большой запрос');chunks.push(chunk);}
 try{const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!body||Array.isArray(body)||typeof body!=='object')throw new Error();return body;}catch{throw new HttpError(400,'Некорректный JSON');}
}
export function createWorkspaceServer({db,bankPreview=null,previewOnly=false,ownerKey=randomBytes(32).toString('base64url'),now=()=>Date.now()}){
 const sessions=new Map();let used=false,origin,cookieName,loginAttempts=[];const expires=now()+10*60_000;
 const server=createServer({requestTimeout:15000,headersTimeout:10000,maxHeaderSize:8192,keepAliveTimeout:1000},async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
  try{
   if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==new URL(origin).host)throw new HttpError(403,'Локальный доступ запрещён');
   const url=new URL(req.url,origin),path=url.pathname;
   if(req.method==='GET'&&assets.has(path)){const[type,data]=assets.get(previewOnly&&path==='/'?'/bank-preview.html':path);res.writeHead(200,{'Content-Type':type});res.end(data);return;}
   if(!path.startsWith('/api/'))throw new HttpError(404,'Не найдено');
   if(!['GET','POST','PATCH'].includes(req.method))throw new HttpError(405,'Метод запрещён');
   if(req.method!=='GET'&&(req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site'))throw new HttpError(403,'Проверка источника запроса не пройдена');
   if(path==='/api/session'&&req.method==='POST'){
    loginAttempts=loginAttempts.filter(t=>now()-t<60_000);if(loginAttempts.length>=10)throw new HttpError(429,'Повторите вход позже');loginAttempts.push(now());
    const body=await jsonBody(req);if(used||now()>expires||!same(body.key,ownerKey))throw new HttpError(401,'Ссылка входа недействительна или уже использована');
    used=true;const token=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url');
    sessions.set(digest(token).toString('hex'),{csrf,created:now(),last:now()});
    res.setHeader('Set-Cookie',`${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
    send(200,{ok:true});return;
   }
   const cookie=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1);
   const key=cookie?digest(cookie).toString('hex'):null,session=key?sessions.get(key):null;
   if(!session||now()-session.created>8*3600_000||now()-session.last>30*60_000){if(key)sessions.delete(key);throw new HttpError(401,'Нужен локальный вход владельца');}
   if(req.method!=='GET'&&!same(req.headers['x-csrf-token'],session.csrf))throw new HttpError(403,'Не пройдена проверка сохранения');
   session.last=now();
   if(path==='/api/me'&&req.method==='GET'){send(200,{name:'Пример Владелец',mode:'local_owner',csrf:session.csrf,sourceDate:'15.09.2026',employeeAccountsEnabled:false});return;}
   if(path==='/api/logout'&&req.method==='POST'){sessions.delete(key);res.setHeader('Set-Cookie',`${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);send(200,{ok:true});return;}
   if(path==='/api/bank-preview'&&req.method==='GET'){
    if(!bankPreview)throw new HttpError(404,'Предпросмотр выписок ещё не подготовлен');
    send(200,bankPreview);return;
   }
   if(previewOnly)throw new HttpError(405,'Здесь доступен только предпросмотр. Запись в учёт отключена.');
   const result=await asWorkspaceOwner(db,async tx=>{
    if(path==='/api/summary'&&req.method==='GET'){
     const counts=(await tx.query("SELECT record->>'status' AS status,count(*)::int AS count FROM app.trips GROUP BY record->>'status'")).rows;
     return {statuses:counts,total:counts.reduce((s,v)=>s+v.count,0)};
    }
    if(path==='/api/employees'&&req.method==='GET')return employeeDirectory(tx);
    if(path==='/api/trip-references'&&req.method==='GET')return tripReferences(tx);
    if(path==='/api/trips'&&req.method==='POST'){
     const body=await jsonBody(req);if(!uuid.test(body.requestId??''))throw new HttpError(400,'Нужен ключ новой заявки');
     return (await tx.query('SELECT app.create_trip($1,$2,$3,$4) AS result',[body.requestId,JSON.stringify(body.record),JSON.stringify(body.assignments??{}),body.reason])).rows[0].result;
    }
    if(path==='/api/employees'&&req.method==='POST'){
     const body=await jsonBody(req);if(body.id&&!uuid.test(body.id))throw new HttpError(400,'Некорректная карточка');
     if(!Number.isInteger(body.version)||body.version<0||!Array.isArray(body.roles)||!Array.isArray(body.aliases)||body.aliases.length>30)throw new HttpError(400,'Проверьте роли и варианты имени');
     return saveEmployee(tx,body);
    }
    if(path==='/api/payroll-drafts'&&req.method==='GET'){
     const e=url.searchParams.get('employeeId'),period=url.searchParams.get('period');
     if(!uuid.test(e??'')||(period!==null&&!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)))throw new HttpError(400,'Проверьте сотрудника и месяц');
     const entries=(await tx.query('SELECT id,employee_id,period,revision,previous_id,payload,reason,created_at,app.payroll_draft_totals(payload) AS totals FROM app.payroll_drafts WHERE employee_id=$1 AND ($2::text IS NULL OR period=$2) ORDER BY period DESC,revision DESC',[e,period])).rows;
     return {policy:bonusPolicy,entries,confirmedPayrollAvailable:false};
    }
    if(path==='/api/payroll-drafts'&&req.method==='POST'){
     const b=await jsonBody(req);if(!uuid.test(b.employeeId??'')||!uuid.test(b.requestId??'')||(b.previousId!=null&&!uuid.test(b.previousId)))throw new HttpError(400,'Проверьте сотрудника и версию');
     return (await tx.query('SELECT app.save_payroll_draft($1,$2,$3,$4,$5,$6) AS result',[b.employeeId,b.period,b.previousId??null,b.requestId,JSON.stringify(b.payload),b.reason])).rows[0].result;
    }
    if(path==='/api/pay-profiles'&&req.method==='POST'){
     const body=await jsonBody(req);
     if(!uuid.test(body.employeeId??'')||!uuid.test(body.requestId??'')||[body.previousId,body.legacyBasisId].some(v=>v!=null&&!uuid.test(v))||(body.validFrom!=null&&!/^\d{4}-\d{2}-\d{2}$/.test(body.validFrom)))throw new HttpError(400,'Проверьте сотрудника, версию и дату');
     return (await tx.query('SELECT app.save_pay_profile($1,$2,$3,$4,$5,$6,$7,$8) AS id',[body.employeeId,body.previousId??null,body.requestId,body.legacyBasisId??null,body.effectiveBasis,body.validFrom??null,JSON.stringify(body.terms),body.reason])).rows[0];
    }
    if(path==='/api/terms'&&req.method==='POST'){
     const body=await jsonBody(req);if(!uuid.test(body.employeeId??'')||!/^\d{4}-\d{2}-\d{2}$/.test(body.validFrom??''))throw new HttpError(400,'Проверьте сотрудника и дату');
     return (await tx.query('SELECT app.set_compensation($1,$2,$3,$4,$5) AS id',[body.employeeId,body.validFrom,body.previousId??null,JSON.stringify(body.terms),body.reason])).rows[0];
    }
    if(path==='/api/trips'&&req.method==='GET'){
     const q=(url.searchParams.get('q')??'').trim().slice(0,120),status=url.searchParams.get('status')??'',offset=Number(url.searchParams.get('offset')??0);
     if((status&&!statuses.has(status))||!Number.isInteger(offset)||offset<0||offset>100000)throw new HttpError(400,'Некорректный фильтр');
     const filter="($1='' OR position(lower($1) in lower(trip_number||' '||COALESCE(record->>'client_name','')||' '||COALESCE(record->>'carrier_name','')||' '||COALESCE(record->>'start_city','')||' '||COALESCE(record->>'end_city','')))>0) AND ($2='' OR record->>'status'=$2)";
     const total=(await tx.query(`SELECT count(*)::int AS n FROM app.trips WHERE ${filter}`,[q,status])).rows[0].n;
     const rows=(await tx.query(`SELECT t.id,t.trip_number,t.record,t.version,t.manager_id,t.logistician_id,t.dispatcher_id,t.commercial_review_required,
      jsonb_build_object('manager',(SELECT name FROM app.employees WHERE tenant_id=t.tenant_id AND id=t.manager_id),'logistician',(SELECT name FROM app.employees WHERE tenant_id=t.tenant_id AND id=t.logistician_id),'dispatcher',(SELECT name FROM app.employees WHERE tenant_id=t.tenant_id AND id=t.dispatcher_id)) AS participant_names
      FROM app.trips t WHERE ${filter} ORDER BY imported ASC,trip_number DESC LIMIT 40 OFFSET $3`,[q,status,offset])).rows;
     return {rows,total,offset,limit:40};
    }
    const draftMatch=/^\/api\/trips\/([0-9a-f-]+)\/draft$/.exec(path);
    if(draftMatch&&uuid.test(draftMatch[1])&&req.method==='POST'){
     const body=await jsonBody(req);if(!Number.isInteger(body.baseVersion))throw new HttpError(400,'Нужна исходная версия рейса');
     await tx.query('SELECT app.save_trip_edit_draft($1,$2,$3)',[draftMatch[1],body.baseVersion,JSON.stringify(body.payload)]);return {saved:true,tripUpdated:false};
    }
    const match=/^\/api\/trips\/([0-9a-f-]+)$/.exec(path);
    if(match&&uuid.test(match[1])){
     if(req.method==='GET'){
      const row=await tripDetails(tx,match[1]);
      if(!row)throw new HttpError(404,'Рейс не найден');return row;
     }
     if(req.method==='PATCH'){
      const body=await jsonBody(req);if(!Number.isInteger(body.version))throw new HttpError(400,'Нужна версия рейса');
      return saveTrip(tx,match[1],body);
     }
    }
    throw new HttpError(404,'Не найдено');
   });
   send(200,result);
  }catch(error){
   const known=/^(PAYROLL_|EMPLOYEE_|ALIAS_|TRIP_|UNSUPPORTED_EMPLOYEE_|INVALID_|FIELD_FORBIDDEN|VERSION_CONFLICT|FINANCIAL_LINKS_|CONFIRMED_TRIP_|COMPENSATION_|DISPATCHER_|RETROACTIVE_|TERMS_|ROLE_STATUS_|STATUS_TRANSITION_|MISSING_|REQUIRED_FIELD|POSITIVE_REVENUE|TYPE_|FLEET_|CREATE_|NEW_TRIP_|ASSIGNMENT_|UNKNOWN_|OWN_CARRIER_|CARRIER_PLATE_|PATCH_)/.test(error.message);
   const status=error.status??(known?409:500);send(status,{error:status===500?'Операция не выполнена. Данные не подтверждены.':error.message});
  }
 });
 return {server,ownerKey,async listen(port=0){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});origin=`http://127.0.0.1:${server.address().port}`;cookieName=`kaztir_owner_${server.address().port}`;return {origin,setupUrl:`${origin}/#key=${ownerKey}`};},async close(){sessions.clear();if(!server.listening)return;await new Promise((r,j)=>server.close(e=>e?j(e):r()));}};
}
