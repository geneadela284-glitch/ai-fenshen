import test from'node:test';import assert from'node:assert/strict';import{DatabaseSync}from'node:sqlite';
import{createConversationRuntime}from'../conversation/runtime.js';import{createVoiceChatRuntime}from'./runtime.js';
const wait=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,2));}throw Error('WAIT_TIMEOUT');};
function harness(t,{assistantOverride,clock=Date.now,coreOptions={},mediaProtocol=1,asrRun}={}){const database=new DatabaseSync(':memory:');let asr;const released=[],events=[],ttsTasks=[];let ttsCalls=0;
 const ai={settings:{load:()=>({})},router:{async run(task){if(task.capability==='VOICE_CHAT_ASR'){asr=task;if(asrRun)return asrRun(task);task.onReady({append(){},finish(){}});await new Promise(r=>task.signal.addEventListener('abort',r,{once:true}));return{};}ttsCalls++;ttsTasks.push(task);for await(const text of task.text){if(!task.signal.aborted)task.onAudio(Buffer.alloc(480));}return{};}},async stream(task,{onDelta,signal},invocation){assert.equal(task.metadata.requestId,invocation.requestLease.requestId,'voice text uses the same authenticated lease identity');await onDelta('你好。');return{ok:true,content:'你好。'};}};
 const accessControl={assertAuthenticatedSubject:subject=>subject,beginRequest:({requestId})=>({requestId}),releaseRequest:l=>released.push(l)};
 const base=createConversationRuntime({database,aiService:ai,applyMigrations:true});
 const runtime=createVoiceChatRuntime({enabled:true,clock,coreOptions,conversationRuntime:base,aiService:ai,accessControl,assistantOverride:assistantOverride||{async processUserMessage(){return{handled:false};}}});
 t.after(async()=>{await runtime.close();base.close();database.close();});
 const s=runtime.create({user:{id:'a'},subject:{accountId:'a'},mediaProtocol});runtime.subscribe(s.id,'a',event=>events.push(event),()=>{});
 return{runtime,s,events,getAsr:()=>asr,base,released,ai,getTtsCalls:()=>ttsCalls,getTtsTasks:()=>ttsTasks};}
