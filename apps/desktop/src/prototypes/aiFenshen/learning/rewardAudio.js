// One context is unlocked by a user's gesture, reused, and closed on leaving.
export function createRewardAudio(url,{Context=globalThis.AudioContext||globalThis.webkitAudioContext,fetcher=globalThis.fetch}={}){
 let context=null,bufferPromise=null,source=null,generation=0,closed=false;
 function stop(){generation++;if(source){try{source.stop();}catch{}source=null;}}
 function warm(){
  if(closed||!Context)return Promise.resolve(null);
  context ||=new Context();void context.resume().catch(()=>{});
  bufferPromise ||=fetcher(url).then(r=>{if(!r.ok)throw Error('REWARD_AUDIO_UNAVAILABLE');return r.arrayBuffer();}).then(b=>context.decodeAudioData(b)).catch(()=>{bufferPromise=null;return null;});
  return bufferPromise;
 }
 async function play(){
  stop();const ticket=generation,buffer=await warm();if(closed||ticket!==generation||!buffer||context.state!=='running')return false;
  const duration=Math.min(2.8,buffer.duration),gain=context.createGain();source=context.createBufferSource();source.buffer=buffer;source.connect(gain);gain.connect(context.destination);
  const t=context.currentTime;gain.gain.setValueAtTime(0,t);gain.gain.linearRampToValueAtTime(.65,t+.08);gain.gain.setValueAtTime(.65,t+Math.max(.08,duration-.25));gain.gain.linearRampToValueAtTime(0,t+duration);
  source.start(0,0,duration);return true;
 }
 function close(){stop();closed=true;void context?.close().catch(()=>{});}
 return {warm,play,stop,close};
}
