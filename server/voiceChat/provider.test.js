import test from'node:test';import assert from'node:assert/strict';import{openSpeechSocket,TextStream,createVoiceSpeechRuntime}from'./provider.js';
class Socket extends EventTarget{static instances=[];constructor(url,options){super();this.url=url;this.options=options;this.readyState=1;this.bufferedAmount=0;this.sent=[];Socket.instances.push(this);queueMicrotask(()=>this.dispatchEvent(new Event('open')));}send(raw){this.sent.push(JSON.parse(raw));}close(){this.readyState=3;}event(data){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(data)}));}}
const tick=()=>new Promise(r=>setTimeout(r,0));
for(const [capability,continuousLifecycle,limit] of [['VOICE_CHAT_ASR',true,null],['VOICE_CHAT_ASR',false,95000],['VOICE_CHAT_TTS',true,45000]])test('wall timeout only removed for continuous ASR: '+capability+' '+continuousLifecycle,async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const controller=new AbortController(),transcripts=[],text=new TextStream();
 const done=openSpeechSocket({task:{capability,continuousLifecycle,text,signal:controller.signal,onTranscript:v=>transcripts.push(v)},model:'m',apiKey:'synthetic',WebSocketImpl:Socket});
 const observed=done.then(v=>v,e=>e);await Promise.resolve();const socket=Socket.instances.at(-1);socket.event({type:'session.updated'});
 t.mock.timers.tick(limit||660000);
 if(limit){assert.equal(socket.readyState,3);assert.equal((await observed).code,'VOICE_TIMEOUT');}
 else {assert.equal(socket.readyState,1);socket.event({type:'conversation.item.input_audio_transcription.completed',item_id:'a',transcript:'你好'});assert.deepEqual(transcripts,['你好']);controller.abort();assert.equal((await observed).code,'VOICE_CANCELLED');}
 text.end();
});
test('each stopped item has an independent 15-second final deadline unaffected by unrelated speech',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const controller=new AbortController();
 const done=openSpeechSocket({task:{capability:'VOICE_CHAT_ASR',continuousLifecycle:true,signal:controller.signal},model:'m',apiKey:'synthetic',WebSocketImpl:Socket}).catch(e=>e);
 await Promise.resolve();const socket=Socket.instances.at(-1);socket.event({type:'session.updated'});
 socket.event({type:'input_audio_buffer.speech_stopped',item_id:'a'});t.mock.timers.tick(10000);
 socket.event({type:'input_audio_buffer.speech_stopped',item_id:'b'});socket.event({type:'conversation.item.input_audio_transcription.completed',item_id:'b',transcript:'后来'});
 t.mock.timers.tick(4999);assert.equal(socket.readyState,1);t.mock.timers.tick(1);assert.equal(socket.readyState,3);assert.equal((await done).code,'VOICE_FINAL_TIMEOUT');
});
test('normal finish waits for session.finished and refuses further audio; missing finish is bounded',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 for(const completes of [true,false]){
  let handle;const done=openSpeechSocket({task:{capability:'VOICE_CHAT_ASR',continuousLifecycle:true,onReady:h=>handle=h},model:'m',apiKey:'synthetic',WebSocketImpl:Socket}).catch(e=>e);
  await Promise.resolve();const socket=Socket.instances.at(-1);socket.event({type:'session.updated'});handle.finish();
  assert.throws(()=>handle.append(Buffer.alloc(2)),{code:'VOICE_FINISHING'});assert.equal(socket.readyState,1);
  if(completes){socket.event({type:'session.finished'});assert.equal((await done).code,undefined);}
  else {t.mock.timers.tick(10000);assert.equal(socket.readyState,3);assert.equal((await done).code,'VOICE_FINISH_TIMEOUT');}
 }
});
test('continuous mode retains handshake deadline and clears completed item deadlines',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let done=openSpeechSocket({task:{capability:'VOICE_CHAT_ASR',continuousLifecycle:true},model:'m',apiKey:'synthetic',WebSocketImpl:Socket}).catch(e=>e);
 await Promise.resolve();t.mock.timers.tick(10000);assert.equal((await done).code,'VOICE_CONNECT_TIMEOUT');
 const controller=new AbortController();done=openSpeechSocket({task:{capability:'VOICE_CHAT_ASR',continuousLifecycle:true,signal:controller.signal},model:'m',apiKey:'synthetic',WebSocketImpl:Socket}).catch(e=>e);
 await Promise.resolve();const socket=Socket.instances.at(-1);socket.event({type:'session.updated'});
 socket.event({type:'input_audio_buffer.speech_stopped',item_id:'a'});t.mock.timers.tick(14000);socket.event({type:'conversation.item.input_audio_transcription.completed',item_id:'a',transcript:'完整'});
 t.mock.timers.tick(660000);assert.equal(socket.readyState,1);controller.abort();await done;
});
test('session.finished with an unfinished stopped item is incomplete, not successful recognition',async()=>{
 let handle;const done=openSpeechSocket({task:{capability:'VOICE_CHAT_ASR',continuousLifecycle:true,onReady:h=>handle=h},model:'m',apiKey:'synthetic',WebSocketImpl:Socket}).catch(e=>e);
 await Promise.resolve();const socket=Socket.instances.at(-1);socket.event({type:'session.updated'});socket.event({type:'input_audio_buffer.speech_stopped',item_id:'unfinished'});handle.finish();socket.event({type:'session.finished'});
 assert.equal((await done).code,'VOICE_FINAL_INCOMPLETE');
});
test('ASR append reports temporary socket pressure without accepting or losing the frame',async()=>{
 const controller=new AbortController();let handle;
 const done=openSpeechSocket({task:{capability:'VOICE_CHAT_ASR',signal:controller.signal,onReady:h=>handle=h},model:'m',apiKey:'synthetic',WebSocketImpl:Socket});
 try{await tick();const socket=Socket.instances.at(-1);socket.event({type:'session.updated'});
 socket.bufferedAmount=128001;const frame=Buffer.alloc(6400,7);
 assert.equal(handle.append(frame),false);assert.equal(socket.sent.filter(e=>e.type==='input_audio_buffer.append').length,0);
 assert.equal(handle.finish(),false);assert.equal(socket.sent.filter(e=>e.type==='session.finish').length,0);
 assert.throws(()=>handle.append(Buffer.alloc(3)),{code:'VOICE_AUDIO_INVALID'});
 socket.bufferedAmount=0;assert.equal(handle.append(frame),true);
 assert.deepEqual(Buffer.from(socket.sent.at(-1).audio,'base64'),frame);
 assert.equal(handle.finish(),true);handle.finish();assert.equal(socket.sent.filter(e=>e.type==='session.finish').length,1);
 }finally{controller.abort();await assert.rejects(done,{code:'VOICE_CANCELLED'});}
});
test('low latency ASR uses the negotiated silence window without weakening speech threshold',async()=>{
 const controller=new AbortController();const done=openSpeechSocket({task:{capability:'VOICE_CHAT_ASR',signal:controller.signal,silenceDurationMs:650},model:'m',apiKey:'synthetic',WebSocketImpl:Socket});
 await tick();const detection=Socket.instances.at(-1).sent.find(e=>e.type==='session.update').session.turn_detection;controller.abort();await assert.rejects(done,{code:'VOICE_CANCELLED'});
 assert.deepEqual(detection,{type:'server_vad',threshold:0.5,silence_duration_ms:650});
});
test('ASR transport forwards partial/final only, cancels socket and releases listeners',async()=>{const controller=new AbortController(),found=[];let handle;const result=openSpeechSocket({task:{capability:'VOICE_CHAT_ASR',signal:controller.signal,onReady:v=>handle=v,onPartial:v=>found.push(v),onTranscript:v=>found.push(v)},model:'m',apiKey:'synthetic',WebSocketImpl:Socket});await tick();const socket=Socket.instances.at(-1);assert.equal(socket.options.headers.Authorization,'Bearer synthetic');assert.deepEqual(socket.sent.find(e=>e.type==='session.update').session.turn_detection,{type:'server_vad',threshold:0.5,silence_duration_ms:800});socket.event({type:'session.updated'});handle.append(Buffer.alloc(6400));socket.event({type:'conversation.item.input_audio_transcription.text',text:'你好',stash:'啊'});socket.event({type:'conversation.item.input_audio_transcription.completed',transcript:'你好啊'});controller.abort();await assert.rejects(result,{code:'VOICE_CANCELLED'});assert.deepEqual(found,['你好啊','你好啊']);assert.equal(socket.readyState,3);});
test('TTS forwards streamed text and audio, then ends; unknown capabilities fail before calls',async()=>{const text=new TextStream(),audio=[];const result=openSpeechSocket({task:{capability:'VOICE_CHAT_TTS',text,onAudio:b=>audio.push(b)},model:'m',apiKey:'synthetic',WebSocketImpl:Socket});await tick();const socket=Socket.instances.at(-1);socket.event({type:'session.updated'});text.push('你好。');text.end();await tick();assert.ok(socket.sent.some(e=>e.type==='input_text_buffer.append'));assert.ok(socket.sent.some(e=>e.type==='session.finish'));socket.event({type:'response.audio.delta',delta:Buffer.alloc(4800).toString('base64')});socket.event({type:'session.finished'});assert.equal((await result).outputAudioMs,100);assert.equal(audio.length,1);await assert.rejects(createVoiceSpeechRuntime({}).run({capability:'OTHER'}),{code:'VOICE_CAPABILITY_INVALID'});});
test('low-latency TTS explicitly commits only the first streamed speech chunk',async()=>{
 const controller=new AbortController(),text=new TextStream();const result=openSpeechSocket({task:{capability:'VOICE_CHAT_TTS',text,signal:controller.signal,commitFirstTextChunk:true},model:'m',apiKey:'synthetic',WebSocketImpl:Socket});
 await tick();const socket=Socket.instances.at(-1);socket.event({type:'session.updated'});
 text.push('第一句。');text.push('第二句。');text.end();await tick();
 const sentTypes=socket.sent.filter(event=>event.type.startsWith('input_text_buffer.')||event.type==='session.finish').map(event=>event.type);
 controller.abort();await assert.rejects(result,{code:'VOICE_CANCELLED'});
 assert.deepEqual(sentTypes,[
  'input_text_buffer.append','input_text_buffer.commit','input_text_buffer.append','session.finish'
 ]);
});
