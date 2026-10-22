import { runCheckedAnswer } from './checkedAnswer.js';
import { buildAnswerContext } from './answerContext.js';
import { PacedAudioDelivery } from './audioDelivery.js';
import { buildVoicePublicSearch } from './publicSearch.js';
import { PlaybackNoteFilter, stripPlaybackNotes } from './playbackText.js';
import { SpeechText } from './speechText.js';
import { randomUUID, createHash } from 'node:crypto';
import { validateProjection, decodeDocumentMessage } from '../../core/documentQa/contract.js';
import { ConversationService } from '../conversation/conversationService.js';
import { healthPrivateAiService,redactStreamHistory } from '../health/aiPrivacy.js';
import { VoiceWriteGate } from './writeGate.js';
import { VoiceRepository } from './repository.js';
import { createVoiceAssistant,confirmationSummary,confirmationResult } from './assistant.js';
import { createVoiceSpeechRuntime,TextStream } from './provider.js';
import {hasMeaningfulInterruptionText,hasFreshCandidate,receiveSpeechCandidate,normalizedSpeech,isExplicitInterruption,isStopRequest,isReplyContinuation,REPLY_RECOVERY_TTL_MS,MAX_RECOVERABLE_ANSWER_CHARS} from './interruption.js';
import {VOICE_RESPONSE_STYLE,isVoiceBusinessCandidate} from './ordinaryChat.js';
import {isAccessControlErrorCode} from '../../core/router/AccessControlErrorCodes.js';
import { validateLocalMemoryEvidence, localMemoryDataMessage, parseMemoryReceiptMessage } from '../../core/memory/localEvidence.js';
const fail=code=>Object.assign(new Error(code),{code});
const noise=text=>!text||!/\p{L}|\p{N}/u.test(text)||/^(?:谢谢观看|感谢观看|字幕由|请不吝点赞|请勿模仿)/.test(text);
const ASR_HANDOFF_MAX_BYTES=320000,ASR_HANDOFF_WAIT_MS=10000;
export function createVoiceChatRuntime({conversationRuntime,aiService,accessControl,enabled=false,clock=Date.now,globalLimit=2,dailyLimitMs=null,assistantOverride,coreOptions={},onTiming=()=>{},...domains}={}) {
 if(!enabled)return{enabled:false,close(){}};
 if(!conversationRuntime?.database||!aiService?.router||!accessControl)throw fail('VOICE_RUNTIME_REQUIRED');
 const repository=new VoiceRepository(conversationRuntime.database);repository.migrate();
 conversationRuntime.messages.voiceRepository=repository;conversationRuntime.conversations.voiceRepository=repository;
 const gate=new VoiceWriteGate({clock}),sessions=new Map(),background=new Set(),ended=new Map();
 function timing(stage,t){try{onTiming({stage,at:clock(),turnId:t?.id||null});}catch{}}
 function track(promise){background.add(promise);promise.then(()=>background.delete(promise),()=>background.delete(promise));return promise;}
 function queueTurn(s,text){
  const resume=s.coreOptions.pendingReplyProtection&&isReplyContinuation(text)?recoverableReply(s):null;
  interrupt(s);
  // A requested saved answer takes precedence over the incidental reply being
  // interrupted by the continuation command itself.
  if(resume)s.interruptedReply=resume;
  (s.pendingTranscripts||=[]).push(text);const version=(s.turnVersion||0)+1;s.turnVersion=version;
  s.turnTask=track(Promise.resolve(s.turnTask).catch(()=>{}).then(()=>{if(!s.closed&&s.turnVersion===version)return turn(s,s.pendingTranscripts.splice(0).join('\n'));}));
 }
 aiService.router.voiceChatRuntime=createVoiceSpeechRuntime({aiService});
 const assistant=assistantOverride||createVoiceAssistant({gate,aiService,...domains,ordinaryChatEnabled:coreOptions.ordinaryChat===true,getMessages:i=>conversationRuntime.messages.listForConversationOwner(i.conversationId,i.ownerId)});
 function activeTurn(invocation){
  return [...sessions.values()].find(s=>s.ownerId===invocation?.ownerId&&s.turn?.prepared?.invocation?.requestLease===invocation?.requestLease)?.turn;
 }
 function recoverableReply(s){
  const reply=s.interruptedReply;
  if(!reply||clock()<reply.savedAt||clock()-reply.savedAt>REPLY_RECOVERY_TTL_MS){s.interruptedReply=null;return null;}
  return reply;
 }
 const voiceAi=new Proxy(healthPrivateAiService(aiService),{get(target,key){
  if(key==='stream')return async(task,options,invocation)=>{
   const current=activeTurn(invocation);
   // Only a read-only ordinary answer may be resumed. Domain proposals/results
   // remain governed by the existing confirmation and permission contracts.
   if(current?.recoveryEnabled&&!isVoiceBusinessCandidate({message:task.input,ownerId:invocation.ownerId,conversationId:task.metadata?.conversationId},domains))current.replyQuestion=current.resumeReply?.question||String(task.input||'');
   if(current?.resumeReply){
    const reply=current.resumeReply;
    task={...task,metadata:{...(task.metadata||{}),voiceReplyRecovery:true},messages:[
     ...(task.messages||[]).filter(message=>message.role==='system'),
     {role:'user',content:reply.question},
     ...(reply.answer?[{role:'assistant',content:reply.answer}]:[]),
     {role:'user',content:String(task.input||'')},
     {role:'system',content:'用户要求接回被打断的普通回答。以上助手文字只表示生成过，不代表用户已听到。围绕保留的原问题，先简短重述必要要点，再补充未完成内容。不要切到中途插话的话题，不声称已听完或已执行任何操作。这里只续接解释，不执行、确认或重试业务动作。'}
    ]};
   }
   const searchSession=[...sessions.values()].find(s=>s.turn===current);
   const localMemory=current?.prepared?.localMemory,localData=localMemoryDataMessage(localMemory);
   const answerContext=coreOptions.ordinaryChat===true && coreOptions.intelligentAnswers!==false && task.metadata?.routeDomain==='ordinary_chat' && !(task.messages||[]).some(m=>m.role==='system'&&String(m.content||'').includes('Trusted Memory Context')) ? buildAnswerContext({...task,messages:redactStreamHistory((task.messages||[]).filter(m=>!localData||m.content!==localData.content)),localMemory},clock()) : null;
   const publicSearch=answerContext?null:buildVoicePublicSearch(task,clock(),searchSession?.publicSearchContext);
   if(current)current.publicSearch=Boolean(publicSearch||answerContext);
   if(searchSession)searchSession.publicSearchContext=null;
   // Open only the authenticated ordinary-answer synthesis channel; no text is
   // queued until runCheckedAnswer validates the complete answer.
   if(answerContext && coreOptions.checkedAnswers===true){if(current)current.checkedOrdinaryTransport=true;current?.startSynthesis?.();}
   const filter=new PlaybackNoteFilter();
   const result=answerContext && coreOptions.checkedAnswers===true ? await runCheckedAnswer({task,context:answerContext,resourceState:searchSession?.resourceState,invoke:target.stream.bind(target),options:{...options,onDelta:async delta=>{const text=filter.push(delta);if(text)await options.onDelta(text);}},invocation,onStep:event=>timing('checked_'+event.phase,current)}) : await target.stream({...task,metadata:{...(task.metadata||{}),voiceRealtimeOnly:true,voicePublicSearch:publicSearch,...(answerContext?{voiceAnswerContext:answerContext}:{})},messages:[...(task.messages||[]),{role:'system',content:'当前语音交流已开启，本轮输入是已识别的用户话语。围绕当前问题自然接话，结合已有上下文，不突然换话题、不反复自我介绍。先说最有用的一两句，用户要求展开时再继续；不要连续抛出多个问题。用户打断后优先回应新话题；用户说没听清或再说一遍时重复刚才的要点，不跳到下一段。历史回答只表示生成过，不代表用户已经听完；不要主动解释播放进度、回执、内部状态或推测用户有没有听见。不要朗读Markdown、隐藏标记、链接或内部参数。当前语音通道的可用状态以本条为准，不要否认已开启的语音能力。'+(coreOptions.ordinaryChat===true?'\n'+VOICE_RESPONSE_STYLE:'')}]},
    {...options,onDelta:async delta=>{const text=filter.push(delta);if(text)await options.onDelta(text);}},invocation);
   if(searchSession && result?.ok && !options.signal?.aborted && answerContext && coreOptions.checkedAnswers===true)searchSession.resourceState=result.resourceState||null;
   if(!options.signal?.aborted){const tail=filter.finish();if(tail)await options.onDelta(tail);}
   if(publicSearch&&!result?.ok&&!options.signal?.aborted&&!isAccessControlErrorCode(result?.code)){
    const content='这次联网查询没有成功，暂时无法确认最新信息，请稍后再试。';await options.onDelta(content);return{ok:true,content};
   }
   if(publicSearch&&result?.ok&&result.content?.includes('\n\n检索日期：')&&searchSession&&!options.signal?.aborted){
    searchSession.publicSearchContext={input:String(task.input||''),answer:result.content.split('\n\n检索日期：')[0],savedAt:clock()};
   }
   return {...result,content:stripPlaybackNotes(result?.content)};
  };
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 const voiceAssistant={...assistant,async processUserMessage(input){
  try{
   const current=activeTurn(input.invocation);
   if(current?.resumeReply){
    current.replyQuestion=current.resumeReply.question;
    if(current.resumeReply.complete)return{handled:true,domain:'voice_reply_recovery',content:current.resumeReply.answer};
    return{handled:false};
   }
   return await assistant.processUserMessage(input);
  }catch(error){
   if(error?.code==='NO_USABLE_RUNTIME_CONNECTION')throw fail('VOICE_UNAVAILABLE');
   if(isAccessControlErrorCode(error?.code))throw fail(error.code==='ACCOUNT_USAGE_LIMIT_REACHED'?'VOICE_SERVICE_LIMIT':'VOICE_ACCOUNT_MISMATCH');
   throw error;
  }
 }};
 const service=new ConversationService({conversations:conversationRuntime.conversations,messages:conversationRuntime.messages,registry:conversationRuntime.registry,aiService:voiceAi,memoryPolicy:conversationRuntime.memoryPolicy,assistantAgent:voiceAssistant});service.voiceMode=true;
 Object.defineProperty(service,'attachmentProcessor',{get:()=>conversationRuntime.service.attachmentProcessor});
 Object.defineProperty(service,'documentQaEnabled',{get:()=>conversationRuntime.service.documentQaEnabled});
 function send(s,type,data={}){if(s.closed)return;const event={type,data:{...data,sessionId:s.id,conversationId:s.conversationId,inputEpoch:s.inputEpoch}};if(s.listener)s.listener(event);else{if(s.events.length>=40)throw fail('VOICE_BACKPRESSURE');s.events.push(event);}}
 function prepareClientContext(s,t,text){
  if(!s.coreOptions.clientContext)return Promise.resolve(null);
  t.contextToken=randomUUID();t.contextQuestion=text;
  return new Promise((resolve,reject)=>{
   let settled=false;const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);t.controller.signal.removeEventListener('abort',abort);t.acceptContext=null;error?reject(error):resolve(value);};
   const abort=()=>finish(fail('ABORTED'));const timer=setTimeout(()=>finish(fail('VOICE_CONTEXT_FAILED')),6000);timer.unref?.();
   t.controller.signal.addEventListener('abort',abort,{once:true});t.acceptContext=value=>finish(null,value);
   send(s,'context_required',{turnId:t.id,contextToken:t.contextToken,text});
  });
 }
 function setInputMuted(s,muted){
  if(muted===s.muted)return;s.muted=muted;s.inputEpoch++;s.speechCandidate=null;clearAudioQueue(s);s.capturing=false;s.asrEpoch=(s.asrEpoch||0)+1;s.asr=null;s.asrController?.abort();
  if(!muted){s.lastActivity=clock();track(startAsr(s));}
 }
 function clearAudioQueue(s){if(s.audioQueueTimer){clearTimeout(s.audioQueueTimer);s.audioQueueTimer=null;}s.audioQueue=[];s.audioQueueBytes=0;s.audioQueueStartedAt=null;}
 function beginAsrWait(s){
  if(s.closed||s.muted||s.asr)return;if(s.audioQueueStartedAt===null)s.audioQueueStartedAt=clock();
  if(s.audioQueueTimer)return;const started=s.audioQueueStartedAt,remaining=ASR_HANDOFF_WAIT_MS-(clock()-started);
  if(remaining<=0){end(s,'VOICE_ASR_HANDOFF_TIMEOUT');return;}
  s.audioQueueTimer=setTimeout(()=>{s.audioQueueTimer=null;if(!s.closed&&!s.muted&&!s.asr&&s.audioQueueStartedAt===started)end(s,'VOICE_ASR_HANDOFF_TIMEOUT');},remaining);s.audioQueueTimer.unref?.();
 }
 function queueAudio(s,bytes){
  beginAsrWait(s);if(s.closed)throw fail('VOICE_ASR_HANDOFF_TIMEOUT');
  if(s.audioQueueBytes+bytes.length>ASR_HANDOFF_MAX_BYTES){end(s,'VOICE_BACKPRESSURE');throw fail('VOICE_BACKPRESSURE');}
  s.audioQueue.push(bytes);s.audioQueueBytes+=bytes.length;
 }
 function identity(s,t=s.turn){return{ownerId:s.ownerId,conversationId:s.conversationId,turnId:t?.id};}
 function get(id,ownerId){const s=sessions.get(id);if(!s||s.ownerId!==ownerId||s.closed)throw fail('VOICE_SESSION_NOT_FOUND');if(clock()-s.heartbeat>20000){end(s,'VOICE_LEASE_EXPIRED');throw fail('VOICE_SESSION_NOT_FOUND');}return s;}
 function interrupt(s,{reason='interrupted'}={}){
  s.speechCandidate=null;
  const t=s.turn;if(!t)return;
  if(s.coreOptions.pendingReplyProtection&&!t.heard&&!t.confirmed&&t.replyQuestion&&!t.proposal&&!t.recoveryOverflow){
   s.interruptedReply={question:t.replyQuestion,answer:t.generatedAnswer||'',complete:t.status==='completed',savedAt:clock()};
  }
  s.turn=null;t.controller.abort();t.text.end();gate.invalidate(identity(s,t));
  if(t.prepared?.assistantMessage){const receipt=repository.receipt({...identity(s,t),messageId:t.prepared.assistantMessage.id,status:'interrupted',completedSegments:t.completedSegments||0});if(receipt.status!=='completed')send(s,'interrupted',{turnId:t.id,messageId:t.prepared.assistantMessage.id,reason});}
 }
 function end(s,code='VOICE_ENDED'){
  if(s.closed)return;try{interrupt(s);}catch{};try{send(s,'ended',{code});}catch{};
  s.closed=true;s.asrController?.abort();clearInterval(s.timer);clearAudioQueue(s);sessions.delete(s.id);ended.set(s.id,s.ownerId);if(ended.size>100)ended.delete(ended.keys().next().value);s.onClose?.();s.listener=null;s.events=[];s.pendingTranscripts=[];s.interruptedReply=null;
 }
 async function startAsr(s){
  if(s.closed||s.muted)return;const epoch=(s.asrEpoch||0)+1;s.asrEpoch=epoch;
  const controller=new AbortController();s.asrController=controller;s.asrStarted=clock();s.asr=null;s.rotating=false;beginAsrWait(s);
  const current=()=>!s.closed&&!s.muted&&s.asrEpoch===epoch;
  let lease;
  try{lease=accessControl.beginRequest({subject:s.subject,requestId:randomUUID()});
   await aiService.router.run({capability:'VOICE_CHAT_ASR',signal:controller.signal,silenceDurationMs:s.coreOptions.lowLatency?650:800,
    onReady:handle=>{if(!current())return;try{while(s.audioQueue.length){const bytes=s.audioQueue[0];handle.append(bytes);s.audioQueue.shift();s.audioQueueBytes-=bytes.length;}clearAudioQueue(s);s.asr=handle;send(s,'ready');}catch(e){end(s,e.code||'VOICE_ASR_FAILED');throw e;}},
    onSpeechStart:()=>{if(!current())return;s.capturing=true;s.lastActivity=clock();s.echoReference=s.turn?.audioSegments&&!s.turn.heard?s.turn.speechText||'':'';send(s,'listening');},
    onSpeechStop:()=>{if(!current())return;s.capturing=false;s.lastSpeechStop=clock();},
    onPartial:text=>{if(current())send(s,'partial',{text:String(text).slice(0,2000)});},
    onTranscript:(text,itemId)=>{if(!current()||(itemId&&s.seenItems.has(itemId)))return;if(itemId){if(s.seenItems.size>=300){end(s,'VOICE_SESSION_LIMIT');return;}s.seenItems.add(itemId);}s.capturing=false;s.lastSpeechStop=clock();
     const heard=normalizedSpeech(text),reference=normalizedSpeech(s.echoReference||((s.turn?.audioSegments&&!s.turn.heard)?s.turn.speechText:''));s.echoReference='';
     const playing=Boolean(reference),explicit=isExplicitInterruption(heard)||Boolean(s.coreOptions.pendingReplyProtection&&isReplyContinuation(heard)&&recoverableReply(s));
     const backchannel=/^(?:嗯+|啊+|哦+|呃+|额+|唔+|好|好的|对|对的|是|是的|噢+)$/.test(heard);
     const candidate=hasFreshCandidate(s,clock());s.speechCandidate=null;
     // A stop phrase spoken by the assistant is still playback echo. Do this
     // before the explicit-interruption exception, including one-word "停".
     if(playing&&((heard.length>=1&&reference.includes(heard))||(!explicit&&backchannel))){send(s,'echo_ignored');return;}
     const pending=s.coreOptions.pendingReplyProtection&&s.turn&&!s.turn.heard&&!s.turn.confirmed;
     if((playing||pending)&&s.coreOptions.conservativeInterruption&&!explicit&&(!candidate||!hasMeaningfulInterruptionText(text))){send(s,'echo_ignored');return;}
     if(s.coreOptions.pendingReplyProtection&&isStopRequest(text)){
      s.turnVersion=(s.turnVersion||0)+1;s.pendingTranscripts=[];interrupt(s);s.lastActivity=clock();return;
     }
     if(!noise(text)){timing('asr_final');queueTurn(s,text);}}
   },{ownerId:s.ownerId,subject:s.subject,requestLease:lease});
  }catch(e){if(current())end(s,e.code||'VOICE_ASR_FAILED');}finally{if(lease)accessControl.releaseRequest(lease);}
  if(current())return startAsr(s);
 }
 async function speak(s,t,lease){
  const delivery=new PacedAudioDelivery({signal:t.controller.signal,send:bytes=>{
   if(s.closed||s.turn!==t||t.controller.signal.aborted)return;
   s.lastActivity=clock();
   repository.consume(s.ownerId,0,Math.ceil(bytes.length/48),dailyLimitMs);
   if(t.audioSegments===0)timing('first_audio_generated',t);
   const index=t.audioSegments++;send(s,'audio',{turnId:t.id,index,messageId:t.prepared.assistantMessage.id,audio:bytes.toString('base64'),sampleRate:24000});
  }});
  try{await aiService.router.run({capability:'VOICE_CHAT_TTS',checkedOrdinaryTransport:t.checkedOrdinaryTransport===true,text:t.text,signal:t.controller.signal,onAudio:bytes=>delivery.push(bytes)},{ownerId:s.ownerId,subject:s.subject,requestLease:lease});await delivery.finish();if(!s.closed&&s.turn===t&&!t.controller.signal.aborted)send(s,'audio_end',{turnId:t.id,segments:t.audioSegments,messageId:t.prepared.assistantMessage.id});}
  catch(e){if(!t.controller.signal.aborted&&!s.closed){send(s,'voice_error',{code:e.code||'VOICE_TTS_FAILED'});end(s,e.code||'VOICE_TTS_FAILED');}}
  finally{delivery.cancel();}
 }
 async function turn(s,transcript){
  if(s.closed)return;if(transcript.length>2000){end(s,'VOICE_UTTERANCE_LIMIT');return;}
  interrupt(s);s.lastActivity=clock();
  const resumeReply=s.coreOptions.pendingReplyProtection&&isReplyContinuation(transcript)?recoverableReply(s):null;
  const t={id:randomUUID(),controller:new AbortController(),text:new TextStream(),audioSegments:0,completedSegments:0,proposal:null,recoveryEnabled:s.coreOptions.pendingReplyProtection,resumeReply};s.turn=t;
  let lease,tts;
  try{
   const clientContext=await prepareClientContext(s,t,transcript);
   const localMemory=clientContext?.localMemory||null,documentQuery=clientContext?.documentQuery||null;
   if(t.controller.signal.aborted||s.closed||s.turn!==t)return;
   timing('context_ready',t);
   lease=accessControl.beginRequest({subject:s.subject,requestId:randomUUID()});
   t.prepared=service.prepare({ownerId:s.ownerId,conversationId:s.conversationId,message:transcript,clientRequestId:t.id,requestId:lease.requestId,taskTimezone:s.timezone,localMemory,documentQuery,invocation:{ownerId:s.ownerId,subject:s.subject,requestLease:lease}});
   repository.createDelivery({...identity(s,t),messageId:t.prepared.assistantMessage.id});
   send(s,'messages',{turnId:t.id,messages:[t.prepared.userMessage,t.prepared.assistantMessage]});
   send(s,'thinking',{turnId:t.id});
   // Open synthesis on visible answer text while the first clause is still arriving.
   const speechText=new SpeechText();
   t.startSynthesis=()=>{if(!tts&&!s.closed&&s.turn===t&&!t.controller.signal.aborted)tts=speak(s,t,lease);};
   const result=await service.execute(t.prepared,{signal:t.controller.signal,onDelta:delta=>{
    if(s.turn!==t||s.closed)return;if(!t.answerStarted){t.answerStarted=true;timing('answer_started',t);}send(s,'delta',{turnId:t.id,messageId:t.prepared.assistantMessage.id,text:delta});
    if(t.recoveryEnabled&&!t.recoveryOverflow){
     const answer=(t.generatedAnswer||'')+delta;
     if(answer.length>MAX_RECOVERABLE_ANSWER_CHARS){t.recoveryOverflow=true;t.generatedAnswer='';}else t.generatedAnswer=answer;
    }
    const documentAnswer=decodeDocumentMessage(delta);
    const spoken=documentAnswer?.kind==='answer'?String(documentAnswer.data.text||'这份文件没有提供足够信息。'):parseMemoryReceiptMessage(delta)?'请查看屏幕上的记忆保存结果。':(t.publicSearch||t.resumeReply?.answer?.includes('\n\n检索日期：'))?delta.split('\n\n检索日期：')[0].replace(/\[\d+\]/g,''):delta;
    const chunks=speechText.push(spoken);
    if(!tts&&(chunks.length||/\p{L}|\p{N}/u.test(speechText.sentence)))tts=speak(s,t,lease);
    for(const clean of chunks){t.speechText=(t.speechText||'')+clean;t.text.push(clean);}
   }});
   if(s.turn!==t||s.closed){gate.invalidate(identity(s,t));return;}
   if(result.status==='stopped'){interrupt(s);return;}
   if(result.status!=='completed')throw fail(result.code||'VOICE_REPLY_FAILED');
   for(const tail of speechText.finish()){t.speechText=(t.speechText||'')+tail;if(!tts)tts=speak(s,t,lease);t.text.push(tail);}t.text.end();
   t.proposal=result.voiceProposal||null;t.status=result.status;
   if(t.recoveryEnabled){
    const answer=String(result.content||'');t.recoveryOverflow=answer.length>MAX_RECOVERABLE_ANSWER_CHARS;
    t.generatedAnswer=t.recoveryOverflow?'':answer;
   }
   send(s,'completed',{turnId:t.id,messageId:t.prepared.assistantMessage.id,content:result.content,status:result.status});
   if(t.proposal)send(s,'proposal',{turnId:t.id,proposal:confirmationSummary(t.proposal)});
   if(tts)await tts;else send(s,'audio_end',{turnId:t.id,messageId:t.prepared.assistantMessage.id,segments:0});
  }catch(e){if(!t.controller.signal.aborted&&!s.closed){send(s,'voice_error',{code:e.code||'VOICE_REPLY_FAILED'});end(s,e.code||'VOICE_REPLY_FAILED');}}
  finally{t.text.end();if(tts)await tts;if(lease)accessControl.releaseRequest(lease);}
 }

 const runtime={enabled:true,repository,gate,sessions,
  create({user,subject,conversationId,timezone='Asia/Shanghai',mediaProtocol,interruptionVersion,clientContextVersion}){
   if(!user?.id||!subject)throw fail('UNAUTHENTICATED');const actor=accessControl.assertAuthenticatedSubject(subject);if(actor.accountId!==user.id)throw fail('VOICE_ACCOUNT_MISMATCH');
   if([...sessions.values()].some(s=>s.ownerId===user.id))throw fail('VOICE_ALREADY_ACTIVE');if(sessions.size>=globalLimit)throw fail('VOICE_BUSY');
   const conversation=conversationId?conversationRuntime.conversations.getByIdForOwner(conversationId,user.id):conversationRuntime.conversations.createForOwner(user.id,{title:'语音聊天'});
   if(!conversation||conversationRuntime.service.isLearningConversation?.(conversation.id,user.id))throw fail('CONVERSATION_NOT_FOUND');
   repository.consume(user.id,0,0,dailyLimitMs);
   const negotiated={lowLatency:coreOptions.lowLatency===true,ordinaryChat:coreOptions.ordinaryChat===true,conservativeInterruption:coreOptions.conservativeInterruption===true&&mediaProtocol===1,pendingReplyProtection:coreOptions.conservativeInterruption===true&&mediaProtocol===1&&interruptionVersion===2,...(clientContextVersion===1?{clientContext:true}:{})};
   const s={id:randomUUID(),ownerId:user.id,subject,conversationId:conversation.id,timezone,coreOptions:negotiated,speechCandidate:null,lastCandidateSequence:-1,created:clock(),heartbeat:clock(),lastActivity:clock(),lastSpeechStop:clock(),events:[],audioQueue:[],audioQueueBytes:0,audioQueueStartedAt:null,audioQueueTimer:null,seenItems:new Set(),expectedSequence:0,inputEpoch:0,muted:false,closed:false,turn:null};sessions.set(s.id,s);
   s.timer=setInterval(()=>{try{
    if(s.interruptedReply)recoverableReply(s);
    if(clock()-s.heartbeat>20000)return end(s,'VOICE_LEASE_EXPIRED');
    if(!s.muted&&clock()-s.lastActivity>60000)return end(s,'VOICE_IDLE');
    if(s.asr&&clock()-s.asrStarted>70000&&!s.capturing&&clock()-s.lastSpeechStop>2000){const handle=s.asr;s.asr=null;s.rotating=true;beginAsrWait(s);handle.finish();}
   }catch(e){end(s,e.code||'VOICE_FAILED');}},1000);s.timer.unref?.();
   return{id:s.id,conversationId:s.conversationId,expiresInSeconds:20,coreOptions:negotiated};
  },
  subscribe(id,ownerId,listener,onClose){const s=get(id,ownerId);if(s.listener)throw fail('VOICE_ALREADY_CONNECTED');s.listener=listener;s.onClose=onClose;for(const e of s.events)listener(e);s.events=[];track(startAsr(s));return()=>end(s,'VOICE_DISCONNECTED');},
  audio(id,ownerId,bytes,sequence,inputEpoch=0){const s=get(id,ownerId);if(sequence!==s.expectedSequence||!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>32000||bytes.length%2)throw fail('VOICE_AUDIO_INVALID');s.expectedSequence++;if(!Number.isSafeInteger(inputEpoch)||inputEpoch<0||inputEpoch>s.inputEpoch)throw fail('VOICE_AUDIO_INVALID');if(s.muted||inputEpoch<s.inputEpoch)return;repository.consume(ownerId,Math.ceil(bytes.length/32),0,dailyLimitMs);if(s.asr){try{s.asr.append(bytes);}catch(e){end(s,e.code||'VOICE_ASR_FAILED');throw e;}}else queueAudio(s,bytes);},
  control(id,ownerId,body){if(body.type==='end'&&ended.get(id)===ownerId)return{ok:true};const s=get(id,ownerId);s.heartbeat=clock();
   if(body.type==='context'){
    const t=s.turn;if(!t?.acceptContext||body.turnId!==t.id||body.contextToken!==t.contextToken)throw fail('VOICE_CONTEXT_STALE');
    const evidence=validateLocalMemoryEvidence(body.localMemory,{ownerId:s.ownerId,question:t.contextQuestion});
    const documentQuery=body.documentQuery==null?null:validateProjection(body.documentQuery,{ownerId:s.ownerId,conversationId:s.conversationId,question:t.contextQuestion,hash:text=>createHash('sha256').update(text).digest('hex')});
    t.acceptContext({localMemory:evidence,documentQuery});return{ok:true};
   }
   if(body.type==='external_input'){
    if(typeof body.id!=='string'||!body.id||body.id.length>160||typeof body.active!=='boolean')throw fail('VOICE_CONTROL_INVALID');
    if(body.active){if(s.externalInput&&s.externalInput.id!==body.id)throw fail('VOICE_INPUT_BUSY');
     if(!s.externalInput){s.externalInput={id:body.id,wasMuted:s.muted};s.turnVersion=(s.turnVersion||0)+1;s.pendingTranscripts=[];interrupt(s);s.interruptedReply=null;setInputMuted(s,true);}
    }else{if(s.externalInput?.id!==body.id)throw fail('VOICE_INPUT_STALE');const previous=s.externalInput;s.externalInput=null;setInputMuted(s,previous.wasMuted);}
    return{ok:true,inputEpoch:s.inputEpoch};
   }
   if(body.type==='heartbeat'){send(s,'heartbeat');return{ok:true};}if(body.type==='end'){end(s);return{ok:true};}
   if(body.type==='speech_candidate'){receiveSpeechCandidate(s,body,clock());return{ok:true};}
   if(body.type==='interrupt'){s.echoReference='';interrupt(s);s.lastActivity=clock();return{ok:true};}
   if(body.type==='mute'){if(s.externalInput)throw fail('VOICE_INPUT_BUSY');setInputMuted(s,body.muted===true);send(s,'muted',{muted:s.muted});return{ok:true};}
   if(body.type==='receipt'){const t=s.turn;if(!t||body.turnId!==t.id||body.messageId!==t.prepared?.assistantMessage.id)throw fail('VOICE_RECEIPT_INVALID');if(t.confirmed)return{ok:true};if(body.completedSegments>t.audioSegments)throw fail('VOICE_RECEIPT_INVALID');t.completedSegments=body.completedSegments;repository.receipt({...identity(s,t),messageId:body.messageId,status:body.status,completedSegments:body.completedSegments});if(body.status==='completed'){t.heard=true;if(t.resumeReply&&s.interruptedReply===t.resumeReply)s.interruptedReply=null;}return{ok:true};}
   if(body.type==='cancel_proposal'){if(s.turn){gate.invalidate(identity(s));s.turn.proposal=null;}return{ok:true};}
   throw fail('VOICE_CONTROL_INVALID');
  },
  async confirm(id,ownerId,body){const s=get(id,ownerId),t=s.turn;if(!t?.proposal||body.proposalId!==t.proposal.id||body.turnId!==t.id)throw fail('VOICE_CONFIRMATION_EXPIRED');
   const outcome=await gate.confirm(body.proposalId,identity(s,t));const content=confirmationResult(outcome);t.confirmed=true;t.controller.abort();t.text.end();repository.markReplacementUnspoken({...identity(s,t),messageId:t.prepared.assistantMessage.id});if(!s.closed&&s.turn===t)send(s,'confirmed',{turnId:t.id,content});
   conversationRuntime.messages.completeAssistantMessage({ownerId,messageId:t.prepared.assistantMessage.id,content});if(!s.closed&&s.turn===t)send(s,'completed',{turnId:t.id,messageId:t.prepared.assistantMessage.id,content,status:'completed'});return{ok:true,content};
  },
  close(){for(const s of [...sessions.values()])end(s);gate.close();return Promise.allSettled([...background]);},
  endForOwner(ownerId){for(const s of [...sessions.values()])if(s.ownerId===ownerId)end(s);}
 };return runtime;
}
