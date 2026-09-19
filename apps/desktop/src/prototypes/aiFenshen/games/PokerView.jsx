import { useEffect, useRef, useState } from 'react';
import { PokerRepository } from './repository.js';
import { STAKES, emptyPrizePool } from '../../../../../../core/games/poker/engine.js';
import { paytableForRules } from '../../../../../../core/games/poker/rules.js';
import { Card } from './Cards.jsx';
import Fireworks from './Fireworks.jsx';
import PrizePool from './PrizePool.jsx';
import { Dialog, Rules } from './dialogs.jsx';
import { cardSequence, gambleSequence, collectionPresentation, rewardPresentation } from './presentation.js';
const number=n=>new Intl.NumberFormat('zh-CN').format(n||0);
const id=()=>crypto.randomUUID();
function download(data){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='我的扑克机记录.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export default function PokerView({ownerId,onBack,getAudio,audioUnavailable,onAudioReady}) {
  const [game,setGame]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[motion,setMotion]=useState(null),[modal,setModal]=useState(null),[notice,setNotice]=useState(''),[gambleChoosing,setGambleChoosing]=useState(false);
  const repo=useRef(null),current=useRef(null),lock=useRef(false),timers=useRef(new Set()),alive=useRef(false),motionVersion=useRef(0),soundGetter=useRef(getAudio);
  soundGetter.current=getAudio;
  function sound(){return soundGetter.current();}
  function display(g){setGambleChoosing(false);current.current=g;setGame(g);sound().configure(g);}
  function stopMotion(){motionVersion.current++;for(const t of timers.current)clearTimeout(t);timers.current.clear();setMotion(null);sound().stop();}
  function later(fn,ms){const version=motionVersion.current;const t=setTimeout(()=>{timers.current.delete(t);if(alive.current&&version===motionVersion.current)fn();},ms);timers.current.add(t);}
  useEffect(()=>{
    alive.current=true;const instance=new PokerRepository(ownerId);repo.current=instance;
    const load=()=>instance.read().then(g=>{if(!instance.closed&&alive.current){stopMotion();display(g);}}).catch(e=>{if(!instance.closed&&alive.current)setError(e.message);});
    void load();const unsub=instance.subscribe(()=>{if(!lock.current)void load();});
    const visibility=()=>{if(document.hidden)stopMotion();};document.addEventListener('visibilitychange',visibility);
    return()=>{alive.current=false;motionVersion.current++;for(const t of timers.current)clearTimeout(t);timers.current.clear();sound().stop();document.removeEventListener('visibilitychange',visibility);unsub();instance.close();};
  },[ownerId]);
  async function reload(){setError('');try{display(await repo.current.read());}catch(e){setError(e.message);}}
  function animate(type,before,next){
    const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if(type==='DEAL'||type==='DRAW'){
      stopMotion();const round=next.round||next.lastRound,changed=type==='DEAL'?[0,1,2,3,4]:before.round.held.flatMap((h,i)=>h?[]:[i]);
      const plan=cardSequence(changed);
      setMotion({kind:'cards',hidden:changed});
      sound().sequence(plan.events);
      plan.cards.forEach(event=>later(()=>setMotion(m=>m?.kind==='cards'?{...m,hidden:m.hidden.filter(x=>x!==event.index)}:m),event.at));
      later(()=>{setMotion(null);if(type==='DRAW')reward(round);},plan.duration+100);
    } else if(type==='GAMBLE'){
      stopMotion();const plan=gambleSequence(next.round.gambleResult.poolAward?'win':next.round.gambleResult.outcome);setMotion({kind:'gamble',balance:before.balance,prizePool:before.prizePool??emptyPrizePool()});sound().sequence(plan.events);later(()=>setMotion(null),plan.revealAt);
    }else if(type==='COLLECT'){
      stopMotion();const plan=collectionPresentation(before.balance,next.lastRound.collected);
      if(reduced){void sound().play('collect',{loop:true,duration:plan.duration});}
      else {setMotion({kind:'collect',balance:before.balance});const start=performance.now();const tick=()=>{const elapsed=performance.now()-start;if(elapsed>=plan.duration){setMotion(null);return;}setMotion({kind:'collect',balance:plan.balanceAt(elapsed)});later(tick,33);};later(tick,33);void sound().play('collect',{loop:true,duration:plan.duration});}
      setNotice(`已领取 ${number(next.lastRound.collected)} 积分`);
    }
    else if(type==='HOLD'||type==='HOLD_ALL'){sound().stop();void sound().play(type==='HOLD_ALL'||next.round.held.some((h,i)=>h&&!before.round.held[i])?'hold':'release');}
    else if(type==='CLAIM_POOL'){stopMotion();void sound().play('pair');setNotice(`已领取奖池 ${number(next.balance-before.balance)} 积分，开始新一轮累计`);}
    else if(type==='TOPUP'){void sound().play('even');setNotice('已免费补充至 1000 积分');}
  }
  function reward(r){
    const multiplier=r.handRank.multiplier;
    if(!multiplier){void sound().play('loss');return;}
    const plan=rewardPresentation(r.handRank.id);
    sound().sequence(plan.events);setMotion({kind:'reward',fireworks:plan.fireworks});later(()=>setMotion(null),plan.duration);
  }
  async function act(type,fields={}) {
    if(lock.current||!current.current)return;
    lock.current=true;setBusy(true);setError('');setNotice('');
    const before=current.current,instance=repo.current;
    const audio=sound();audio.configure(before);void audio.unlock().then(ok=>{if(ok){audio.warm();onAudioReady();}});
    const cues=type==='DEAL'||type==='DRAW'?['shuffle','deal1','deal2','deal3','deal4','deal5','pair','cheer','loss']:type==='GAMBLE'?['roll','pair','push','loss']:type==='COLLECT'?['collect']:type==='CLAIM_POOL'?['pair']:[];
    try{const [next]=await Promise.all([instance.command({type,operationId:id(),...fields},before.revision),audio.prepare(cues)]);if(instance.closed||!alive.current)return;display(next);animate(type,before,next);if(type==='TOPUP')setModal(null);}
    catch(e){if(!instance.closed&&alive.current){stopMotion();setError(e.message);if(e.code==='GAME_CONFLICT')try{display(await instance.read());}catch{}}}
    finally{lock.current=false;if(alive.current)setBusy(false);}
  }
  const round=game?.round,shown=round||game?.lastRound,phase=round?.phase||'READY';
  const dealing=motion?.kind==='cards'||motion?.kind==='gamble';
  const blocked=busy||dealing||motion?.kind==='collect';
  const currentRank=shown?.handRank;
  const prizePool=motion?.kind==='gamble'?motion.prizePool:game?.prizePool??emptyPrizePool();
  const awardFlashing=Boolean(currentRank?.multiplier&&!dealing&&((phase==='REWARD_PENDING'&&!gambleChoosing)||motion?.kind==='collect'));
  const paytable=paytableForRules(round?.rulesVersion||5);
  const payoutStake=round?.stake??game?.selectedStake??10;
  let prompt='好牌，留在手里。';let hint='点击押注切换积分，再点击发牌。';
  if(phase==='HOLDING'){prompt='点击牌面，保留好牌';hint=`已保留 ${round.held.filter(Boolean).length} 张 · 其余牌可更换一次`;}
  if(phase==='REWARD_PENDING'){prompt=round.gambleCount?`待领取 ${number(round.pendingPayout)} 积分`:currentRank?.label;hint=round.gambleCount?'可以领取，也可以继续比大小':round.pendingPayout===round.stake?`返还 ${number(round.pendingPayout)} · 本局持平`:`返还 ${number(round.pendingPayout)} · 本局净得 ${number(round.pendingPayout-round.stake)}`;}
  if(phase==='REWARD_PENDING'&&gambleChoosing){prompt='请选择大或小';hint='也可以直接领取，保留本局奖励。';}
  if(phase==='GAMBLE_REVEALED'){prompt=dealing?'好运，正在揭晓…':round.gambleResult.outcome==='win'?'猜中了，奖励翻倍！':round.gambleResult.outcome==='push'?'平局，奖励保留':'这次没有猜中';hint=dealing?'':round.pendingPayout?`待领取 ${number(round.pendingPayout)} 积分`:'待领取奖励归零，余额不再扣除';}
  if(phase==='READY'&&shown){prompt=shown.collected?'积分已领取':'这一局结束了';hint=shown.collected?'随时开始下一局，也可以先休息。':'没有返还，随时可以再玩。';}
  if(phase==='READY'&&game&&game.balance<game.selectedStake){hint='积分不足，请点击押注调低本局积分。';}
  if(motion?.kind==='cards'){prompt=phase==='HOLDING'?'正在发牌…':'正在揭牌…';hint='';}
  async function toggleSound(){if(!game)return;stopMotion();const enabled=!game.soundEnabled;sound().configure({soundEnabled:enabled,volume:game.volume});if(enabled){await sound().unlock();onAudioReady();void sound().play('hold');}await act('SETTINGS',{soundEnabled:enabled});}
  const back=()=>{stopMotion();onBack();};
  return <div className="pg-machine" data-testid="poker-machine">
    {motion?.kind==='reward'&&motion.fireworks&&<Fireworks/>}
    <header className="pg-top"><button type="button" className="pg-back" aria-label="返回游戏列表" onClick={back}>‹</button><div className="pg-wordmark"><span>♠</span><div><strong>老虎扑克机</strong><small>CLASSIC VIDEO POKER</small></div></div><div className="pg-tools"><button type="button" className={!game?.soundEnabled?'is-muted':''} onClick={toggleSound} disabled={!game||busy} aria-label={game?.soundEnabled?'关闭音效':'开启音效'}>{game?.soundEnabled?'♪':'♩'}</button><button type="button" onClick={()=>setModal('rules')} aria-label="查看玩法">?</button><button type="button" onClick={()=>setModal('settings')} aria-label="声音与记录">☷</button></div></header>
    {!game?<div className="pg-loading" role="status">{error||'正在接回你的牌桌…'}{error&&<button onClick={reload}>重试</button>}</div>:<>
    <div className="pg-scoreboard"><div><span>我的积分</span><strong data-testid="balance">{number(motion?.kind==='collect'||motion?.kind==='gamble'?motion.balance:game.balance)}</strong><button type="button" className="pg-topup-entry" onClick={()=>setModal('topup')}>上分 / 补分</button></div><div><span>本局积分</span><strong>{number(shown&&round?shown.stake:game.selectedStake)}</strong></div><div className="pg-score-reward"><span>{dealing?'待揭晓':'待领取'}</span><strong>{dealing?'—':number(round?.pendingPayout)}</strong></div></div>
    <div className="pg-cabinet">
      <aside className="pg-paytable" aria-label="本局奖励积分"><div className="pg-paytable-heading">本局可得 <span>积分</span></div>{paytable.filter(x=>x.multiplier).map(row=><div key={row.id} className={currentRank?.id===row.id&&phase!=='HOLDING'&&!dealing?`is-active ${awardFlashing?'is-flashing':''}`:''}><span>{row.label}</span><b>{number(payoutStake*row.multiplier)}</b></div>)}</aside>
      <main className="pg-stage">
        <div className={`pg-announcement ${motion?.kind==='reward'?'is-celebrating':''}`} aria-live="polite"><span className="pg-eyebrow">{phase==='HOLDING'?'HOLD YOUR LUCK':phase==='REWARD_PENDING'?'LUCKY HAND':'GOOD TIMES, GOOD CARDS'}</span><h1>{prompt}</h1><p>{hint||'\u00a0'}</p></div>
        {phase==='REWARD_PENDING'&&gambleChoosing?<div className="pg-gamble-reveal"><span>比牌</span><Card hidden/><strong>?</strong></div>:phase==='GAMBLE_REVEALED'?<div className="pg-gamble-reveal"><span>你选了{round.gambleResult.pick==='big'?'大':'小'}</span><Card card={round.gambleResult.card} hidden={dealing}/><strong>{dealing?'?':round.gambleResult.outcome==='win'?'×2':round.gambleResult.outcome==='push'?'平局':'下次再来'}</strong></div>:<div className="pg-cards">{Array.from({length:5},(_,i)=><Card key={i} index={i} card={shown?.hand[i]} held={phase==='HOLDING'&&round.held[i]} hidden={motion?.kind==='cards'&&motion.hidden.includes(i)} highlight={awardFlashing&&currentRank?.indices.includes(i)} disabled={phase!=='HOLDING'||blocked} onClick={()=>act('HOLD',{index:i,held:!round.held[i]})}/>)}</div>}
        <div className="pg-stage-note">{motion?.kind==='collect'?<button type="button" onClick={stopMotion}>完成得分 ›</button>:motion?.kind==='reward'?<button type="button" onClick={stopMotion}>跳过庆祝 ›</button>:phase==='HOLDING'?<button type="button" disabled={blocked} onClick={()=>act('HOLD_ALL')}>全部保留</button>:<span>♠ <i>♥</i> ♣ <i>♦</i></span>}</div>
      </main>
    </div>
    <div className="pg-console">
      {phase==='READY'?<><div className="pg-stakes"><button type="button" className={`pg-stake-cycle pg-chip pg-chip-${game.selectedStake}`} disabled={blocked} aria-label={`押注 ${game.selectedStake} 分，点击切换`} onClick={()=>act('SETTINGS',{stake:STAKES[(STAKES.indexOf(game.selectedStake)+1)%STAKES.length]})}><span className="pg-chip-face"><small>押注</small><strong>{game.selectedStake}</strong><small>分</small></span></button><small className="pg-chip-hint">点击换筹码 ↻</small></div><button type="button" className="pg-primary" disabled={blocked||game.balance<game.selectedStake} onClick={()=>act('DEAL')}>发牌 <span>DEAL</span></button>{game.balance<10&&<button className="pg-secondary" onClick={()=>act('TOPUP')} disabled={blocked}>免费补充至 1000</button>}</>:null}
      {phase==='HOLDING'?<><div className="pg-console-help">点击牌面留牌<br/><small>选好后，只换一次</small></div><button type="button" className="pg-primary" disabled={blocked} onClick={()=>act('DRAW')}>{round.held.every(Boolean)?'确认牌型':'换牌'} <span>DRAW</span></button></>:null}
      {phase==='REWARD_PENDING'?<><button type="button" className="pg-primary" disabled={blocked} onClick={()=>act('COLLECT')}>领取 {number(round.pendingPayout)} <span>COLLECT</span></button><div className="pg-gamble-buttons"><span>{round.gambleCount>=3?'本局比大小已结束':`自选比大小 · 还可比 ${3-round.gambleCount} 次`}</span><div>{gambleChoosing?<><button type="button" className="pg-small" disabled={blocked||round.gambleCount>=3} onClick={()=>act('GAMBLE',{pick:'small'})}>小 <small>2–7</small></button><button type="button" className="pg-big" disabled={blocked||round.gambleCount>=3} onClick={()=>act('GAMBLE',{pick:'big'})}>大 <small>9–A</small></button></>:<button type="button" className="pg-big" disabled={blocked||round.gambleCount>=3} onClick={()=>{stopMotion();setGambleChoosing(true);}}>比牌</button>}</div><small>8 为平局{round.rulesVersion>=3?' · 鬼牌算猜中':''} · 猜错仅失去待领取奖励</small></div></>:null}
      {phase==='GAMBLE_REVEALED'?<><div className="pg-console-help">{dealing?'正在揭晓…':round.gambleResult.outcome==='loss'?'本局余额已保留':round.gambleResult.outcome==='win'?'奖励翻倍，随时领取':'8 为平局，奖励不变'}<br/><small>结果已保存</small></div><button type="button" className="pg-primary" disabled={blocked} onClick={()=>act('ACK_GAMBLE')}>{round.pendingPayout?'继续':'结束本局'} <span>NEXT</span></button></>:null}
    </div>
    {((phase==='REWARD_PENDING'&&gambleChoosing)||phase==='GAMBLE_REVEALED')&&<PrizePool pool={prizePool} award={!dealing&&phase==='GAMBLE_REVEALED'?round.gambleResult.poolAward:0} disabled={blocked} onLegacyClaim={()=>act('CLAIM_POOL')}/>}
    {phase==='GAMBLE_REVEALED'&&!dealing&&round.gambleResult.poolContribution>0&&!round.gambleResult.poolAward&&<div className="pg-notice">本次 {number(round.gambleResult.poolContribution)} 分已计入奖池，余额不再扣分。</div>}
    {error&&<div className="pg-notice is-error" role="alert">{error}<button onClick={reload} disabled={busy}>重新读取</button></div>}
    {round&&round.rulesVersion<3&&<div className="pg-notice">本局沿用原来52张牌的规则；下一局加入大小王百变牌与五条。</div>}
    {round&&round.rulesVersion<5&&<div className="pg-notice">本局保留原中奖规则；新牌局一对10及以上才有奖。</div>}
    {round?.rulesVersion===3&&<div className="pg-notice">本局沿用原倍数；下一局顺子5倍、同花7倍、葫芦12倍。</div>}
    {notice&&<div className="pg-notice" role="status">{notice}</div>}
    {audioUnavailable&&game.soundEnabled&&<div className="pg-notice"><span>声音暂未开启</span><button onClick={async()=>{if(await sound().unlock()){onAudioReady();void sound().play('intro');}}}>开启声音</button></div>}
    <footer className="pg-footer"><span>免费娱乐积分 · 自动保存在本机</span><span>横竖屏随心玩</span></footer>
    </>}
    {modal==='topup'&&<Dialog title="上分 / 补分" onClose={()=>setModal(null)}><h3>免费娱乐积分</h3><p>首次进入赠送 1000 分。余额不足 10 分且本局结束后，可以免费补回 1000 分。</p><p>当前余额：{number(game?.balance)} 分</p>{round?<p>请先完成本局并领取或结算奖励，再来补分。</p>:game?.balance>=10?<p>当前积分仍可继续玩；可点击押注按钮调低本局积分。</p>:null}<button type="button" className="pg-secondary" disabled={!game||busy||Boolean(round)||game.balance>=10} onClick={()=>act('TOPUP')}>免费补分至 1000</button><p>积分无现金价值，无需充值。</p>{error&&<p role="alert">{error}</p>}</Dialog>}
    {modal==='rules'&&<Rules rulesVersion={round?.rulesVersion||5} onClose={()=>setModal(null)}/>}
    {modal==='settings'&&<Dialog title="声音与记录" onClose={()=>setModal(null)}>{game&&<><h3>经典街机音效</h3><div className="pg-setting-row"><span>游戏音效</span><button type="button" disabled={busy} onClick={toggleSound}>{game.soundEnabled?'已开启':'已关闭'}</button></div><label className="pg-volume">音量 <input type="range" min="0" max="100" step="5" value={Math.round(game.volume*100)} disabled={busy} onChange={e=>act('SETTINGS',{volume:Number(e.target.value)/100})}/><span>{Math.round(game.volume*100)}%</span></label><button className="pg-secondary" disabled={!game.soundEnabled} onClick={async()=>{if(await sound().unlock()){onAudioReady();await sound().prepare(['shuffle','deal1','deal2','deal3','deal4','deal5','pair','collect']);sound().sequence([...cardSequence([0,1,2,3,4]).events,{at:1400,name:'pair'},{at:2700,name:'collect',loop:true,duration:800}]);}}}>试听经典音效 ♪</button><h3>本机游戏记录</h3><p>已完成 {number(game.completedRounds)} 局 · 最高领取 {number(game.bestPayout)} 积分</p><p>仅保存在当前设备与浏览器，未上传云端。</p><div className="pg-record-actions"><button disabled={busy} onClick={async()=>{try{download(await repo.current.export());setNotice('游戏记录已导出');}catch(e){setError(e.message);}}}>导出我的记录</button><button disabled={busy} onClick={()=>setModal('delete')}>删除本机记录</button></div></>}</Dialog>}
    {modal==='delete'&&<Dialog title="删除本机游戏记录？" onClose={()=>setModal(null)}><p>只删除你在这台设备上的扑克机积分、奖池、牌局和记录。删除后不可恢复；其他功能的数据不受影响。</p><button className="pg-secondary" onClick={()=>setModal(null)}>保留记录</button><button className="pg-danger" disabled={busy} onClick={async()=>{if(lock.current)return;lock.current=true;setBusy(true);stopMotion();try{await repo.current.delete(current.current.revision);display(await repo.current.read());setModal(null);setNotice('本机游戏记录已删除，可以重新开始');}catch(e){setError(e.message);}finally{lock.current=false;setBusy(false);}}}>确认删除游戏记录</button></Dialog>}
  </div>;
}
