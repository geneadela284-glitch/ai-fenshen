import test from'node:test';import assert from'node:assert/strict';import{DatabaseSync}from'node:sqlite';
import{createConversationRuntime}from'../conversation/runtime.js';import{createVoiceChatRuntime}from'./runtime.js';
const wait=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,2));}throw Error('WAIT_TIMEOUT');};
test('voice obtains owner-bound local context before the model and does not accept stale context tokens',async t=>{
 const h=harness(t,{clientContextVersion:1});let modelTask;
 h.ai.stream=async(task,{onDelta})=>{modelTask=task;await onDelta('你喜欢喝龙井。');return{ok:true,content:'你喜欢喝龙井。'}};
 h.getAsr().onTranscript('我喜欢喝什么？');await wait(()=>h.events.some(e=>e.type==='context_required'));
 assert.equal(modelTask,undefined);const request=h.events.find(e=>e.type==='context_required').data;
 const localMemory={schema:'local-memory-evidence:1',ownerId:'a',spaceId:'personal',question:request.text,state:'available',revision:1,
 items:[{memoryId:'mem_test',version:1,text:'我喜欢喝龙井。',source:{type:'conversation_message',id:'source'},updatedAt:'2026-10-03T00:00:00.000Z'}],revoked:[]};
 assert.throws(()=>h.runtime.control(h.s.id,'a',{type:'context',turnId:request.turnId,contextToken:'wrong',localMemory}),{code:'VOICE_CONTEXT_STALE'});
 h.runtime.control(h.s.id,'a',{type:'context',turnId:request.turnId,contextToken:request.contextToken,localMemory});
 await wait(()=>modelTask);assert.match(JSON.stringify(modelTask.messages),/龙井/);await wait(()=>h.events.some(e=>e.type==='audio_end'));
});
test('typed input clears recognition fragments and late ASR without ending the existing session',async t=>{
 const h=harness(t);const previous=h.getAsr();
 const begin=h.runtime.control(h.s.id,'a',{type:'external_input',active:true,id:'typed-1'});
 assert.ok(begin.inputEpoch>0);previous.onTranscript('不应该入队的旧片段');await new Promise(r=>setTimeout(r,5));
 assert.equal(h.base.messages.listForConversationOwner(h.s.conversationId,'a').length,0);
 const end=h.runtime.control(h.s.id,'a',{type:'external_input',active:false,id:'typed-1'});assert.ok(end.inputEpoch>begin.inputEpoch);
 assert.equal(h.runtime.sessions.size,1);await wait(()=>h.getAsr()!==previous);h.getAsr().onTranscript('继续当前对话');await wait(()=>h.events.some(e=>e.type==='audio_end'));
 assert.equal(h.base.messages.listForConversationOwner(h.s.conversationId,'a')[0].content,'继续当前对话');
});
function harness(t,{assistantOverride,clock=Date.now,coreOptions={},mediaProtocol=1,clientContextVersion=0}={}){const database=new DatabaseSync(':memory:');let asr;const released=[],events=[];let ttsCalls=0;
 const ai={settings:{load:()=>({})},router:{async run(task){if(task.capability==='VOICE_CHAT_ASR'){asr=task;task.onReady({append(){},finish(){}});await new Promise(r=>task.signal.addEventListener('abort',r,{once:true}));return{};}ttsCalls++;for await(const text of task.text){if(!task.signal.aborted)task.onAudio(Buffer.alloc(480));}return{};}},async stream(task,{onDelta,signal},invocation){assert.equal(task.metadata.requestId,invocation.requestLease.requestId,'voice text uses the same authenticated lease identity');await onDelta('你好。');return{ok:true,content:'你好。'};}};
 const accessControl={assertAuthenticatedSubject:subject=>subject,beginRequest:({requestId})=>({requestId}),releaseRequest:l=>released.push(l)};
 const base=createConversationRuntime({database,aiService:ai,applyMigrations:true});
 const runtime=createVoiceChatRuntime({enabled:true,clock,coreOptions,conversationRuntime:base,aiService:ai,accessControl,assistantOverride:assistantOverride||{async processUserMessage(){return{handled:false};}}});
 t.after(async()=>{await runtime.close();base.close();database.close();});
 const s=runtime.create({user:{id:'a'},subject:{accountId:'a'},mediaProtocol,clientContextVersion});runtime.subscribe(s.id,'a',event=>events.push(event),()=>{});
 return{runtime,s,events,getAsr:()=>asr,base,released,ai,getTtsCalls:()=>ttsCalls};}
test('an explicit stop word in the current spoken answer cannot bypass playback echo protection',async t=>{
 const answer='你可以对他说，等一下，我们先核对清楚。';
 const h=harness(t,{assistantOverride:{processUserMessage:()=>({handled:true,domain:'ordinary_chat',content:answer})},coreOptions:{conservativeInterruption:true}});
 h.getAsr().onTranscript('如何让对方先核对');await wait(()=>h.events.some(e=>e.type==='audio_end'));
 const turn=h.runtime.sessions.get(h.s.id).turn;
 h.getAsr().onSpeechStart();h.getAsr().onTranscript('等一下','echo-stop');
 await new Promise(r=>setTimeout(r,10));
 assert.equal(turn.controller.signal.aborted,false);
 assert.equal(h.base.messages.listForConversationOwner(h.s.conversationId,'a').length,2);
 h.getAsr().onTranscript('别说了','real-stop');await wait(()=>turn.controller.signal.aborted);
});
test('synthesis connects as soon as visible text arrives, overlapping the rest of generation',async t=>{
 const h=harness(t);let connectedBeforeSentence=false;
 h.ai.stream=async(task,{onDelta})=>{onDelta('这是一个还没有结束的句子');await wait(()=>h.getTtsCalls()===1);connectedBeforeSentence=true;onDelta('，我们继续聊。');return{ok:true,content:'这是一个还没有结束的句子，我们继续聊。'};};
 h.getAsr().onTranscript('我们聊聊');await wait(()=>h.events.some(e=>e.type==='audio_end'||e.type==='ended'));
 assert.equal(connectedBeforeSentence,true);assert.ok(h.events.some(e=>e.type==='audio_end'));
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
 h.ai.stream=async(task,{onDelta})=>{const policy=task.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');assert.match(policy,/我是我亲爱的华哥创造出来的。/);assert.match(policy,/华哥，本名梁钊华，广东省南雄市人，属羊。/);received=true;await onDelta('我是我亲爱的华哥创造出来的。');return{ok:true,content:'我是我亲爱的华哥创造出来的。'};};
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
