const messages={VOICE_ALREADY_ACTIVE:'你的账号已有语音聊天，请先结束另一处通话。',VOICE_BUSY:'语音服务正在忙，请稍后再试。',VOICE_DAILY_LIMIT:'今天的语音时长已用完，可以继续文字聊天。',VOICE_CONFIRMATION_EXPIRED:'这条确认已失效，请重新说明。',VOICE_SESSION_NOT_FOUND:'语音已结束，请重新开始。',VOICE_UNAVAILABLE:'语音聊天暂时不可用，请使用文字。'};
export async function handleVoiceChatApi({req,res,url,session,runtime,sendJson,readJson}) {
 if(!url.pathname.startsWith('/api/voice/chat'))return false;
 const user=session?.user;
 if(!user||!session.subject){sendJson(res,401,{ok:false,code:'UNAUTHENTICATED',message:'请先登录。'});return true;}
 const headers={'Cache-Control':'private, no-store',Vary:'Cookie','X-AI-Account-Context':user.id};
 const json=(status,body)=>sendJson(res,status,body,headers);
 if(!runtime?.enabled){json(503,{ok:false,code:'VOICE_UNAVAILABLE',message:messages.VOICE_UNAVAILABLE});return true;}
 try{
  const origin=req.headers.origin,host=req.headers.host;
  if((origin&&(!['http:','https:'].includes(new URL(origin).protocol)||new URL(origin).host!==host))||['cross-site','same-site'].includes(req.headers['sec-fetch-site'])||req.headers['x-ai-expected-account-context']!==user.id)throw Object.assign(new Error('VOICE_ACCOUNT_MISMATCH'),{code:'VOICE_ACCOUNT_MISMATCH'});
  if(url.pathname==='/api/voice/chat/sessions'&&req.method==='POST'){
   const body=await readJson(req);if(body.consent!==true)throw Object.assign(new Error('VOICE_CONSENT_REQUIRED'),{code:'VOICE_CONSENT_REQUIRED'});
   const result=runtime.create({user,subject:session.subject,conversationId:body.conversationId,timezone:body.timezone,mediaProtocol:body.mediaProtocol,interruptionVersion:body.interruptionVersion,clientContextVersion:body.clientContextVersion});json(201,{ok:true,...result});return true;
  }
  const match=url.pathname.match(/^\/api\/voice\/chat\/sessions\/([a-f0-9-]{36})\/(events|audio|control|confirm)$/);
  if(!match){json(404,{ok:false});return true;}const[,id,action]=match;
  if(action==='events'&&req.method==='GET'){
   let subscribed=false,detach,pulse;
   const active=runtime.sessions?.get(id),lowLatency=active?.ownerId===user.id&&active.coreOptions.lowLatency;
   // WebKit can withhold a fetch chunk until the next network write (bug 322545).
   // One coalesced SSE comment per burst releases it without inventing an event,
   // changing lease heartbeats, or running a permanent high-frequency timer.
   const listener=event=>{if(res.writableEnded||res.destroyed)return;if(!subscribed){res.writeHead(200,{...headers,'Content-Type':'text/event-stream;charset=utf-8','X-Accel-Buffering':'no'});res.flushHeaders?.();subscribed=true;}if(res.writableLength>256000)throw Object.assign(new Error('VOICE_BACKPRESSURE'),{code:'VOICE_BACKPRESSURE'});res.write(`data: ${JSON.stringify(event)}\n\n`);
    if(lowLatency&&!pulse)pulse=setTimeout(()=>{pulse=null;if(res.writableEnded||res.destroyed)return;if(res.writableLength>256000){detach?.();return;}try{res.write(': flush\n\n');}catch{detach?.();}},20);
   };
   detach=runtime.subscribe(id,user.id,listener,()=>{clearTimeout(pulse);res.end();});listener({type:'connected',data:{sessionId:id}});res.on('close',()=>{clearTimeout(pulse);detach?.();});return true;
  }
  if(action==='audio'&&req.method==='POST'){
   if(String(req.headers['content-type']||'').split(';')[0]!=='application/octet-stream')throw Object.assign(new Error('VOICE_AUDIO_INVALID'),{code:'VOICE_AUDIO_INVALID'});
   const chunks=[];let n=0;for await(const c of req){n+=c.length;if(n>32000)throw Object.assign(new Error('VOICE_AUDIO_INVALID'),{code:'VOICE_AUDIO_INVALID'});chunks.push(c);}
   runtime.audio(id,user.id,Buffer.concat(chunks),Number(req.headers['x-voice-sequence']),Number(req.headers['x-voice-input-epoch']));json(200,{ok:true});return true;
  }
  if(['control','confirm'].includes(action)&&req.method==='POST'){
   const body=await readJson(req);json(200,await(action==='confirm'?runtime.confirm(id,user.id,body):runtime.control(id,user.id,body)));return true;
  }
  json(405,{ok:false});
 }catch(e){const code=e.code||'VOICE_FAILED';if(res.headersSent){res.end();return true;}json(code==='VOICE_ACCOUNT_MISMATCH'?403:code==='VOICE_SESSION_NOT_FOUND'?404:code.includes('LIMIT')||code==='VOICE_BUSY'?429:400,{ok:false,code,message:messages[code]||'语音没有完成，请结束后重试。'});}
 return true;
}
