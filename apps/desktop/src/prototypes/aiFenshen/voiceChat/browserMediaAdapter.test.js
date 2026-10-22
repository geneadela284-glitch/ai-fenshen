import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserVoiceMediaAdapter} from './browserMediaAdapter.js';
class Track extends EventTarget{
 stopped=0;readyState='live';
 stop(){this.stopped++;this.readyState='ended';}
}
class Context extends EventTarget{
 state='running';currentTime=0;destination={};audioWorklet={addModule:async()=>{}};
 resume(){return Promise.resolve();}close(){this.state='closed';return Promise.resolve();}
 createGain(){return{gain:{value:1,setTargetAtTime(){}},connect(){},disconnect(){}};}
 createMediaStreamSource(){return{connect(){},disconnect(){}};}
 createBuffer(c,n){return{duration:n/24000,getChannelData:()=>new Float32Array(n)};}
 createBufferSource(){return{connect(){},disconnect(){},start(){},stop(){}};}
}
class Worklet{port={postMessage(){},onmessage:null};connect(){}disconnect(){}}
function fixture(){const document=new EventTarget(),window=new EventTarget(),devices=new EventTarget(),tracks=[];devices.getUserMedia=async()=>{const track=new Track();tracks.push(track);return{getTracks:()=>[track],getAudioTracks:()=>[track]};};const adapter=new BrowserVoiceMediaAdapter({mediaDevices:devices,AudioContextImpl:Context,AudioWorkletNodeImpl:Worklet,documentImpl:document,windowImpl:window});return{adapter,document,window,devices,tracks};}
test('capture and unmute retain echo/noise processing without automatic amplification of background audio',async()=>{
 const f=fixture(),requests=[];const get=f.devices.getUserMedia;
 f.devices.getUserMedia=async options=>{requests.push(options);return get(options);};
 await f.adapter.start({});await f.adapter.setMuted(true);await f.adapter.setMuted(false);f.adapter.dispose();
 assert.equal(requests.length,2);
 for(const request of requests){assert.equal(request.audio.echoCancellation,true);assert.equal(request.audio.noiseSuppression,true);assert.equal(request.audio.autoGainControl,false);}
});
test('media adapter releases capture and playback on dispose, ignoring late events',async()=>{
 const f=fixture(),events=[];await f.adapter.start({onInterruption:code=>events.push(code)});
 const context=f.adapter.context;f.adapter.play({audio:'AAA=',sampleRate:24000,onEnded(){throw Error('disposed audio callback');}});
 assert.equal(f.adapter.playing,true);f.adapter.dispose();assert.equal(f.tracks[0].stopped,1);assert.equal(context.state,'closed');assert.equal(f.adapter.playing,false);
 f.window.dispatchEvent(new Event('offline'));assert.deepEqual(events,[]);
});
test('late permission after dispose stops the granted track and never activates capture',async()=>{
 let grant;const track=new Track();const adapter=new BrowserVoiceMediaAdapter({mediaDevices:{getUserMedia:()=>new Promise(r=>grant=r)},AudioContextImpl:Context,AudioWorkletNodeImpl:Worklet});
 const pending=adapter.start({});await Promise.resolve();adapter.dispose();grant({getTracks:()=>[track]});await pending;assert.equal(track.stopped,1);assert.equal(adapter.context,null);
});
test('Apple audio interruption, hidden page, microphone loss and offline all surface explicit events',async()=>{
 for(const kind of ['interrupted','suspended','hidden','track','offline']){
  const f=fixture(),events=[];await f.adapter.start({onInterruption:code=>events.push(code)});
  if(['interrupted','suspended'].includes(kind)){f.adapter.context.state=kind;f.adapter.context.dispatchEvent(new Event('statechange'));}
  if(kind==='hidden'){f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));}
  if(kind==='track')f.tracks[0].dispatchEvent(new Event('ended'));
  if(kind==='offline')f.window.dispatchEvent(new Event('offline'));
  assert.equal(events.length,1,kind);f.adapter.dispose();
 }
});
test('audio route device changes keep an active microphone capture alive',async()=>{
 const f=fixture(),events=[];await f.adapter.start({onInterruption:code=>events.push(code)});
 f.devices.dispatchEvent(new Event('devicechange'));
 assert.equal(f.tracks[0].readyState,'live');assert.deepEqual(events,[]);assert.equal(f.tracks[0].stopped,0);f.adapter.dispose();
});
test('device changes report a truly ended active microphone track',async()=>{
 const f=fixture(),events=[];await f.adapter.start({onInterruption:code=>events.push(code)});
 f.tracks[0].readyState='ended';f.devices.dispatchEvent(new Event('devicechange'));
 assert.deepEqual(events,['VOICE_MICROPHONE_LOST']);f.adapter.dispose();
});
test('device changes while the user deliberately muted do not pause the session',async()=>{
 const f=fixture(),events=[];await f.adapter.start({onInterruption:code=>events.push(code)});
 await f.adapter.setMuted(true);f.devices.dispatchEvent(new Event('devicechange'));
 assert.deepEqual(events,[]);f.adapter.dispose();
});
test('unmute tracks have the same microphone-loss protection as initial tracks',async()=>{
 const f=fixture(),events=[];await f.adapter.start({onInterruption:c=>events.push(c)});await f.adapter.setMuted(true);assert.equal(f.tracks[0].stopped,1);await f.adapter.setMuted(false);f.tracks[1].dispatchEvent(new Event('ended'));assert.deepEqual(events,['VOICE_MICROPHONE_LOST']);f.adapter.dispose();
});
test('denied permission cleans up AudioContext without opening capture',async()=>{
 const adapter=new BrowserVoiceMediaAdapter({mediaDevices:{getUserMedia:async()=>{throw Object.assign(Error('denied'),{name:'NotAllowedError'});}},AudioContextImpl:Context});
 await assert.rejects(adapter.start({}),{name:'NotAllowedError'});assert.equal(adapter.context,null);
});

test('one failed cleanup cannot keep the microphone or audio context alive',async()=>{
 const f=fixture();await f.adapter.start({});const context=f.adapter.context;f.adapter.capture.port.postMessage=()=>{throw Error('detached worklet');};assert.doesNotThrow(()=>f.adapter.dispose());assert.equal(f.tracks[0].stopped,1);assert.equal(context.state,'closed');
});
test('播放状态和音量只在音频时钟到达实际片段时更新，取消后不再回调',async()=>{
 const f=fixture(),starts=[],levels=[];await f.adapter.start({});
 f.adapter.play({audio:Buffer.alloc(4800,64).toString('base64'),sampleRate:24000,onStarted:()=>starts.push(1),onLevel:value=>levels.push(value)});
 assert.deepEqual(starts,[]);assert.equal(typeof f.adapter.samplePlayback,'function');
 f.adapter.context.currentTime=.02;f.adapter.samplePlayback();assert.deepEqual(starts,[]);
 f.adapter.context.currentTime=.05;f.adapter.samplePlayback();assert.deepEqual(starts,[1]);assert.ok(levels.at(-1)>0);
 f.adapter.clearPlayback();f.adapter.context.currentTime=.07;f.adapter.samplePlayback();assert.deepEqual(starts,[1]);assert.equal(f.adapter.sources.size,0);f.adapter.dispose();
});
