import {randomUUID} from 'node:crypto';
import {learningError} from '../../core/learning/contract.js';
export async function handleLearningRealtime({req,res,route,user,subject,runtime,accessControl,readJson,send,emit,signal}){
 const start=route.match(/^\/sessions\/([^/]+)\/realtime$/),active=route.match(/^\/realtime\/([^/]+)\/(chunk|finish|cancel)$/);
 if(!start&&!active)return false;
 if(!runtime.realtime)throw learningError('LEARNING_DISABLED',503);
 if(req.method!=='POST')throw learningError('LEARNING_INPUT_INVALID');
 if(req.headers['x-ai-expected-account-context']!==user.id)throw learningError('ACCOUNT_CONTEXT_MISMATCH',403);
 if(req.headers.origin){let origin;try{origin=new URL(req.headers.origin);}catch{throw learningError('ACCOUNT_CONTEXT_MISMATCH',403);}if(!['http:','https:'].includes(origin.protocol)||origin.host!==req.headers.host)throw learningError('ACCOUNT_CONTEXT_MISMATCH',403);}
 if(start){const input=await readJson(req);const lease=accessControl.beginRequest({subject,requestId:`learning_${randomUUID()}`});let transferred=false;try{const result=runtime.realtime.start(user.id,decodeURIComponent(start[1]),input,{subject,requestLease:lease},()=>accessControl.releaseRequest(lease));transferred=true;send(result,201);}finally{if(!transferred)accessControl.releaseRequest(lease);}return true;}
 const [,id,action]=active;
 if(action==='cancel'){runtime.realtime.cancel(user.id,id);send({cancelled:true});return true;}
 if(action==='chunk'){
  runtime.realtime.require(user.id,id);
  if(req.headers['content-type']!=='application/octet-stream')throw learningError('AUDIO_INVALID');
  const chunks=[];let size=0;for await(const part of req){size+=part.length;if(size>65536){runtime.realtime.cancel(user.id,id);throw learningError('AUDIO_TOO_LONG');}chunks.push(part);}
  const sequence=new URL(req.url,'http://localhost').searchParams.get('sequence');if(!/^\d+$/.test(sequence||''))throw learningError('LEARNING_REALTIME_SEQUENCE',409);
  send(runtime.realtime.chunk(user.id,id,Number(sequence),Buffer.concat(chunks)));return true;
 }
 const input=await readJson(req);
 const result=await runtime.realtime.finish(user.id,id,input.count,data=>emit('feedback',data),signal);
 const{result:stored,...audio}=result;emit('audio',audio);res.end();return true;
}
