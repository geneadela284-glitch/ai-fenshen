import{useEffect,useRef}from'react';
import {parseMemoryReceiptMessage,visibleMemoryText} from '../../../../../../core/memory/localEvidence.js';
import {decodeDocumentMessage} from '../../../../../../core/documentQa/contract.js';import './voiceChat.css';
const labels={permission:'等待麦克风授权',connecting:'正在连接',listening:'我在听',thinking:'正在处理',text:'文字输入期间暂停收音',speaking:'正在说',muted:'麦克风已静音',paused:'语音已暂停'};
const errors={ACCOUNT_REQUEST_RATE_LIMITED:'这段时间启动语音较频繁，请稍等一分钟再继续。文字聊天仍可使用。',VOICE_PERMISSION_DENIED:'请在浏览器的网站设置中允许麦克风，然后点击继续。',VOICE_NO_MICROPHONE:'没有找到麦克风，请检查设备连接。',VOICE_BACKGROUND:'离开页面后已停止收音。准备好后，点击继续。',VOICE_OFFLINE:'网络已断开，收音和播放已停止。连接恢复后可继续。',VOICE_DAILY_LIMIT:'今天的语音时长已用完，你可以继续文字聊天。',VOICE_SERVICE_LIMIT:'当前语音服务额度已用完，请稍后再试或继续文字聊天。',VOICE_RATE_LIMITED:'当前语音请求较多，请稍后再试或继续文字聊天。',VOICE_ALREADY_ACTIVE:'你的账号已有语音聊天，请先结束另一处通话。',VOICE_BUSY:'语音服务正在忙，稍后可以重试。',VOICE_IDLE:'一段时间没有听到你说话，已暂停收音。',VOICE_SESSION_LIMIT:'这次语音已结束，点击继续即可开始下一段。',VOICE_PLAYBACK_BLOCKED:'声音播放被暂停，点击继续重新连接。',VOICE_NETWORK_SLOW:'网络连续约十秒无法上传语音，已暂停收音。连接稳定后可继续。',VOICE_BROWSER_UNSUPPORTED:'当前环境无法启动语音，文字聊天仍可使用。',VOICE_CONFIRMATION_EXPIRED:'这条确认已过期，请重新说明。',VOICE_ACTION_FAILED:'操作未确认完成，请查看聊天记录后再试。',VOICE_CONTEXT_FAILED:'这次未能读取对话资料，请重试。',VOICE_CONTEXT_STALE:'本轮已经结束，请继续提问。',VOICE_ENDED:'通话已结束。'};
export function VoiceWaveIcon(){return <svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" aria-hidden="true"><path d="M4 10v4m4-7v10m4-14v18m4-15v12m4-9v6"/></svg>;}
export default function VoiceChatPanel({voice,onText}){
 const panel=useRef(null),previous=useRef(null);
 useEffect(()=>{previous.current=document.activeElement;panel.current?.focus();return()=>previous.current?.focus?.({preventScroll:true});},[]);
 const{state}=voice,intro=state.phase==='intro',paused=state.phase==='paused';
 const keydown=e=>{if(e.key==='Escape'){voice.minimize();onText?.();return;}if(e.key==='Tab'){const nodes=[...panel.current.querySelectorAll('button:not(:disabled)')];const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}};
 return <div className="af-voice-overlay" data-voice-phase={state.phase} data-voice-error={state.error||undefined} ref={panel} role="dialog" aria-modal="true" aria-label="语音聊天" tabIndex={-1} onKeyDown={keydown}>
  <div className="af-voice-top"><span>AI分身 · 语音</span><button type="button" onClick={voice.end} aria-label="结束语音聊天">×</button></div>
  <div className="af-voice-main">
   {['speaking','thinking'].includes(state.phase)?<button type="button" className={`af-voice-orb ${state.phase==='speaking'?'is-speaking':''}`} style={voiceLevelStyle(state)} aria-label="打断回答，我来说" onClick={()=>voice.engine.interrupt()}><VoiceWaveIcon/></button>:<div className={`af-voice-orb ${state.muted?'is-muted':''}`} style={voiceLevelStyle(state)} aria-hidden="true"><VoiceWaveIcon/></div>}
   <h2>{intro?'开启连续语音':labels[state.phase]||'语音聊天'}</h2>
   {intro?<p className="af-voice-intro">开启后可以连续交谈，也可点圆球立即打断。<br/>音频会发送至语音服务处理，应用不保存录音；文字保存在当前聊天。</p>:null}
   {!intro&&state.subtitle?<p className="af-voice-subtitle">{voiceSubtitle(state.subtitle)}</p>:null}
   {state.error?<p className="af-voice-error" role="status">{errors[state.error]||'语音暂时没有完成，收音已停止。可以点击继续，或返回文字聊天。'}</p>:null}

   {state.proposal?<section className="af-voice-confirm" aria-label="语音操作确认"><strong>{state.proposal.title}</strong><p>{state.proposal.text}</p><div><button type="button" onClick={voice.cancelProposal} disabled={state.confirming}>取消</button><button type="button" className="primary" onClick={voice.confirm} disabled={state.confirming}>{state.confirming?'正在保存…':'确认执行'}</button></div></section>:null}
  </div>
  <div className="af-voice-bottom">
   {intro||paused?<button type="button" className="af-voice-start" onClick={voice.start}>{intro?'开启语音':'继续语音'}</button>:<div className="af-voice-controls"><button type="button" aria-pressed={state.muted} onClick={voice.mute} disabled={state.inputSuspended||['permission','connecting'].includes(state.phase)}>{state.muted?'取消静音':'麦克风静音'}</button><button type="button" className="af-voice-end" onClick={voice.end}>结束</button></div>}
   <button type="button" className="af-voice-text" onClick={()=>{voice.minimize();onText?.();}}>缩小，与文字同屏</button>
   {!intro&&!paused?<small>{state.muted?'麦克风已关闭，AI仍可继续回答':'开口接话，也可点圆球打断 · 切到后台会暂停'}</small>:null}
  </div>
 </div>;
}

function voiceLevelStyle(state){const level=state.phase==='speaking'?state.playbackLevel:state.phase==='listening'&&!state.muted?state.level:0;return {'--voice-level':Math.min(1,Math.max(0,(level||0)*5))};}
export function VoiceChatBar({voice}) {
 const {state}=voice,paused=state.phase==='paused',intro=state.phase==='intro';
 const canInterrupt=['speaking','thinking'].includes(state.phase);
 return <section className="af-voice-bar" aria-label="同屏语音" data-voice-phase={state.phase} data-voice-error={state.error||undefined}>
  <div className="af-voice-bar-heading">
   <button type="button" className="af-voice-bar-activity" onClick={canInterrupt?()=>voice.engine.interrupt():voice.expand} aria-label={canInterrupt?'打断回答，我来说':'查看完整语音'}>
    <span className={`af-voice-meter ${state.muted?'is-muted':''}`} style={voiceLevelStyle(state)} aria-hidden="true"><VoiceWaveIcon/></span>
    <span className="af-voice-bar-status" role="status">{intro?'语音尚未开启':labels[state.phase]||'语音聊天'}{canInterrupt?<small>点此打断 · 我来说</small>:null}</span>
   </button>
   {state.muted?<span className="af-voice-bar-muted">收音已关闭</span>:null}
  </div>
  <div className="af-voice-bar-line">
   {paused||intro?<button type="button" className="af-voice-bar-mic" onClick={voice.start}><VoiceControlIcon name="mic"/>{intro?'开启':'重试'}</button>:<button type="button" className="af-voice-bar-mic" aria-label={state.muted?'取消静音':'麦克风静音'} aria-pressed={state.muted} onClick={voice.mute} disabled={state.inputSuspended||['permission','connecting'].includes(state.phase)}><VoiceControlIcon name={state.muted?'muted':'mic'}/>{state.muted?'开麦':'静音'}</button>}
   <button type="button" onClick={voice.expand} aria-label="展开语音"><VoiceControlIcon name="expand"/>展开</button><button type="button" className="af-voice-bar-end" onClick={voice.end} aria-label="结束语音聊天"><VoiceControlIcon name="end"/>结束</button>
  </div>
  {state.subtitle&&!paused?<p className="af-voice-bar-subtitle">{voiceSubtitle(state.subtitle)}</p>:null}
  {state.error?<p className="af-voice-bar-error" role="status">{errors[state.error]||'语音未完成，请重试。'}</p>:null}
  {state.proposal?<button type="button" className="af-voice-bar-proposal" onClick={voice.expand}>查看待确认操作</button>:null}
 </section>;
}

function VoiceControlIcon({name}){return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{name==='expand'?<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>:name==='end'?<path d="M5 9c3-4 11-4 14 0l2 4-4 2-2-3H9l-2 3-4-2z"/>:<><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 10v1a6 6 0 0 0 12 0v-1m-6 7v4m-3 0h6"/>{name==='muted'?<path d="m3 3 18 18"/>:null}</>}</svg>;}

function voiceSubtitle(text){if(parseMemoryReceiptMessage(text))return '请在对话中查看记忆保存结果。';const doc=decodeDocumentMessage(text);return doc?doc.data.text||doc.data.question||'正在读取资料':visibleMemoryText(text);}
