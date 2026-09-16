import {mkdirSync,writeFileSync,readFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
export function lockDatabase(parent){
 const directory=join(parent,'.database.lock'),file=join(directory,'owner.json'),nonce=randomUUID();
 try{mkdirSync(directory,{mode:0o700});}catch(error){if(error.code==='EEXIST')throw new Error('DATABASE_IN_USE: close the local app before running an import; stale locks require operator review');throw error;}
 writeFileSync(file,JSON.stringify({pid:process.pid,nonce,createdAt:new Date().toISOString()}),{mode:0o600,flag:'wx'});
 return ()=>{const owner=JSON.parse(readFileSync(file,'utf8'));if(owner.nonce!==nonce)throw new Error('LOCK_OWNER_CHANGED');unlinkSync(file);rmdirSync(directory);};
}
