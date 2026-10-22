import {BrowserVoiceMediaAdapter} from './browserMediaAdapter.js';
const fail=(code,voiceDiagnostic)=>Object.assign(new Error(code),{code,...(voiceDiagnostic?{voiceDiagnostic}:{})});
const MAX_UPLOAD_BACKLOG_FRAMES=100;
const voiceErrorCode=code=>code==='ACCOUNT_USAGE_LIMIT_REACHED'?'VOICE_SERVICE_LIMIT':code;
const requestKind=path=>{
 const value=String(path||'').split('?')[0];
 if(value==='/sessions')return'start';
 if(value.endsWith('/events'))return'events';
 if(value.endsWith('/audio'))return'audio';
 if(value.endsWith('/control'))return'control';
 if(value.endsWith('/confirm'))return'confirm';
 return'other';
};
const allowedErrorCodes=new Set(['VOICE_CONTEXT_FAILED','VOICE_CONTEXT_STALE','VOICE_INPUT_BUSY','VOICE_INPUT_STALE','LOCAL_MEMORY_CONTEXT_INVALID','VOICE_ACCOUNT_MISMATCH','UNAUTHENTICATED','VOICE_ALREADY_ACTIVE','VOICE_BUSY','VOICE_DAILY_LIMIT','VOICE_CONFIRMATION_EXPIRED','VOICE_SESSION_NOT_FOUND','VOICE_UNAVAILABLE','VOICE_CONSENT_REQUIRED','VOICE_AUDIO_INVALID','VOICE_CONTROL_INVALID','VOICE_RATE_LIMITED','VOICE_SERVICE_LIMIT','ACCOUNT_ACCESS_DISABLED','ACCOUNT_QUOTA_NOT_CONFIGURED','ACCOUNT_REQUEST_RATE_LIMITED','ACCOUNT_CONCURRENCY_LIMITED','ACCOUNT_USAGE_LIMIT_REACHED','ACCESS_CONTROL_UNAVAILABLE','DUPLICATE_PROVIDER_ATTEMPT','REQUEST_LEASE_INVALID']);
const fallbackErrorCode=status=>status===401?'UNAUTHENTICATED':status===429?'VOICE_RATE_LIMITED':'VOICE_NETWORK_FAILED';
export class VoiceChatEngine {
 constructor({ownerId,onState=()=>{},onEvent=()=>{},onConversation=()=>{},prepareContext=null,onTiming=()=>{},clock=Date.now,fetchImpl=globalThis.fetch,mediaAdapter,...mediaOptions}={}){
  Object.assign(this,{ownerId,onState,onEvent,onConversation,prepareContext,onTiming,clock,fetchImpl:fetchImpl.bind(globalThis)});this.media=mediaAdapter||new BrowserVoiceMediaAdapter(mediaOptions);this.epoch=0;this.blockedTurns=new Set();this.coreOptions={};this.state={phase:'idle',muted:false,level:0,playbackLevel:0,subtitle:'',error:'',diagnostic:null,proposal:null};this.conversationId=null;
 }
 update(values){this.state={...this.state,...values};this.onState(this.state);}
 timing(stage,at=this.clock()){try{this.onTiming({stage,at,turnId:this.turn?.id||null,inputEpoch:this.inputEpoch});}catch{}}
 async request(path,{method='POST',body,headers={},signal=this.controller?.signal,keepalive=false}={}){
  const binary=body instanceof ArrayBuffer;
  const kind=requestKind(path);let response;
  try{response=await this.fetchImpl('/api/voice/chat'+path,{method,credentials:'same-origin',cache:'no-store',signal,keepalive,headers:{'X-AI-Expected-Account-Context':this.ownerId,...(method==='POST'?{'Content-Type':binary?'application/octet-stream':'application/json'}:{}),...headers},...(method==='POST'?{body:binary?body:JSON.stringify(body||{})}:{})});}
  catch(error){throw fail(error?.code||'VOICE_NETWORK_FAILED',{httpStatus:null,accountContextPresent:false,accountContextMatches:false,requestKind:kind});}
  const accountContext=response.headers.get('X-AI-Account-Context');
  const voiceDiagnostic={httpStatus:Number.isInteger(response.status)?response.status:null,accountContextPresent:accountContext!==null,accountContextMatches:accountContext!==null&&accountContext===this.ownerId,requestKind:kind};
  // Never inspect a body which the server explicitly binds to another account.
  if(accountContext!==null&&accountContext!==this.ownerId)throw fail('VOICE_ACCOUNT_MISMATCH',voiceDiagnostic);
  if(!response.ok){
   if(accountContext===this.ownerId){let code;try{const body=await response.json();code=typeof body?.code==='string'&&allowedErrorCodes.has(body.code)?body.code:null;}catch{}throw fail(code||fallbackErrorCode(response.status),voiceDiagnostic);}
   // Missing account context means the body is not trusted. A bare 403 is not
   // enough evidence to claim that the user is logged out.
   throw fail(fallbackErrorCode(response.status),voiceDiagnostic);
  }
  if(accountContext!==this.ownerId)throw fail('VOICE_ACCOUNT_MISMATCH',voiceDiagnostic);
  return response;
 }
 control(body){if(!this.sessionId)return Promise.resolve();return this.request(`/sessions/${this.sessionId}/control`,{body});}
 async start({conversationId,timezone}={}){
  this.end();const epoch=++this.epoch;this.sessionStartedAt=this.clock();this.controller=new AbortController();this.conversationId=conversationId;this.sessionId=null;this.sequence=0;this.inputEpoch=0;this.upload=[];this.uploading=false;this.firstUploadSent=false;this.coreOptions={};this.blockedTurns=new Set();this.turn=null;this.ready=false;this.speechFrames=0;this.noise=.002;this.lastVoice=0;
  this.update({phase:'permission',muted:false,subtitle:'',error:'',diagnostic:null,proposal:null});
  this.candidateSequence=0;this.pendingCandidate=null;this.captureStartedAt=null;
  try{
   await this.media.start({onFrame:data=>{if(epoch===this.epoch&&this.ready&&!this.state.muted)this.captureAudio(data);},onInterruption:code=>{if(epoch===this.epoch)this.pause(code);}});if(epoch!==this.epoch)return;
   this.update({phase:'connecting'});
   const data=await(await this.request('/sessions',{body:{consent:true,conversationId,timezone,mediaProtocol:1,interruptionVersion:2,clientContextVersion:this.prepareContext?1:0}})).json();if(epoch!==this.epoch){void this.request(`/sessions/${data.id}/control`,{body:{type:'end'},signal:null,keepalive:true}).catch(()=>{});return;}
   this.sessionId=data.id;this.coreOptions=data.coreOptions||{};this.conversationId=data.conversationId;this.onConversation(data.conversationId);
   this.heartbeat=setInterval(()=>{void this.control({type:'heartbeat'}).catch(e=>{if(epoch===this.epoch)this.pause(e);});},5000);
   void this.events(epoch).catch(e=>{if(epoch===this.epoch)this.pause(e?.code?e:fail('VOICE_DISCONNECTED',e?.voiceDiagnostic));});
  }catch(e){if(epoch===this.epoch)this.pause(e.name==='NotAllowedError'?fail('VOICE_PERMISSION_DENIED'):e.name==='NotFoundError'?fail('VOICE_NO_MICROPHONE'):e?.code?e:fail('VOICE_START_FAILED',e?.voiceDiagnostic));}
 }
 captureAudio({pcm,rms}){
  if(this.externalInput)return;
  if(!(pcm instanceof ArrayBuffer)||pcm.byteLength!==3200||!Number.isFinite(rms)||rms<0||rms>1)return this.pause('VOICE_AUDIO_INVALID');
  this.update({level:this.state.muted?0:rms});
  if(this.captureStartedAt==null){this.captureStartedAt=this.clock();this.timing('capture_started',this.captureStartedAt);}
  const speaking=this.media.playing,threshold=Math.max(.014,this.noise*3.5);
  if(!speaking&&rms<threshold)this.noise=this.noise*.97+rms*.03;
  if(rms>threshold){this.speechFrames++;this.quietFrames=0;if(this.speechFrames===2){this.lastVoice=this.clock();if(!speaking&&!this.turn)this.update({phase:'listening'});}}
  else{this.speechFrames=0;this.quietFrames=(this.quietFrames||0)+1;if(this.quietFrames===3)this.setVolume(1);}
  const pendingReply=this.coreOptions.pendingReplyProtection&&this.turn&&!this.turn.receiptSent;
  if((speaking||pendingReply)&&this.coreOptions.conservativeInterruption&&this.speechFrames>=4&&this.speechFrames%4===0)this.pendingCandidate={type:'speech_candidate',candidateSequence:this.candidateSequence++,turnId:this.turn?.id,inputEpoch:this.inputEpoch,durationMs:Math.min(10000,this.speechFrames*100),peakRms:rms,createdAt:this.clock()};
  this.upload.push(pcm);if(this.upload.length>MAX_UPLOAD_BACKLOG_FRAMES)return this.pause('VOICE_NETWORK_SLOW');
  if(this.upload.length>=(this.coreOptions?.lowLatency?(this.firstUploadSent?4:2):5)&&!this.uploading)void this.flush();
 }
 async flush(){if(this.uploading||!this.sessionId)return;const epoch=this.epoch;this.uploading=true;
  try{while(epoch===this.epoch&&this.upload.length&&!this.state.muted){if(this.coreOptions?.lowLatency&&this.upload.length<(this.firstUploadSent?4:2))break;const chunks=this.upload.splice(0,this.coreOptions?.lowLatency?(this.firstUploadSent?4:2):10),data=new Uint8Array(chunks.reduce((n,c)=>n+c.byteLength,0));this.firstUploadSent=true;let offset=0;for(const c of chunks){data.set(new Uint8Array(c),offset);offset+=c.byteLength;}
   const inputEpoch=this.inputEpoch,candidate=this.pendingCandidate;this.pendingCandidate=null;
   if(candidate&&candidate.turnId===this.turn?.id&&candidate.inputEpoch===inputEpoch&&this.clock()-candidate.createdAt<=1000){const{createdAt,...body}=candidate;await this.control(body);}
   if(epoch!==this.epoch)return;if(inputEpoch!==this.inputEpoch||this.state.muted)continue;
   if(this.sequence===0)this.timing('first_upload');
   await this.request(`/sessions/${this.sessionId}/audio`,{body:data.buffer,headers:{'X-Voice-Sequence':String(this.sequence++),'X-Voice-Input-Epoch':String(inputEpoch)}});}}
  catch(e){if(epoch===this.epoch)this.pause(e?.code?e:fail('VOICE_NETWORK_FAILED',e?.voiceDiagnostic));}finally{if(epoch===this.epoch)this.uploading=false;}
 }
 async events(epoch){const response=await this.request(`/sessions/${this.sessionId}/events`,{method:'GET'});const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';
  while(epoch===this.epoch){const{done,value}=await reader.read();if(done)break;pending+=decoder.decode(value,{stream:true});if(pending.length>512000)throw fail('VOICE_EVENT_LIMIT');let boundary;
   while((boundary=pending.indexOf('\n\n'))>=0){const frame=pending.slice(0,boundary);pending=pending.slice(boundary+2);const raw=frame.split('\n').find(line=>line.startsWith('data: '));if(raw&&epoch===this.epoch)this.event(JSON.parse(raw.slice(6)));}}
  if(epoch===this.epoch)throw fail('VOICE_DISCONNECTED');
 }
 event(event){const data=event.data||{};if(data.sessionId&&data.sessionId!==this.sessionId)return;
  if(this.externalInput&&!['ready','heartbeat','ended','voice_error','muted'].includes(event.type)){if(data.turnId)this.blockedTurns.add(data.turnId);return;}
  if(Number.isSafeInteger(data.inputEpoch)&&data.inputEpoch<this.inputEpoch)return;
  if(data.turnId&&this.blockedTurns?.has(data.turnId)&&event.type!=='interrupted')return;
  if(event.type==='context_required'){this.timing('asr_received');void this.resolveContext(data);return;}
  if(event.type==='ready'){this.ready=true;if(this.externalInput)return;this.update({phase:this.state.muted?'muted':'listening'});}
  else if(event.type==='messages'){this.clearAudio();this.turn={id:data.turnId,messageId:data.messages.at(-1).id,completed:0,received:0,ended:false};this.update({phase:'thinking',subtitle:data.messages[0].content,proposal:null});}
  else if(event.type==='partial'&&!['speaking','thinking'].includes(this.state.phase))this.update({subtitle:data.text});
  else if(event.type==='echo_ignored')this.setVolume(1);
  else if(event.type==='delta'&&this.turn?.id===data.turnId){if(!this.turn.reply&&/[\p{L}\p{N}]/u.test(data.text))this.timing('first_text_received');this.turn.reply=(this.turn.reply||'')+data.text;this.update({subtitle:this.turn.reply});}
  else if(event.type==='thinking')this.update({phase:'thinking'});
  else if(event.type==='audio'){if(!this.blockedTurns.has(data.turnId)&&this.turn?.id===data.turnId)this.play(data);}
  else if(event.type==='audio_end'){if(this.turn?.id===data.turnId&&!this.blockedTurns.has(data.turnId)){this.turn.ended=true;this.turn.total=data.segments;this.finishPlayback();}}
  else if(event.type==='interrupted'){this.blockedTurns.add(data.turnId);if(this.turn?.id===data.turnId){this.clearAudio();this.turn=null;this.update({phase:this.state.muted?'muted':'listening',proposal:null});}}
  else if(event.type==='proposal'&&this.turn?.id===data.turnId)this.update({proposal:data.proposal});
  else if(event.type==='confirmed'&&this.turn?.id===data.turnId){const messageId=this.turn.messageId;this.blockedTurns.add(data.turnId);this.clearAudio();this.turn=null;this.update({subtitle:data.content,proposal:null,phase:this.state.muted?'muted':'listening'});this.onEvent({type:'completed',data:{...data,messageId,status:'completed'}});}
  else if(event.type==='voice_error')this.pause(data.code);
  else if(event.type==='ended'){this.pause(data.code);}
  this.onEvent(event);
 }
 play(data){
  const turn=this.turn;if(data.index!==turn.received||data.sampleRate!==24000)return this.pause('VOICE_AUDIO_ORDER');
  try{const playback=this.media.play({...data,onStarted:()=>{if(this.turn!==turn||this.blockedTurns.has(turn.id))return;if(!turn.playbackStarted){turn.playbackStarted=true;this.timing('first_audio_played');}this.update({phase:'speaking'});},onLevel:level=>{if(this.turn===turn&&!this.blockedTurns.has(turn.id))this.update({playbackLevel:level});},onEnded:()=>{if(this.turn===turn&&!this.blockedTurns.has(turn.id)){turn.completed++;this.finishPlayback();}}});if(turn.received===0)this.timing('first_audio_scheduled',this.clock()+(playback?.scheduledInMs||0));turn.received++;}catch(e){this.pause(e?.code?e:fail('VOICE_PLAYBACK_BLOCKED',e?.voiceDiagnostic));}
 }
 finishPlayback(){const t=this.turn;if(!t||!t.ended||t.receiptSent||this.media.playing||t.completed!==t.total)return;t.receiptSent=true;const epoch=this.epoch;this.update({phase:this.state.muted?'muted':'listening'});void this.control({type:'receipt',turnId:t.id,messageId:t.messageId,status:'completed',completedSegments:t.completed}).catch(e=>{if(epoch===this.epoch&&this.turn===t)this.pause(e);});}
 setVolume(value){this.media.setVolume?.(value);}
 clearAudio(){this.media.clearPlayback();this.speechFrames=0;this.pendingCandidate=null;this.update({playbackLevel:0});}
 interrupt(){const t=this.turn;this.contextPreparation?.abort();this.contextPreparation=null;if(!t)return;const epoch=this.epoch;this.blockedTurns.add(t.id);this.clearAudio();this.turn=null;this.update({proposal:null,phase:this.state.muted?'muted':'listening'});void this.control({type:'interrupt'}).catch(e=>{if(epoch===this.epoch)this.pause(e);});}
 async resolveContext(data){
  if(!this.prepareContext||!this.coreOptions.clientContext||this.externalInput)return;
  this.contextPreparation?.abort();const controller=new AbortController();this.contextPreparation=controller;const epoch=this.epoch;
  this.clearAudio();this.turn={id:data.turnId,received:0,completed:0,ended:false};this.update({phase:'thinking',subtitle:data.text,proposal:null});
  try{const context=await this.prepareContext({text:data.text,requestId:data.turnId,source:'user_voice',signal:controller.signal});
   if(controller.signal.aborted||epoch!==this.epoch||this.turn?.id!==data.turnId)return;
   this.timing('context_prepared');
   await this.control({type:'context',turnId:data.turnId,contextToken:data.contextToken,localMemory:context?.localMemory||context,documentQuery:context?.documentQuery||null});
  }catch(error){if(!controller.signal.aborted&&epoch===this.epoch)this.pause(error?.code||'VOICE_CONTEXT_FAILED');}
 }
 async beginExternalInput(){
  if(!this.sessionId)return null;if(this.externalInput)throw fail('VOICE_INPUT_BUSY');
  const lease={epoch:this.epoch,sessionId:this.sessionId,id:globalThis.crypto.randomUUID(),wasMuted:this.state.muted};this.externalInput=lease;
  this.contextPreparation?.abort();this.contextPreparation=null;
  if(this.turn){this.blockedTurns.add(this.turn.id);this.onEvent({type:'interrupted',data:{turnId:this.turn.id,messageId:this.turn.messageId}});}
  this.clearAudio();this.turn=null;this.upload=[];this.ready=false;this.inputEpoch++;
  this.update({phase:'text',muted:true,level:0,proposal:null,inputSuspended:true});
  try{await this.media.setMuted(true);if(lease.epoch!==this.epoch)return null;const result=await(await this.control({type:'external_input',active:true,id:lease.id})).json();if(lease.epoch!==this.epoch)return null;if(Number.isSafeInteger(result.inputEpoch))this.inputEpoch=result.inputEpoch;return lease;}
  catch(error){if(lease.epoch===this.epoch)this.pause(error);throw error;}
 }
 async finishExternalInput(lease){
  if(!lease||this.externalInput!==lease||lease.epoch!==this.epoch||lease.sessionId!==this.sessionId)return;
  try{const result=await(await this.control({type:'external_input',active:false,id:lease.id})).json();if(lease.epoch!==this.epoch)return;
   if(Number.isSafeInteger(result.inputEpoch))this.inputEpoch=result.inputEpoch;
   await this.media.setMuted(lease.wasMuted);if(lease.epoch!==this.epoch)return;this.externalInput=null;
   this.update({muted:lease.wasMuted,phase:lease.wasMuted?'muted':this.ready?'listening':'connecting',inputSuspended:false,level:0});
  }catch(error){if(lease.epoch===this.epoch)this.pause(error);}
 }
 async mute(){if(this.muting||this.externalInput)return;this.muting=true;const value=!this.state.muted,epoch=this.epoch;this.upload=[];this.speechFrames=0;this.pendingCandidate=null;
  try{this.inputEpoch++;if(value){this.update({muted:true,phase:this.media.playing?'speaking':'muted',level:0});await this.media.setMuted(true);if(epoch!==this.epoch)return;await this.control({type:'mute',muted:true});}
   else{await this.media.setMuted(false);if(epoch!==this.epoch)return;await this.control({type:'mute',muted:false});if(epoch===this.epoch)this.update({muted:false,phase:'listening'});}}
  catch(e){if(epoch===this.epoch)this.pause(e?.code?e:fail('VOICE_MICROPHONE_LOST',e?.voiceDiagnostic));}finally{if(epoch===this.epoch)this.muting=false;}}
 async confirm(){const p=this.state.proposal;if(!p)return;const epoch=this.epoch;this.update({confirming:true});try{await this.request(`/sessions/${this.sessionId}/confirm`,{body:{proposalId:p.id,turnId:p.turnId}});if(epoch===this.epoch)this.update({proposal:null,confirming:false});}catch(e){if(epoch===this.epoch)this.update({confirming:false,error:e.code||'VOICE_ACTION_FAILED'});}}
 cancelProposal(){const epoch=this.epoch;this.update({proposal:null});void this.control({type:'cancel_proposal'}).catch(e=>{if(epoch===this.epoch)this.pause(e);});}
 pause(failure){const code=typeof failure==='string'?failure:failure?.code;const error=voiceErrorCode(code)||'VOICE_PAUSED';let diagnostic=null;try{const now=this.clock(),started=Number.isFinite(this.sessionStartedAt)?this.sessionStartedAt:now,source=failure?.voiceDiagnostic;diagnostic={code:error,relativeMs:Math.max(0,now-started)};if(source&&(source.httpStatus===null||(Number.isInteger(source.httpStatus)&&source.httpStatus>=100&&source.httpStatus<=599)))diagnostic.httpStatus=source.httpStatus;if(typeof source?.accountContextPresent==='boolean')diagnostic.accountContextPresent=source.accountContextPresent;if(typeof source?.accountContextMatches==='boolean')diagnostic.accountContextMatches=source.accountContextMatches;if(['start','events','audio','control','confirm','other'].includes(source?.requestKind))diagnostic.requestKind=source.requestKind;}catch{}this.end();this.update({phase:'paused',error,diagnostic,proposal:null});}
 end(){const sessionId=this.sessionId;this.sessionId=null;++this.epoch;this.ready=false;this.contextPreparation?.abort();this.contextPreparation=null;this.externalInput=null;clearInterval(this.heartbeat);this.controller?.abort();this.clearAudio();this.turn=null;this.upload=[];this.media.dispose();this.muting=false;this.update({phase:'idle',level:0,playbackLevel:0,inputSuspended:false});
  if(sessionId)void this.request(`/sessions/${sessionId}/control`,{body:{type:'end'},signal:null,keepalive:true}).catch(()=>{});
 }
}
