import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { createBetaServer } from '../betaServer.js';
import { createTasksRuntime } from '../tasks/runtime.js';
export async function request(h,route,cookie='',options={}) {
 const res=await fetch(h.baseUrl+route,{method:options.method||'GET',headers:{'content-type':'application/json',...(cookie?{cookie}:{})},...(options.body===undefined?{}:{body:JSON.stringify(options.body)})});
 return {status:res.status,body:await res.json()};
}
export async function createDiaryHarness({enabled=true,publicDir=null,port=0,host='127.0.0.1',directory:chosenDirectory=null,diaryKeyAvailable=true}={}) {
 const directory=chosenDirectory||mkdtempSync('/private/tmp/af-diary-acceptance-');
 const web=publicDir||path.join(directory,'public');mkdirSync(web,{recursive:true});
 if(!publicDir)writeFileSync(path.join(web,'index.html'),'<main>日记隔离验证</main>');
 const tasksRuntime=createTasksRuntime({databasePath:path.join(directory,'tasks.sqlite'),applyMigrations:true});
 const instance=await createBetaServer({config:{publicDir:web,authDb:path.join(directory,'auth.sqlite'),accessControlDb:path.join(directory,'access.sqlite'),privacyDb:path.join(directory,'privacy.sqlite'),privacyExportDir:path.join(directory,'exports'),conversationDb:path.join(directory,'conversation.sqlite'),privacyRequired:true,cookieSecret:randomBytes(32).toString('hex'),secureCookie:false,diaryEnabled:enabled,diaryEncryptionKey:diaryKeyAvailable ? Buffer.alloc(32,71) : null,host,port},tasksRuntime,financeRuntime:null,protectedMemoryRuntime:null,memoryRuntime:{initialize:async()=>({status:'disabled',pathSummary:'synthetic diary acceptance'}),close:async()=>{},service:{}},aiService:{getStatus:()=>({available:true}),async run(){return{ok:false};},async stream(_task,{onDelta}){const content='此隔离验收环境用于日记功能，普通 AI 回复未连接真实模型。';await onDelta(content);return{ok:true,content};}}});
 async function accountSession(username) {
 const password='DiaryTestOnly2026!';
 const account=(await instance.auth.listAccounts()).find(item=>item.username===username) || await instance.auth.createAccount({username,displayName:'日记验收',password,role:'beta_user',quotaProfileId:'closed_beta_user_v1'});
 const login=await instance.auth.login({username,password});
 const notice=instance.privacyLifecycle.notice();
 instance.privacyLifecycle.acceptConsent({ownerId:account.id,accepted:true,privacyNoticeVersion:notice.privacyNoticeVersion,termsVersion:notice.termsVersion,locale:'zh-CN',source:'diary-isolated-test'});
 return {account,login,password,username};
 }
 const a=await accountSession('diary_acceptance');
 await new Promise((resolve,reject)=>{instance.server.once('error',reject);instance.server.listen(port,host,resolve);});
 return {instance,directory,...a,accountSession,baseUrl:`http://127.0.0.1:${instance.server.address().port}`,async close(){await new Promise(resolve=>instance.server.close(resolve));await instance.auth.close();}};
}
