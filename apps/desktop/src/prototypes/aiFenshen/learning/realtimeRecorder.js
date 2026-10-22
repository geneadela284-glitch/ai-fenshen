import {encodePcm16Wav} from '../dictationRecorder.js';
export function createPcmResampler(rate){
 if(!Number.isFinite(rate)||rate<16000||rate>192000)throw Error('录音采样率不支持。');
 const ratio=rate/16000;let weight=0,sum=0;
 return{push(samples){const output=[];for(const sample of samples){if(!Number.isFinite(sample))throw Error('录音数据无效。');let left=1;while(left>1e-9){const n=Math.min(left,ratio-weight);sum+=sample*n;weight+=n;left-=n;if(weight>=ratio-1e-9){output.push(sum/ratio);weight=0;sum=0;}}}return Float32Array.from(output);}};
}
export function createLearningRealtimeRecorder({mediaDevices=globalThis.navigator?.mediaDevices,AudioContextClass=globalThis.AudioContext||globalThis.webkitAudioContext,maxDurationMs=120000,onRecordingReady=()=>{},onChunk=()=>{},onAudioReady=()=>{},onError=()=>{},onStateChange=()=>{},onProgress=()=>{}}={}){
 let state='idle',cancelled=false,stream,context,source,processor,sink,timer,resampler;const parts=[];let count=0;
 const set=s=>{state=s;onStateChange(s);};
 const release=()=>{clearTimeout(timer);try{processor?.disconnect();source?.disconnect();sink?.disconnect();}catch{}for(const track of stream?.getTracks()||[])track.stop();stream=null;void context?.close().catch(()=>{});context=null;};
 const fail=e=>{release();set('failed');onError(Object.assign(new Error(e?.name==='NotAllowedError'?'请允许使用麦克风后再试。':e?.message||'录音失败，请重试。'),{code:'LEARNING_RECORDING_FAILED'}));};
 const stop=()=>{if(state==='requesting_permission'){cancel();return false;}if(state!=='recording')return false;release();set('processing');const total=new Float32Array(count);let at=0;for(const p of parts){total.set(p,at);at+=p.length;}parts.length=0;if(!count){fail(Error('没有采集到有效声音。'));return false;}onAudioReady({blob:new Blob([encodePcm16Wav(total)],{type:'audio/wav'}),durationMs:count/16});return true;};
 const cancel=()=>{cancelled=true;release();parts.length=0;set('cancelled');};
 return{get active(){return state==='recording'||state==='requesting_permission';},stop,cancel,async start(){if(state!=='idle')return;set('requesting_permission');try{stream=await mediaDevices.getUserMedia({audio:true});if(cancelled){release();return;}context=new AudioContextClass();await context.resume();if(cancelled){release();return;}resampler=createPcmResampler(context.sampleRate);source=context.createMediaStreamSource(stream);processor=context.createScriptProcessor(4096,1,1);sink=context.createGain();sink.gain.value=0;source.connect(processor);processor.connect(sink);sink.connect(context.destination);
 processor.onaudioprocess=e=>{if(state!=='recording')return;try{const input=e.inputBuffer.getChannelData(0),out=resampler.push(input);const remaining=Math.max(0,Math.floor(Math.min(120000,maxDurationMs)*16)-count),pcm=out.subarray(0,remaining);if(pcm.length){parts.push(pcm);count+=pcm.length;onChunk(new Uint8Array(encodePcm16Wav(pcm)).slice(44));onProgress({durationMs:count/16});}if(pcm.length<out.length||count>=Math.min(120000,maxDurationMs)*16)stop();}catch(error){fail(error);}};
 set('recording');onRecordingReady();timer=setTimeout(stop,Math.min(120000,maxDurationMs));
 }catch(e){if(!cancelled)fail(e);else release();}}};
}
