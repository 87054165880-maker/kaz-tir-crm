import {readFileSync,writeFileSync,unlinkSync,mkdirSync} from 'node:fs';
import {createWorkspaceServer} from './web-server.mjs';
import {buildSampleReview} from './bank-preview.mjs';
import {applyReviewDecisions} from './bank-review-decisions.mjs';
// Separate loopback process. No PGlite instance, migrations, production lock or
// production session changes. Only authenticated read access to the prepared review.
// Publication demo only: all statements, accounts and decisions are invented.
// This is NOT a universal bank importer and never verifies a real XLSX file.
const fixtures=new URL('../test/fixtures/',import.meta.url);
const sources=JSON.parse(readFileSync(new URL('bank-sources.json',fixtures),'utf8'));
const evidence=JSON.parse(readFileSync(new URL('bank-evidence.json',fixtures),'utf8'));
const decisions=JSON.parse(readFileSync(new URL('bank-decisions.json',fixtures),'utf8'));
const preview=applyReviewDecisions(buildSampleReview(sources,evidence),decisions),app=createWorkspaceServer({db:null,bankPreview:preview,previewOnly:true});
const descriptor=new URL('../.local-data/bank-preview-session.json',import.meta.url);
process.umask(0o077);
mkdirSync(new URL('../.local-data/',import.meta.url),{recursive:true,mode:0o700});
const requestedPort=process.env.KAZTIR_BANK_PREVIEW_PORT===undefined?0:Number(process.env.KAZTIR_BANK_PREVIEW_PORT);
if(!Number.isInteger(requestedPort)||requestedPort<0||requestedPort>65535)throw Error('Некорректный порт предпросмотра');
const info=await app.listen(requestedPort);
writeFileSync(descriptor,JSON.stringify({...info,pid:process.pid,scope:'bank_preview_only',postingEnabled:false}),{mode:0o600});
console.log(JSON.stringify({origin:info.origin,setupUrl:info.setupUrl,counts:preview.counts,synthetic:true,productionDatabaseOpened:false}));
let stopping=false;async function stop(){if(stopping)return;stopping=true;await app.close();try{if(JSON.parse(readFileSync(descriptor,'utf8')).pid===process.pid)unlinkSync(descriptor);}catch(e){if(e.code!=='ENOENT')throw e;}}
process.once('SIGINT',()=>stop().then(()=>process.exit(0)));process.once('SIGTERM',()=>stop().then(()=>process.exit(0)));
