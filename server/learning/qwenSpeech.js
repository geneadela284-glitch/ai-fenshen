import {qwenRealtimeTransport} from './realtimeSpeech.js';
import { randomUUID } from 'node:crypto';
import { learningError } from '../../core/learning/contract.js';
import { createRouterExecutionContext } from '../../core/router/RouterExecutionContext.js';
import { encodePcm16Wav, downsampleMonoFloat32 } from '../../apps/desktop/src/prototypes/aiFenshen/dictationRecorder.js';
import { SpeechGateway, validateLearningAudio } from './speech.js';
const models={transcribe:'qwen3-asr-flash',synthesize:'qwen3-tts-flash',realtime:'qwen3-asr-flash-realtime'};
function endpoint(baseUrl){let u;try{u=new URL(baseUrl);}catch{throw learningError('SPEECH_ENDPOINT_INVALID',503);}if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||!(/^(dashscope|dashscope-intl)\.aliyuncs\.com$/.test(u.hostname)||/^[a-z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(u.hostname)))throw learningError('SPEECH_ENDPOINT_INVALID',503);return u.origin;}
export function approvedAudioUrl(value){let u;try{u=new URL(value);}catch{throw learningError('SPEECH_OUTPUT_INVALID',502);}if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port||!/^dashscope-result-[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(u.hostname))throw learningError('SPEECH_OUTPUT_INVALID',502);u.protocol='https:';return u.href;}
async function limited(response,limit){if(!response.ok)throw learningError('LEARNING_SPEECH_UNAVAILABLE',503);const reader=response.body.getReader();const parts=[];let bytes=0;try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>limit)throw learningError('SPEECH_OUTPUT_INVALID',502);parts.push(Buffer.from(value));}return Buffer.concat(parts);}finally{await reader.cancel().catch(()=>{});}}
export function normalizeSpeechWav(bytes){
 // Qwen's completed response can retain the exact streaming length sentinels below.
 // Finalize only that known PCM24k mono framing after the bounded HTTP body has ended.
 // Arbitrary length mismatches and all learner-upload validation remain rejected.
 if(Buffer.isBuffer(bytes)&&bytes.length>=44&&bytes.length<=8*1024*1024&&bytes.length%2===0&&
   bytes.toString('ascii',0,4)==='RIFF'&&bytes.readUInt32LE(4)===0x7fffffbf&&bytes.toString('ascii',8,16)==='WAVEfmt '&&
   bytes.readUInt32LE(16)===16&&bytes.readUInt16LE(20)===1&&bytes.readUInt16LE(22)===1&&bytes.readUInt32LE(24)===24000&&
   bytes.readUInt32LE(28)===48000&&bytes.readUInt16LE(32)===2&&bytes.readUInt16LE(34)===16&&bytes.toString('ascii',36,40)==='data'&&bytes.readUInt32LE(40)===0x7fffff9b){
   bytes=Buffer.from(bytes);bytes.writeUInt32LE(bytes.length-8,4);bytes.writeUInt32LE(bytes.length-44,40);
 }

 if(!Buffer.isBuffer(bytes)||bytes.length<44||bytes.length>8*1024*1024||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE'||bytes.readUInt32LE(4)+8!==bytes.length)throw learningError('AUDIO_INVALID');
 let fmt,data;for(let offset=12;offset+8<=bytes.length;){const length=bytes.readUInt32LE(offset+4),start=offset+8;if(start+length>bytes.length)throw learningError('AUDIO_INVALID');const kind=bytes.toString('ascii',offset,offset+4);if(kind==='fmt '){if(fmt||length<16)throw learningError('AUDIO_INVALID');fmt=bytes.subarray(start,start+length);}if(kind==='data'){if(data)throw learningError('AUDIO_INVALID');data=bytes.subarray(start,start+length);}offset=start+length+length%2;}
 if(!fmt||!data?.length||fmt.readUInt16LE(0)!==1||fmt.readUInt16LE(14)!==16)throw learningError('AUDIO_INVALID');const channels=fmt.readUInt16LE(2),rate=fmt.readUInt32LE(4);if(![1,2].includes(channels)||![16000,22050,24000,32000,44100,48000].includes(rate)||data.length%(channels*2)||fmt.readUInt32LE(8)!==rate*channels*2||fmt.readUInt16LE(12)!==channels*2)throw learningError('AUDIO_INVALID');
 if(channels===1&&rate===16000){validateLearningAudio(bytes);return bytes;}
 const samples=new Float32Array(data.length/(channels*2));for(let i=0;i<samples.length;i++){let value=0;for(let c=0;c<channels;c++)value+=data.readInt16LE((i*channels+c)*2)/32768;samples[i]=value/channels;}
 const output=Buffer.from(encodePcm16Wav(downsampleMonoFloat32(samples,rate)));validateLearningAudio(output);return output;
}
export async function qwenSpeechTransport({kind,input,apiKey,baseUrl,signal,fetchImpl=fetch}){
 const origin=endpoint(baseUrl);if(!apiKey||!models[kind])throw learningError('LEARNING_SPEECH_UNAVAILABLE',503);
 const body=kind==='transcribe'?{model:models[kind],messages:[{role:'user',content:[{type:'input_audio',input_audio:{data:`data:audio/wav;base64,${input.toString('base64')}`}}]}],stream:false,asr_options:{language:'en',enable_itn:false}}:{model:models[kind],input:{text:input,voice:'Cherry',language_type:'English'}};
 const route=kind==='transcribe'?'/compatible-mode/v1/chat/completions':'/api/v1/services/aigc/multimodal-generation/generation';
 const response=await fetchImpl(origin+route,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal});
 let result;try{result=JSON.parse((await limited(response,128*1024)).toString('utf8'));}catch(e){if(e.code)throw e;throw learningError('SPEECH_OUTPUT_INVALID',502);}
 if(kind==='transcribe'){const transcript=result.choices?.[0]?.message?.content;if(typeof transcript!=='string'||!/[a-z]/i.test(transcript)||/^\s*[\[(]/.test(transcript))throw learningError('AUDIO_NO_SPEECH',422);return {transcript,usage:result.usage||null};}
 const audio=await fetchImpl(approvedAudioUrl(result.output?.audio?.url),{redirect:'error',signal});return {audio:normalizeSpeechWav(await limited(audio,8*1024*1024)),usage:result.usage||null};
}
export function createQwenLearningSpeech({aiService,fetchImpl=fetch,createSocket}){
 if(!aiService?.settings||!aiService?.router?.invokeGuardedOperation)return new SpeechGateway();
 async function invoke(kind,input,{signal,invocation}){
  const settings=aiService.settings.load(),config=settings.providers?.qwen;
  if(config?.enabled!==true)throw learningError('LEARNING_SPEECH_UNAVAILABLE',503);
  const candidate={providerId:'qwen',modelId:models[kind]};const execution=createRouterExecutionContext({requestId:invocation.requestLease?.requestId||randomUUID(),ownerId:invocation.ownerId,domain:'learning_speech'});
  const operation=async()=>{
    const withKey=credentials=>kind==='realtime'?qwenRealtimeTransport({audioSource:input,apiKey:credentials.api_key,baseUrl:config.baseUrl,signal,createSocket}):qwenSpeechTransport({kind,input,apiKey:credentials.api_key,baseUrl:config.baseUrl,signal,fetchImpl});
    if(aiService.credentialResolver)return aiService.credentialResolver.withCredentials({providerId:'qwen',purpose:'invoke'},withKey);
    return withKey({api_key:config.apiKey});
  };
  return aiService.router.invokeGuardedOperation({candidate,attempt:execution.attempt(1,candidate,'planning'),invocation,pricing:null,request:{input:kind==='transcribe'||kind==='realtime'?'English speech recognition':input,options:{maxTokens:1200},metadata:{purpose:'learning_speech'}},operation});
 }
 return new SpeechGateway({realtimeTranscribe:(input,options)=>invoke('realtime',input,options),transcribe:(input,options)=>invoke('transcribe',input,options),synthesize:async(input,options)=>(await invoke('synthesize',input,options)).audio});
}