test('70-second ASR rotation buffers a three-second handshake and drains pressure in order',async t=>{
 let now=0;const connections=[],received=[];let budget=4,canFinish=false;
 t.mock.timers.enable({apis:['setInterval']});
 const h=harness(t,{clock:()=>now,asrRun:task=>new Promise(resolve=>{
  const handle={append:bytes=>{if(!budget)return false;budget--;received.push(bytes[0]);return true;},finish:()=>{if(!canFinish)return false;resolve();return true;}};
  connections.push({task,handle});task.signal.addEventListener('abort',resolve,{once:true});if(connections.length===1)task.onReady(handle);
 })});
 for(let i=0;i<14;i++){now+=5000;h.runtime.control(h.s.id,'a',{type:'heartbeat'});h.getAsr().onSpeechStart();t.mock.timers.tick(5000);}
 h.getAsr().onSpeechStop();now+=3000;t.mock.timers.tick(3000);assert.equal(h.runtime.sessions.get(h.s.id).asr,connections[0].handle);
 canFinish=true;now+=1000;t.mock.timers.tick(1000);await wait(()=>connections.length===2);
 for(let i=0;i<15;i++){now+=200;h.runtime.audio(h.s.id,'a',Buffer.alloc(6400,i),i);t.mock.timers.tick(200);}
 connections[1].task.onReady(connections[1].handle);
 h.runtime.audio(h.s.id,'a',Buffer.alloc(6400,15),15);
 assert.deepEqual(received,[0,1,2,3]);
 budget=20;now+=20;t.mock.timers.tick(20);
 assert.deepEqual(received,Array.from({length:16},(_,i)=>i));assert.equal(h.runtime.sessions.has(h.s.id),true);
 assert.equal(h.events.some(e=>e.type==='ended'),false);
});
test('synthesis connects as soon as visible text arrives, overlapping the rest of generation',async t=>{
 const h=harness(t);let connectedBeforeSentence=false;
 h.ai.stream=async(task,{onDelta})=>{onDelta('这是一个还没有结束的句子');await wait(()=>h.getTtsCalls()===1);connectedBeforeSentence=true;onDelta('，我们继续聊。');return{ok:true,content:'这是一个还没有结束的句子，我们继续聊。'};};
 h.getAsr().onTranscript('我们聊聊');await wait(()=>h.events.some(e=>e.type==='audio_end'||e.type==='ended'));
 assert.equal(connectedBeforeSentence,true);assert.ok(h.events.some(e=>e.type==='audio_end'));
});
test('low-latency synthesis warms its connection before the first answer delta',async t=>{
 const h=harness(t,{coreOptions:{lowLatency:true}});
 h.ai.stream=async(task,{onDelta})=>{
  await wait(()=>h.getTtsCalls()===1);
  await onDelta('你好。');
  return{ok:true,content:'你好。'};
 };
 h.getAsr().onTranscript('你好');
 await wait(()=>h.events.some(e=>e.type==='audio_end'||e.type==='ended'));
 assert.equal(h.events.some(e=>e.type==='audio_end'),true);
});
test('TTS first-chunk commit follows the negotiated low-latency mode',async t=>{
 for(const [lowLatency,expected] of [[true,true],[false,false]]){
  const h=harness(t,{coreOptions:{lowLatency}});h.getAsr().onTranscript('你好');
  await wait(()=>h.events.some(e=>e.type==='audio_end'||e.type==='ended'));
  assert.equal(h.getTtsTasks()[0].commitFirstTextChunk===true,expected);
 }
});
test('ordinary voice answers pass a bounded output budget to the AI stream',async t=>{
 const h=harness(t,{coreOptions:{ordinaryChat:true}});let received;
 h.ai.stream=async(task,{onDelta})=>{received=task;await onDelta('周末可以去公园散步。');return{ok:true,content:'周末可以去公园散步。'};};
 h.getAsr().onTranscript('周末想出去散步，给我一个简单建议。');await wait(()=>h.events.some(e=>e.type==='audio_end'));
 assert.equal(received.options.maxTokens,256);
 assert.equal(received.metadata.voiceOrdinaryChat,true);
 assert.equal(received.metadata.voiceRealtimeOnly,true);
});
test('ordinary voice context keeps recent advice without sending stale business history',async t=>{
 const h=harness(t,{coreOptions:{ordinaryChat:true}});
 const seed=[
  ['明天提醒我开会','几点？'],
  ['周末想出去散步，给我一个简单建议。','可以去附近公园走走。'],
  ['那下雨的话呢？','可以去室内博物馆。'],
  ['还有别的选择吗？','也可以去购物中心。']
 ];
 for(const [index,[user,assistant]] of seed.entries()){
  const userMessage=h.base.messages.createUserMessage({ownerId:'a',conversationId:h.s.conversationId,content:user,clientRequestId:`seed-${index}`});
  const placeholder=h.base.messages.createAssistantPlaceholder({ownerId:'a',conversationId:h.s.conversationId,clientRequestId:`seed-${index}`});
  h.base.messages.completeAssistantMessage({ownerId:'a',messageId:placeholder.id,content:assistant});
  assert.ok(userMessage.id);
 }
 let received;
 h.ai.stream=async(task,{onDelta})=>{received=task.messages;await onDelta('可以去室内展馆。');return{ok:true,content:'可以去室内展馆。'};};
 h.getAsr().onTranscript('那下雨的话呢？');await wait(()=>h.events.some(e=>e.type==='audio_end'));
 const visible=received.filter(message=>message.role!=='system');
 assert.ok(visible.length<=8);
 assert.equal(visible.some(message=>message.content==='明天提醒我开会'),false);
 assert.ok(visible.some(message=>message.content==='还有别的选择吗？'));
 assert.ok(visible.some(message=>message.content==='也可以去购物中心。'));
});
for(const greeting of ['我说：“嗨，你好啊。”','早上好','听得到吗'])test('voice greeting preserves business history with a current-turn boundary: '+greeting,async t=>{
 const h=harness(t,{coreOptions:{ordinaryChat:true}});
 h.base.messages.createUserMessage({ownerId:'a',conversationId:h.s.conversationId,content:'明天提醒我开会',clientRequestId:'prior'});
 const previous=h.base.messages.createAssistantPlaceholder({ownerId:'a',conversationId:h.s.conversationId,clientRequestId:'prior'});
 h.base.messages.completeAssistantMessage({ownerId:'a',messageId:previous.id,content:'几点？'});
 let received;
 h.ai.stream=async(task,{onDelta})=>{received=task.messages;
  await onDelta('嗨，你好。');return{ok:true,content:'嗨，你好。'};};
 h.getAsr().onTranscript(greeting);await wait(()=>h.events.some(e=>e.type==='audio_end'||e.type==='ended'));
 assert.ok(received.some(m=>m.role==='user'&&m.content==='明天提醒我开会'));
 const policy=received.filter(m=>m.role==='system').map(m=>m.content).join('\n');assert.match(policy,/本轮是独立问候/);assert.match(policy,/不要主动续办/);
 assert.equal(h.events.some(e=>e.type==='ended'),false);
});
for(const [message,ordinaryChat] of [['讲个笑话',true],['你好',false]])test('greeting-only policy does not alter content requests or flag-off: '+message,async t=>{
 const h=harness(t,{coreOptions:{ordinaryChat}});let received;
 h.ai.stream=async(task,{onDelta})=>{received=task.messages;await onDelta('可以。');return{ok:true,content:'可以。'};};
 h.getAsr().onTranscript(message);await wait(()=>h.events.some(e=>e.type==='audio_end'));
 assert.ok(received.every(m=>!m.content.includes('本轮是独立问候')));
});
test('ASR waiting remains byte bounded and invalid audio never becomes queued speech',async t=>{
 const h=harness(t);h.runtime.sessions.get(h.s.id).asr={append:()=>false};
 assert.throws(()=>h.runtime.audio(h.s.id,'b',Buffer.alloc(6400),0),{code:'VOICE_SESSION_NOT_FOUND'});
 assert.throws(()=>h.runtime.audio(h.s.id,'a',Buffer.alloc(3),0),{code:'VOICE_AUDIO_INVALID'});
 for(let i=0;i<50;i++)h.runtime.audio(h.s.id,'a',Buffer.alloc(6400),i);
 assert.throws(()=>h.runtime.audio(h.s.id,'a',Buffer.alloc(6400),50),{code:'VOICE_BACKPRESSURE'});
 assert.equal(h.runtime.sessions.has(h.s.id),false);assert.equal(h.events.at(-1).data.code,'VOICE_BACKPRESSURE');
});
test('a stalled ASR drain stops at its deadline even without further uploads',async t=>{
 let now=1000;t.mock.timers.enable({apis:['setInterval']});const h=harness(t,{clock:()=>now});
 h.runtime.sessions.get(h.s.id).asr={append:()=>false};h.runtime.audio(h.s.id,'a',Buffer.alloc(6400),0);
 now+=9999;t.mock.timers.tick(9999);assert.equal(h.runtime.sessions.has(h.s.id),true);
 now+=21;t.mock.timers.tick(21);assert.equal(h.runtime.sessions.has(h.s.id),false);assert.equal(h.events.at(-1).data.code,'VOICE_BACKPRESSURE');
});
test('mute and end discard queued microphone epochs and ignore late ASR readiness',async t=>{
 const connections=[],received=[];let now=0;t.mock.timers.enable({apis:['setInterval']});
 const h=harness(t,{clock:()=>now,asrRun:task=>new Promise(resolve=>{connections.push(task);task.signal.addEventListener('abort',resolve,{once:true});})});
 h.runtime.audio(h.s.id,'a',Buffer.alloc(6400,1),0);
 h.runtime.control(h.s.id,'a',{type:'mute',muted:true});h.runtime.control(h.s.id,'a',{type:'mute',muted:false});
 const handle={append:bytes=>{received.push(bytes[0]);return true;},finish(){}};
 connections[0].onReady(handle);h.runtime.audio(h.s.id,'a',Buffer.alloc(6400,2),1,0);
 connections[1].onReady(handle);h.runtime.audio(h.s.id,'a',Buffer.alloc(6400,9),2,2);
 assert.deepEqual(received,[9]);h.runtime.sessions.get(h.s.id).asr={append:()=>false};h.runtime.audio(h.s.id,'a',Buffer.alloc(6400,8),3,2);
 h.runtime.control(h.s.id,'a',{type:'end'});connections[1].onReady(handle);now+=12000;t.mock.timers.tick(12000);
 assert.deepEqual(received,[9]);assert.equal(h.events.filter(e=>e.type==='ended').length,1);
});
test('speech activity alone does not cancel an answer before recognized words arrive',async t=>{
 let finish;const h=harness(t,{assistantOverride:{processUserMessage:()=>new Promise(r=>finish=r)}});
 h.getAsr().onTranscript('聊聊旅行');await wait(()=>finish);const turn=h.runtime.sessions.get(h.s.id).turn;
 h.getAsr().onSpeechStart();const aborted=turn.controller.signal.aborted;finish({handled:false});
 assert.equal(aborted,false);await wait(()=>h.events.some(e=>e.type==='audio_end'));
});
test('queued utterance fragments are kept in order while a cancelled request settles',async t=>{
 let finish,calls=0;const h=harness(t,{assistantOverride:{processUserMessage(){if(++calls===1)return new Promise(r=>finish=r);return{handled:false};}}});
 h.getAsr().onTranscript('先聊旅行');await wait(()=>finish);
 h.getAsr().onTranscript('我想去海边');h.getAsr().onTranscript('预算大约两千');h.getAsr().onTranscript('帮我安排两天');
 finish({handled:false});await wait(()=>h.events.some(e=>e.type==='audio_end'));
 const users=h.base.messages.listForConversationOwner(h.s.conversationId,'a').filter(m=>m.role==='user');
 assert.equal(users.at(-1).content,'我想去海边\n预算大约两千\n帮我安排两天');
});
test('recognized long playback echo cannot create a user turn; a distinct interruption still can',async t=>{
 const answer='我们可以先安排周六去海边散步。';const h=harness(t,{assistantOverride:{processUserMessage:()=>({handled:true,domain:'ordinary_chat',content:answer})}});
 h.getAsr().onTranscript('周末去哪里');await wait(()=>h.events.some(e=>e.type==='audio_end'));
 h.getAsr().onSpeechStart();h.getAsr().onTranscript(answer,'echo-1');await new Promise(r=>setTimeout(r,10));
 assert.equal(h.base.messages.listForConversationOwner(h.s.conversationId,'a').length,2);
 assert.ok(h.events.some(e=>e.type==='echo_ignored'));
 h.getAsr().onSpeechStart();h.getAsr().onTranscript('不去海边了，聊聊露营','real-2');await wait(()=>h.events.filter(e=>e.type==='audio_end').length===2);
 assert.equal(h.base.messages.listForConversationOwner(h.s.conversationId,'a').filter(m=>m.role==='user').at(-1).content,'不去海边了，聊聊露营');
});
test('twenty synthetic conversation rounds share history; audio receipts preserve owner isolation',async t=>{const h=harness(t);await wait(()=>h.getAsr());for(let i=0;i<20;i++){h.getAsr().onTranscript('第'+i+'句话');await wait(()=>h.events.filter(e=>e.type==='audio_end').length===i+1);const last=h.events.findLast(e=>e.type==='audio_end');h.runtime.control(h.s.id,'a',{type:'receipt',turnId:last.data.turnId,messageId:last.data.messageId,status:'completed',completedSegments:last.data.segments});}assert.equal(h.getTtsCalls(),20);assert.equal(h.base.messages.listForConversationOwner(h.s.conversationId,'a').length,40);assert.throws(()=>h.runtime.audio(h.s.id,'b',Buffer.alloc(3200),0));assert.throws(()=>h.runtime.control(h.s.id,'b',{type:'end'}));h.runtime.control(h.s.id,'a',{type:'end'});assert.equal(h.runtime.sessions.size,0);});
test('interrupt cancels current synthesis and invalid old receipts; duplicate sessions and sequenced audio enforced',async t=>{const h=harness(t);await wait(()=>h.getAsr());assert.throws(()=>h.runtime.create({user:{id:'a'},subject:{accountId:'a'}}),{code:'VOICE_ALREADY_ACTIVE'});h.runtime.audio(h.s.id,'a',Buffer.alloc(3200),0);assert.throws(()=>h.runtime.audio(h.s.id,'a',Buffer.alloc(3200),0),{code:'VOICE_AUDIO_INVALID'});h.getAsr().onTranscript('你好');await wait(()=>h.events.some(e=>e.type==='audio_end'));const last=h.events.findLast(e=>e.type==='audio_end');h.runtime.control(h.s.id,'a',{type:'interrupt'});assert.throws(()=>h.runtime.control(h.s.id,'a',{type:'receipt',turnId:last.data.turnId,messageId:last.data.messageId,status:'completed',completedSegments:1}));assert.equal(h.runtime.repository.get(last.data.messageId,'a').status,'interrupted');});

