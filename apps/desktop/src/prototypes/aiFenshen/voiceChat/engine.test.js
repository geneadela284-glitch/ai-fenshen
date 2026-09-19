import test from'node:test';import assert from'node:assert/strict';import{VoiceChatEngine}from'./engine.js';
class Context{constructor(){this.state='running';this.currentTime=0;this.destination={};this.closed=false;}resume(){return Promise.resolve();}close(){this.closed=true;this.state='closed';return Promise.resolve();}createGain(){return{gain:{setTargetAtTime(){}},connect(){},disconnect(){}};}createBuffer(channels,length){return{duration:length/24000,getChannelData:()=>new Float32Array(length)};}createBufferSource(){return{connect(){},disconnect(){},start(){},stop(){}};}}
test('background energy never changes playback volume or discards an answer',()=>{
 const engine=new VoiceChatEngine({ownerId:'a',mediaDevices:{},AudioContextImpl:Context});
 engine.media.context=new Context();engine.media.output={gain:{value:1,setTargetAtTime(v){this.value=v;}}};
 engine.turn={id:'t',messageId:'m'};engine.media.sources.add({stop(){throw Error('must not cancel on energy');},disconnect(){}});
 engine.upload=[];engine.uploading=true;engine.noise=.002;engine.speechFrames=0;engine.blockedTurns=new Set();
 for(let i=0;i<2;i++)engine.captureAudio({pcm:new ArrayBuffer(3200),rms:.04});
 assert.equal(engine.turn.id,'t');assert.equal(engine.media.sources.size,1);assert.equal(engine.media.output.gain.value,1);
 engine.media.sources.clear();engine.end();
});
test('partial recognition does not replace the answer before a new turn is confirmed',()=>{
 const engine=new VoiceChatEngine({ownerId:'a',mediaDevices:{}});engine.turn={id:'t',reply:'原来的回答'};engine.update({phase:'speaking',subtitle:'原来的回答'});
 engine.event({type:'partial',data:{text:'可能是外放回声'}});assert.equal(engine.state.subtitle,'原来的回答');
});
test('late microphone permission cannot resurrect an ended session',async()=>{let grant,stopped=0;const engine=new VoiceChatEngine({ownerId:'a',mediaDevices:{getUserMedia:()=>new Promise(r=>grant=r)},AudioContextImpl:Context,fetchImpl:()=>{throw Error('must not reach API');}});const pending=engine.start();await Promise.resolve();engine.end();grant({getTracks:()=>[{stop:()=>stopped++}]});await pending;assert.equal(stopped,1);assert.equal(engine.sessionId,null);assert.equal(engine.media.context,null);});
test('interrupt clears all sources immediately and rejects late audio from that turn',()=>{let stops=0;const engine=new VoiceChatEngine({ownerId:'a',mediaDevices:{},AudioContextImpl:Context});engine.blockedTurns=new Set();engine.media.context=new Context();engine.turn={id:'t',messageId:'m',received:0,completed:0};engine.media.sources.add({stop(){stops++;},disconnect(){}});engine.interrupt();assert.equal(stops,1);assert.equal(engine.media.sources.size,0);assert.equal(engine.turn,null);engine.event({type:'audio',data:{turnId:'t',sampleRate:24000,index:0,audio:btoa('\0\0')}});assert.equal(engine.media.sources.size,0);engine.end();});
test('account-mismatched response is rejected before processing data',async()=>{const engine=new VoiceChatEngine({ownerId:'a',mediaDevices:{},fetchImpl:async()=>new Response('{}',{headers:{'X-AI-Account-Context':'b'}})});await assert.rejects(engine.request('/sessions',{body:{consent:true}}),{code:'VOICE_ACCOUNT_MISMATCH'});});
test('native browser fetch is invoked with its Window receiver',async()=>{const engine=new VoiceChatEngine({ownerId:'a',mediaDevices:{},fetchImpl:async function(){assert.equal(this,globalThis);return new Response('{}',{headers:{'X-AI-Account-Context':'a'}});}});await engine.request('/sessions',{body:{consent:true}});});

