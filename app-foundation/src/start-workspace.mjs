import {PGlite} from '@electric-sql/pglite';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeFileSync,unlinkSync,readFileSync} from 'node:fs';
import {migrate} from './migrate.mjs';
import {lockDatabase} from './database-lock.mjs';
import {ensureWorkspaceOperator} from './workspace.mjs';
import {createWorkspaceServer} from './web-server.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),parent=resolve(root,'.local-data');
process.umask(0o077);const release=lockDatabase(parent),db=new PGlite(resolve(parent,'kaztir-workspace-pg'));let app,stopping=false;
const descriptor=resolve(parent,'workspace-session.json');
async function stop(){if(stopping)return;stopping=true;try{if(app)await app.close();await db.close();try{const d=JSON.parse(readFileSync(descriptor,'utf8'));if(d.pid===process.pid)unlinkSync(descriptor);}catch(e){if(e.code!=='ENOENT')throw e;}}finally{release();}}
try{await migrate(db);await ensureWorkspaceOperator(db);app=createWorkspaceServer({db});const info=await app.listen();writeFileSync(descriptor,JSON.stringify({...info,pid:process.pid,kind:'temporary_local_owner_access',expiresInMinutes:10}),{mode:0o600});console.log(JSON.stringify({running:true,origin:info.origin,sessionFile:descriptor,scope:'loopback_only',employeeAccountsCreated:0}));process.once('SIGINT',()=>stop().then(()=>process.exit(0)));process.once('SIGTERM',()=>stop().then(()=>process.exit(0)));}catch(e){console.error(e.message);await stop();process.exitCode=1;}