test('mute epochs reject old in-flight audio after reopening the microphone',async t=>{const h=harness(t);await wait(()=>h.getAsr());let appended=0;h.runtime.sessions.get(h.s.id).asr={append(){appended++;}};h.runtime.control(h.s.id,'a',{type:'mute',muted:true});h.runtime.control(h.s.id,'a',{type:'mute',muted:false});h.runtime.sessions.get(h.s.id).asr={append(){appended++;}};h.runtime.audio(h.s.id,'a',Buffer.alloc(3200),0,0);assert.equal(appended,0);h.runtime.audio(h.s.id,'a',Buffer.alloc(3200),1,2);assert.equal(appended,1);});

test('starting another turn never labels an already heard answer as interrupted',async t=>{const h=harness(t);await wait(()=>h.getAsr());h.getAsr().onTranscript('你好');await wait(()=>h.events.some(e=>e.type==='audio_end'));const last=h.events.findLast(e=>e.type==='audio_end').data;h.runtime.control(h.s.id,'a',{type:'receipt',turnId:last.turnId,messageId:last.messageId,status:'completed',completedSegments:last.segments});h.runtime.control(h.s.id,'a',{type:'interrupt'});assert.equal(h.runtime.repository.get(last.messageId,'a').status,'completed');assert.equal(h.events.some(e=>e.type==='interrupted'),false);});

