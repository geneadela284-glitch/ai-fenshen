const fail=code=>Object.assign(new Error(code),{code});
const safely=fn=>{try{fn();}catch{}};
const constraints={audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false};

// Platform-only media port. No account, conversation, model or business state lives here.
export class BrowserVoiceMediaAdapter {
 constructor({mediaDevices=globalThis.navigator?.mediaDevices,AudioContextImpl=globalThis.AudioContext||globalThis.webkitAudioContext,AudioWorkletNodeImpl=globalThis.AudioWorkletNode,documentImpl=globalThis.document,windowImpl=globalThis.window,workletUrl=new URL('./capture.worklet.js?no-inline',import.meta.url).href}={}){
  Object.assign(this,{mediaDevices,AudioContextImpl,AudioWorkletNodeImpl,documentImpl,windowImpl,workletUrl});
  this.generation=0;this.sources=new Set();this.listeners=[];this.trackListeners=[];this.context=null;
 }
 get playing(){return this.sources.size>0;}
 listen(target,type,fn,collection=this.listeners){if(!target?.addEventListener)return;target.addEventListener(type,fn);collection.push(()=>target.removeEventListener(type,fn));}
 stopCapture(){for(const off of this.trackListeners.splice(0))safely(off);for(const track of this.stream?.getTracks()||[])safely(()=>track.stop());this.stream=null;safely(()=>this.input?.disconnect());this.input=null;safely(()=>this.capture?.port.postMessage('clear'));}
 attachStream(stream,generation){
  this.stream=stream;for(const track of stream.getTracks())this.listen(track,'ended',()=>{if(this.generation===generation)this.onInterruption('VOICE_MICROPHONE_LOST');},this.trackListeners);
  this.input=this.context.createMediaStreamSource(stream);this.input.connect(this.capture);
 }
 async start({onFrame=()=>{},onInterruption=()=>{}}={}){
  this.dispose();const generation=++this.generation;this.onInterruption=onInterruption;this.muted=false;
  try{
   if(!this.AudioContextImpl||!this.mediaDevices?.getUserMedia)throw fail('VOICE_BROWSER_UNSUPPORTED');
   const context=new this.AudioContextImpl();this.context=context;await context.resume();
   if(generation!==this.generation)return false;
   const stream=await this.mediaDevices.getUserMedia(constraints);
   if(generation!==this.generation){for(const track of stream.getTracks())safely(()=>track.stop());return false;}
   this.stream=stream;
   if(!context.audioWorklet||!this.AudioWorkletNodeImpl)throw fail('VOICE_BROWSER_UNSUPPORTED');
   await context.audioWorklet.addModule(this.workletUrl);if(generation!==this.generation)return false;
   this.output=context.createGain();this.output.connect(context.destination);
   this.capture=new this.AudioWorkletNodeImpl(context,'voice-chat-capture');this.silent=context.createGain();this.silent.gain.value=0;
   this.capture.connect(this.silent);this.silent.connect(context.destination);this.attachStream(stream,generation);
   this.capture.port.onmessage=e=>{if(generation===this.generation&&!this.muted)onFrame(e.data);};
   const notify=code=>{if(generation===this.generation)onInterruption(code);};
   this.listen(context,'statechange',()=>{if(context.state!=='running')notify('VOICE_PLAYBACK_BLOCKED');});
   this.listen(this.documentImpl,'visibilitychange',()=>{if(this.documentImpl.hidden)notify('VOICE_BACKGROUND');});
   this.listen(this.windowImpl,'pagehide',()=>notify('VOICE_BACKGROUND'));
   this.listen(this.windowImpl,'offline',()=>notify('VOICE_OFFLINE'));
   this.listen(this.mediaDevices,'devicechange',()=>notify('VOICE_MICROPHONE_LOST'));
   if(context.state!=='running'||this.documentImpl?.hidden)throw fail(this.documentImpl?.hidden?'VOICE_BACKGROUND':'VOICE_PLAYBACK_BLOCKED');
   return true;
  }catch(error){if(generation===this.generation)this.dispose();throw error;}
 }
 async setMuted(value){
  const generation=this.generation;this.muted=value;this.stopCapture();if(value)return;
  const stream=await this.mediaDevices.getUserMedia(constraints);
  if(generation!==this.generation){for(const track of stream.getTracks())safely(()=>track.stop());return;}
  try{this.attachStream(stream,generation);}catch(error){for(const track of stream.getTracks())safely(()=>track.stop());throw error;}
 }
 play({audio,sampleRate,onEnded}){
  const context=this.context;if(!context||context.state!=='running')throw fail('VOICE_PLAYBACK_BLOCKED');
  if(sampleRate!==24000)throw fail('VOICE_AUDIO_ORDER');
  let raw;try{raw=atob(audio);}catch{throw fail('VOICE_AUDIO_INVALID');}
  if(!raw.length||raw.length%2)throw fail('VOICE_AUDIO_INVALID');
  const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0)),pcm=new DataView(bytes.buffer),buffer=context.createBuffer(1,bytes.length/2,24000),channel=buffer.getChannelData(0);
  for(let i=0;i<channel.length;i++)channel[i]=pcm.getInt16(i*2,true)/32768;
  const now=context.currentTime;if(this.nextPlay-now>30)throw fail('VOICE_PLAYBACK_SLOW');
  const source=context.createBufferSource();source.buffer=buffer;source.connect(this.output||context.destination);this.sources.add(source);
  source.onended=()=>{safely(()=>source.disconnect());this.sources.delete(source);onEnded?.();};
  const at=Math.max(now+.035,this.nextPlay||0);source.start(at);this.nextPlay=at+buffer.duration;return{scheduledInMs:(at-now)*1000};
 }
 setVolume(value){if(this.output?.gain&&this.context)this.output.gain.setTargetAtTime(value,this.context.currentTime,.04);}
 clearPlayback(){for(const source of this.sources){source.onended=null;safely(()=>source.stop());safely(()=>source.disconnect());}this.sources.clear();this.nextPlay=0;this.setVolume(1);}
 dispose(){
  ++this.generation;for(const off of this.listeners.splice(0))safely(off);this.stopCapture();this.clearPlayback();
  if(this.capture)this.capture.port.onmessage=null;
  for(const node of [this.capture,this.silent,this.output])safely(()=>node?.disconnect());this.capture=null;this.silent=null;this.output=null;
  const context=this.context;this.context=null;if(context)safely(()=>{void context.close().catch(()=>{});});
 }
}
