import { PlaybackNoteFilter, stripPlaybackNotes } from './playbackText.js';
import { SpeechText } from './speechText.js';
import { randomUUID } from 'node:crypto';
import { ConversationService } from '../conversation/conversationService.js';
import { healthPrivateAiService } from '../health/aiPrivacy.js';
import { VoiceWriteGate } from './writeGate.js';
import { VoiceRepository } from './repository.js';
import { createVoiceAssistant,confirmationSummary,confirmationResult,isStandaloneVoiceGreeting } from './assistant.js';
import { createVoiceSpeechRuntime,TextStream,VOICE_CONNECT_TIMEOUT_MS } from './provider.js';
import {hasMeaningfulInterruptionText,hasFreshCandidate,receiveSpeechCandidate,normalizedSpeech,isExplicitInterruption} from './interruption.js';
import {VOICE_RESPONSE_MAX_TOKENS,VOICE_RESPONSE_STYLE,boundVoiceConversationMessages} from './ordinaryChat.js';
import {isAccessControlErrorCode} from '../../core/router/AccessControlErrorCodes.js';
const fail=code=>Object.assign(new Error(code),{code});
const noise=text=>!text||!/\p{L}|\p{N}/u.test(text)||/^(?:谢谢观看|感谢观看|字幕由|请不吝点赞|请勿模仿)/.test(text);
function boundedVoiceTask(task={}){
 const requested=Number(task.options?.maxTokens);
 const maxTokens=Number.isFinite(requested)&&requested>0?Math.min(requested,VOICE_RESPONSE_MAX_TOKENS):VOICE_RESPONSE_MAX_TOKENS;
 return {...task,options:{...(task.options||{}),maxTokens},metadata:{...(task.metadata||{}),voiceOrdinaryChat:true}};
}
export function createVoiceChatRuntime({conversationRuntime,aiService,accessControl,enabled=false,clock=Date.now,globalLimit=2,dailyLimitMs=null,assistantOverride,coreOptions={},onTiming=()=>{},...domains}={}) {
 if(!enabled)return{enabled:false,close(){}};
 if(!conversationRuntime?.database||!aiService?.router||!accessControl)throw fail('VOICE_RUNTIME_REQUIRED');
 const repository=new VoiceRepository(conversationRuntime.database);repository.migrate();
 conversationRuntime.messages.voiceRepository=repository;conversationRuntime.conversations.voiceRepository=repository;
 const gate=new VoiceWriteGate({clock}),sessions=new Map(),background=new Set(),ended=new Map(),starting=new Map(),draining=new Map();
 const continuous=coreOptions.continuousLifecycle===true;
 let runtimeClosed=false;
 function timing(stage,t){try{onTiming({stage,at:clock(),turnId:t?.id||null});}catch{}}
 function requirePermit(s){
  if(!continuous)return;
  if(s.closed||clock()>=s.authorizationExpiresAt||(s.asrLease&&clock()>=Date.parse(s.asrLease.lease.leaseExpiresAt))){
   if(!s.closed)end(s,'VOICE_AUTHORIZATION_EXPIRED');throw fail('VOICE_AUTHORIZATION_EXPIRED');
  }
 }
 function permitted(s){if(s.closed||s.ending)return false;try{requirePermit(s);return true;}catch{return false;}}
 function requireInvocation(invocation){
  if(!continuous)return;
  const s=[...sessions.values()].find(s=>s.ownerId===invocation?.ownerId&&s.turn?.prepared?.invocation?.requestLease===invocation?.requestLease);
  if(!s)throw fail('VOICE_AUTHORIZATION_EXPIRED');requirePermit(s);
 }
 function turnInvocation(s,t,lease){
  const check=()=>{requirePermit(s);if(s.turn!==t||t.controller.signal.aborted)throw fail('VOICE_CANCELLED');};
  // Planner run/repair and health calls retain this invocation. The shared
  // Router reads these fields anew at every guarded Provider admission.
  return continuous?Object.freeze({ownerId:s.ownerId,
   get subject(){check();return s.subject;},
   get requestLease(){check();return lease;}
  }):{ownerId:s.ownerId,subject:s.subject,requestLease:lease};
 }
 function cancelDrain(record){
  if(!record.incomplete){record.incomplete=true;timing('asr_finish_incomplete');}
  clearInterval(record.finishRetry);clearTimeout(record.finishDeadline);record.controller.abort();
 }
 function authenticate(s){
  if(s.authorizationInFlight)return s.authorizationInFlight;
  const epoch=s.asrEpoch,record=s.asrLease;
  const pending=(async()=>{
   try{
    requirePermit(s);
    const stopped=new Promise(resolve=>{s.authorizationStop=()=>resolve(null);});
    // Observe the original validation even after close wins the non-blocking
    // wait: a late revoke may still cancel only this generation's drain.
    const validation=Promise.resolve(s.validateAuthorization()).then(value=>{
     const subject=accessControl.assertAuthenticatedSubject(value);
     if(subject.accountId!==s.ownerId)throw fail('VOICE_ACCOUNT_MISMATCH');
     return subject;
    }).catch(error=>{if(record&&draining.get(s.id)?.record===record&&record.epoch===epoch)cancelDrain(record);throw error;});
    const validated=await Promise.race([validation,stopped]);
    if(s.closed||s.asrEpoch!==epoch)return false;
    requirePermit(s);const subject=accessControl.assertAuthenticatedSubject(validated);
    if(subject.accountId!==s.ownerId)throw fail('VOICE_ACCOUNT_MISMATCH');
    if(record&&s.asrLease===record)record.lease=accessControl.renewVoiceStreamRequest({subject,requestLease:record.lease,voiceSessionId:s.id,generation:epoch});
    s.subject=subject;s.authorizationCheckAt=clock();s.authorizationExpiresAt=clock()+20000;s.nextRenewAt=clock()+10000;
    return true;
   }catch(error){if(!s.closed&&s.asrEpoch===epoch)end(s,error.code||'VOICE_AUTHORIZATION_FAILED');return false;}
  })();
  s.authorizationInFlight=pending;
  pending.finally(()=>{if(s.authorizationInFlight===pending){s.authorizationInFlight=null;s.authorizationStop=null;}});return pending;
 }
 // Match the existing connection deadline, rather than failing a normal
 // reconnect after just one second. Both bytes and oldest-frame age are bounded.
 function clearAudioQueue(s){clearInterval(s.audioDrainTimer);s.audioDrainTimer=null;s.audioQueue=[];}
 function drainAudio(s){
  if(s.closed||s.muted){clearAudioQueue(s);return;}
  requirePermit(s);
  if(s.audioQueue.length&&clock()-s.audioQueue[0].at>=VOICE_CONNECT_TIMEOUT_MS)throw fail('VOICE_BACKPRESSURE');
  while(s.asr&&s.audioQueue.length){requirePermit(s);
   if(s.asr.append(s.audioQueue[0].bytes)===false)break;
   s.audioQueue.shift();
  }
  if(!s.audioQueue.length){clearAudioQueue(s);return;}
  if(!s.audioDrainTimer){s.audioDrainTimer=setInterval(()=>{try{drainAudio(s);}catch(e){end(s,e.code||'VOICE_ASR_FAILED');}},20);s.audioDrainTimer.unref?.();}
 }
 function track(promise){background.add(promise);promise.then(()=>background.delete(promise),()=>background.delete(promise));return promise;}
 function queueTurn(s,text){interrupt(s);(s.pendingTranscripts||=[]).push(text);const version=(s.turnVersion||0)+1;s.turnVersion=version;
  s.turnTask=track(Promise.resolve(s.turnTask).catch(()=>{}).then(()=>{if(permitted(s)&&s.turnVersion===version)return turn(s,s.pendingTranscripts.splice(0).join('\n'));}));
 }
 aiService.router.voiceChatRuntime=createVoiceSpeechRuntime({aiService});
 const assistant=assistantOverride||createVoiceAssistant({gate,aiService,...domains,ordinaryChatEnabled:coreOptions.ordinaryChat===true,getMessages:i=>conversationRuntime.messages.listForConversationOwner(i.conversationId,i.ownerId)});
 const voiceAi=new Proxy(healthPrivateAiService(aiService),{get(target,key){
 if(key==='stream')return async(task,options,invocation)=>{
   requireInvocation(invocation);
   const standaloneGreeting=coreOptions.ordinaryChat===true&&isStandaloneVoiceGreeting(task.input);
   if(coreOptions.ordinaryChat===true){
    task=boundedVoiceTask(task);
    if(!standaloneGreeting)task={...task,messages:boundVoiceConversationMessages(task.messages)};
   }
   const filter=new PlaybackNoteFilter();
   if(standaloneGreeting)task={...task,messages:[...(task.messages||[]),{role:'system',content:'本轮是独立问候，请自然、简短地回应问候。不要主动续办或追问历史提醒、账目等旧事项，不要猜测用户心情。历史内容仍保留，等用户明确续谈旧事项时再处理；本轮问候不是任何操作确认。'}]};
   const result=await target.stream({...task,metadata:{...(task.metadata||{}),voiceRealtimeOnly:true},messages:[...(task.messages||[]),{role:'system',content:'当前语音交流已开启，本轮输入是已识别的用户话语。围绕当前问题自然接话，结合已有上下文，不突然换话题、不反复自我介绍。先说最有用的一两句，用户要求展开时再继续；不要连续抛出多个问题。用户打断后优先回应新话题；用户说没听清或再说一遍时重复刚才的要点，不跳到下一段。历史回答只表示生成过，不代表用户已经听完；不要主动解释播放进度、回执、内部状态或推测用户有没有听见。不要朗读Markdown、隐藏标记、链接或内部参数。当前语音通道的可用状态以本条为准，不要否认已开启的语音能力。'+(coreOptions.ordinaryChat===true?'\n'+VOICE_RESPONSE_STYLE:'')}]},
    {...options,onDelta:async delta=>{const text=filter.push(delta);if(text)await options.onDelta(text);}},invocation);
   requireInvocation(invocation);
   if(!options.signal?.aborted){const tail=filter.finish();if(tail)await options.onDelta(tail);}
   return {...result,content:stripPlaybackNotes(result?.content)};
  };
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 const voiceAssistant={...assistant,async processUserMessage(input){
  try{requireInvocation(input.invocation);const result=await assistant.processUserMessage(input);requireInvocation(input.invocation);return result;}catch(error){
   if(error?.code==='NO_USABLE_RUNTIME_CONNECTION')throw fail('VOICE_UNAVAILABLE');
   if(isAccessControlErrorCode(error?.code))throw fail(error.code==='ACCOUNT_USAGE_LIMIT_REACHED'?'VOICE_SERVICE_LIMIT':'VOICE_ACCOUNT_MISMATCH');
   throw error;
  }
 }};
 // The shared conversation service remains unchanged. Its final persistence is
 // guarded at this voice-only facade, including asynchronous handled replies.
 const messages=continuous?new Proxy(conversationRuntime.messages,{get(target,key){const value=Reflect.get(target,key,target);if(key==='completeAssistantMessage')return input=>{
  const s=[...sessions.values()].find(s=>s.ownerId===input.ownerId&&s.turn?.prepared?.assistantMessage.id===input.messageId);
  if(!s)throw fail('VOICE_AUTHORIZATION_EXPIRED');requirePermit(s);return value.call(target,input);
 };return typeof value==='function'?value.bind(target):value;}}):conversationRuntime.messages;
 const service=new ConversationService({conversations:conversationRuntime.conversations,messages,registry:conversationRuntime.registry,aiService:voiceAi,memoryPolicy:conversationRuntime.memoryPolicy,assistantAgent:voiceAssistant});service.voiceMode=true;
 function send(s,type,data={}){if(s.closed)return;if(type!=='ended')requirePermit(s);const event={type,data:{...data,sessionId:s.id,conversationId:s.conversationId}};if(s.listener)s.listener(event);else{if(s.events.length>=40)throw fail('VOICE_BACKPRESSURE');s.events.push(event);}}
 function identity(s,t=s.turn){return{ownerId:s.ownerId,conversationId:s.conversationId,turnId:t?.id};}
 function get(id,ownerId){const s=sessions.get(id);if(!s||s.ownerId!==ownerId||s.closed)throw fail('VOICE_SESSION_NOT_FOUND');requirePermit(s);if(clock()-s.heartbeat>20000){end(s,'VOICE_LEASE_EXPIRED');throw fail('VOICE_SESSION_NOT_FOUND');}return s;}
 function interrupt(s,{reason='interrupted'}={}){
  s.speechCandidate=null;
  const t=s.turn;if(!t)return;s.turn=null;t.controller.abort();t.text.end();gate.invalidate(identity(s,t));
  if(t.prepared?.assistantMessage){const receipt=repository.receipt({...identity(s,t),messageId:t.prepared.assistantMessage.id,status:'interrupted',completedSegments:t.completedSegments||0});if(receipt.status!=='completed')send(s,'interrupted',{turnId:t.id,messageId:t.prepared.assistantMessage.id,reason});}
 }
 function end(s,code='VOICE_ENDED'){
  if(s.closed||s.ending)return;s.ending=true;
  const graceful=continuous&&code==='VOICE_ENDED'&&clock()<s.authorizationExpiresAt&&s.asr&&s.asrLease&&clock()<Date.parse(s.asrLease.lease.leaseExpiresAt);
  try{interrupt(s);}catch{};try{send(s,'ended',{code});}catch{};
  s.closed=true;s.validateAuthorization=null;s.authorizationStop?.();s.authorizationStop=null;clearInterval(s.timer);clearAudioQueue(s);sessions.delete(s.id);ended.set(s.id,s.ownerId);if(ended.size>100)ended.delete(ended.keys().next().value);
  if(graceful){const record=s.asrLease;record.finishing=true;draining.set(s.id,{ownerId:s.ownerId,record});
   record.finishExpiresAt=Math.min(clock()+10000,s.authorizationExpiresAt,Date.parse(record.lease.leaseExpiresAt));
   const finish=()=>{try{if(clock()>=record.finishExpiresAt)return cancelDrain(record);if(s.asr.finish()!==false){clearInterval(record.finishRetry);record.finishRetry=null;}}catch{cancelDrain(record);}};
   record.finishRetry=setInterval(finish,20);record.finishDeadline=setTimeout(()=>cancelDrain(record),Math.max(0,record.finishExpiresAt-clock()));finish();
  }else s.asrController?.abort();
  s.onClose?.();s.onClose=null;s.listener=null;s.events=[];s.pendingTranscripts=[];
 }
 async function startAsr(s){
  if(s.closed||s.muted)return;const epoch=(s.asrEpoch||0)+1;s.asrEpoch=epoch;
  const controller=new AbortController();s.asrController=controller;s.asrStarted=clock();s.asr=null;s.rotating=false;
  const current=()=>!s.closed&&!s.muted&&s.asrEpoch===epoch&&permitted(s);
  let lease,record;
  try{
   if(continuous){
    if(s.authorizationInFlight)await s.authorizationInFlight;
    if(!current())return;
    if(!await authenticate(s)||!current())return;
   }
   lease=continuous?accessControl.beginVoiceStreamRequest({subject:s.subject,requestId:randomUUID(),voiceSessionId:s.id,generation:epoch}):accessControl.beginRequest({subject:s.subject,requestId:randomUUID()});
   record={lease,controller,epoch};if(continuous)s.asrLease=record;
   await aiService.router.run({capability:'VOICE_CHAT_ASR',signal:controller.signal,...(continuous?{continuousLifecycle:true}:{}),silenceDurationMs:s.coreOptions.lowLatency?650:800,
    onReady:handle=>{if(!current())return;s.asr=handle;drainAudio(s);send(s,'ready');},
    onSpeechStart:()=>{if(!current())return;s.capturing=true;s.lastActivity=clock();s.echoReference=s.turn?.audioSegments&&!s.turn.heard?s.turn.speechText||'':'';send(s,'listening');},
    onSpeechStop:()=>{if(!current())return;s.capturing=false;s.lastSpeechStop=clock();},
    onPartial:text=>{if(current())send(s,'partial',{text:String(text).slice(0,2000)});},
    onTranscript:(text,itemId)=>{if(!current()||(itemId&&s.seenItems.has(itemId)))return;if(itemId){if(s.seenItems.size>=300){end(s,'VOICE_SESSION_LIMIT');return;}s.seenItems.add(itemId);}s.capturing=false;s.lastSpeechStop=clock();
     const heard=normalizedSpeech(text),reference=normalizedSpeech(s.echoReference||((s.turn?.audioSegments&&!s.turn.heard)?s.turn.speechText:''));s.echoReference='';
     const playing=Boolean(reference),explicit=isExplicitInterruption(heard);
     const backchannel=/^(?:嗯+|啊+|哦+|呃+|额+|唔+|好|好的|对|对的|是|是的|噢+)$/.test(heard);
     const candidate=hasFreshCandidate(s,clock());s.speechCandidate=null;
     if(playing&&!explicit&&(backchannel||(heard.length>=2&&reference.includes(heard)))){send(s,'echo_ignored');return;}
     if(playing&&s.coreOptions.conservativeInterruption&&!explicit&&(!candidate||!hasMeaningfulInterruptionText(text))){send(s,'echo_ignored');return;}
     if(!noise(text)){timing('asr_final');queueTurn(s,text);}}
   },{ownerId:s.ownerId,subject:s.subject,requestLease:lease});
   if(record.finishing&&!record.incomplete){if(clock()>=record.finishExpiresAt)cancelDrain(record);else timing('asr_finished');}
  }catch(e){if(record?.finishing&&!record.incomplete){record.incomplete=true;timing('asr_finish_incomplete');}if(current())end(s,e.code||'VOICE_ASR_FAILED');}finally{
   if(record){clearTimeout(record.finishDeadline);clearInterval(record.finishRetry);if(draining.get(s.id)?.record===record)draining.delete(s.id);if(s.asrLease===record)s.asrLease=null;}
   if(lease)accessControl.releaseRequest(record?.lease||lease);
  }
  if(current()){if(continuous)end(s,'VOICE_DISCONNECTED');else return startAsr(s);}
 }
 async function speak(s,t,lease){
  try{requirePermit(s);if(continuous&&s.turn!==t)throw fail('VOICE_CANCELLED');await aiService.router.run({capability:'VOICE_CHAT_TTS',text:t.text,signal:t.controller.signal,commitFirstTextChunk:s.coreOptions.lowLatency===true,onAudio:bytes=>{
   if(!permitted(s)||s.turn!==t||t.controller.signal.aborted)return;
   repository.consume(s.ownerId,0,Math.ceil(bytes.length/48),dailyLimitMs);
   if(t.audioSegments===0)timing('first_audio_generated',t);
   const index=t.audioSegments++;send(s,'audio',{turnId:t.id,index,messageId:t.prepared.assistantMessage.id,audio:bytes.toString('base64'),sampleRate:24000});
  }},{ownerId:s.ownerId,subject:s.subject,requestLease:lease});if(!s.closed&&s.turn===t)send(s,'audio_end',{turnId:t.id,segments:t.audioSegments,messageId:t.prepared.assistantMessage.id});}
  catch(e){if(!t.controller.signal.aborted&&!s.closed){send(s,'voice_error',{code:e.code||'VOICE_TTS_FAILED'});end(s,e.code||'VOICE_TTS_FAILED');}}
 }
 async function turn(s,transcript){
  if(!permitted(s))return;if(transcript.length>2000){end(s,'VOICE_UTTERANCE_LIMIT');return;}
  interrupt(s);s.lastActivity=clock();
  const t={id:randomUUID(),controller:new AbortController(),text:new TextStream(),audioSegments:0,completedSegments:0,proposal:null};s.turn=t;
  let lease,tts;
  try{
   lease=accessControl.beginRequest({subject:s.subject,requestId:randomUUID()});
   t.prepared=service.prepare({ownerId:s.ownerId,conversationId:s.conversationId,message:transcript,clientRequestId:t.id,requestId:lease.requestId,taskTimezone:s.timezone,invocation:turnInvocation(s,t,lease)});
   repository.createDelivery({...identity(s,t),messageId:t.prepared.assistantMessage.id});
   send(s,'messages',{turnId:t.id,messages:[t.prepared.userMessage,t.prepared.assistantMessage]});
   send(s,'thinking',{turnId:t.id});
   // In the low-latency mobile path, open synthesis before text generation so
   // the provider handshake overlaps the first answer delta.
   const speechText=new SpeechText();
   if(s.coreOptions.lowLatency)tts=speak(s,t,lease);
   const result=await service.execute(t.prepared,{signal:t.controller.signal,onDelta:delta=>{
    if(continuous){requirePermit(s);if(s.turn!==t)throw fail('VOICE_CANCELLED');}else if(s.turn!==t||s.closed)return;if(!t.answerStarted){t.answerStarted=true;timing('answer_started',t);}send(s,'delta',{turnId:t.id,messageId:t.prepared.assistantMessage.id,text:delta});
    const chunks=speechText.push(delta);
    if(!tts&&(chunks.length||/\p{L}|\p{N}/u.test(speechText.sentence)))tts=speak(s,t,lease);
    for(const clean of chunks){t.speechText=(t.speechText||'')+clean;t.text.push(clean);}
   }});
   if(s.turn!==t||!permitted(s)){gate.invalidate(identity(s,t));return;}
   if(result.status!=='completed')throw fail(result.code||'VOICE_REPLY_FAILED');
   for(const tail of speechText.finish()){t.speechText=(t.speechText||'')+tail;if(!tts)tts=speak(s,t,lease);t.text.push(tail);}t.text.end();
   t.proposal=result.voiceProposal||null;t.status=result.status;
   send(s,'completed',{turnId:t.id,messageId:t.prepared.assistantMessage.id,content:result.content,status:result.status});
   if(t.proposal)send(s,'proposal',{turnId:t.id,proposal:confirmationSummary(t.proposal)});
   if(tts)await tts;else send(s,'audio_end',{turnId:t.id,messageId:t.prepared.assistantMessage.id,segments:0});
  }catch(e){if(!t.controller.signal.aborted&&!s.closed){send(s,'voice_error',{code:e.code||'VOICE_REPLY_FAILED'});end(s,e.code||'VOICE_REPLY_FAILED');}}
  finally{t.text.end();if(tts)await tts;if(lease)accessControl.releaseRequest(lease);}
 }

 function createSession({user,subject,conversationId,timezone='Asia/Shanghai',mediaProtocol,validateAuthorization}){
   if(!user?.id||!subject)throw fail('UNAUTHENTICATED');const actor=accessControl.assertAuthenticatedSubject(subject);if(actor.accountId!==user.id)throw fail('VOICE_ACCOUNT_MISMATCH');
   if([...sessions.values()].some(s=>s.ownerId===user.id))throw fail('VOICE_ALREADY_ACTIVE');if(sessions.size>=globalLimit)throw fail('VOICE_BUSY');
   const conversation=conversationId?conversationRuntime.conversations.getByIdForOwner(conversationId,user.id):conversationRuntime.conversations.createForOwner(user.id,{title:'语音聊天'});
   if(!conversation||conversationRuntime.service.isLearningConversation?.(conversation.id,user.id))throw fail('CONVERSATION_NOT_FOUND');
   repository.consume(user.id,0,0,dailyLimitMs);
   const negotiated={lowLatency:coreOptions.lowLatency===true,ordinaryChat:coreOptions.ordinaryChat===true,conservativeInterruption:coreOptions.conservativeInterruption===true&&mediaProtocol===1};
   const s={id:randomUUID(),ownerId:user.id,subject,conversationId:conversation.id,timezone,coreOptions:negotiated,speechCandidate:null,lastCandidateSequence:-1,created:clock(),heartbeat:clock(),lastActivity:clock(),lastSpeechStop:clock(),events:[],audioQueue:[],seenItems:new Set(),expectedSequence:0,inputEpoch:0,muted:false,closed:false,turn:null,
    ...(continuous?{validateAuthorization,authorizationCheckAt:clock(),authorizationExpiresAt:clock()+20000,nextRenewAt:clock()+10000}:{} )};sessions.set(s.id,s);
   s.timer=setInterval(()=>{try{
    requirePermit(s);
    if(clock()-s.heartbeat>20000)return end(s,'VOICE_LEASE_EXPIRED');
    if(!s.muted&&clock()-s.lastActivity>60000)return end(s,'VOICE_IDLE');
    if(continuous){if(clock()>=s.nextRenewAt)void authenticate(s);}
    else if(s.asr&&!s.audioQueue.length&&clock()-s.asrStarted>70000&&!s.capturing&&clock()-s.lastSpeechStop>2000){const handle=s.asr;if(handle.finish()!==false){s.asr=null;s.rotating=true;}}
   }catch(e){end(s,e.code||'VOICE_FAILED');}},1000);s.timer.unref?.();
   return{id:s.id,conversationId:s.conversationId,expiresInSeconds:20,coreOptions:negotiated};
 }
 const runtime={enabled:true,repository,gate,sessions,
  create(input){
   if(!continuous)return createSession(input);
   return (async()=>{
    const {user,validateAuthorization}=input;
    if(!user?.id||typeof validateAuthorization!=='function')throw fail('VOICE_AUTHORIZATION_REQUIRED');
    if(runtimeClosed)throw fail('VOICE_ENDED');
    if(starting.has(user.id)||[...sessions.values()].some(s=>s.ownerId===user.id))throw fail('VOICE_ALREADY_ACTIVE');
    if(starting.size+sessions.size>=globalLimit)throw fail('VOICE_BUSY');
    const token={};starting.set(user.id,token);let timeout;
    try{
     const checked=await Promise.race([validateAuthorization(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(fail('VOICE_AUTHORIZATION_TIMEOUT')),10000);})]);
     if(runtimeClosed||starting.get(user.id)!==token)throw fail('VOICE_ENDED');
     const subject=accessControl.assertAuthenticatedSubject(checked);
     if(subject.accountId!==user.id)throw fail('VOICE_ACCOUNT_MISMATCH');
     return createSession({...input,subject});
    }finally{clearTimeout(timeout);if(starting.get(user.id)===token)starting.delete(user.id);}
   })();
  },
  subscribe(id,ownerId,listener,onClose){const s=get(id,ownerId);if(s.listener)throw fail('VOICE_ALREADY_CONNECTED');s.listener=listener;s.onClose=onClose;for(const e of s.events)listener(e);s.events=[];track(startAsr(s));return()=>end(s,'VOICE_DISCONNECTED');},
  audio(id,ownerId,bytes,sequence,inputEpoch=0){
   const s=get(id,ownerId);
   if(sequence!==s.expectedSequence||!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>32000||bytes.length%2||!Number.isSafeInteger(inputEpoch)||inputEpoch<0||inputEpoch>s.inputEpoch)throw fail('VOICE_AUDIO_INVALID');
   if(s.muted||inputEpoch<s.inputEpoch){s.expectedSequence++;return;}
   try{
    if(s.audioQueue.reduce((n,frame)=>n+frame.bytes.length,0)+bytes.length>32*VOICE_CONNECT_TIMEOUT_MS)throw fail('VOICE_BACKPRESSURE');
    if(s.audioQueue.length&&clock()-s.audioQueue[0].at>=VOICE_CONNECT_TIMEOUT_MS)throw fail('VOICE_BACKPRESSURE');
    repository.consume(ownerId,Math.ceil(bytes.length/32),0,dailyLimitMs);s.audioQueue.push({bytes,at:clock()});s.expectedSequence++;drainAudio(s);
   }catch(e){end(s,e.code||'VOICE_ASR_FAILED');throw e;}
  },
  control(id,ownerId,body){if(body.type==='end'&&ended.get(id)===ownerId)return{ok:true};const s=get(id,ownerId);s.heartbeat=clock();
   if(body.type==='heartbeat'){send(s,'heartbeat');return{ok:true};}if(body.type==='end'){end(s);return{ok:true};}
   if(body.type==='speech_candidate'){receiveSpeechCandidate(s,body,clock());return{ok:true};}
   if(body.type==='interrupt'){s.echoReference='';interrupt(s);s.lastActivity=clock();return{ok:true};}
   if(body.type==='mute'){const muted=body.muted===true;if(muted!==s.muted){s.muted=muted;s.inputEpoch++;s.speechCandidate=null;clearAudioQueue(s);s.capturing=false;s.asrEpoch=(s.asrEpoch||0)+1;s.asr=null;s.asrController?.abort();s.asrLease=null;if(!muted){s.lastActivity=clock();track(startAsr(s));}}send(s,'muted',{muted:s.muted});return{ok:true};}
   if(body.type==='receipt'){const t=s.turn;if(!t||body.turnId!==t.id||body.messageId!==t.prepared?.assistantMessage.id)throw fail('VOICE_RECEIPT_INVALID');if(t.confirmed)return{ok:true};if(body.completedSegments>t.audioSegments)throw fail('VOICE_RECEIPT_INVALID');t.completedSegments=body.completedSegments;repository.receipt({...identity(s,t),messageId:body.messageId,status:body.status,completedSegments:body.completedSegments});if(body.status==='completed')t.heard=true;return{ok:true};}
   if(body.type==='cancel_proposal'){if(s.turn){gate.invalidate(identity(s));s.turn.proposal=null;}return{ok:true};}
   throw fail('VOICE_CONTROL_INVALID');
  },
  async confirm(id,ownerId,body){const s=get(id,ownerId),t=s.turn;if(!t?.proposal||body.proposalId!==t.proposal.id||body.turnId!==t.id)throw fail('VOICE_CONFIRMATION_EXPIRED');
   if(continuous){const proposal=gate.pending.get(body.proposalId);if(proposal&&!proposal.promise){const execute=proposal.execute;proposal.execute=()=>{requirePermit(s);if(s.turn!==t)throw fail('VOICE_CONFIRMATION_EXPIRED');return execute();};}}
   const outcome=await gate.confirm(body.proposalId,identity(s,t));requirePermit(s);if(continuous&&s.turn!==t)throw fail('VOICE_CONFIRMATION_EXPIRED');const content=confirmationResult(outcome);t.confirmed=true;t.controller.abort();t.text.end();repository.markReplacementUnspoken({...identity(s,t),messageId:t.prepared.assistantMessage.id});if(!s.closed&&s.turn===t)send(s,'confirmed',{turnId:t.id,content});
   conversationRuntime.messages.completeAssistantMessage({ownerId,messageId:t.prepared.assistantMessage.id,content});if(!s.closed&&s.turn===t)send(s,'completed',{turnId:t.id,messageId:t.prepared.assistantMessage.id,content,status:'completed'});return{ok:true,content};
  },
  close(){runtimeClosed=true;starting.clear();for(const s of [...sessions.values()])end(s);gate.close();return Promise.allSettled([...background]);},
  endForOwner(ownerId){starting.delete(ownerId);for(const s of [...sessions.values()])if(s.ownerId===ownerId)end(s,continuous?'VOICE_AUTHORIZATION_REVOKED':'VOICE_ENDED');for(const drain of draining.values())if(drain.ownerId===ownerId){if(!drain.record.incomplete){drain.record.incomplete=true;timing('asr_finish_incomplete');}drain.record.controller.abort();}}
 };return runtime;
}
