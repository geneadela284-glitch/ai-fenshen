import {useEffect,useRef,useState} from 'react';
import {OriginalPokerRepository,POKER_RUNTIME,POKER_CONTENT_HASH} from './originalRepository.js';
import documentSource from '../../../../public/poker/w90-v1/index.html?raw';
import './original-poker.css';
const ROOT='/poker/w90-v1/';
export default function PokerView({ownerId,onBack}){
 return <OriginalPokerSession key={ownerId} ownerId={ownerId} onBack={onBack}/>;
}
function OriginalPokerSession({ownerId,onBack}){
 const frame=useRef(null),row=useRef(null),repo=useRef(null),lockRelease=useRef(null),running=useRef(false),leaving=useRef(false),pending=useRef(null);
 const [ready,setReady]=useState(false),[message,setMessage]=useState('正在读取本机牌局…');
 const channel=useRef(crypto.randomUUID()).current,origin=location.origin;
 const script=new URL(ROOT+'runtime.js',location.href);script.searchParams.set('channel',channel);script.searchParams.set('parentOrigin',origin);
 const frameDocument=documentSource.replace('src="./runtime.js"','src="'+script.href.replaceAll('&','&amp;')+'"');
 const send=(type,data={})=>frame.current?.contentWindow?.postMessage({poker:channel,type,...data},origin);
 const sendViewport=()=>{
  const s=getComputedStyle(document.getElementById('pg-safe-insets'));
  send('viewport',{insets:[s.paddingTop,s.paddingRight,s.paddingBottom,s.paddingLeft].map(parseFloat)});
 };
 const saveForLeave=()=>{
  if(!running.current)return Promise.resolve();if(pending.current)return pending.current.promise;
  let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});
  const requestId=crypto.randomUUID(),timer=setTimeout(()=>{pending.current=null;reject(Error('保存未完成，仍停留在牌桌，请重试返回。'));},12000);
  pending.current={requestId,promise,resolve,reject,timer};send('save',{requestId,pause:true});return promise;
 };
 const leave=async()=>{if(leaving.current)return;leaving.current=true;try{await saveForLeave();send('close');onBack();}catch(error){setMessage(error.message);leaving.current=false;}};
 useEffect(()=>{
  let cancelled=false,playerReady=false;const repository=new OriginalPokerRepository(ownerId);repo.current=repository;
  const init=()=>{if(!cancelled&&playerReady&&row.current){send('init',{state:row.current.snapshot?.state});sendViewport();}};
  (async()=>{try{
   if(!navigator.locks)throw Error('当前环境不能保护重复打开的牌局，请稍后重试。');
   let signal;const acquired=new Promise(r=>{signal=r;});
   navigator.locks.request('ai-fenshen-poker-original:'+ownerId,{ifAvailable:true},async lock=>{if(!lock){signal(false);return;}signal(true);await new Promise(r=>{lockRelease.current=r;if(cancelled)r();});}).catch(()=>signal(false));
   if(!await acquired)throw Error('扑克已在另一个页面打开，请先返回那边的游戏目录。');
   const current=await repository.read();if(cancelled)return;row.current=current;setReady(true);setMessage('');init();
  }catch(error){if(!cancelled)setMessage(error.message);}})();
  let writes=Promise.resolve();
  const onMessage=event=>{
   if(event.source!==frame.current?.contentWindow||event.origin!==origin||event.data?.poker!==channel)return;
   const d=event.data;
   if(d.type==='ready'){playerReady=true;init();}
   if(d.type==='running'){running.current=true;setMessage('');if(document.hidden)send('pause');}
   if(d.type==='leave')leave();
   if(d.type==='snapshot'){
    writes=writes.then(async()=>{if(cancelled)return;try{const next=await repository.save({runtime:POKER_RUNTIME,contentHash:POKER_CONTENT_HASH,state:d.state},row.current.revision);if(cancelled)return;row.current=next;send('ack',{requestId:d.requestId});}catch(error){if(!cancelled){send('ack',{requestId:d.requestId,error:error.message});setMessage(error.message);}}});
   }
   if(d.type==='saved'||d.type==='saveError'){
    const p=pending.current;if(p&&p.requestId===d.requestId){clearTimeout(p.timer);pending.current=null;d.type==='saved'?p.resolve():p.reject(Error(d.message));}
   }
   if(d.type==='error')setMessage('已有存档保留。'+d.message);
  };
  addEventListener('message',onMessage);
  const tick=setInterval(()=>{if(running.current&&!document.hidden&&!pending.current)send('save',{requestId:'periodic',pause:false});},30000);
  const visibility=()=>{if(running.current)send(document.hidden?'pause':'resume');};document.addEventListener('visibilitychange',visibility);
  addEventListener('resize',sendViewport);window.visualViewport?.addEventListener('resize',sendViewport);
  return()=>{cancelled=true;send('close');running.current=false;row.current=null;clearInterval(tick);removeEventListener('message',onMessage);document.removeEventListener('visibilitychange',visibility);removeEventListener('resize',sendViewport);window.visualViewport?.removeEventListener('resize',sendViewport);if(pending.current){clearTimeout(pending.current.timer);pending.current.resolve();pending.current=null;}writes.finally(()=>{repository.close();lockRelease.current?.();});};
 },[ownerId]);
 return <div className="pg-original-viewport"><div id="pg-safe-insets" aria-hidden="true"/>{ready?<iframe ref={frame} title="怀旧原版扑克机" srcDoc={frameDocument} allow="autoplay; fullscreen"/>:<div className="pg-original-cover"><p role="status">{message}</p><button onClick={onBack}>返回游戏目录</button></div>}{ready&&message&&<p className="pg-original-error" role="alert">{message}</p>}</div>;
}
