import {useEffect,useRef,useState} from 'react';
import {splitSpeech,rewardPresentation} from './experience.js';
import {createRewardAudio} from './rewardAudio.js';
import cheerUrl from './assets/applause-cheer.mp3?url';
export default function PracticeStage({view,cap,busy,recording,seconds,translation,setTranslation,speak,audio,audioUrl,audioReady,record,stop,cancelRecord,leave,hint,requestHint,feedback,error,retryAudio,canRetry,controller,draft,setDraft,submit,correctsTurnId,setCorrectsTurnId,textMode,setTextMode,ownAudio,ownAudioUrl,automaticVoice,setAutomaticVoice,complete,end,finishReward}){
 const [panel,setPanel]=useState(null),[page,setPage]=useState(0),[celebrate,setCelebrate]=useState(false),[sound,setSound]=useState(true),[soundBlocked,setSoundBlocked]=useState(false);
 const rewardAudio=useRef(null),rewardTimer=useRef(null);const reward=rewardPresentation(feedback);
 const pages=splitSpeech(view.teacher.replyEn,140),blocked=!!busy||recording,last=view.turns.at(-1);
 useEffect(()=>{setPage(0);setPanel(null);},[view.session.revision]);
 useEffect(()=>{if(draft)setPanel('text');},[draft]);
 function player(){if(!rewardAudio.current)rewardAudio.current=createRewardAudio(cheerUrl);return rewardAudio.current;}
 function dismissReward(play=true){clearTimeout(rewardTimer.current);setCelebrate(false);rewardAudio.current?.stop();finishReward(play);}
 useEffect(()=>{if(!feedback){setCelebrate(false);return;}setCelebrate(true);setSoundBlocked(false);if(reward.celebrate&&sound)void player().play().then(ok=>setSoundBlocked(!ok));rewardTimer.current=setTimeout(()=>dismissReward(true),reward.durationMs);return()=>{clearTimeout(rewardTimer.current);rewardAudio.current?.stop();};},[feedback]);
 useEffect(()=>{const hide=()=>{if(document.hidden)dismissReward(false);};document.addEventListener('visibilitychange',hide);return()=>{document.removeEventListener('visibilitychange',hide);rewardAudio.current?.close();};},[]);
 function playLesson(text,rate){dismissReward(false);speak(text,rate);}
 const toggle=which=>{dismissReward(false);setPanel(p=>p===which?null:which);};
 function correct(){dismissReward(false);setCorrectsTurnId(last.id);setDraft(last.transcript);setTextMode(true);setPanel('text');}
 function begin(){dismissReward(false);setPanel(null);void player().warm();record();}
 return <div className="al-stage" aria-label="沉浸练习">
  <div className="al-mission"><span>{view.lesson.kind==='foundation'?['听一句，跟着说','换个说法，再试一次','小挑战：自己说'][Math.min(view.foundationStep,2)]:'情境挑战'}</span><strong>{view.lesson.kind==='foundation'?`${Math.min(view.foundationStep,3)} / 3`:`第 ${view.session.turnCount+1} 轮`}</strong></div>
  <div className="al-route" aria-label="关卡进度">{[0,1,2].map(n=><i key={n} className={(view.lesson.kind==='foundation'?view.foundationStep>n:view.session.goalReached)?'is-passed':''}/>)}</div>
  <article className="al-scene">
   <div className="al-scene-top"><span className="al-avatar">{view.lesson.emoji}</span><div><strong>{view.lesson.title}</strong><small>{view.lesson.goal}</small></div></div>
   <div className="al-line"><p lang="en">{pages[Math.min(page,pages.length-1)]}</p>{translation&&(view.teacher.helpZh.length>70?<button className="al-translation-open" onClick={()=>setPanel('translation')}>查看这段中文 ↗</button>:<p className="al-stage-zh">{view.teacher.helpZh}</p>)}</div>
   {pages.length>1&&<nav className="al-line-pages" aria-label="台词分页"><button disabled={!page} onClick={()=>setPage(page-1)}>上一段</button><span>{page+1}/{pages.length}</span><button disabled={page===pages.length-1} onClick={()=>setPage(page+1)}>下一段</button></nav>}
   {view.prompt&&<div className="al-next-line"><span>{view.prompt.helpZh}</span>{view.prompt.example&&<strong lang="en">{view.prompt.example}</strong>}</div>}
   {feedback&&<button className={`al-round-feedback ${feedback.passed?'is-success':''}`} onClick={()=>toggle('feedback')} aria-label="查看本轮反馈"><span>{feedback.passed?'✦':'↻'} {feedback.title}</span><small>{reward.displayScore!=null?`${reward.displayScore} · 词句匹配（非发音分）`:'点开看建议，每次尝试都算进步'}</small></button>}
   {celebrate&&feedback&&<div className={`al-reward-layer ${reward.celebrate?'is-celebrating':'is-encouraging'}`} role="status" aria-label="本轮练习反馈"><div className="al-reward-flowers" aria-hidden="true">{reward.celebrate?'🌸 🌷 🌼':'🌱'}</div><span className="al-reward-kicker">{reward.displayScore!=null?'这一句 · 词句匹配':reward.celebrate?'小目标达成':'每次开口，都在向前'}</span>{reward.displayScore!=null?<div className="al-reward-score">{reward.displayScore}<small>/100</small></div>:<div className="al-reward-symbol" aria-hidden="true">{reward.celebrate?'✦':'♡'}</div>}<h2>{reward.title}</h2><p>{reward.message}</p>{reward.displayScore!=null&&<small>依据识别文字，不是发音评分</small>}{soundBlocked&&reward.celebrate&&<button onClick={()=>{void player().warm();void player().play().then(ok=>setSoundBlocked(!ok));}}>听掌声与欢呼</button>}<button className="al-reward-continue" onClick={()=>dismissReward(true)}>继续练习 →</button><div className="al-reward-time" style={{animationDuration:`${reward.durationMs}ms`}}/></div>}

  </article>
  <div className="al-stage-message" aria-live="polite">{error?<><span>{error}</span>{canRetry&&<button disabled={blocked} onClick={retryAudio}>重试录音</button>}</>:busy?<><span className="al-thinking">● ● ●</span><span>{busy}…</span><button onClick={()=>controller.current?.abort()}>取消</button></>:recording?`正在听 · ${seconds}秒 · 说完再点一下`:<span>{view.session.goalReached?'目标完成！可以收下这一关。':'听一听，开口回应我。'}</span>}</div>
  <div className="al-dock">
   <div className="al-dock-tools"><button disabled={blocked||!cap?.speechAvailable} onClick={()=>playLesson(view.teacher.replyEn)}>▷ 听一遍</button><button disabled={blocked||!cap?.speechAvailable} onClick={()=>playLesson(view.teacher.replyEn,'slow')}>慢一点</button><button aria-expanded={panel==='hint'} disabled={blocked} onClick={()=>{toggle('hint');if(!hint)requestHint();}}>提示</button><button aria-expanded={panel==='more'} disabled={blocked} onClick={()=>toggle('more')}>更多</button></div>
   <button className={`al-mic ${recording?'is-recording':''}`} disabled={!!busy||(!cap?.speechAvailable&&!view.session.goalReached)} onClick={()=>recording?stop():view.session.goalReached?(dismissReward(false),complete()):begin()}>{recording?'■ 说完了':view.session.goalReached?'收下这一关 ✓':'🎙 开始说'}</button>
   {recording?<button className="al-dock-minor" onClick={cancelRecord}>取消录音</button>:<button className="al-dock-minor" disabled={blocked} onClick={()=>{dismissReward(false);void player().warm();setTextMode(true);setPanel('text');}}>用文字练习</button>}
  </div>
  <audio ref={audio} src={audioUrl||undefined} onLoadedMetadata={audioReady} aria-label="英语示范播放"/>
  {panel&&<div className="al-panel-scrim" onClick={()=>setPanel(null)}><section className="al-panel" role="dialog" aria-modal="true" aria-label="练习辅助" onClick={e=>e.stopPropagation()} onKeyDown={e=>{if(e.key==='Escape')setPanel(null);}}><header><strong>{panel==='hint'?'给你一点帮助':panel==='text'?'文字与识别核对':panel==='feedback'?'这一轮的反馈':'练习设置'}</strong><button autoFocus onClick={()=>setPanel(null)} aria-label="关闭辅助面板">关闭 ✕</button></header><div className="al-panel-content">
   {panel==='translation'&&<p>{view.teacher.helpZh}</p>}
   {panel==='hint'&&<><p lang="en">{hint||'正在准备提示…'}</p><p>借助提示也很好，这次会记为有帮助的练习。</p><button disabled={blocked||!hint} onClick={()=>playLesson(hint)}>▷ 听提示</button></>}
   {panel==='feedback'&&<><p>你刚才说：{last?.transcript}</p>{feedback?.score!=null&&<p>本次词句匹配：{feedback.score} / 100。只用于找出下一步怎么练，不代表你的英语能力。</p>}<p>{feedback?.score!=null?'词句匹配按识别文字与示范计算，不代表发音质量。':'依据本轮表达与任务进度，不评价发音。'}</p>{last?.reply.feedback.map((f,i)=><div className="al-feedback" key={i}><q>{f.original}</q><strong>{f.suggestion}</strong><p>{f.reasonZh}</p></div>)}{last?.hint!=='none'&&<p>本次有提示支持，不计独立掌握。</p>}{last?.inputMode==='voice'&&<button onClick={correct}>识别错了，改一下</button>}{ownAudioUrl&&<audio ref={ownAudio} controls src={ownAudioUrl} aria-label="自己的录音"/>}</>}
   {panel==='text'&&<div className="al-draft"><label htmlFor="al-transcript">{correctsTurnId?'更正刚才的识别文字':'文字练习'}</label><textarea id="al-transcript" value={draft} onChange={e=>setDraft(e.target.value)} disabled={blocked} maxLength={6000} rows={2}/><button disabled={blocked||!draft.trim()} onClick={submit}>{correctsTurnId?'更正并重新回应':'就这样说 →'}</button><p>文字练习不计入口语尝试。</p></div>}
   {panel==='more'&&<><button aria-pressed={translation} onClick={()=>setTranslation(!translation)}>{translation?'收起中文':'看中文'}</button><label><input type="checkbox" checked={automaticVoice} onChange={e=>setAutomaticVoice(e.target.checked)}/>说完后自动回应并播报</label><label><input type="checkbox" checked={sound} onChange={e=>{setSound(e.target.checked);if(e.target.checked)void player().warm();else rewardAudio.current?.stop();}}/>掌声与欢呼</label>{last?.inputMode==='voice'&&<button onClick={correct}>识别错了，改一下</button>}{ownAudioUrl&&<audio ref={ownAudio} controls src={ownAudioUrl} aria-label="自己的录音"/>}<button onClick={leave}>保存进度并返回</button><button onClick={end}>结束本次练习</button></>}
  </div></section></div>}
 </div>;
}
