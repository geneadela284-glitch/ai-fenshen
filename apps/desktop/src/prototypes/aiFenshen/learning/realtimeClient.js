export function createRealtimeUpload({api,sessionId,revision,clientTurnId,onError=()=>{}}){
 let streamId=null,cancelled=false,finishing=false,error=null,buffer=[],queued=0,sequence=0,chain=Promise.resolve();
 const cancelledError=()=>new DOMException('已取消','AbortError');
 const cancelRemote=()=>{if(streamId)void api(`/realtime/${streamId}/cancel`,{method:'POST',body:{},keepalive:true}).catch(()=>{});};
 const failed=e=>{if(!error){error=e;if(!cancelled)onError(e);}cancelRemote();};
 // Do not abort the start HTTP response: a late returned id must be explicitly cancelled.
 const start=api(`/sessions/${sessionId}/realtime`,{method:'POST',body:{revision,clientTurnId}}).then(result=>{streamId=result.streamId;if(cancelled||error)cancelRemote();return streamId;});
 start.catch(failed);
 const flush=()=>{if(!buffer.length)return;const parts=buffer;buffer=[];const size=parts.reduce((n,p)=>n+p.length,0);const bytes=new Uint8Array(size);let at=0;for(const p of parts){bytes.set(p,at);at+=p.length;}
  chain=chain.then(async()=>{await start;if(cancelled)throw cancelledError();if(error)throw error;for(let i=0;i<bytes.length;i+=32768){if(cancelled)throw cancelledError();if(error)throw error;const piece=bytes.slice(i,i+32768);await api(`/realtime/${streamId}/chunk?sequence=${sequence}`,{method:'POST',body:new Blob([piece],{type:'application/octet-stream'}),contentType:'application/octet-stream'});sequence++;queued-=piece.length;}}).catch(e=>{failed(e);});
 };
 return{push(bytes){if(cancelled||finishing)throw cancelledError();if(error)throw error;if(queued+bytes.length>256*1024){const e=Error('网络传输跟不上录音，录音保留，可以手动重试。');failed(e);throw e;}queued+=bytes.length;buffer.push(new Uint8Array(bytes));if(buffer.reduce((n,p)=>n+p.length,0)>=8000)flush();},cancel(){if(cancelled)return;cancelled=true;buffer=[];cancelRemote();},async finish(options={}){if(cancelled)throw cancelledError();if(finishing)throw Error('本轮正在处理，请稍候。');finishing=true;const abort=()=>{cancelled=true;cancelRemote();};options.signal?.addEventListener('abort',abort,{once:true});try{if(options.signal?.aborted)abort();options.signal?.throwIfAborted();flush();await start;await chain;if(cancelled)throw cancelledError();if(error)throw error;return await api(`/realtime/${streamId}/finish`,{...options,method:'POST',body:{count:sequence}});}catch(e){cancelRemote();throw e;}finally{options.signal?.removeEventListener('abort',abort);}}};
}
