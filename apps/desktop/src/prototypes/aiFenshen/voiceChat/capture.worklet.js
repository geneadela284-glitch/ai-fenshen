// Browser echo cancellation runs before this node. Audio is never persisted.
class VoiceCapture extends AudioWorkletProcessor {
 constructor(){super();this.samples=[];this.phase=0;this.energy=0;this.count=0;this.port.onmessage=e=>{if(e.data==='clear'){this.samples=[];this.phase=0;this.energy=0;this.count=0;}};}
 process(inputs){const input=inputs[0]?.[0];if(!input)return true;
  const step=sampleRate/16000;
  for(let i=0;i<input.length;i++){this.energy+=input[i]*input[i];this.count++;}
  while(this.phase<input.length){const i=Math.floor(this.phase),fraction=this.phase-i;const value=input[i]+((input[Math.min(i+1,input.length-1)]||0)-input[i])*fraction;this.samples.push(Math.round(Math.max(-1,Math.min(1,value))*32767));this.phase+=step;}
  this.phase-=input.length;
  if(this.samples.length>=1600){const pcm=new Int16Array(this.samples.splice(0,1600));this.port.postMessage({pcm:pcm.buffer,rms:Math.sqrt(this.energy/Math.max(1,this.count))},[pcm.buffer]);this.energy=0;this.count=0;}
  return true;
 }
}
registerProcessor('voice-chat-capture',VoiceCapture);
