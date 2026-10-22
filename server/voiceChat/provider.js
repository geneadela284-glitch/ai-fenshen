import { randomUUID } from 'node:crypto';
import { createRouterExecutionContext } from '../../core/router/RouterExecutionContext.js';
const fail=code=>Object.assign(new Error(code),{code});
const ASR_PENDING_MAX_BYTES=320000,ASR_PENDING_MAX_WAIT_MS=10000,SOCKET_HARD_BYTES=128000,SOCKET_LOW_WATER_BYTES=64000,ASR_DRAIN_INTERVAL_MS=20;
export const VOICE_CAPABILITIES=new Set(['VOICE_CHAT_ASR','VOICE_CHAT_TTS']);
export function createVoiceSpeechRuntime({aiService,WebSocketImpl=WebSocket}={}) {
 return {async run(task,invocation={}) {
  if(!VOICE_CAPABILITIES.has(task.capability))throw fail('VOICE_CAPABILITY_INVALID');
  const asr=task.capability==='VOICE_CHAT_ASR';
  const model=asr?'qwen3-asr-flash-realtime':'qwen3-tts-flash-realtime';
  const config=aiService.settings.load().providers?.qwen;
  if(!config?.enabled||new URL(config.baseUrl).hostname!=='dashscope.aliyuncs.com')throw fail('VOICE_UNAVAILABLE');
  const candidate={providerId:'qwen',modelId:model};
  const context=createRouterExecutionContext({requestId:invocation.requestLease?.requestId,ownerId:invocation.ownerId,domain:'voice_chat'});
  return aiService.router.invokeGuardedOperation({candidate,attempt:context.attempt(1,candidate),invocation,pricing:null,
   request:{input:asr?'Real-time speech recognition':'Real-time reply synthesis',options:{maxTokens:512}},
   operation:()=>{
    const connect=async credentials=>{const dispatcher=!asr&&task.checkedOrdinaryTransport===true?(await import('../../core/providers/ordinaryVoiceTransport.node.js')).getOrdinaryVoiceDispatcher():undefined;return openSpeechSocket({task,model,apiKey:credentials.api_key,WebSocketImpl,dispatcher});};
    return aiService.credentialResolver?aiService.credentialResolver.withCredentials({providerId:'qwen',purpose:'invoke'},connect):connect({api_key:config.apiKey});
   }});
 }};
}
export function openSpeechSocket({task,model,apiKey,WebSocketImpl=WebSocket,url,dispatcher}) {
 const asr=task.capability==='VOICE_CHAT_ASR';
 if(!apiKey)throw fail('VOICE_UNAVAILABLE');
 return new Promise((resolve,reject)=>{
  if(task.signal?.aborted)return reject(fail('VOICE_CANCELLED'));
  const ws=new WebSocketImpl(url||`wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${model}`,{...(dispatcher?{dispatcher}:{}),headers:{Authorization:`Bearer ${apiKey}`}});
  let settled=false,ready=false,characters=0,audioBytes=0,usage=null,finishRequested=false,finishSent=false,pendingAudio=[],pendingAudioBytes=0,pendingAudioStartedAt=null,pumpTimer=null;
  const timer=setTimeout(()=>end('VOICE_TIMEOUT'),asr?95000:45000);
  const connectTimer=setTimeout(()=>end('VOICE_CONNECT_TIMEOUT'),10000);
  const abort=()=>end('VOICE_CANCELLED');task.signal?.addEventListener('abort',abort,{once:true});
  const send=(type,fields={})=>{if(settled||ws.readyState!==1)throw fail('VOICE_DISCONNECTED');if(ws.bufferedAmount>SOCKET_HARD_BYTES)throw fail('VOICE_BACKPRESSURE');ws.send(JSON.stringify({event_id:randomUUID(),type,...fields}));};
  function clearPendingAudio(){if(pumpTimer){clearTimeout(pumpTimer);pumpTimer=null;}pendingAudio=[];pendingAudioBytes=0;pendingAudioStartedAt=null;}
  function scheduleDrain(){if(settled||pumpTimer)return;pumpTimer=setTimeout(()=>{pumpTimer=null;drainAudio();},ASR_DRAIN_INTERVAL_MS);pumpTimer.unref?.();}
  function sendBounded(raw){if(settled||ws.readyState!==1)throw fail('VOICE_DISCONNECTED');const byteLength=Buffer.byteLength(raw);if(ws.bufferedAmount>SOCKET_LOW_WATER_BYTES||ws.bufferedAmount+byteLength>SOCKET_HARD_BYTES)return false;ws.send(raw);return true;}
  function drainAudio(){try{
   if(settled||!asr)return;
   if(pendingAudio.length&&Date.now()-pendingAudioStartedAt>=ASR_PENDING_MAX_WAIT_MS){end('VOICE_BACKPRESSURE');return;}
   while(pendingAudio.length){const bytes=pendingAudio[0],raw=JSON.stringify({event_id:randomUUID(),type:'input_audio_buffer.append',audio:bytes.toString('base64')});if(!sendBounded(raw)){scheduleDrain();return;}pendingAudio.shift();pendingAudioBytes-=bytes.length;}
   pendingAudioStartedAt=null;
   if(finishRequested&&!finishSent){const raw=JSON.stringify({event_id:randomUUID(),type:'session.finish'});if(!sendBounded(raw)){scheduleDrain();return;}finishSent=true;}
  }catch(e){end(e.code||'VOICE_PROTOCOL_ERROR');}}
  function appendAudio(bytes){
   if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>32000||bytes.length%2)throw fail('VOICE_AUDIO_INVALID');
   if(finishRequested)throw fail('VOICE_INPUT_CLOSED');
   if(pendingAudioBytes+bytes.length>ASR_PENDING_MAX_BYTES){end('VOICE_BACKPRESSURE');throw fail('VOICE_BACKPRESSURE');}
   if(!pendingAudio.length)pendingAudioStartedAt=Date.now();pendingAudio.push(bytes);pendingAudioBytes+=bytes.length;scheduleDrain();
  }
  function end(code){if(settled)return;settled=true;clearTimeout(timer);clearTimeout(connectTimer);clearPendingAudio();task.signal?.removeEventListener('abort',abort);try{ws.close();}catch{};const result={usage,inputCharacters:characters,outputAudioMs:Math.ceil(audioBytes/48)};if(code)reject(Object.assign(fail(code),{usage}));else resolve(result);}
  function finish(){if(settled||finishRequested)return;finishRequested=true;if(asr)drainAudio();else send('session.finish');}
  ws.addEventListener('open',()=>{try{send('session.update',{session:asr?{input_audio_format:'pcm',sample_rate:16000,input_audio_transcription:{language:'zh'},turn_detection:{type:'server_vad',threshold:0.5,silence_duration_ms:task.silenceDurationMs===650?650:800}}:{mode:'server_commit',voice:'Cherry',language_type:'Chinese',response_format:'pcm',sample_rate:24000}});}catch(e){end(e.code||'VOICE_PROTOCOL_ERROR');}});
  ws.addEventListener('error',()=>end('VOICE_CONNECTION_FAILED'));
  ws.addEventListener('close',()=>{if(!settled)end('VOICE_DISCONNECTED');});
  ws.addEventListener('message',event=>{try{
   if(typeof event.data!=='string'||event.data.length>1024*1024)throw fail('VOICE_EVENT_LIMIT');
   const data=JSON.parse(event.data);if(data.type==='error')throw fail('VOICE_PROVIDER_ERROR');
   if(data.type==='session.updated'&&!ready){ready=true;clearTimeout(connectTimer);
    if(asr)task.onReady?.({append:appendAudio,finish});
    else{void(async()=>{try{for await(const text of task.text){if(settled)break;const part=String(text);characters+=part.length;if(characters>3000)throw fail('VOICE_TEXT_LIMIT');if(part)send('input_text_buffer.append',{text:part});}if(!settled)finish();}catch(e){end(e.code||'VOICE_TEXT_FAILED');}})();}
   }
   if(data.type==='input_audio_buffer.speech_started')task.onSpeechStart?.();
   if(data.type==='input_audio_buffer.speech_stopped')task.onSpeechStop?.();
   if(data.type==='conversation.item.input_audio_transcription.text')task.onPartial?.(String(data.text||'')+String(data.stash||''));
   if(data.type==='conversation.item.input_audio_transcription.completed')task.onTranscript?.(String(data.transcript||'').trim(),String(data.item_id||data.event_id||''));
   if(data.type==='response.audio.delta'){const bytes=Buffer.from(data.delta||'','base64');if(bytes.length%2)throw fail('VOICE_AUDIO_INVALID');audioBytes+=bytes.length;if(audioBytes>60*48000)throw fail('VOICE_AUDIO_LIMIT');task.onAudio?.(bytes);}
   if(data.type==='response.done')usage=data.response?.usage||data.usage||usage;
   if(data.type==='session.finished'){usage=data.usage||usage;end();}
  }catch(e){end(e.code||'VOICE_PROTOCOL_ERROR');}});
 });
}
export class TextStream {
 constructor(){this.queue=[];this.waiter=null;this.done=false;this.size=0;}
 push(text){if(this.done)return;this.size+=text.length;if(this.size>3000)throw fail('VOICE_TEXT_LIMIT');this.queue.push(text);this.waiter?.();this.waiter=null;}
 end(){this.done=true;this.waiter?.();this.waiter=null;}
 async *[Symbol.asyncIterator](){while(!this.done||this.queue.length){if(this.queue.length)yield this.queue.shift();else await new Promise(r=>this.waiter=r);}}
}
