import test from 'node:test';import assert from 'node:assert/strict';
import { VoiceChatEngine } from './engine.js';
function setup(){const calls=[],events=[],muted=[];const media={playing:false,clearPlayback(){},dispose(){},async setMuted(value){muted.push(value)}};
 const engine=new VoiceChatEngine({ownerId:'a',mediaAdapter:media,onEvent:event=>events.push(event),fetchImpl:async(_url,options)=>{const body=JSON.parse(options.body);calls.push(body);return new Response(JSON.stringify({inputEpoch:calls.length}),{headers:{'X-AI-Account-Context':'a'}})}});
 Object.assign(engine,{sessionId:'same-session',conversationId:'same-conversation',epoch:1,inputEpoch:0,ready:true,upload:[],uploading:false,turn:{id:'old',messageId:'old-message'}});engine.update({phase:'speaking',muted:false});return{engine,calls,events,muted};}
test('发送文字暂时停收音但保留同一语音会话；旧片段与晚到结果不能入队',async()=>{
 const {engine,calls,events,muted}=setup();assert.equal(typeof engine.beginExternalInput,'function');
 const lease=await engine.beginExternalInput();assert.equal(engine.sessionId,'same-session');assert.equal(engine.conversationId,'same-conversation');
 const before=events.length;
 for(const type of ['partial','messages','delta','completed','audio','context_required'])engine.event({type,data:{turnId:'old',text:'过期片段',messages:[{id:'late'}]}});
 assert.equal(events.length,before);engine.captureAudio({pcm:new ArrayBuffer(3200),rms:.2});assert.equal(engine.upload.length,0);
 await engine.finishExternalInput(lease);assert.equal(engine.sessionId,'same-session');assert.deepEqual(muted,[true,false]);
 assert.deepEqual(calls.map(c=>[c.type,c.active]),[['external_input',true],['external_input',false]]);engine.sessionId=null;engine.end();
});
test('取消整个语音后，晚到的文字完成不能重新打开麦克风',async()=>{
 const {engine,muted}=setup();assert.equal(typeof engine.beginExternalInput,'function');const lease=await engine.beginExternalInput();engine.end();await engine.finishExternalInput(lease);assert.deepEqual(muted,[true]);assert.equal(engine.sessionId,null);
});
test('本机记忆准备必须绑定当前轮次，迟到的准备结果不能送给另一轮',async()=>{
 let resolve;const {engine,calls}=setup();engine.prepareContext=()=>new Promise(r=>resolve=r);engine.coreOptions={clientContext:true};
 engine.event({type:'context_required',data:{turnId:'new',contextToken:'token',text:'我的偏好',inputEpoch:0}});
 await Promise.resolve();assert.equal(typeof resolve,'function');engine.interrupt();resolve({state:'available'});await new Promise(r=>setTimeout(r,0));assert.equal(calls.filter(c=>c.type==='context').length,0);engine.sessionId=null;engine.end();
});
