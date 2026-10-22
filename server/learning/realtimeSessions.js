import {randomUUID,createHash} from 'node:crypto';
import {learningError,requiredText} from '../../core/learning/contract.js';
import {AudioQueue} from './realtimeSpeech.js';
import {validateLearningAudio} from './speech.js';
const digest=b=>createHash('sha256').update(b).digest('hex');
function wav(parts){const data=Buffer.concat(parts),header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(data.length+36,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(16000,24);header.writeUInt32LE(32000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(data.length,40);return Buffer.concat([header,data]);}
export class LearningRealtimeSessions{
 constructor({service,idleMs=10000,lifetimeMs=150000}){this.service=service;this.entries=new Map();this.idleMs=idleMs;this.lifetimeMs=lifetimeMs;}
 start(owner,id,input,invocation,release){
  const session=this.service.repo(owner,id).require(owner,id),clientTurnId=requiredText(input.clientTurnId,160);
  if(session.status!=='active'||session.revision!==input.revision)throw learningError('LEARNING_REVISION_CONFLICT',409);
  if(this.entries.size>=64||[...this.entries.values()].some(e=>e.owner===owner))throw learningError('LEARNING_BUSY',429);
  if(this.service.repo(owner,id).turns(owner,id).some(t=>t.clientTurnId===clientTurnId))throw learningError('LEARNING_REQUEST_CONFLICT',409);
  const e={owner,id,revision:input.revision,clientTurnId,streamId:randomUUID(),queue:new AudioQueue(),controller:new AbortController(),parts:[],hashes:[],bytes:0,state:'recording',release,created:performance.now()};
  this.entries.set(e.streamId,e);this.touch(e);
  e.lifeTimer=setTimeout(()=>this.abort(e,learningError('SPEECH_TIMEOUT',504)),this.lifetimeMs);e.lifeTimer.unref?.();
  e.invocation={...invocation,ownerId:owner,signal:e.controller.signal};
  e.recognition=Promise.resolve().then(()=>this.service.aiService.router.run({capability:'SPEECH_TO_TEXT',mode:'learning_realtime',language:'en',audioSource:e.queue},e.invocation));
  e.recognition.catch(error=>{e.error=error;if(e.state!=='finishing'){this.abort(e,error);this.cleanup(e);}});
  return{streamId:e.streamId,maxChunkBytes:65536,maxBufferedBytes:256*1024};
 }
 touch(e){clearTimeout(e.idleTimer);e.idleTimer=setTimeout(()=>this.abort(e,learningError('SPEECH_TIMEOUT',504)),this.idleMs);e.idleTimer.unref?.();}
 require(owner,id){const e=this.entries.get(id);if(!e||e.owner!==owner)throw learningError('LEARNING_NOT_FOUND',404);if(e.error)throw e.error;return e;}
 abort(e,error=learningError('LEARNING_CANCELLED',499)){if(e.controller.signal.aborted)return;e.error=error;e.controller.abort(error);e.queue.fail(error);void e.recognition?.catch(()=>{}).finally(()=>{if(e.state!=='finishing')this.cleanup(e);});}
 cleanup(e){if(e.cleaned)return;e.cleaned=true;clearTimeout(e.idleTimer);clearTimeout(e.lifeTimer);e.parts=[];e.queue.parts=[];this.entries.delete(e.streamId);e.release();}
 chunk(owner,id,sequence,bytes){const e=this.require(owner,id);try{
  if(!Number.isInteger(sequence)||sequence<0||!Buffer.isBuffer(bytes)||!bytes.length||bytes.length%2||bytes.length>65536)throw learningError('AUDIO_INVALID');
  const hash=digest(bytes);if(sequence<e.parts.length){if(e.hashes[sequence]!==hash)throw learningError('LEARNING_REQUEST_CONFLICT',409);return{nextSequence:e.parts.length};}
  if(e.state!=='recording')throw learningError('LEARNING_BUSY',409);
  if(sequence!==e.parts.length)throw learningError('LEARNING_REALTIME_SEQUENCE',409);
  if(e.bytes+bytes.length>3840000)throw learningError('AUDIO_TOO_LONG');
  e.queue.push(bytes);e.parts.push(Buffer.from(bytes));e.hashes.push(hash);e.bytes+=bytes.length;this.touch(e);return{nextSequence:e.parts.length};
 }catch(error){this.abort(e,error);throw error;}}
 async finish(owner,id,count,onFeedback,signal){const e=this.require(owner,id);if(e.state!=='recording')throw learningError('LEARNING_BUSY',409);e.state='finishing';const finishStarted=this.service.clock();clearTimeout(e.idleTimer);const abort=()=>this.abort(e);signal?.addEventListener('abort',abort,{once:true});try{
  if(signal?.aborted)abort();e.controller.signal.throwIfAborted();if(!Number.isInteger(count)||count!==e.parts.length)throw learningError('LEARNING_REALTIME_SEQUENCE',409);
  const audio=wav(e.parts);validateLearningAudio(audio);e.queue.end();const recognition=await e.recognition;e.controller.signal.throwIfAborted();
  const transcript=requiredText(recognition.transcript,6000),voiceToken=randomUUID();
  for(const [key,value] of this.service.voiceEvidence)if(value.expires<this.service.now())this.service.voiceEvidence.delete(key);
  if(this.service.voiceEvidence.size>=500)throw learningError('LEARNING_BUSY',429);
  this.service.voiceEvidence.set(voiceToken,{owner,id:e.id,transcript,audioDigest:digest(audio),expires:this.service.now()+600000,turnId:null});
  return await this.service.voiceTurn(owner,e.id,audio,{revision:e.revision,clientTurnId:e.clientTurnId},{...e.invocation,onFeedback,realtimeStarted:finishStarted}, {transcript,voiceToken});
 }catch(error){this.abort(e,error);throw error;}finally{signal?.removeEventListener('abort',abort);await e.recognition.catch(()=>{});await this.service.aiService.router.speechRuntime?.waitForIdle?.();this.cleanup(e);}}
 cancel(owner,id){const e=this.entries.get(id);if(!e)return;if(e.owner!==owner)throw learningError('LEARNING_NOT_FOUND',404);this.abort(e);}
 cancelOwner(owner){for(const e of this.entries.values())if(e.owner===owner)this.abort(e);}
 close(){for(const e of this.entries.values())this.abort(e);}
}
