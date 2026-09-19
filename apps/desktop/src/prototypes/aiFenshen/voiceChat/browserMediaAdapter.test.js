import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserVoiceMediaAdapter} from './browserMediaAdapter.js';
class Track extends EventTarget{stopped=0;stop(){this.stopped++;}}
class Context extends EventTarget{
 state='running';currentTime=0;destination={};audioWorklet={addModule:async()=>{}};
 resume(){return Promise.resolve();}close(){this.state='closed';return Promise.resolve();}
 createGain(){return{gain:{value:1,setTargetAtTime(){}},connect(){},disconnect(){}};}
 createMediaStreamSource(){return{connect(){},disconnect(){}};}
 createBuffer(c,n){return{duration:n/24000,getChannelData:()=>new Float32Array(n)};}
 createBufferSource(){return{connect(){},disconnect(){},start(){},stop(){}};}
}
class Worklet{port={postMessage(){},onmessage:null};connect(){}disconnect(){}}
function fixture(){const document=new EventTarget(),window=new EventTarget(),devices=new EventTarget(),tracks=[];devices.getUserMedia=async()=>{const track=new Track();tracks.push(track);return{getTracks:()=>[track]};};const adapter=new BrowserVoiceMediaAdapter({mediaDevices:devices,AudioContextImpl:Context,AudioWorkletNodeImpl:Worklet,documentImpl:document,windowImpl:window});return{adapter,document,window,devices,tracks};}
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
test('Apple audio interruption, hidden page, route loss and offline all surface explicit events',async()=>{
 for(const kind of ['interrupted','suspended','hidden','device','track','offline']){
  const f=fixture(),events=[];await f.adapter.start({onInterruption:code=>events.push(code)});
  if(['interrupted','suspended'].includes(kind)){f.adapter.context.state=kind;f.adapter.context.dispatchEvent(new Event('statechange'));}
  if(kind==='hidden'){f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));}
  if(kind==='device')f.devices.dispatchEvent(new Event('devicechange'));
  if(kind==='track')f.tracks[0].dispatchEvent(new Event('ended'));
  if(kind==='offline')f.window.dispatchEvent(new Event('offline'));
  assert.equal(events.length,1,kind);f.adapter.dispose();
 }
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