test('live microphone upload waits for a half-second batch before sending', async () => {
 const uploads=[];
 const engine=new VoiceChatEngine({
  ownerId:'a',
  mediaDevices:{},
  fetchImpl:async (url,options)=>{
   if(url.endsWith('/audio'))uploads.push(options.body.byteLength);
   return new Response('{}',{headers:{'X-AI-Account-Context':'a'}});
  }
 });
 engine.sessionId='session-a';engine.epoch=1;engine.upload=[];engine.uploading=false;
 engine.noise=.002;engine.speechFrames=0;engine.media.sources=new Set();engine.state={phase:'listening',muted:false};
 for(let index=0;index<4;index++)engine.captureAudio({pcm:new ArrayBuffer(3200),rms:0});
 await Promise.resolve();
 assert.deepEqual(uploads,[]);
 engine.captureAudio({pcm:new ArrayBuffer(3200),rms:0});
 await new Promise(resolve=>setTimeout(resolve,0));
 assert.deepEqual(uploads,[16000]);
 engine.sessionId=null;
});

test('brief mobile upload jitter keeps the voice session listening', () => {
 const engine=new VoiceChatEngine({ownerId:'a',mediaDevices:{}});
 engine.sessionId='session-a';engine.epoch=1;engine.upload=[];engine.uploading=true;
 engine.noise=.002;engine.speechFrames=0;engine.media.sources=new Set();engine.state={phase:'listening',muted:false};
 for(let index=0;index<60;index++)engine.captureAudio({pcm:new ArrayBuffer(3200),rms:0});
 assert.equal(engine.state.phase,'listening');
 assert.equal(engine.state.error,undefined);
});

test('hard upload backlog safety still pauses a persistently stalled voice session', () => {
 const engine=new VoiceChatEngine({ownerId:'a',mediaDevices:{}});
 engine.sessionId='session-a';engine.epoch=1;engine.upload=[];engine.uploading=true;
 engine.noise=.002;engine.speechFrames=0;engine.media.sources=new Set();engine.state={phase:'listening',muted:false};
 for(let index=0;index<101;index++)engine.captureAudio({pcm:new ArrayBuffer(3200),rms:0});
 assert.equal(engine.state.phase,'paused');
 assert.equal(engine.state.error,'VOICE_NETWORK_SLOW');
});

test('account quota exhaustion is reported as a service limit instead of slow network', () => {
 const engine=new VoiceChatEngine({ownerId:'a',mediaDevices:{}});
 engine.pause('ACCOUNT_USAGE_LIMIT_REACHED');
 assert.equal(engine.state.phase,'paused');
 assert.equal(engine.state.error,'VOICE_SERVICE_LIMIT');
});

test('low latency sends the first 200ms then ordered batches of at most 400ms',async()=>{
 const uploads=[];const engine=new VoiceChatEngine({ownerId:'a',mediaDevices:{},fetchImpl:async(url,options)=>{if(url.endsWith('/audio'))uploads.push({bytes:options.body.byteLength,sequence:options.headers['X-Voice-Sequence']});return new Response('{}',{headers:{'X-AI-Account-Context':'a'}});}});
 Object.assign(engine,{sessionId:'s',epoch:1,inputEpoch:0,sequence:0,upload:[],uploading:false,noise:.002,speechFrames:0,coreOptions:{lowLatency:true}});
 engine.captureAudio({pcm:new ArrayBuffer(3200),rms:0});assert.equal(uploads.length,0);
 engine.captureAudio({pcm:new ArrayBuffer(3200),rms:0});await new Promise(r=>setTimeout(r,0));
 assert.deepEqual(uploads,[{bytes:6400,sequence:'0'}]);
 for(let i=0;i<4;i++)engine.captureAudio({pcm:new ArrayBuffer(3200),rms:0});await new Promise(r=>setTimeout(r,0));
 assert.deepEqual(uploads,[{bytes:6400,sequence:'0'},{bytes:12800,sequence:'1'}]);engine.sessionId=null;engine.end();
});

test('blocked turn events never reach the conversation page after interruption',()=>{
 const forwarded=[];const engine=new VoiceChatEngine({ownerId:'a',mediaDevices:{},onEvent:e=>forwarded.push(e)});
 engine.blockedTurns=new Set();engine.turn={id:'old'};engine.interrupt();
 for(const type of ['messages','delta','completed','thinking','audio','audio_end','proposal'])engine.event({type,data:{turnId:'old',text:'旧回答',messages:[{id:'m',content:'旧回答'}]}});
 assert.equal(engine.turn,null);assert.equal(forwarded.length,0);engine.end();
});

