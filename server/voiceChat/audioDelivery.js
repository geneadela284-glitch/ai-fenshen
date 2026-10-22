const fail=code=>Object.assign(new Error(code),{code});
const BYTES_PER_MS=48,CHUNK_BYTES=4800,LOOKAHEAD_MS=2000,MAX_BYTES=60*48000;
// Producer speed is independent of playback speed. Keep the existing browser
// 30-second stall guard intact by delivering at most two seconds ahead.
export class PacedAudioDelivery {
 constructor({send,signal,now=()=>performance.now()}){Object.assign(this,{send,signal,now});this.queue=[];this.queuedBytes=0;this.totalBytes=0;this.nextEnd=0;this.cancelled=false;this.abort=()=>this.cancel();signal?.addEventListener('abort',this.abort,{once:true});if(signal?.aborted)this.cancel();}
 push(bytes){
  if(this.cancelled)return;if(this.failure)throw this.failure;
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length%2)throw fail('VOICE_AUDIO_INVALID');
  if(this.totalBytes+bytes.length>MAX_BYTES)throw fail('VOICE_AUDIO_LIMIT');
  this.totalBytes+=bytes.length;this.queuedBytes+=bytes.length;this.queue.push({bytes,offset:0});this.start();
 }
 start(){if(this.task||this.cancelled||!this.queue.length)return;
  this.task=Promise.resolve().then(()=>this.drain()).catch(e=>{this.failure=e;this.cancel();}).finally(()=>{this.task=null;this.start();});
 }
 async drain(){while(this.queue.length&&!this.cancelled){
  const item=this.queue[0],length=Math.min(CHUNK_BYTES,item.bytes.length-item.offset),duration=length/BYTES_PER_MS;
  const now=this.now(),delay=Math.max(now,this.nextEnd)+duration-now-LOOKAHEAD_MS;
  if(delay>0){await new Promise(resolve=>{this.wake=()=>{clearTimeout(this.timer);this.timer=null;this.wake=null;resolve();};this.timer=setTimeout(this.wake,Math.min(100,Math.ceil(delay)));});continue;}
  if(this.signal?.aborted){this.cancel();break;}
  this.send(item.bytes.subarray(item.offset,item.offset+length));this.nextEnd=Math.max(now,this.nextEnd)+duration;
  item.offset+=length;this.queuedBytes-=length;if(item.offset===item.bytes.length)this.queue.shift();
 }}
 async finish(){this.start();while(this.task)await this.task;this.signal?.removeEventListener('abort',this.abort);if(this.failure)throw this.failure;}
 cancel(){this.cancelled=true;this.queue=[];this.queuedBytes=0;this.wake?.();this.signal?.removeEventListener('abort',this.abort);}
}
