import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {AIRouter} from '../../core/router/AIRouter.js';
import {createVoiceDictationRuntime} from './runtime.js';
import {encodePcm16Wav} from '../../apps/desktop/src/prototypes/aiFenshen/dictationRecorder.js';
const cloud=await import('./cloudSpeech.js').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
function fixture(fetchImpl,overrides={}){
 const calls={begun:0,released:0,reserved:0,settled:0};
 const accessControl={assertAuthenticatedSubject:s=>{if(!s?.accountId)throw Object.assign(Error(),{code:'ACCOUNT_ACCESS_DISABLED'});return s;},beginRequest:()=>{calls.begun++;return {requestId:'test-lease'};},releaseRequest:()=>calls.released++,reserveProviderAttempt:()=>{calls.reserved++;return {request:{}};},settleProviderAttempt:()=>calls.settled++,...overrides};
 const aiService={settings:{load:()=>({providers:{qwen:{enabled:true,baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1'}}})},credentialResolver:{withCredentials:async(_,fn)=>fn({api_key:'synthetic-key'})},router:new AIRouter({accessControl})};
 assert.equal(typeof cloud.createDictationSpeechRuntime,'function','scoped Chinese runtime must exist');
 aiService.router.dictationRuntime=cloud.createDictationSpeechRuntime({aiService,fetchImpl});
 return {calls,aiService,transcribeImpl:cloud.createRoutedDictationTranscriber({aiService,accessControl})};
}
const bytes=Buffer.from(encodePcm16Wav(new Float32Array(16000).fill(0.1)));
const request={ownerId:'owner-a',requestId:'dictation-cloud-0001',audioBytes:bytes,audioHash:createHash('sha256').update(bytes).digest('hex'),format:'audio/wav',sampleRate:16000,durationMs:1000};
const invocation={subject:{accountId:'owner-a'}};
const response=text=>new Response(JSON.stringify({choices:[{message:{content:text}}],usage:{input_tokens:10,output_tokens:5}}),{status:200});

test('Chinese audio reaches scoped Router capability and preserves literal transcript without English filtering',async()=>{
 let sent; const f=fixture(async(url,init)=>{sent={url,init,body:JSON.parse(init.body)};return response('明天下午三点，报价一千二百元。');});
 const result=await f.transcribeImpl({request,invocation,signal:new AbortController().signal});
 assert.equal(result.transcript,'明天下午三点，报价一千二百元。');
 assert.equal(sent.body.asr_options.language,'zh');assert.equal(sent.body.asr_options.enable_itn,false);
 assert.equal(sent.body.messages.length,1);assert.equal(sent.body.messages[0].content[0].input_audio.data,'data:audio/wav;base64,'+bytes.toString('base64'));
 assert.equal(sent.init.redirect,'error');assert.deepEqual(f.calls,{begun:1,released:1,reserved:1,settled:1});
});
test('missing or mismatched trusted account and denied quota never reach network',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return response('错误');});
 for(const subject of [null,{accountId:'other'}])await assert.rejects(f.transcribeImpl({request,invocation:{subject}}));
 assert.equal(calls,0);assert.equal(f.calls.begun,0);
 const denied=fixture(async()=>{calls++;},{reserveProviderAttempt:()=>{throw Object.assign(Error(),{code:'ACCOUNT_USAGE_LIMIT_REACHED'});}});
 await assert.rejects(denied.transcribeImpl({request,invocation}),{code:'ACCOUNT_USAGE_LIMIT_REACHED'});assert.equal(calls,0);assert.equal(denied.calls.released,1);
});
test('failed, empty, malformed and oversized provider replies stop without retries',async()=>{
 for(const make of [()=>new Response('private',{status:503}),()=>response(''),()=>new Response('bad'),()=>response('字'.repeat(70000))]){
 let count=0;const f=fixture(async()=>{count++;return make();});await assert.rejects(f.transcribeImpl({request,invocation}));assert.equal(count,1);assert.equal(f.calls.released,1);
 }
});
test('cancellation after dispatch aborts transport and never produces successful text',async()=>{
 let ready;const started=new Promise(r=>ready=r);const controller=new AbortController();
 const f=fixture(async(_,init)=>{ready();return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));});
 const pending=f.transcribeImpl({request,invocation,signal:controller.signal});await started;controller.abort();await assert.rejects(pending,{code:'CANCELLED'});assert.equal(f.calls.released,1);
});
test('runtime keeps owner/request deduplication around cloud call and reports actual provider',async()=>{
 let count=0;const f=fixture(async()=>{count++;return response('下午三点');});const tempRoot=await mkdtemp(path.join(os.tmpdir(),'dictation-cloud-test-'));
 const runtime=createVoiceDictationRuntime({tempRoot,transcribeImpl:f.transcribeImpl,providerId:'qwen_asr'});
 try{const [a,b]=await Promise.all([runtime.transcribe(request,invocation),runtime.transcribe(request,invocation)]);assert.equal(count,1);assert.equal(a.transcript,'下午三点');assert.equal(a.providerId,'qwen_asr');assert.deepEqual(a,b);assert.equal(a.autoSend,false);}finally{await runtime.close();await rm(tempRoot,{recursive:true,force:true});}
});
test('missing local engine is service-unavailable rather than a hearing failure',async()=>{
 const tempRoot=await mkdtemp(path.join(os.tmpdir(),'dictation-missing-test-'));const runtime=createVoiceDictationRuntime({tempRoot,moduleLoader:async()=>{throw Object.assign(Error(),{code:'ERR_MODULE_NOT_FOUND'});}});
 try{await assert.rejects(runtime.transcribe(request),{code:'ASR_ENGINE_UNAVAILABLE'});}finally{await runtime.close();await rm(tempRoot,{recursive:true,force:true});}
});

test('unapproved endpoint never receives credentials or audio',async()=>{
 let count=0;const f=fixture(async()=>{count++;});f.aiService.settings.load=()=>({providers:{qwen:{enabled:true,baseUrl:'https://attacker.example'}}});await assert.rejects(f.transcribeImpl({request,invocation}),{code:'ASR_ENGINE_UNAVAILABLE'});assert.equal(count,0);assert.equal(f.calls.released,1);
});
test('cloud timeout aborts pending transport and releases quota without retry',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});let ready;const started=new Promise(r=>ready=r);let count=0;
 const f=fixture(async(_,init)=>{count++;ready();return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));});
 const pending=f.transcribeImpl({request,invocation});await started;t.mock.timers.tick(40000);await assert.rejects(pending,{code:'TIMEOUT'});assert.equal(count,1);assert.equal(f.calls.released,1);
});