test('sustained speech candidate is sent before its audio and does not cancel playback locally',async()=>{
 const requests=[];const engine=new VoiceChatEngine({ownerId:'a',mediaDevices:{},fetchImpl:async(url,options)=>{requests.push({url,body:options.body});return new Response('{}',{headers:{'X-AI-Account-Context':'a'}});}});
 Object.assign(engine,{sessionId:'s',epoch:1,inputEpoch:0,sequence:0,upload:[],uploading:false,noise:.002,speechFrames:0,candidateSequence:0,coreOptions:{lowLatency:true,conservativeInterruption:true},turn:{id:'t'}});
 engine.media.sources.add({stop(){},disconnect(){}});
 for(let i=0;i<2;i++)engine.captureAudio({pcm:new ArrayBuffer(3200),rms:.04});await new Promise(r=>setTimeout(r,0));
 for(let i=0;i<4;i++)engine.captureAudio({pcm:new ArrayBuffer(3200),rms:.04});await new Promise(r=>setTimeout(r,0));
 const candidate=requests.find(r=>r.url.endsWith('/control'));assert.ok(candidate);assert.equal(JSON.parse(candidate.body).durationMs,400);assert.ok(requests.indexOf(candidate)<requests.findIndex((r,i)=>i>0&&r.url.endsWith('/audio')));assert.equal(engine.turn.id,'t');engine.sessionId=null;engine.end();
});

test('timing observers cannot break uploads and never receive audio or transcript content',async()=>{
 const timings=[];const engine=new VoiceChatEngine({ownerId:'a',mediaDevices:{},clock:()=>1000,onTiming:e=>{timings.push(e);throw Error('observer unavailable');},fetchImpl:async()=>new Response('{}',{headers:{'X-AI-Account-Context':'a'}})});
 Object.assign(engine,{sessionId:'s',epoch:1,inputEpoch:0,sequence:0,upload:[],uploading:false,noise:.002,speechFrames:0,coreOptions:{lowLatency:true}});
 for(let i=0;i<2;i++)engine.captureAudio({pcm:new ArrayBuffer(3200),rms:.04});await new Promise(r=>setTimeout(r,0));
 assert.deepEqual(timings.map(e=>e.stage),['capture_started','first_upload']);assert.ok(timings.every(e=>Object.keys(e).every(k=>['stage','at','turnId','inputEpoch'].includes(k))));assert.notEqual(engine.state.phase,'paused');engine.sessionId=null;engine.end();
});

test('confirmed business result reaches chat but stale generated completions cannot overwrite it',()=>{
 const events=[];const engine=new VoiceChatEngine({ownerId:'a',mediaDevices:{},onEvent:e=>events.push(e)});engine.turn={id:'t',messageId:'m'};
 engine.event({type:'confirmed',data:{turnId:'t',content:'已经按确认保存。'}});
 engine.event({type:'completed',data:{turnId:'t',messageId:'m',content:'旧的确认提示',status:'completed'}});
 assert.equal(events.findLast(e=>e.type==='completed')?.data.content,'已经按确认保存。');assert.equal(events.find(e=>e.type==='completed')?.data.messageId,'m');engine.end();
});

test('old interrupt request rejection cannot pause a newly started session',async()=>{
 let reject;const engine=new VoiceChatEngine({ownerId:'a',mediaDevices:{},fetchImpl:()=>new Promise((r,j)=>reject=j)});engine.sessionId='old';engine.turn={id:'t'};engine.interrupt();engine.epoch++;engine.sessionId='new';engine.update({phase:'listening'});reject(Error('old request aborted'));await new Promise(r=>setTimeout(r,0));assert.equal(engine.sessionId,'new');assert.equal(engine.state.phase,'listening');engine.sessionId=null;engine.end();
});

test('late mute completion cannot send a mute command into a reopened session',async()=>{
 let finishMute;const calls=[];const media={setMuted:()=>new Promise(r=>finishMute=r),clearPlayback(){},dispose(){}};
 const engine=new VoiceChatEngine({ownerId:'a',mediaAdapter:media,fetchImpl:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return new Response('{}',{headers:{'X-AI-Account-Context':'a'}});}});
 engine.sessionId='old';engine.inputEpoch=0;const oldMute=engine.mute();engine.end();engine.sessionId='new';engine.inputEpoch=0;engine.update({phase:'listening',muted:false});
 finishMute();await oldMute;assert.equal(calls.some(c=>c.url.includes('/new/')&&c.body.type==='mute'),false);assert.equal(engine.inputEpoch,0);assert.equal(engine.state.muted,false);engine.sessionId=null;engine.end();
});
