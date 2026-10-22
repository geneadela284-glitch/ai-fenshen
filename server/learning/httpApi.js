import {handleLearningRealtime} from './realtimeHttp.js';
import { randomUUID } from 'node:crypto';
import { learningError } from '../../core/learning/contract.js';
import { PUBLIC_MESSAGES } from '../access/accessErrors.js';
export const LEARNING_MESSAGES={
 ...PUBLIC_MESSAGES,
 LEARNING_REALTIME_BACKPRESSURE:'网络传输跟不上录音，本次已停止。录音保留，可以手动重试。',LEARNING_REALTIME_SEQUENCE:'录音传输不完整，本次未计入进度。请重试。',LEARNING_REALTIME_INTERRUPTED:'识别连接中断，本次未计入进度。请重试。',LEARNING_REALTIME_CLOSED:'这次实时录音已结束，请重新开始。',
 LEARNING_DISABLED:'学习功能暂未开放。',LEARNING_CORRECTION_CONFLICT:'只能更正最新一轮口语，请重新打开本次练习。',LEARNING_NOT_FOUND:'这次练习不存在或已经清除。',LEARNING_CONSENT_REQUIRED:'请先确认本次学习的数据处理方式。',LEARNING_REVISION_CONFLICT:'练习已在别处更新，请重新打开后继续。',LEARNING_BUSY:'上一轮还在处理，请稍候。',LEARNING_SPEECH_BUSY:'语音正在处理，请稍后再试。',LEARNING_SPEECH_UNAVAILABLE:'语音服务暂时不可用，录音没有提交成功。',LEARNING_TEACHER_UNAVAILABLE:'陪练暂时没有回应，已保留你的输入，可以重试。',AUDIO_SILENT:'没有听到有效声音，请靠近麦克风再说一次。',AUDIO_INVALID:'这段录音无效，请重新录制。',AUDIO_TOO_LONG:'每次最多说两分钟，请分段练习。',SPEECH_TIMEOUT:'语音处理超时，请重试。',TEACHER_REPLY_INVALID:'这次反馈未通过检查，请重试，本轮未计入进度。',FEEDBACK_SOURCE_INVALID:'这次纠错未能对应你的原话，本轮未计入进度。',LEARNING_GOAL_NOT_REACHED:'还没有完成本次目标，可以继续练习或提前结束。',LEARNING_CANCELLED:'已取消本次处理。',CANCELLED:'已取消本次处理。',LEARNING_TURN_LIMIT:'本次已练习40轮，可以结束后开始新的练习。'
};
export async function handleLearningApi({req,res,url,user,subject,runtime,accessControl,readJson,sendJson}){
 if(!url.pathname.startsWith('/api/learning'))return false;
 if(!user){sendJson(res,401,{ok:false,message:'请先登录。'});return true;}
 const expected=String(req.headers['x-ai-expected-account-context']||'');
 try{const actor=accessControl.assertAuthenticatedSubject(subject);if(actor.accountId!==user.id||(expected&&expected!==user.id))throw Error('ACCOUNT_CONTEXT_MISMATCH');}
 catch{sendJson(res,403,{ok:false,code:'ACCOUNT_CONTEXT_MISMATCH',message:'账号状态已变化，请重新登录。'});return true;}
 res.setHeader('X-AI-Account-Context',user.id);res.setHeader('Vary','Cookie');
 const route=url.pathname.slice('/api/learning'.length);
 const send=(data,status=200)=>sendJson(res,status,{ok:true,...data},{'Cache-Control':'no-store'});
 if(route==='/capabilities'&&req.method==='GET'){send({enabled:runtime?.enabled===true,realtimeAvailable:!!runtime?.realtime,speechAvailable:runtime?.service.aiService?.router?.speechRuntime?.available===true});return true;}
 const lifecycle=route==='/export'||(req.method==='DELETE'&&/^\/sessions\/[^/]+$/.test(route));
 if(!runtime||(!runtime.enabled&&!lifecycle)){sendJson(res,503,{ok:false,code:'LEARNING_DISABLED',message:LEARNING_MESSAGES.LEARNING_DISABLED});return true;}
 let streamed=false;
 const emit=(type,data)=>{if(res.destroyed)return;if(!streamed){res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'});streamed=true;}res.write(JSON.stringify({type,...data})+'\n');};
 let lease=null;const controller=new AbortController();runtime.requests.set(controller,user.id);
 const onClose=()=>{if(!res.writableEnded)controller.abort();};res.on('close',onClose);
 const service=runtime.service;
 try{
  if(await handleLearningRealtime({req,res,route,user,subject,runtime,accessControl,readJson,send,emit,signal:controller.signal}))return true;
  if(route===''&&req.method==='GET'){send(service.dashboard(user.id));return true;}
  if(route==='/export'&&req.method==='GET'){send({data:service.export(user.id)});return true;}
  if(route==='/sessions'&&req.method==='POST'){const input=await readJson(req);if(service.repository.list(user.id).length>=1000)throw learningError('LEARNING_STORAGE_LIMIT',409);send(service.start(user.id,input),201);return true;}
  const match=route.match(/^\/sessions\/([^/]+)(?:\/(turn|voice-turn|transcribe|speak|hint|action))?$/);
  if(!match){sendJson(res,404,{ok:false,message:'学习入口不存在。'});return true;}
  const id=decodeURIComponent(match[1]),action=match[2];
  if(!action&&req.method==='GET'){send(service.view(user.id,id));return true;}
  if(!action&&req.method==='DELETE'){const input=await readJson(req);send(service.action(user.id,id,{...input,action:'delete'}));return true;}
  if(req.method!=='POST')throw learningError('LEARNING_INPUT_INVALID');
  if(action==='hint'){send(service.hint(user.id,id));return true;}
  if(action==='action'){send(service.action(user.id,id,await readJson(req)));return true;}
  // All external learning computation uses the existing authenticated quota lease.
  lease=accessControl.beginRequest({subject,requestId:`learning_${randomUUID()}`});
  const invocation={subject,requestLease:lease,signal:controller.signal};
  if(action==='transcribe'||action==='voice-turn'){
    if(!String(req.headers['content-type']||'').startsWith('audio/wav'))throw learningError('AUDIO_INVALID');
    const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>8*1024*1024)throw learningError('AUDIO_TOO_LONG');chunks.push(chunk);}
    const audio=Buffer.concat(chunks);
    if(action==='voice-turn'){
      const stream=url.searchParams.get('stream')==='1';
      if(stream)invocation.onFeedback=data=>emit('feedback',data);
      const result=await service.voiceTurn(user.id,id,audio,{revision:Number(url.searchParams.get('revision')),clientTurnId:url.searchParams.get('clientTurnId')},invocation);
      if(stream){const {result:alreadySent,...speech}=result;emit('audio',speech);res.end();}else send(result);
    }
    else send(await service.transcribe(user.id,id,audio,invocation));return true;
  }
  const input=await readJson(req);
  if(action==='turn'){send(await service.turn(user.id,id,input,invocation));return true;}
  if(action==='speak'){const result=await service.speak(user.id,id,input,invocation);res.writeHead(200,{'Content-Type':result.contentType,'Content-Length':result.audio.length,'Cache-Control':'no-store'});res.end(result.audio);return true;}
  throw learningError('LEARNING_INPUT_INVALID');
 }catch(error){if(streamed){if(!res.destroyed&&!res.writableEnded){emit('error',{code:error.code||'LEARNING_UNAVAILABLE',message:LEARNING_MESSAGES[error.code]||'这次操作没有完成，请稍后重试。'});res.end();}return true;}if(!res.destroyed&&!res.writableEnded)sendJson(res,error.status||500,{ok:false,code:error.code||'LEARNING_UNAVAILABLE',message:LEARNING_MESSAGES[error.code]||'这次操作没有完成，请稍后重试。',...(error.recognition?{recognition:error.recognition}:{})});return true;}
 finally{if(lease)accessControl.releaseRequest(lease);runtime.requests.delete(controller);res.off('close',onClose);}
}
