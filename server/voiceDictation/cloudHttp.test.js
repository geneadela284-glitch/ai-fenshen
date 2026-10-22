import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {AccessControlService} from '../access/accessControlService.js';
import {AccessControlStore} from '../access/accessControlStore.js';
import {AIRouter} from '../../core/router/AIRouter.js';
import {createBetaServer} from '../betaServer.js';
import {encodePcm16Wav} from '../../apps/desktop/src/prototypes/aiFenshen/dictationRecorder.js';

test('actual HTTP session, quota and scoped cloud wiring preserve owner isolation; cloud stays off by default',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'dictation-cloud-http-'));
 const store=new AccessControlStore({dbPath:path.join(dir,'access.sqlite')}).initialize();
 const secret=randomBytes(32).toString('hex');const accessControl=new AccessControlService({store,hmacSecret:secret});
 const aiService={getStatus:()=>({available:true}),settings:{load:()=>({providers:{qwen:{enabled:true,baseUrl:'https://dashscope.aliyuncs.com',apiKey:'fake-key'}}})},router:new AIRouter({accessControl})};
 await mkdir(path.join(dir,'public'));await writeFile(path.join(dir,'public/index.html'),'<title>synthetic</title>');
 const originalFetch=globalThis.fetch;let paidRequests=0;
 globalThis.fetch=async(input,init)=>{const u=new URL(input);if(u.hostname==='127.0.0.1')return originalFetch(input,init);assert.equal(u.href,'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');paidRequests++;return new Response(JSON.stringify({choices:[{message:{content:'明天下午三点'}}],usage:{input_tokens:2,output_tokens:6}}));};
 const config={publicDir:path.join(dir,'public'),authDb:path.join(dir,'auth.sqlite'),cookieSecret:secret,secureCookie:false,privacyRequired:false,dictationCloudEnabled:true};
 let instance;
 try{
 instance=await createBetaServer({config,aiService,accessControl,accessControlStore:store,memoryRuntime:{service:{},initialize:async()=>({status:'disabled'}),close(){}}});
 await new Promise(r=>instance.server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${instance.server.address().port}/api/voice/dictation`;
 const audio=Buffer.from(encodePcm16Wav(new Float32Array(16000).fill(.1)));
 const headers={'Content-Type':'audio/wav','X-Voice-Request-Id':'same-request-0001','X-Voice-Audio-Hash':createHash('sha256').update(audio).digest('hex'),'X-Voice-Format':'audio/wav','X-Voice-Sample-Rate':'16000','X-Voice-Duration-Ms':'1000'};
 assert.equal((await fetch(url,{method:'POST',headers,body:audio})).status,401);assert.equal(paidRequests,0);
 for(const name of ['owner_one','owner_two']){
 await instance.auth.createAccount({username:name,displayName:name,password:'Synthetic-password-123!Ab',role:'beta_user',quotaProfileId:'closed_beta_user_v1'});
 const login=await instance.auth.login({username:name,password:'Synthetic-password-123!Ab'});
 const req={method:'POST',headers:{...headers,Cookie:login.setCookie},body:audio};
 const response=await fetch(url,req);const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));assert.equal(body.transcript,'明天下午三点');assert.equal(body.autoSend,false);assert.equal(body.providerId,'qwen_asr');
 assert.equal((await fetch(url,req)).status,200);
 assert.equal((await fetch(url,{...req,headers:{...req.headers,'X-Owner-Id':'other'}})).status,400);
 }
 assert.equal(paidRequests,2,'two owners must not share cached text; repeats must not call twice');
 // Disabled router capability cannot fall back into generic chat.
 const disabled=new AIRouter({accessControl});await assert.rejects(disabled.run({capability:'DICTATION_ASR'}),{code:'ASR_ENGINE_UNAVAILABLE'});
 }finally{globalThis.fetch=originalFetch;if(instance){await new Promise(r=>instance.server.close(r));instance.auth.close();}else store.close();await rm(dir,{recursive:true,force:true});}
});
