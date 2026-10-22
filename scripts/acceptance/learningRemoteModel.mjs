// User-authorized synthetic evaluation only. Credentials remain on the existing server.
// Not imported by application or production runtime. Remote source and databases are never changed.
import {spawn} from 'node:child_process';
export const remoteSource=String.raw`
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,randomUUID} from 'node:crypto';
const base='file:///opt/ai-fenshen/releases/20260910T-home-ui-multi-account-g217/';
const {AccessControlStore}=await import(base+'server/access/accessControlStore.js');
const {AccessControlService}=await import(base+'server/access/accessControlService.js');
const {initializeAccessControlSchema}=await import(base+'server/access/accessControlSchema.js');
const {createCoreAiService}=await import(base+'server/coreAiService.js');
const {createMemoryStorage}=await import(base+'core/storage/memoryStorage.js');
class MemoryStore extends AccessControlStore {
 initialize(){this.database=new DatabaseSync(':memory:');this.database.exec('PRAGMA foreign_keys=ON');initializeAccessControlSchema(this.database,{nowIso:()=>this.nowIso()});return this;}
 secureFiles(){} // This subclass owns only an in-memory SQLite database, no files.
}
const store=new MemoryStore({dbPath:'/dev/null'}).initialize();
try{
 const chunks=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>65536)throw Error('INPUT_TOO_LARGE');chunks.push(chunk);}
 const task=JSON.parse(Buffer.concat(chunks).toString());
 if(task.capability!=='CHAT'||task.metadata?.purpose!=='learning_roleplay')throw Error('SYNTHETIC_LEARNING_ONLY');
 const secret=JSON.parse(readFileSync('/run/credentials/ai-fenshen.service/ai-settings.json','utf8'));
 const storage=createMemoryStorage();storage.set('ai-settings',secret['ai-settings']);
 const accessControl=new AccessControlService({store,hmacSecret:randomBytes(32).toString('hex')});
 const accountId='synthetic-learning-evaluation';accessControl.bindAccountProfile({accountId,profileId:'closed_beta_user_v1',enabled:true});
 const subject=accessControl.createAuthenticatedSubject({accountId,role:'beta_user'});
 const requestLease=accessControl.beginRequest({subject,requestId:randomUUID()});
 const ai=createCoreAiService({configPath:'/dev/null',storage,healthStorage:createMemoryStorage(),accessControl});
 try{const result=await ai.run({...task,metadata:{...task.metadata,userId:accountId}}, {subject,requestLease});console.log('LEARNING_RESULT:'+JSON.stringify({ok:result.ok,content:result.content,code:result.code,latency:result.latency,usage:result.usage}));}
 finally{accessControl.releaseRequest(requestLease);}
}catch(error){console.log('LEARNING_RESULT:'+JSON.stringify({ok:false,code:String(error.code||'REMOTE_EVALUATION_FAILED')}));}
finally{store.close();}
`;
const quote=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";
export function createRemoteSyntheticModel({evaluationScope='targeted'}={}){
 // The full 144-case scope is the already-approved curriculum acceptance matrix.
 // Default probes remain capped at 20 calls; curriculum permits two passes per case, never unbounded retries.
 if(!['targeted','curriculum-144'].includes(evaluationScope))throw Error('SYNTHETIC_EVALUATION_SCOPE_INVALID');
 const maxCalls=evaluationScope==='curriculum-144'?288:20;
 let calls=0;return {getStatus:()=>({available:true}),async run(task,invocation={}){
 if(++calls>maxCalls)throw Error('SYNTHETIC_EVALUATION_CALL_LIMIT');
 const args=['-i','/Users/jacky/.ssh/id_ed25519','-o','UserKnownHostsFile=/Users/jacky/Desktop/known_hosts-old-mac','-o','StrictHostKeyChecking=yes','-o','BatchMode=yes','root@45.78.76.88',`node --input-type=module -e ${quote(remoteSource)}`];
 return new Promise((resolve,reject)=>{const child=spawn('ssh',args,{stdio:['pipe','pipe','pipe'],signal:invocation.signal});let output='';const timer=setTimeout(()=>child.kill('SIGTERM'),40000);child.stdout.on('data',chunk=>{output+=chunk;if(output.length>131072)child.kill('SIGTERM');});child.stderr.resume();child.on('error',()=>{clearTimeout(timer);reject(Object.assign(new Error('Remote evaluation stopped'),{code:'REMOTE_EVALUATION_STOPPED'}));});child.on('close',()=>{clearTimeout(timer);const line=output.split('\n').findLast(x=>x.startsWith('LEARNING_RESULT:'));try{if(!line)throw Error();resolve(JSON.parse(line.slice('LEARNING_RESULT:'.length)));}catch{reject(Object.assign(new Error('Remote evaluation unavailable'),{code:'REMOTE_EVALUATION_UNAVAILABLE'}));}});child.stdin.end(JSON.stringify(task));});
 },async stream(){return {ok:false,code:'SYNTHETIC_LEARNING_ONLY'};}};}
