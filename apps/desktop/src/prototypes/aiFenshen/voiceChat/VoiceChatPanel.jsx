import{useEffect,useRef}from'react';import './voiceChat.css';
const labels={permission:'等待麦克风授权',connecting:'正在连接',listening:'我在听',thinking:'正在想',speaking:'正在说',muted:'麦克风已静音',paused:'语音已暂停'};
const errors={VOICE_PERMISSION_DENIED:'请在浏览器的网站设置中允许麦克风，然后点击继续。',VOICE_NO_MICROPHONE:'没有找到麦克风，请检查设备连接。',VOICE_BACKGROUND:'离开页面后已停止收音。准备好后，点击继续。',VOICE_OFFLINE:'网络已断开，收音和播放已停止。连接恢复后可继续。',VOICE_DAILY_LIMIT:'今天的语音时长已用完，你可以继续文字聊天。',VOICE_SERVICE_LIMIT:'当前语音服务额度已用完，请稍后再试或继续文字聊天。',VOICE_ALREADY_ACTIVE:'你的账号已有语音聊天，请先结束另一处通话。',VOICE_BUSY:'语音服务正在忙，稍后可以重试。',VOICE_IDLE:'一段时间没有听到你说话，已暂停收音。',VOICE_SESSION_LIMIT:'这次语音已结束，点击继续即可开始下一段。',VOICE_PLAYBACK_BLOCKED:'声音播放被暂停，点击继续重新连接。',VOICE_NETWORK_SLOW:'网络连续约十秒无法上传语音，已暂停收音。连接稳定后可继续。',VOICE_BROWSER_UNSUPPORTED:'当前环境无法启动语音，文字聊天仍可使用。',VOICE_CONFIRMATION_EXPIRED:'这条确认已过期，请重新说明。',VOICE_ACTION_FAILED:'操作未确认完成，请查看聊天记录后再试。',VOICE_ENDED:'通话已结束。'};
export function VoiceWaveIcon(){return <svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" aria-hidden="true"><path d="M4 10v4m4-7v10m4-14v18m4-15v12m4-9v6"/></svg>;}
export default function VoiceChatPanel({voice,onText}){
 const panel=useRef(null),previous=useRef(null);
 useEffect(()=>{previous.current=document.activeElement;panel.current?.focus();return()=>previous.current?.focus?.({preventScroll:true});},[]);
 const{state}=voice,intro=state.phase==='intro',paused=state.phase==='paused';
 const keydown=e=>{if(e.key==='Escape'){voice.end();return;}if(e.key==='Tab'){const nodes=[...panel.current.querySelectorAll('button:not(:disabled)')];const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}};
 return <div className="af-voice-overlay" data-voice-phase={state.phase} data-voice-error={state.error||undefined} ref={panel} role="dialog" aria-modal="true" aria-label="语音聊天" tabIndex={-1} onKeyDown={keydown}>
  <div className="af-voice-top"><span>AI分身 · 语音</span><button type="button" onClick={voice.end} aria-label="结束语音聊天">×</button></div>
  <div className="af-voice-main">
   {['speaking','thinking'].includes(state.phase)?<button type="button" className={`af-voice-orb ${state.phase==='speaking'?'is-speaking':''}`} aria-label="打断回答，我来说" onClick={()=>voice.engine.interrupt()}><VoiceWaveIcon/></button>:<div className={`af-voice-orb ${state.muted?'is-muted':''}`} aria-hidden="true"><VoiceWaveIcon/></div>}
   <h2>{intro?'直接说，我在听':labels[state.phase]||'语音聊天'}</h2>
   {intro?<p className="af-voice-intro">开启后可以连续交谈，也可点圆球立即打断。<br/>音频会发送至语音服务处理，应用不保存录音；文字保存在当前聊天。</p>:null}
   {!intro&&state.subtitle?<p className="af-voice-subtitle">{state.subtitle}</p>:null}
   {state.error?<p className="af-voice-error" role="status">{errors[state.error]||'语音暂时没有完成，收音已停止。可以点击继续，或返回文字聊天。'}</p>:null}
   {state.proposal?<section className="af-voice-confirm" aria-label="语音操作确认"><strong>{state.proposal.title}</strong><p>{state.proposal.text}</p><div><button type="button" onClick={voice.cancelProposal} disabled={state.confirming}>取消</button><button type="button" className="primary" onClick={voice.confirm} disabled={state.confirming}>{state.confirming?'正在保存…':'确认执行'}</button></div></section>:null}
  </div>
  <div className="af-voice-bottom">
   {intro||paused?<button type="button" className="af-voice-start" onClick={voice.start}>{intro?'开启语音':'继续语音'}</button>:<div className="af-voice-controls"><button type="button" aria-pressed={state.muted} onClick={voice.mute} disabled={['permission','connecting'].includes(state.phase)}>{state.muted?'取消静音':'麦克风静音'}</button><button type="button" className="af-voice-end" onClick={voice.end}>结束</button></div>}
   <button type="button" className="af-voice-text" onClick={()=>{voice.end();onText?.();}}>返回文字聊天</button>
   {!intro&&!paused?<small>{state.muted?'麦克风已关闭，AI仍可继续回答':'开口接话，也可点圆球打断 · 切到后台会暂停'}</small>:null}
  </div>
 </div>;
}
