export async function learningRequest(route='',{method='GET',body,signal,binary=false,keepalive=false,expectedAccountId}={}){
 const audio=body instanceof Blob;
 const response=await fetch(`/api/learning${route}`,{method,credentials:'same-origin',signal,keepalive,headers:{...(body?{'Content-Type':audio?'audio/wav':'application/json'}:{}),...(expectedAccountId?{'X-AI-Expected-Account-Context':expectedAccountId}:{})},body:body?(audio?body:JSON.stringify(body)):undefined});
 if(expectedAccountId && response.ok && response.headers.get('x-ai-account-context')!==expectedAccountId)throw Object.assign(new Error('账号状态已变化，请重新登录。'),{code:'ACCOUNT_CONTEXT_MISMATCH'});
 if(binary&&response.ok){const blob=await response.blob();signal?.throwIfAborted();return blob;}
 const result=await response.json();signal?.throwIfAborted();if(!response.ok||result.ok===false)throw Object.assign(new Error(result.message||'学习暂时无法打开，请重试。'),{code:result.code,status:response.status,recognition:result.recognition});return result;
}
export function learningIntent(text){const value=String(text||'').trim().replace(/[。！!？?]$/,'');return /^(?:我想|我要|帮我)?(?:开始|继续|练习|学|学习|练)(?:一下)?(?:英语|英语口语|口语)$/.test(value)?'practice':/^(?:查看|看看|查询|我的)(?:一下)?(?:英语)?学习进度$/.test(value)?'progress':null;}