test('short echoes and backchannels do not cancel playback; meaningful speech and explicit interrupt still work',async t=>{
 const h=harness(t,{assistantOverride:{processUserMessage:()=>({handled:true,domain:'ordinary_chat',content:'你好，周六我们去海边散步。'})}});
 h.getAsr().onTranscript('周末安排');await wait(()=>h.events.some(e=>e.type==='audio_end'));
 const original=h.runtime.sessions.get(h.s.id).turn;
 for(const word of ['嗯','啊','好','对','你好','海边散步']){h.getAsr().onSpeechStart();h.getAsr().onTranscript(word);}
 await new Promise(r=>setTimeout(r,10));assert.equal(original.controller.signal.aborted,false);assert.equal(h.base.messages.listForConversationOwner(h.s.conversationId,'a').length,2);
 h.getAsr().onSpeechStart();h.getAsr().onTranscript('不对');await wait(()=>h.events.filter(e=>e.type==='audio_end').length===2);
 assert.equal(h.base.messages.listForConversationOwner(h.s.conversationId,'a').filter(m=>m.role==='user').at(-1).content,'不对');
 h.runtime.control(h.s.id,'a',{type:'interrupt'});h.getAsr().onTranscript('你好');await wait(()=>h.events.filter(e=>e.type==='audio_end').length===3);
});
test('playback metadata never becomes prior assistant speech or new streamed speech',async t=>{
 const h=harness(t);let calls=0,spoken=[];const note='[这条语音未确认完整播放，用户可能没有听完。]';
 const originalRun=h.ai.router.run;h.ai.router.run=async(task,...args)=>{if(task.capability==='VOICE_CHAT_TTS'){for await(const word of task.text){spoken.push(word);task.onAudio(Buffer.alloc(480));}return{};}return originalRun(task,...args);};
 h.ai.stream=async(task,{onDelta})=>{calls++;if(calls===2){assert.ok(task.messages.some(m=>m.role==='assistant'&&m.content==='周六去海边。'));assert.ok(task.messages.filter(m=>m.role==='assistant').every(m=>!m.content.includes('未确认完整播放')));}
 const content=calls===1?'周六去海边。':note+'可以下午出发。';for(const char of content)await onDelta(char);return{ok:true,content};};
 h.getAsr().onTranscript('周末去哪里');await wait(()=>h.events.some(e=>e.type==='audio_end'));
 const first=h.events.find(e=>e.type==='audio_end').data;h.runtime.control(h.s.id,'a',{type:'interrupt'});
 h.getAsr().onTranscript('什么时候出发');await wait(()=>h.events.filter(e=>e.type==='audio_end').length===2||h.events.some(e=>e.type==='ended'));
 assert.equal(h.events.some(e=>e.type==='ended'),false);assert.equal(h.runtime.repository.get(first.messageId,'a').status,'interrupted');
 assert.equal(h.base.messages.listForConversationOwner(h.s.conversationId,'a').at(-1).content,'可以下午出发。');
 assert.equal(spoken.join(''),'周六去海边。可以下午出发。');
 assert.equal(h.events.filter(e=>e.type==='delta').map(e=>e.data.text).join(''),'周六去海边。可以下午出发。');
});

