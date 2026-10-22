import {useEffect,useState} from 'react';
import {splitSpeech} from './experience.js';

export default function PracticeStage({view,cap,busy,recording,seconds,translation,setTranslation,speak,audio,audioUrl,audioReady,firstAudio,record,stop,cancelRecord,leave,hint,requestHint,feedback,error,retryAudio,canRetry,controller,draft,setDraft,submit,correctsTurnId,setCorrectsTurnId,ownAudio,ownAudioUrl,automaticVoice,setAutomaticVoice,complete,end,speechLoading,listenRate,setListenRate,stopPlayback}){
 const [panel,setPanel]=useState(null),[page,setPage]=useState(0),[showHint,setShowHint]=useState(false);
 const pages=splitSpeech(view.teacher.replyEn,120),blocked=!!busy||recording,last=view.turns.at(-1);
 const foundation=view.lesson.kind==='foundation',coffee=view.lesson.id==='coffee';
 const correction=last?.reply.feedback[0];
 useEffect(()=>{setPage(0);setPanel(null);setShowHint(false);},[view.session.revision]);
 useEffect(()=>{if(draft)setPanel('text');},[draft]);
 function correct(){stopPlayback();setCorrectsTurnId(last.id);setDraft(last.transcript);setPanel('text');}
 function begin(){setPanel(null);setShowHint(false);record();}
 function help(){setShowHint(true);requestHint();}
 return <div className="al-stage" aria-label="沉浸练习">
  {cap?.realtimeAvailable&&automaticVoice&&<p className="al-realtime-notice">开口说时，录音会逐段发送用于实时识别；取消或离开即停止。</p>}
  <div className="al-mission"><span>{foundation?['听一句，跟着说','换个说法，再试一次','小挑战：自己说'][Math.min(view.foundationStep,2)]:coffee?'你是顾客 · 我来做店员':'你来做情境主角'}</span><strong>{foundation?`${Math.min(view.foundationStep,3)} / 3`:view.session.goalReached?'目标已完成':`已交流 ${view.session.turnCount} 轮`}</strong></div>
  {foundation&&<div className="al-route" aria-label="练习进度">{[0,1,2].map(n=><i key={n} className={view.foundationStep>n?'is-passed':''}/>)}</div>}
  <article className={`al-scene ${coffee?'al-coffee-scene':''}`}>
   <div className="al-scene-top"><span className="al-avatar" aria-hidden="true">{view.lesson.emoji}</span><div><strong>{view.lesson.title}</strong><small>{view.lesson.goal}</small></div></div>
   {coffee&&<p className="al-scenario-cue">{view.session.goalReached?'这次点单目标已完成。把这句话带到下一次。':view.session.turnCount?'店员正在接你的话，按自己的想法继续说。':'轮到你点单了。不用背台词，说出你的选择。'}</p>}
   <div className="al-dialogue" key={last?.id||'opening'}>
    {coffee&&last&&<div className="al-order-note"><span>你的点单原话</span><q lang="en">{last.transcript}</q><small>{view.session.goalReached?'✓ 表达目标已完成':'继续聊，让店员听懂你的选择'}</small></div>}
    <div className="al-line"><p lang="en">{pages[Math.min(page,pages.length-1)]}</p>{translation&&(view.teacher.helpZh.length>70?<button className="al-translation-open" onClick={()=>setPanel('translation')}>查看这段中文 ↗</button>:<p className="al-stage-zh">{view.teacher.helpZh}</p>)}</div>
    {pages.length>1&&<nav className="al-line-pages" aria-label="台词分页"><button disabled={!page} onClick={()=>setPage(page-1)}>上一段</button><span>{page+1}/{pages.length}</span><button disabled={page===pages.length-1} onClick={()=>setPage(page+1)}>下一段</button></nav>}
    {view.prompt&&<div className="al-next-line"><span>{view.prompt.helpZh}</span>{view.prompt.example&&<strong lang="en">{view.prompt.example}</strong>}</div>}
    {showHint&&<div className="al-hint-inline" role="status"><div><span>可以这样说 · 本轮计为有提示</span><button onClick={()=>{setShowHint(false);stopPlayback();}} aria-label="收起提示">收起</button></div><p lang="en">{hint||'正在准备提示…'}</p>{speechLoading&&<small>文字先给你，声音正在准备</small>}</div>}
    {feedback&&<button className={`al-round-feedback ${feedback.passed?'is-success':''}`} onClick={()=>setPanel('feedback')} aria-label="查看本轮反馈"><span>{correction?'试试这一处表达':feedback.passed?'这一小步，完成了':'对话在继续'}</span>{correction?<strong lang="en">{correction.original} → {correction.suggestion}</strong>:<small>{feedback.passed?view.lesson.goal:'接着对方的问题说下去，也可以打开提示。'}</small>}{correction&&<small>{correction.reasonZh}</small>}</button>}
   </div>
  </article>
  <div className="al-stage-message" aria-live="polite">{error?<><span>{error}</span>{canRetry&&<button disabled={blocked} onClick={retryAudio}>重试录音</button>}</>:busy?<><span>{busy}…</span><button onClick={()=>controller.current?.abort()}>取消</button></>:recording?`正在听 · ${seconds}秒 · 说完再点一下`:speechLoading?<><span>声音正在准备，可以继续操作</span><button onClick={stopPlayback}>停止</button></>:<span>{view.session.goalReached?'目标已完成，准备好就结束本次练习。':'听一句，按自己的想法回应。'}</span>}</div>
  <div className="al-dock">
   <div className="al-core-controls">
    <button disabled={blocked||!cap?.speechAvailable} onClick={()=>speak(view.teacher.replyEn)}><span aria-hidden="true">▷</span>听一遍</button>
    <button className={`al-mic ${recording?'is-recording':''}`} disabled={!!busy||(!cap?.speechAvailable&&!view.session.goalReached)} onClick={()=>recording?stop():view.session.goalReached?(stopPlayback(),complete()):begin()}><span aria-hidden="true">{recording?'■':view.session.goalReached?'✓':'●'}</span>{recording?'说完了':view.session.goalReached?'完成练习':'开口说'}</button>
    <button aria-expanded={showHint} disabled={blocked} onClick={help}><span aria-hidden="true">?</span>提示</button>
   </div>
   <div className="al-secondary-controls">{recording?<button onClick={cancelRecord}>取消录音</button>:<><button disabled={!!busy} onClick={()=>{stopPlayback();setPanel('text');}}>用文字练习</button><button disabled={!!busy} onClick={()=>setPanel('more')}>更多设置</button></>}</div>
  </div>
  <audio ref={audio} src={audioUrl||undefined} onLoadedMetadata={audioReady} onPlaying={firstAudio} aria-label="英语示范播放"/>
  {panel&&<div className="al-panel-scrim" onClick={()=>setPanel(null)}><section className="al-panel" role="dialog" aria-modal="true" aria-label="练习辅助" onClick={e=>e.stopPropagation()} onKeyDown={e=>{if(e.key==='Escape')setPanel(null);}}><header><strong>{panel==='text'?'文字与识别核对':panel==='feedback'?'这一轮的反馈':panel==='translation'?'中文意思':'练习设置'}</strong><button autoFocus onClick={()=>setPanel(null)} aria-label="关闭辅助面板">关闭 ✕</button></header><div className="al-panel-content">
   {panel==='translation'&&<p>{view.teacher.helpZh}</p>}
   {panel==='feedback'&&<><p>你刚才说：{last?.transcript}</p>{feedback?.score!=null&&<p>本次词句匹配：{feedback.score} / 100。只用于找出下一步怎么练，不代表你的英语能力或发音质量。</p>}{last?.reply.feedback.map((f,i)=><div className="al-feedback" key={i}><q>{f.original}</q><strong>{f.suggestion}</strong><p>{f.reasonZh}</p></div>)}{last?.hint!=='none'&&<p>本次有提示支持，不计独立掌握。</p>}{last?.inputMode==='voice'&&<button onClick={correct}>识别错了，改一下</button>}{ownAudioUrl&&<audio ref={ownAudio} controls src={ownAudioUrl} onPlay={()=>stopPlayback(false)} aria-label="自己的录音"/>}</>}
   {panel==='text'&&<div className="al-draft"><label htmlFor="al-transcript">{correctsTurnId?'更正刚才的识别文字':'文字练习'}</label><textarea id="al-transcript" value={draft} onChange={e=>setDraft(e.target.value)} disabled={blocked} maxLength={6000} rows={2}/><button disabled={blocked||!draft.trim()} onClick={submit}>{correctsTurnId?'更正并重新回应':'就这样说 →'}</button><p>文字练习不计入口语尝试。</p></div>}
   {panel==='more'&&<><label>示范语速<select aria-label="示范语速" value={listenRate} onChange={e=>setListenRate(e.target.value)}><option value="normal">正常速度</option><option value="slow">慢速</option></select></label><button aria-pressed={translation} onClick={()=>setTranslation(!translation)}>{translation?'收起中文':'看中文'}</button><label><input type="checkbox" checked={automaticVoice} onChange={e=>setAutomaticVoice(e.target.checked)}/>说完后自动回应并播报</label>{last?.inputMode==='voice'&&<button onClick={correct}>识别错了，改一下</button>}{ownAudioUrl&&<audio ref={ownAudio} controls src={ownAudioUrl} onPlay={()=>stopPlayback(false)} aria-label="自己的录音"/>}<button onClick={leave}>保存进度并返回</button><button onClick={()=>{stopPlayback();end();}}>结束本次练习</button></>}
  </div></section></div>}
 </div>;
}
