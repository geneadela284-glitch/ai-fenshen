import {useEffect,useRef,useState} from 'react';
import {MahjongRepository,MAHJONG_RUNTIME} from './repository.js';
import './mahjong.css';
import playerDocument from './player/index.html?raw';
const CONTENT_HASH='f19ae4e5bec53c6e30e2c377c28d37e8b6387a6a23e464c261afe4f7755e1319';
export default function MahjongView({ownerId,onBack}){
 const [phase,setPhase]=useState('loading'),[opened,setOpened]=useState(false),[muted,setMuted]=useState(false),[enhanced,setEnhanced]=useState(false),[message,setMessage]=useState('正在读取本机牌局…'),[saved,setSaved]=useState(false);
 const readViewport=()=>{const v=window.visualViewport;return {width:Math.round(v?.width||innerWidth),height:Math.round(v?.height||innerHeight),left:Math.round(v?.offsetLeft||0),top:Math.round(v?.offsetTop||0)};};
 const [viewport,setViewport]=useState(readViewport),[showMessage,setShowMessage]=useState(true);
 const portrait=viewport.width<viewport.height;
 const soundPrefs=useRef({muted,enhanced});soundPrefs.current={muted,enhanced};
 const frame=useRef(null),repo=useRef(null),row=useRef(null),pending=useRef(null),running=useRef(false),alive=useRef(true),release=useRef(null),ready=useRef(false),phaseRef=useRef(phase);
 phaseRef.current=phase;
 const channel=useRef(crypto.randomUUID()).current;
 const base=import.meta.env.VITE_AI_FENSHEN_MAHJONG_PLAYER_URL||'/mahjong/player.html';
 const url=new URL(base,location.href);url.searchParams.set('channel',channel);url.searchParams.set('parentOrigin',location.origin);
 const origin=url.origin;
 const embedded=origin===location.origin;
 const scriptUrl=new URL('./runtime.js',url);scriptUrl.search=url.search;
 const frameDocument=embedded?playerDocument.replace('src="/host/runtime.js"','src="'+scriptUrl.href.replaceAll('&','&amp;')+'"'):undefined;
 const send=(type,data={})=>frame.current?.contentWindow?.postMessage({mahjong:channel,type,...data},origin);
 const save=(pause=false)=>{
  if(!running.current)return Promise.resolve();if(pending.current){if(pause)send('save',{pause:true});return pending.current.promise;}
  let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});const timer=setTimeout(()=>{pending.current=null;setMessage('保存没有完成，已有存档仍保留，请重试。');setPhase('running');reject(Error('保存超时'));},15000);
  pending.current={promise,resolve,reject,timer};setPhase('saving');send('save',{pause});return promise;
 };
 useEffect(()=>{
  alive.current=true;const repository=new MahjongRepository(ownerId);repo.current=repository;let cancelled=false;
  (async()=>{try{
   if(!navigator.locks)throw Error('当前浏览器暂不能保护多页面牌局，请稍后重试。');
   let lockReady;const acquired=new Promise(r=>{lockReady=r;});
   navigator.locks.request('ai-fenshen-mahjong:'+ownerId,{ifAvailable:true},async lock=>{if(!lock){lockReady(false);return;}lockReady(true);await new Promise(r=>{release.current=r;if(cancelled)r();});}).catch(()=>lockReady(false));
   if(!await acquired)throw Error('麻将已在另一个页面打开，请先退出那边的牌桌。');
   const current=await repository.read();if(cancelled)return;
   if(current.snapshot&&current.snapshot.contentHash!==CONTENT_HASH)throw Error('本机牌局与当前游戏版本不一致，原存档已保留。');
   row.current=current;ready.current=true;setSaved(!!current.snapshot);setPhase('ready');setMessage(current.snapshot?'上次牌局已保存在本机。':'熟悉的牌桌，原来的玩法与声音。');
  }catch(error){if(!cancelled){setPhase('error');setMessage(error.message);}}})();
  const onMessage=async event=>{
   if(event.source!==frame.current?.contentWindow||event.origin!==origin||event.data?.mahjong!==channel)return;
   const data=event.data;
   if(data.type==='ready'&&ready.current){send('init',{state:row.current?.snapshot?.state,muted:soundPrefs.current.muted,enhanced:soundPrefs.current.enhanced});return;}
   if(data.type==='running'){running.current=true;setPhase('running');setMessage(data.restored?'已恢复上次牌局。':'上分 → 押注 → 开始。点选手牌，再点一次或按出牌。');return;}
   if(data.type==='audioBlocked'){setMessage('轻触画面，开启原版声音。');return;}
   if(data.type==='error'){running.current=false;setPhase('error');setMessage('牌桌未能继续运行，已有存档保留。'+data.message);return;}
   if(data.type==='saveError'){setMessage(data.message);setPhase('running');if(pending.current){clearTimeout(pending.current.timer);pending.current.reject(Error(data.message));pending.current=null;}return;}
   if(data.type==='snapshot'){
    try{const next=await repository.save({runtime:MAHJONG_RUNTIME,contentHash:CONTENT_HASH,state:data.state},row.current.revision);row.current=next;if(cancelled)return;setSaved(true);setMessage('牌局已保存在本机。');setPhase('running');if(pending.current){clearTimeout(pending.current.timer);pending.current.resolve();pending.current=null;}}
    catch(error){if(cancelled)return;setMessage(error.message);setPhase('running');if(pending.current){clearTimeout(pending.current.timer);pending.current.reject(error);pending.current=null;}}
   }
  };
  addEventListener('message',onMessage);
  const tick=setInterval(()=>{if(running.current&&!document.hidden&&!pending.current)save().catch(()=>{});},30000);
  const visibility=()=>{if(document.hidden&&running.current)save(true).catch(()=>{});else send('resume');};document.addEventListener('visibilitychange',visibility);
  return()=>{cancelled=true;alive.current=false;send('close');running.current=false;ready.current=false;clearInterval(tick);removeEventListener('message',onMessage);document.removeEventListener('visibilitychange',visibility);if(pending.current){clearTimeout(pending.current.timer);pending.current.resolve();pending.current=null;}repository.close();release.current?.();};
 },[ownerId]);
 useEffect(()=>{let timer;const change=()=>{clearTimeout(timer);timer=setTimeout(()=>setViewport(readViewport()),120);};const v=window.visualViewport;addEventListener('resize',change);v?.addEventListener('resize',change);v?.addEventListener('scroll',change);return()=>{clearTimeout(timer);removeEventListener('resize',change);v?.removeEventListener('resize',change);v?.removeEventListener('scroll',change);};},[]);
 useEffect(()=>{setShowMessage(true);if(phase!=='running')return;const t=setTimeout(()=>setShowMessage(false),2500);return()=>clearTimeout(t);},[message,phase]);
 useEffect(()=>{send('sound',{muted,enhanced});},[muted,enhanced]);
 useEffect(()=>{const handle=event=>{if(phaseRef.current!=='running'||event.repeat||event.metaKey||event.ctrlKey||event.altKey||event.shiftKey)return;const letter=/^Key([A-N])$/.exec(event.code);const code=letter?letter[1].charCodeAt(0)-65+4:{KeyQ:20,KeyZ:29,Digit1:30,Digit3:32,Enter:40,Backspace:42,Space:44}[event.code];if(code){event.preventDefault();send('key',{code});}};addEventListener('keydown',handle);return()=>removeEventListener('keydown',handle);},[]);
 const leave=async()=>{try{await save(true);send('close');try{screen.orientation?.unlock?.();}catch{}if(document.fullscreenElement)await document.exitFullscreen?.().catch(()=>{});onBack();}catch{}};
 return <div className={`mj-viewport ${portrait?'mj-portrait':''}`} style={{left:viewport.left,top:viewport.top,width:viewport.width,height:viewport.height}}>
  <div className="mj-machine" style={{width:portrait?viewport.height:viewport.width,height:portrait?viewport.width:viewport.height,transform:`translate(-50%, -50%) rotate(${portrait?90:0}deg)`}}><div className="mj-game-surface">
  <button className="mj-back" onClick={leave} aria-label="返回游戏目录">‹</button>
  <div className="mj-screen">
   {opened?<iframe ref={frame} title="龙虎争霸2原版牌桌" src={embedded?undefined:url.href} srcDoc={frameDocument} allow="autoplay; fullscreen"/>:<div className="mj-cover"><h2>龙虎争霸 Ⅱ</h2><p>原版画面 · 原版声音 · 手机横屏</p><button disabled={phase!=='ready'} onClick={()=>{setOpened(true);setPhase('loading');setMessage('正在启动原版牌桌…');}}>{phase==='loading'?'准备中…':saved?'继续牌局':'进入牌桌'}<span>↗</span></button></div>}
  </div>
  {showMessage&&<p className={`mj-message ${phase==='error'?'is-error':''}`} role="status">{message}</p>}
  </div></div>
 </div>;
}
