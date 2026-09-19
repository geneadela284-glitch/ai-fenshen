import test from'node:test';import assert from'node:assert/strict';import{Readable}from'node:stream';import{handleVoiceChatApi}from'./httpApi.js';
const json=async req=>{let raw='';for await(const c of req)raw+=c;return JSON.parse(raw||'{}');};
test('HTTP awaits authenticated startup and only forwards the trusted server validator',async()=>{
 let result,received,release;const trusted=async()=>({accountId:'a'});
 const req=Readable.from([JSON.stringify({consent:true,validateAuthorization:'forged',continuousLifecycle:true})]);req.method='POST';req.headers={host:'example.test','x-ai-expected-account-context':'a'};
 const pending=handleVoiceChatApi({req,res:{},url:new URL('https://example.test/api/voice/chat/sessions'),session:{user:{id:'a'},subject:{accountId:'a'}},validateAuthorization:trusted,runtime:{enabled:true,async create(input){received=input;await new Promise(r=>release=r);return{id:'authenticated'};}},sendJson:(res,status,data)=>result={status,data},readJson:json});
 for(let i=0;i<30&&!release;i++)await new Promise(r=>setImmediate(r));
 assert.equal(result,undefined);assert.equal(received.validateAuthorization,trusted);assert.equal(received.continuousLifecycle,undefined);
 release();await pending;assert.equal(result.data.id,'authenticated');assert.equal(result.status,201);
});
async function call({owner='a',headers={},body={consent:true},enabled=true,method='POST'}={}){let invoked=0,result;const req=Readable.from([JSON.stringify(body)]);req.method=method;req.headers={host:'example.test','x-ai-expected-account-context':'a',origin:'https://example.test',...headers};await handleVoiceChatApi({req,res:{},url:new URL('https://example.test/api/voice/chat/sessions'),session:owner?{user:{id:owner},subject:{accountId:owner}}:{},runtime:{enabled,create(){invoked++;return{id:'synthetic'};}},sendJson:(res,status,data)=>result={status,data},readJson:json});return{invoked,...result};}
test('voice entry rejects no-session, wrong owner, cross-origin, missing consent and disabled service before opening provider',async()=>{
 for(const options of[{owner:null},{owner:'b'},{headers:{origin:'https://evil.test'}},{headers:{'sec-fetch-site':'cross-site'}},{body:{consent:false}},{enabled:false}]){const r=await call(options);assert.equal(r.invoked,0);assert.ok(r.status>=400);}
 const r=await call();assert.equal(r.status,201);assert.equal(r.invoked,1);
});
test('an immediate ASR failure closes SSE without writing another event to an ended response',async()=>{
 const req={method:'GET',headers:{host:'example.test','x-ai-expected-account-context':'a'}};let afterEnd=0,frames=[];
 const res={writableEnded:false,headersSent:false,writeHead(){this.headersSent=true;},write(frame){if(this.writableEnded)afterEnd++;frames.push(frame);},end(){this.writableEnded=true;},on(){}};
 await handleVoiceChatApi({req,res,url:new URL('https://example.test/api/voice/chat/sessions/00000000-0000-0000-0000-000000000000/events'),session:{user:{id:'a'},subject:{accountId:'a'}},runtime:{enabled:true,subscribe(id,owner,listener,close){listener({type:'ended',data:{code:'VOICE_ASR_FAILED'}});close();return()=>{};}},sendJson(){throw Error('must use SSE');},readJson:json});
 assert.equal(afterEnd,0);assert.equal(frames.length,1);assert.match(frames[0],/VOICE_ASR_FAILED/);
});

test('low-latency SSE flushes event bursts with a bounded comment and cancels it on close',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 for(const enabled of [true,false]){
  const id='00000000-0000-0000-0000-000000000000',frames=[];let emit,closeHandler,detached=0;
  const res={writableEnded:false,writableLength:0,writeHead(){},write(s){assert.equal(this.writableEnded,false);frames.push(s);},on(type,handler){if(type==='close')closeHandler=handler;}};
  await handleVoiceChatApi({req:{method:'GET',headers:{host:'example.test','x-ai-expected-account-context':'a'}},res,url:new URL('https://example.test/api/voice/chat/sessions/'+id+'/events'),session:{user:{id:'a'},subject:{accountId:'a'}},runtime:{enabled:true,sessions:new Map([[id,{ownerId:'a',coreOptions:{lowLatency:enabled}}]]),subscribe(id,owner,listener){emit=listener;return()=>detached++;}},sendJson(){throw Error('SSE required');},readJson:json});
  emit({type:'audio',data:{}});emit({type:'audio_end',data:{}});t.mock.timers.tick(20);
  assert.equal(frames.filter(f=>f.startsWith(':')).length,enabled?1:0);
  emit({type:'heartbeat',data:{}});res.writableEnded=true;closeHandler();t.mock.timers.tick(20);assert.equal(detached,1);
 }
});
