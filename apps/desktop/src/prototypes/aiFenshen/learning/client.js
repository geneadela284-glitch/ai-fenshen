export async function learningRequest(route='',{method='GET',body,signal,binary=false,keepalive=false,expectedAccountId,onFeedback,contentType}={}){
 const audio=body instanceof Blob;
 const response=await fetch(`/api/learning${route}`,{method,credentials:'same-origin',signal,keepalive,headers:{...(body?{'Content-Type':contentType||(audio?'audio/wav':'application/json')}:{}),...(expectedAccountId?{'X-AI-Expected-Account-Context':expectedAccountId}:{})},body:body?(audio?body:JSON.stringify(body)):undefined});
 if(expectedAccountId && response.ok && response.headers.get('x-ai-account-context')!==expectedAccountId)throw Object.assign(new Error('账号状态已变化，请重新登录。'),{code:'ACCOUNT_CONTEXT_MISMATCH'});
 if(response.ok&&response.headers.get('content-type')?.includes('application/x-ndjson')){
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',feedback=null,complete=null;
  try{for(;;){signal?.throwIfAborted();const {value,done}=await reader.read();buffer+=decoder.decode(value,{stream:!done});
    if(buffer.length>16*1024*1024)throw new Error('学习回复过大，请重新打开练习。');
    let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;const event=JSON.parse(line);signal?.throwIfAborted();
      if(event.type==='feedback'&&!feedback){feedback=event;onFeedback?.(event);}
      else if(event.type==='audio'&&feedback&&!complete)complete={...event,result:feedback.result};
      else if(event.type==='error')throw Object.assign(new Error(event.message),{code:event.code});
      else throw new Error('学习回复顺序异常，请重新打开练习。');
    }
    if(done)break;
  }
  if(!complete||buffer.trim())throw new Error('声音传输中断，已出现的反馈保留。可以点“听一遍”重试。');
  return complete;
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 }
 if(binary&&response.ok){const blob=await response.blob();signal?.throwIfAborted();return blob;}
 const result=await response.json();signal?.throwIfAborted();if(!response.ok||result.ok===false)throw Object.assign(new Error(result.message||'学习暂时无法打开，请重试。'),{code:result.code,status:response.status,recognition:result.recognition});return result;
}
export function learningIntent(text){const value=String(text||'').trim().replace(/[。！!？?]$/,'');return /^(?:我想|我要|帮我)?(?:开始|继续|练习|学|学习|练)(?:一下)?(?:英语|英语口语|口语)$/.test(value)?'practice':/^(?:查看|看看|查询|我的)(?:一下)?(?:英语)?学习进度$/.test(value)?'progress':null;}
