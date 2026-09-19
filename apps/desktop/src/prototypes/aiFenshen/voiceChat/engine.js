import {BrowserVoiceMediaAdapter} from './browserMediaAdapter.js';
const fail=code=>Object.assign(new Error(code),{code});
const MAX_UPLOAD_BACKLOG_FRAMES=100;
const voiceErrorCode=code=>code==='ACCOUNT_USAGE_LIMIT_REACHED'?'VOICE_SERVICE_LIMIT':code;
export class VoiceChatEngine {
 constructor({ownerId,onState=()=>{},onEvent=()=>{},onConversation=()=>{},onTiming=()=>{},clock=Date.now,fetchImpl=globalThis.fetch,mediaAdapter,...mediaOptions}={}){
  Object.assign(this,{ownerId,onState,onEvent,onConversation,onTiming,clock,fetchImpl:fetchImpl.bind(globalThis)});this.media=mediaAdapter||new BrowserVoiceMediaAdapter(mediaOptions);this.epoch=0;this.blockedTurns=new Set();this.coreOptions={};this.state={phase:'idle',muted:false,subtitle:'',error:'',proposal:null};this.conversationId=null;
 }
 update(values){this.state={...this.state,...values};this.onState(this.state);}
 timing(stage,at=this.clock()){try{this.onTiming({stage,at,turnId:this.turn?.id||null,inputEpoch:this.inputEpoch});}catch{}}
 async request(path,{method='POST',body,headers={},signal=this.controller?.signal,keepalive=false}={}){
  const binary=body instanceof ArrayBuffer;
  const response=await this.fetchImpl('/api/voice/chat'+path,{method,credentials:'same-origin',cache:'no-store',signal,keepalive,headers:{'X-AI-Expected-Account-Context':this.ownerId,...(method==='POST'?{'Content-Type':binary?'application/octet-stream':'application/json'}:{}),...headers},...(method==='POST'?{body:binary?body:JSON.stringify(body||{})}:{})});
  if(response.headers.get('X-AI-Account-Context')!==this.ownerId)throw fail('VOICE_ACCOUNT_MISMATCH');
  if(!response.ok){let data={};try{data=await response.json();}catch{}throw fail(data.code||'VOICE_NETWORK_FAILED');}return response;
 }
 control(body){if(!this.sessionId)return Promise.resolve();return this.request(`/sessions/${this.sessionId}/control`,{body});}
 async start({conversationId,timezone}={}){
  this.end();const epoch=++this.epoch;this.controller=new AbortController();this.conversationId=conversationId;this.sessionId=null;this.sequence=0;this.inputEpoch=0;this.upload=[];this.uploading=false;this.firstUploadSent=false;this.coreOptions={};this.blockedTurns=new Set();this.turn=null;this.ready=false;this.speechFrames=0;this.noise=.002;this.lastVoice=0;
  this.update({phase:'permission',muted:false,subtitle:'',error:'',proposal:null});
  this.candidateSequence=0;this.pendingCandidate=null;this.captureStartedAt=null;
  try{
   await this.media.start({onFrame:data=>{if(epoch===this.epoch&&this.ready&&!this.state.muted)this.captureAudio(data);},onInterruption:code=>{if(epoch===this.epoch)this.pause(code);}});if(epoch!==this.epoch)return;
   this.update({phase:'connecting'});
   const data=await(await this.request('/sessions',{body:{consent:true,conversationId,timezone,mediaProtocol:1}})).json();if(epoch!==this.epoch){void this.request(`/sessions/${data.id}/control`,{body:{type:'end'},signal:null,keepalive:true}).catch(()=>{});return;}
   this.sessionId=data.id;this.coreOptions=data.coreOptions||{};this.conversationId=data.conversationId;this.onConversation(data.conversationId);
   this.heartbeat=setInterval(()=>{void this.control({type:'heartbeat'}).catch(e=>{if(epoch===this.epoch)this.pause(e.code);});},5000);
   void this.events(epoch).catch(e=>{if(epoch===this.epoch)this.pause(e.code||'VOICE_DISCONNECTED');});
  }catch(e){if(epoch===this.epoch)this.pause(e.name==='NotAllowedError'?'VOICE_PERMISSION_DENIED':e.name==='NotFoundError'?'VOICE_NO_MICROPHONE':e.code||'VOICE_START_FAILED');}
 }
 captureAudio({pcm,rms}){
  if(!(pcm instanceof ArrayBuffer)||pcm.byteLength!==3200||!Number.isFinite(rms)||rms<0||rms>1)return this.pause('VOICE_AUDIO_INVALID');
  if(this.captureStartedAt==null){this.captureStartedAt=this.clock();this.timing('capture_started',this.captureStartedAt);}
  const speaking=this.media.playing,threshold=Math.max(.014,this.noise*3.5);
  if(!speaking&&rms<threshold)this.noise=this.noise*.97+rms*.03;
  if(rms>threshold){this.speechFrames++;this.quietFrames=0;if(this.speechFrames===2){this.lastVoice=this.clock();if(!speaking&&!this.turn)this.update({phase:'listening'});}}
  else{this.speechFrames=0;this.quietFrames=(this.quietFrames||0)+1;if(this.quietFrames===3)this.setVolume(1);}
  if(speaking&&this.coreOptions.conservativeInterruption&&this.speechFrames>=4&&this.speechFrames%4===0)this.pendingCandidate={type:'speech_candidate',candidateSequence:this.candidateSequence++,turnId:this.turn?.id,inputEpoch:this.inputEpoch,durationMs:Math.min(10000,this.speechFrames*100),peakRms:rms,createdAt:this.clock()};
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
  catch(e){if(epoch===this.epoch)this.pause(e.code||'VOICE_NETWORK_FAILED');}finally{if(epoch===this.epoch)this.uploading=false;}
 }
 async events(epoch){const response=await this.request(`/sessions/${this.sessionId}/events`,{method:'GET'});const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';
  while(epoch===this.epoch){const{done,value}=await reader.read();if(done)break;pending+=decoder.decode(value,{stream:true});if(pending.length>512000)throw fail('VOICE_EVENT_LIMIT');let boundary;
   while((boundary=pending.indexOf('\n\n'))>=0){const frame=pending.slice(0,boundary);pending=pending.slice(boundary+2);const raw=frame.split('\n').find(line=>line.startsWith('data: '));if(raw&&epoch===this.epoch)this.event(JSON.parse(raw.slice(6)));}}
  if(epoch===this.epoch)throw fail('VOICE_DISCONNECTED');
 }
 event(event){const data=event.data||{};if(data.sessionId&&data.sessionId!==this.sessionId)return;
  if(data.turnId&&this.blockedTurns?.has(data.turnId)&&event.type!=='interrupted')return;
  if(event.type==='ready'){this.ready=true;this.update({phase:this.state.muted?'muted':'listening'});}
  else if(event.type==='messages'){this.clearAudio();this.turn={id:data.turnId,messageId:data.messages.at(-1).id,completed:0,received:0,ended:false};this.update({phase:'thinking',subtitle:data.messages[0].content,proposal:null});}
  else if(event.type==='partial'&&!['speaking','thinking'].includes(this.state.phase))this.update({subtitle:data.text});
  else if(event.type==='echo_ignored')this.setVolume(1);
  else if(event.type==='delta'&&this.turn?.id===data.turnId){this.turn.reply=(this.turn.reply||'')+data.text;this.update({subtitle:this.turn.reply});}
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
  try{const playback=this.media.play({...data,onEnded:()=>{if(this.turn===turn&&!this.blockedTurns.has(turn.id)){turn.completed++;this.finishPlayback();}}});if(turn.received===0)this.timing('first_audio_scheduled',this.clock()+(playback?.scheduledInMs||0));turn.received++;this.update({phase:'speaking'});}catch(e){this.pause(e.code||'VOICE_PLAYBACK_BLOCKED');}
 }
 finishPlayback(){const t=this.turn;if(!t||!t.ended||t.receiptSent||this.media.playing||t.completed!==t.total)return;t.receiptSent=true;const epoch=this.epoch;this.update({phase:this.state.muted?'muted':'listening'});void this.control({type:'receipt',turnId:t.id,messageId:t.messageId,status:'completed',completedSegments:t.completed}).catch(e=>{if(epoch===this.epoch&&this.turn===t)this.pause(e.code);});}
 setVolume(value){this.media.setVolume?.(value);}
 clearAudio(){this.media.clearPlayback();this.speechFrames=0;this.pendingCandidate=null;}
 interrupt(){const t=this.turn;if(!t)return;const epoch=this.epoch;this.blockedTurns.add(t.id);this.clearAudio();this.turn=null;this.update({proposal:null,phase:this.state.muted?'muted':'listening'});void this.control({type:'interrupt'}).catch(e=>{if(epoch===this.epoch)this.pause(e.code);});}
 async mute(){if(this.muting)return;this.muting=true;const value=!this.state.muted,epoch=this.epoch;this.upload=[];this.speechFrames=0;this.pendingCandidate=null;
  try{this.inputEpoch++;if(value){this.update({muted:true,phase:'muted'});await this.media.setMuted(true);if(epoch!==this.epoch)return;await this.control({type:'mute',muted:true});}
   else{await this.media.setMuted(false);if(epoch!==this.epoch)return;await this.control({type:'mute',muted:false});if(epoch===this.epoch)this.update({muted:false,phase:'listening'});}}
  catch(e){if(epoch===this.epoch)this.pause(e.code||'VOICE_MICROPHONE_LOST');}finally{if(epoch===this.epoch)this.muting=false;}}
 async confirm(){const p=this.state.proposal;if(!p)return;const epoch=this.epoch;this.update({confirming:true});try{await this.request(`/sessions/${this.sessionId}/confirm`,{body:{proposalId:p.id,turnId:p.turnId}});if(epoch===this.epoch)this.update({proposal:null,confirming:false});}catch(e){if(epoch===this.epoch)this.update({confirming:false,error:e.code||'VOICE_ACTION_FAILED'});}}
 cancelProposal(){const epoch=this.epoch;this.update({proposal:null});void this.control({type:'cancel_proposal'}).catch(e=>{if(epoch===this.epoch)this.pause(e.code);});}
 pause(code){this.end();this.update({phase:'paused',error:voiceErrorCode(code)||'VOICE_PAUSED',proposal:null});}
 end(){const sessionId=this.sessionId;this.sessionId=null;++this.epoch;this.ready=false;clearInterval(this.heartbeat);this.controller?.abort();this.clearAudio();this.turn=null;this.upload=[];this.media.dispose();this.muting=false;
  if(sessionId)void this.request(`/sessions/${sessionId}/control`,{body:{type:'end'},signal:null,keepalive:true}).catch(()=>{});
 }
}
