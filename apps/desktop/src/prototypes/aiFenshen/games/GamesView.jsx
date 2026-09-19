import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import PokerView from './PokerView.jsx';
import MahjongView from '../mahjong/MahjongView.jsx';
const mahjongEnabled=import.meta.env.VITE_AI_FENSHEN_MAHJONG_ENABLED==='true';
import { PokerAudio } from './audio.js';
import './games.css';
export default function GamesView({ownerId,onBack,initialGame='lobby'}) {
  const [selected,setSelected]=useState(initialGame==='poker'?'poker':initialGame==='mahjong'&&mahjongEnabled?'mahjong':null);
  const sound=useRef(null);
  const [audioUnavailable,setAudioUnavailable]=useState(false);
  const audio=()=>{if(!sound.current||sound.current.closed)sound.current=new PokerAudio({onUnavailable:()=>setAudioUnavailable(true)});return sound.current;};
  useEffect(()=>{for(const name of ['dragon-joker-v1','black-dragon-joker-v1']){const dragon=new Image();dragon.src=`/images/poker/${name}.png`;}return()=>sound.current?.close();},[]);
  const enterMahjong=()=>{setSelected('mahjong');try{const full=document.documentElement.requestFullscreen?.();Promise.resolve(full).then(()=>screen.orientation?.lock?.('landscape')).catch(()=>{});}catch{}};
  const leave=()=>{sound.current?.stop();setSelected(null);};
  return createPortal(<section className={`af-games ${selected?'is-playing':''} ${selected==='mahjong'?'is-mahjong':''}`} aria-label="游戏">
    {selected==='mahjong'?<MahjongView ownerId={ownerId} onBack={leave}/>:selected?<PokerView ownerId={ownerId} onBack={leave} getAudio={audio} audioUnavailable={audioUnavailable} onAudioReady={()=>setAudioUnavailable(false)}/>:<div className="pg-lobby">
      <header className="pg-lobby-top"><button type="button" className="pg-back" onClick={onBack} aria-label="返回首页">‹</button><span>AI分身 <i>/</i> 游戏</span><small>轻松片刻</small></header>
      <div className="pg-lobby-heading"><span className="pg-eyebrow">A LITTLE BREAK</span><h1>熟悉的快乐，<br/>再玩一局。</h1><p>经典的玩法，记忆里的声音。</p></div>
      <div className="pg-lobby-games"><button className="pg-game-tile" type="button" onClick={()=>setSelected('poker')}><div className="pg-mini-cards" aria-hidden="true"><i>A<span>♠</span></i><i>K<span>♥</span></i><i>Q<span>♠</span></i></div><div><small>经典街机 · 免费积分</small><h2>老虎扑克机</h2><p>五张牌，一次换牌。<br/>留住好牌，听见好运。</p><strong>开始游戏 <span>↗</span></strong></div></button>
      {mahjongEnabled?<button className="pg-game-tile pg-mahjong-entry" type="button" onClick={enterMahjong}><div className="pg-mini-cards pg-mini-mahjong" aria-hidden="true"><i className="pg-dragon-red">中</i><i className="pg-dragon-green">發</i><i className="pg-dragon-white"><span className="pg-white-board"/></i></div><div><small>经典麻将 · 原版玩法</small><h2>龙虎争霸 Ⅱ</h2><p>熟悉的牌桌，原来的声音。<br/>手机横屏，轻触开局。</p><strong>开始游戏 <span>↗</span></strong></div></button>:<div className="pg-coming"><span className="pg-mahjong" aria-hidden="true">發</span><div><h2>龙虎争霸麻将</h2><p>经典麻将，稍后见。</p></div><small>稍后推出</small></div>}
      </div><footer>进度仅保存在本机</footer>
    </div>}
  </section>, document.body);
}