test('backchannels after completed playback remain valid short user replies',async t=>{
 const h=harness(t);h.getAsr().onTranscript('你好');await wait(()=>h.events.some(e=>e.type==='audio_end'));
 const last=h.events.find(e=>e.type==='audio_end').data;h.runtime.control(h.s.id,'a',{type:'receipt',turnId:last.turnId,messageId:last.messageId,status:'completed',completedSegments:last.segments});
 h.getAsr().onSpeechStart();h.getAsr().onTranscript('好');await wait(()=>h.events.filter(e=>e.type==='audio_end').length===2);
 assert.equal(h.base.messages.listForConversationOwner(h.s.conversationId,'a').filter(m=>m.role==='user').at(-1).content,'好');
});

test('active authenticated voice session continues past ten minutes while heartbeat and idle guards remain',async t=>{
 let now=0;t.mock.timers.enable({apis:['setInterval']});const h=harness(t,{clock:()=>now});
 const s=h.runtime.sessions.get(h.s.id);s.turn={audioSegments:1,heard:false,speechText:'持续回答'};
 for(let i=0;i<132;i++){now+=5000;h.runtime.control(h.s.id,'a',{type:'heartbeat'});h.getAsr().onSpeechStart();h.getAsr().onTranscript('嗯');t.mock.timers.tick(5000);}
 assert.equal(h.runtime.sessions.has(h.s.id),true);assert.equal(h.events.some(e=>e.type==='ended'),false);
 s.turn=null;now+=21000;t.mock.timers.tick(1000);assert.equal(h.runtime.sessions.size,0);assert.equal(h.events.at(-1).data.code,'VOICE_LEASE_EXPIRED');
});
test('open-ended voice questions receive the same creator policy through the actual conversation service',async t=>{
 const h=harness(t);let received=false;
 h.ai.stream=async(task,{onDelta})=>{const policy=task.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');assert.match(policy,/我是由示例维护者创建的。/);assert.match(policy,/示例维护者，身份信息已脱敏。/);received=true;await onDelta('我是由示例维护者创建的。');return{ok:true,content:'我是由示例维护者创建的。'};};
 h.getAsr().onTranscript('聊聊你的诞生过程');await wait(()=>h.events.some(e=>e.type==='audio_end'||e.type==='ended'));assert.equal(received,true);assert.equal(h.events.some(e=>e.type==='ended'),false);
});

test('two-signal interruption ignores background transcripts and requires a fresh matching speech candidate',async t=>{
 let now=1000;const h=harness(t,{clock:()=>now,coreOptions:{conservativeInterruption:true}});
 h.getAsr().onTranscript('聊聊旅行');await wait(()=>h.events.some(e=>e.type==='audio_end'));
 const old=h.runtime.sessions.get(h.s.id).turn;
 h.getAsr().onTranscript('电视正在播天气预报');await new Promise(r=>setTimeout(r,5));assert.equal(old.controller.signal.aborted,false);
 h.runtime.control(h.s.id,'a',{type:'speech_candidate',candidateSequence:0,turnId:old.id,inputEpoch:0,durationMs:400,peakRms:.04});
 h.getAsr().onTranscript('换个话题聊聊露营');await wait(()=>h.events.filter(e=>e.type==='audio_end').length===2);assert.equal(old.controller.signal.aborted,true);
 const current=h.runtime.sessions.get(h.s.id).turn;
 h.runtime.control(h.s.id,'a',{type:'speech_candidate',candidateSequence:1,turnId:old.id,inputEpoch:0,durationMs:400,peakRms:.04});
 h.getAsr().onTranscript('外面在叫卖水果');await new Promise(r=>setTimeout(r,5));assert.equal(current.controller.signal.aborted,false);
 h.runtime.control(h.s.id,'a',{type:'speech_candidate',candidateSequence:2,turnId:current.id,inputEpoch:0,durationMs:400,peakRms:.04});now+=3001;
 h.getAsr().onTranscript('旁边的人又在聊天');await new Promise(r=>setTimeout(r,5));assert.equal(current.controller.signal.aborted,false);
 h.getAsr().onTranscript('停一下');await wait(()=>h.events.filter(e=>e.type==='audio_end').length===3);assert.equal(current.controller.signal.aborted,true);
});

test('candidate inputs are owner-scoped, finite, current-epoch and protocol negotiated',async t=>{
 const h=harness(t,{coreOptions:{lowLatency:true,conservativeInterruption:true}});
 assert.equal(h.s.coreOptions.lowLatency,true);assert.equal(h.getAsr().silenceDurationMs,650);
 assert.throws(()=>h.runtime.control(h.s.id,'b',{type:'speech_candidate',durationMs:400,peakRms:.04}),{code:'VOICE_SESSION_NOT_FOUND'});
 assert.throws(()=>h.runtime.control(h.s.id,'a',{type:'speech_candidate',durationMs:Infinity,peakRms:.04}),{code:'VOICE_CONTROL_INVALID'});
 const legacy=harness(t,{coreOptions:{conservativeInterruption:true},mediaProtocol:0});assert.equal(legacy.s.coreOptions.conservativeInterruption,false);
});

test('unavailable model connection cannot be swallowed into a voice answer by ConversationService',async t=>{
 const h=harness(t,{coreOptions:{ordinaryChat:true},assistantOverride:{processUserMessage(){throw Object.assign(Error('none'),{code:'NO_USABLE_RUNTIME_CONNECTION'});}}});
 let answers=0;h.ai.stream=async()=>{answers++;return{ok:true,content:'不该生成的回答'};};h.getAsr().onTranscript('我想聊聊');await wait(()=>h.events.some(e=>e.type==='ended'));
 assert.equal(answers,0);assert.equal(h.events.find(e=>e.type==='voice_error')?.data.code,'VOICE_UNAVAILABLE');
});

test('consumed, repeated and previous microphone epoch speech candidates cannot be reused',async t=>{
 const h=harness(t,{coreOptions:{conservativeInterruption:true}});h.getAsr().onTranscript('聊聊旅行');await wait(()=>h.events.some(e=>e.type==='audio_end'));
 const session=h.runtime.sessions.get(h.s.id),turn=session.turn;
 const body={type:'speech_candidate',candidateSequence:0,turnId:turn.id,inputEpoch:0,durationMs:400,peakRms:.04};
 h.runtime.control(h.s.id,'a',body);h.getAsr().onTranscript('嗯');assert.equal(session.speechCandidate,null);
 h.runtime.control(h.s.id,'a',body);assert.equal(session.speechCandidate,null);
 h.getAsr().onTranscript('旁边的人正在聊天');assert.equal(turn.controller.signal.aborted,false);
 h.runtime.control(h.s.id,'a',{type:'mute',muted:true});h.runtime.control(h.s.id,'a',{type:'mute',muted:false});
 h.runtime.control(h.s.id,'a',{...body,candidateSequence:1});assert.equal(session.speechCandidate,null);
 h.runtime.control(h.s.id,'a',{...body,candidateSequence:2,inputEpoch:2});assert.equal(session.speechCandidate.inputEpoch,2);
 h.getAsr().onTranscript('换个话题聊聊露营');await wait(()=>turn.controller.signal.aborted);
});
