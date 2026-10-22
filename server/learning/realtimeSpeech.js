import {randomUUID} from 'node:crypto';
import {learningError} from '../../core/learning/contract.js';
export class AudioQueue{
 constructor(limit=256*1024){this.limit=limit;this.parts=[];this.bytes=0;this.wait=null;this.ended=false;this.error=null;}
 push(bytes){if(this.ended||this.error)throw learningError('LEARNING_REALTIME_CLOSED',409);if(this.bytes+bytes.length>this.limit)throw learningError('LEARNING_REALTIME_BACKPRESSURE',429);const copy=Buffer.from(bytes);if(this.wait){const w=this.wait;this.wait=null;w.resolve({value:copy,done:false});}else{this.parts.push(copy);this.bytes+=copy.length;}}
 end(){this.ended=true;if(this.wait){this.wait.resolve({done:true});this.wait=null;}}
 fail(error){this.error=error;this.parts=[];this.bytes=0;if(this.wait){this.wait.reject(error);this.wait=null;}}
 next(){if(this.error)return Promise.reject(this.error);if(this.parts.length){const value=this.parts.shift();this.bytes-=value.length;return Promise.resolve({value,done:false});}if(this.ended)return Promise.resolve({done:true});return new Promise((resolve,reject)=>{this.wait={resolve,reject};});}
 [Symbol.asyncIterator](){return this;}
}
const defaultSocket=async(url,options)=>{const {WebSocket}=await import('undici');return new WebSocket(url,options);};
export async function qwenRealtimeTransport({audioSource,signal,apiKey,baseUrl,createSocket=defaultSocket,connectTimeoutMs=10000,finishTimeoutMs=10000}){
 const u=new URL(baseUrl);if(u.protocol!=='https:'||u.hostname!=='dashscope.aliyuncs.com'||u.port||u.username||u.password||!apiKey)throw learningError('SPEECH_ENDPOINT_INVALID',503);
 signal?.throwIfAborted();const socket=await createSocket('wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime',{headers:{Authorization:`Bearer ${apiKey}`}});
 return new Promise((resolve,reject)=>{
  let settled=false,ending=false,updated=false,closingError=null,finished=false,bytes=0,finishTimer;
  const items=new Map(),known=new Set();
  const cleanup=()=>{clearTimeout(connectTimer);clearTimeout(finishTimer);signal?.removeEventListener('abort',abort);};
  const settle=(error,result)=>{if(settled)return;settled=true;cleanup();error?reject(error):resolve(result);};
  // On cancellation/errors keep the guarded provider operation pending until close.
  const fail=error=>{if(settled||closingError)return;closingError=error;audioSource.fail?.(error);clearTimeout(connectTimer);clearTimeout(finishTimer);try{socket.close();}catch{if(socket.readyState===3)settle(error);}if(socket.readyState===3)settle(error);};
  const send=(type,data={})=>{if(settled||closingError||socket.readyState!==1)throw learningError('LEARNING_SPEECH_UNAVAILABLE',503);if(socket.bufferedAmount>256*1024)throw learningError('LEARNING_REALTIME_BACKPRESSURE',429);socket.send(JSON.stringify({event_id:randomUUID(),type,...data}));};
  const abort=()=>fail(learningError('LEARNING_CANCELLED',499));
  const connectTimer=setTimeout(()=>fail(learningError('SPEECH_TIMEOUT',504)),connectTimeoutMs);connectTimer.unref?.();
  signal?.addEventListener('abort',abort,{once:true});
  socket.addEventListener('close',()=>settle(closingError||learningError('LEARNING_REALTIME_INTERRUPTED',503)));
  socket.addEventListener('error',()=>fail(learningError('LEARNING_SPEECH_UNAVAILABLE',503)));
  const configure=()=>{try{send('session.update',{session:{input_audio_format:'pcm',sample_rate:16000,input_audio_transcription:{language:'en'},turn_detection:{type:'server_vad',threshold:0,silence_duration_ms:400}}});}catch(e){fail(e);}};
  socket.addEventListener('open',configure);
  socket.addEventListener('message',event=>{if(settled||closingError)return;try{
   if(String(event.data).length>128*1024)throw learningError('SPEECH_OUTPUT_INVALID',502);
   const e=JSON.parse(String(event.data));
   if(e.type==='error'||e.type==='conversation.item.input_audio_transcription.failed')throw learningError('LEARNING_SPEECH_UNAVAILABLE',503);
   if(e.type==='session.updated'&&!updated){updated=true;clearTimeout(connectTimer);void(async()=>{try{for await(const chunk of audioSource){signal?.throwIfAborted();if(!chunk.length||chunk.length%2||chunk.length>65536)throw learningError('AUDIO_INVALID');bytes+=chunk.length;if(bytes>3840000)throw learningError('AUDIO_TOO_LONG');send('input_audio_buffer.append',{audio:Buffer.from(chunk).toString('base64')});}ending=true;send('session.finish');finishTimer=setTimeout(()=>fail(learningError('SPEECH_TIMEOUT',504)),finishTimeoutMs);finishTimer.unref?.();}catch(error){fail(error);}})();}
   const id=e.item_id||e.item?.id;
   if(['input_audio_buffer.speech_started','input_audio_buffer.committed','conversation.item.created','conversation.item.input_audio_transcription.completed'].includes(e.type)){
    if(typeof id!=='string'||!id||id.length>200)throw learningError('SPEECH_OUTPUT_INVALID',502);known.add(id);if(known.size>256)throw learningError('SPEECH_OUTPUT_INVALID',502);
    const item=items.get(id)||{};
    if(e.type==='input_audio_buffer.committed'||e.type==='conversation.item.created'){const prev=e.previous_item_id??null;if(prev!==null&&(typeof prev!=='string'||prev.length>200))throw learningError('SPEECH_OUTPUT_INVALID',502);if('previous'in item&&item.previous!==prev)throw learningError('SPEECH_OUTPUT_INVALID',502);item.previous=prev;}
    if(e.type==='conversation.item.input_audio_transcription.completed'){if(typeof e.transcript!=='string'||!e.transcript.trim()||e.transcript.length>6000)throw learningError('AUDIO_NO_SPEECH',422);if(item.text!==undefined&&item.text!==e.transcript)throw learningError('SPEECH_OUTPUT_INVALID',502);item.text=e.transcript;}
    items.set(id,item);
   }
   if(e.type==='session.finished'){
    if(!ending||!items.size)throw learningError('AUDIO_NO_SPEECH',422);
    const result=[],visited=new Set();let previous=null;
    while(visited.size<items.size){const matches=[...items].filter(([id,x])=>!visited.has(id)&&x.previous===previous);if(matches.length!==1||!matches[0][1].text)throw learningError('SPEECH_OUTPUT_INVALID',502);const[id,x]=matches[0];visited.add(id);result.push(x.text);previous=id;}
    const transcript=result.join(' ');if(transcript.length>6000)throw learningError('SPEECH_OUTPUT_INVALID',502);finished=true;settle(null,{transcript,usage:{seconds:bytes/32000}});socket.close();
   }
  }catch(error){fail(error);}});
  if(signal?.aborted)abort();else if(socket.readyState===1)configure();
 });
}
