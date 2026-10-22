import { useEffect, useRef, useState, useMemo } from 'react';
import {createLearningRealtimeRecorder} from './realtimeRecorder.js';
import {createRealtimeUpload} from './realtimeClient.js';
import { createDictationRecorder } from '../dictationRecorder.js';
import { learningRequest as baseApi } from './client.js';
import './learning.css';
import PracticeStage from './PracticeStage.jsx';
import {nextLearningStep,matchFeedback} from './experience.js';
import {canStartTeacherAudio,loadCachedSpeech} from './playback.js';
const LEVELS=[['beginner','初级','从零开口'],['intermediate','中级','自在交流'],['advanced','高级','深入表达']];
const id=()=>crypto.randomUUID();
const labels={active:'进行中',paused:'已暂停',completed:'已完成',ended_early:'已结束'};
function SmallButton({children,...props}){return <button type="button" className="al-small" {...props}>{children}</button>;}
export default function LearningView({onBack,ownerId,onSessionExpired}){
 const api=useMemo(()=>((route,options={})=>baseApi(route,{...options,expectedAccountId:ownerId})),[ownerId]);
 const [dashboard,setDashboard]=useState(null),[cap,setCap]=useState(null),[error,setError]=useState(''),[level,setLevel]=useState('beginner');
 const [selected,setSelected]=useState(null),[persist]=useState(true),[view,setView]=useState(null),[busy,setBusy]=useState('');
 const [draft,setDraft]=useState(''),[voiceToken,setVoiceToken]=useState(null),[hint,setHint]=useState(''),[translation,setTranslation]=useState(false),[recording,setRecording]=useState(false),[seconds,setSeconds]=useState(0);
 const [textMode,setTextMode]=useState(false),[audioUrl,setAudioUrl]=useState(''),[playbackRate,setPlaybackRate]=useState(1),[ownAudioUrl,setOwnAudioUrl]=useState(''),[confirmDelete,setConfirmDelete]=useState(false);
 const [interest,setInterest]=useState('全部'),[minutes,setMinutes]=useState('不限');
 const [slowOperation,setSlowOperation]=useState(false);
 const [speechLoading,setSpeechLoading]=useState(false),[listenRate,setListenRate]=useState('normal');
 const realtimeUpload=useRef(null),recordingGeneration=useRef(0),activeOwner=useRef(ownerId);activeOwner.current=ownerId;
 const speechController=useRef(null),timing=useRef(null),stopTime=useRef(null);
 function markTiming(key){if(!timing.current)return;timing.current[key]=Math.round(performance.now()-timing.current.started);window.dispatchEvent(new CustomEvent('learning-timing',{detail:{...timing.current,started:undefined}}));}
 function stopPlayback(includeOwn=true){speechController.current?.abort();speechController.current=null;playRequest.current=null;audio.current?.pause();if(includeOwn)ownAudio.current?.pause();setSpeechLoading(false);}
 function cancelRecording(){recordingGeneration.current++;realtimeUpload.current?.cancel();realtimeUpload.current=null;recorder.current?.cancel();}
 function stopRecording(){stopTime.current=performance.now();recorder.current?.stop();}
 const [roundFeedback,setRoundFeedback]=useState(null);
 const [automaticVoice,setAutomaticVoice]=useState(true),[correctsTurnId,setCorrectsTurnId]=useState(null);
 const scrollArea=useRef(null);
 const speechCache=useRef(new Map()),playRequest=useRef(null),pendingAudio=useRef(null);
 const controller=useRef(null),recorder=useRef(null),audio=useRef(null),ownAudio=useRef(null),current=useRef(null),alive=useRef(true),blobUrls=useRef(new Set()),pendingTurn=useRef(null),startOperation=useRef(null);
 current.current=view;
 useEffect(()=>()=>{cancelRecording();},[ownerId]);
 useEffect(()=>{if(selected&&!view)void start();},[selected]);
 useEffect(()=>{if(scrollArea.current)scrollArea.current.scrollTop=0;},[view?.session.id,selected?.id]);
 const refresh=async()=>{const [d,c]=await Promise.all([api(),api('/capabilities')]);if(alive.current){setDashboard(d);setCap(c);if(d.preferredLevel)setLevel(d.preferredLevel);}};
 useEffect(()=>{alive.current=true;refresh().catch(e=>setError(e.message));return()=>{alive.current=false;controller.current?.abort();speechController.current?.abort();cancelRecording();audio.current?.pause();ownAudio.current?.pause();for(const url of blobUrls.current)URL.revokeObjectURL(url);const s=current.current?.session;if(s&&!s.persist)void api(`/sessions/${s.id}`,{method:'DELETE',body:{revision:s.revision},keepalive:true}).catch(()=>{});};},[]);
 useEffect(()=>{const interrupted=()=>{if(document.hidden){stopPlayback();playRequest.current=null;controller.current?.abort();audio.current?.pause();ownAudio.current?.pause();if(recorder.current?.active){cancelRecording();setRecording(false);setError('录音已中断，请回来后重新开始。已提交的练习记录保留。');}}};document.addEventListener('visibilitychange',interrupted);return()=>document.removeEventListener('visibilitychange',interrupted);},[]);

 function replaceUrl(blob,own=false){const value=URL.createObjectURL(blob);blobUrls.current.add(value);if(own){if(ownAudioUrl){URL.revokeObjectURL(ownAudioUrl);blobUrls.current.delete(ownAudioUrl);}setOwnAudioUrl(value);}else{if(audioUrl){URL.revokeObjectURL(audioUrl);blobUrls.current.delete(audioUrl);}setAudioUrl(value);}return value;}
 async function work(name,fn){
  if(controller.current)return;
  const ctrl=new AbortController();controller.current=ctrl;setBusy(name);setSlowOperation(false);setError('');
  let rejectStop;
  const stopped=new Promise((_,reject)=>{rejectStop=reject;});
  const onAbort=()=>rejectStop(ctrl.signal.reason||new DOMException('Cancelled','AbortError'));
  ctrl.signal.addEventListener('abort',onAbort,{once:true});
  const slowTimer=setTimeout(()=>{if(alive.current&&controller.current===ctrl)setSlowOperation(true);},10000);
  const timeoutTimer=setTimeout(()=>ctrl.abort(Object.assign(new Error('等待已超过30秒，本次处理已停止。请重试，已录好的声音会保留。'),{code:'LEARNING_OPERATION_TIMEOUT'})),30000);
  try{await Promise.race([Promise.resolve().then(()=>fn(ctrl.signal)),stopped]);}
  catch(e){
   if(controller.current!==ctrl)return;
   if(alive.current&&(!ctrl.signal.aborted||e.code==='LEARNING_OPERATION_TIMEOUT')){
    setError(e.message);
    if(e.recognition){setDraft(e.recognition.transcript);setVoiceToken(e.recognition.voiceToken);}
    if(e.code==='LEARNING_REVISION_CONFLICT'&&current.current){try{setView(await api(`/sessions/${current.current.session.id}`,{signal:ctrl.signal}));}catch{}}
    if(e.code==='ACCOUNT_CONTEXT_MISMATCH'||e.status===401)onSessionExpired?.();
   }else if(alive.current&&pendingAudio.current){setError('处理已取消，录音还在，可以重新处理。');}
  }finally{
   clearTimeout(slowTimer);clearTimeout(timeoutTimer);ctrl.signal.removeEventListener('abort',onAbort);
   if(controller.current===ctrl){if(alive.current){setBusy('');setSlowOperation(false);setRecording(false);}controller.current=null;}
  }
 }
 function clearAudio(includeOwn=false){if(includeOwn)pendingAudio.current=null;stopPlayback();speechCache.current.clear();audio.current?.pause();if(audioUrl){URL.revokeObjectURL(audioUrl);blobUrls.current.delete(audioUrl);}setAudioUrl('');if(includeOwn){ownAudio.current?.pause();if(ownAudioUrl){URL.revokeObjectURL(ownAudioUrl);blobUrls.current.delete(ownAudioUrl);}setOwnAudioUrl('');}}
 function apply(next){const previous=current.current;const last=next.turns.at(-1);if(previous?.session.id===next.session.id&&last&&last.id!==previous.turns.at(-1)?.id){const passed=next.lesson.kind==='foundation'?next.foundationStep>previous.foundationStep:!!last.reply.goalReached;const m=matchFeedback(last.transcript,previous.prompt?.example);const score=last.inputMode==='voice'&&!last.transcriptCorrected&&(!passed||m.score>=95)?m.score:null;setRoundFeedback({passed,score,title:passed?'这一小步，做到了！':last.reply.feedback.length?'差一点，试试这个说法':'继续，故事还在进行'});}else if(previous?.session.id!==next.session.id||last?.id===previous?.turns.at(-1)?.id){setRoundFeedback(null);}pendingAudio.current=null;clearAudio(current.current?.session.id!==next.session.id);setView(next);setHint('');setTranslation(next.session.level==='beginner');setDraft('');setVoiceToken(null);setCorrectsTurnId(null);pendingTurn.current=null;setConfirmDelete(false);}
 async function start(){await work('正在准备',async signal=>{startOperation.current ||=id();const next=await api('/sessions',{method:'POST',body:{lessonId:selected.id,level:selected.level,language:'en',persist,consentAI:true,operationId:startOperation.current},signal});apply(next);setSelected(null);startOperation.current=null;});}
 async function open(session){await work('正在恢复',async signal=>{let v=await api(`/sessions/${session.id}`,{signal});if(v.session.status==='paused')v=await api(`/sessions/${session.id}/action`,{method:'POST',body:{action:'resume',revision:v.session.revision},signal});apply(v);});}
 function loadSpeech(sessionId,text,signal){if(speechCache.current.size>=24&&!speechCache.current.has(text))speechCache.current.delete(speechCache.current.keys().next().value);return loadCachedSpeech(speechCache.current,text,()=>api(`/sessions/${sessionId}/speak`,{method:'POST',body:{text,rate:'normal'},signal,binary:true}),signal);}
 async function playReply(sessionId,text,rate,signal,measure=false){setPlaybackRate(rate==='slow'?0.8:1);playRequest.current=null;audio.current?.pause();ownAudio.current?.pause();const blob=await loadSpeech(sessionId,text,signal);if(signal.aborted)return;playRequest.current={signal,measure};replaceUrl(blob);if(measure)markTiming('ttsReadyMs');}
 function audioReady(event){const element=event.currentTarget;const request=playRequest.current;element.playbackRate=playbackRate;element.defaultPlaybackRate=playbackRate;element.preservesPitch=true;if(!canStartTeacherAudio({request,pageHidden:document.hidden,feedbackVisible:!!roundFeedback}))return;void element.play().catch(()=>{if(alive.current&&playRequest.current===request&&!request.signal.aborted&&!document.hidden)setError('声音已准备好，请点“听一遍”播放。');});}
 function finishReward(){}
 function startPlayback(sessionId,text,rate='normal',measure=false){
  stopPlayback();setError('');const ctrl=new AbortController();speechController.current=ctrl;setSpeechLoading(true);
  const timeout=setTimeout(()=>{if(speechController.current===ctrl&&alive.current){setError('声音等待超过30秒，已停止。可以重试，文字反馈保留。');stopPlayback();}},30000);
  ctrl.signal.addEventListener('abort',()=>clearTimeout(timeout),{once:true});
  void playReply(sessionId,text,rate,ctrl.signal,measure).catch(e=>{if(!ctrl.signal.aborted&&alive.current){setError(e.code==='ACCOUNT_CONTEXT_MISMATCH'||e.status===401?'登录状态已变化，请重新登录。':`文字已保留。${e.message||'声音暂时不可用。'} 可以再次点提示或听一遍。`);if(e.code==='ACCOUNT_CONTEXT_MISMATCH'||e.status===401)onSessionExpired?.();}}).finally(()=>{clearTimeout(timeout);if(speechController.current===ctrl&&alive.current)setSpeechLoading(false);});
 }
 function speak(text,rate=listenRate){if(text)startPlayback(view.session.id,text,rate);}
 async function requestHint(){stopPlayback();await work('正在准备提示',async signal=>{const r=await api(`/sessions/${view.session.id}/hint`,{method:'POST',body:{},signal});setHint(r.text);startPlayback(view.session.id,r.text);});}
 function firstAudio(){if(playRequest.current?.measure){markTiming('firstAudioMs');playRequest.current.measure=false;}}

 async function sendTurn(text,token,correction,signal){if(!pendingTurn.current||pendingTurn.current.text!==text||pendingTurn.current.correction!==correction)pendingTurn.current={text,correction,id:id()};setBusy(correction?'正在更正':'正在回应你');const next=await api(`/sessions/${current.current.session.id}/turn`,{method:'POST',body:{transcript:text,voiceToken:token,correctsTurnId:correction,clientTurnId:pendingTurn.current.id,revision:current.current.session.revision},signal});apply(next);if((token||correction)&&cap?.speechAvailable){setBusy('正在准备声音');try{await playReply(next.session.id,next.teacher.replyEn,'normal',signal);}catch(e){if(!signal.aborted)setError(`本轮回应已保存，声音暂时没有准备好。${e.message}`);}}}
 async function sendAudio(signal){
  const pending=pendingAudio.current;if(!pending||pending.sessionId!==current.current?.session.id)return;
  const ctrl=controller.current;let feedbackReceived=false;
  timing.current={started:stopTime.current??performance.now(),feedbackVisibleMs:null,firstAudioMs:null};
  const sample=timing.current;sample.uploadStartedMs=Math.round(performance.now()-sample.started);
  const showFeedback=response=>{
   signal.throwIfAborted();feedbackReceived=true;sample.server=response.timings||null;apply(response.result);
   // Keep the same authenticated request through TTS, but release the controls.
   if(controller.current===ctrl)controller.current=null;
   speechController.current=ctrl;setBusy('');setSlowOperation(false);setSpeechLoading(true);
   requestAnimationFrame(()=>{if(timing.current===sample&&alive.current)markTiming('feedbackVisibleMs');});
  };
  try{
   const upload=pending.realtime;pending.realtime=null;
   const response=upload?await upload.finish({signal,onFeedback:showFeedback}):await api(`/sessions/${pending.sessionId}/voice-turn?revision=${pending.revision}&clientTurnId=${encodeURIComponent(pending.id)}&stream=1`,{method:'POST',body:pending.blob,signal,onFeedback:showFeedback});
   if(realtimeUpload.current===upload)realtimeUpload.current=null;
   if(signal.aborted)return;if(!feedbackReceived)showFeedback(response);
   sample.server=response.timings||sample.server;
   if(response.audioBase64){const bytes=Uint8Array.from(atob(response.audioBase64),c=>c.charCodeAt(0));const blob=new Blob([bytes],{type:response.audioType||'audio/wav'});speechCache.current.set(response.result.teacher.replyEn,blob);setPlaybackRate(1);playRequest.current={signal,measure:true};replaceUrl(blob);markTiming('ttsReadyMs');}
   else setError('回应已保存，声音暂时不可用。可以点“听一遍”重试播报。');
  }catch(e){if(!feedbackReceived)throw e;if(alive.current&&(!signal.aborted||signal.reason?.code==='LEARNING_OPERATION_TIMEOUT'))setError('回应已保存，声音传输没有完成。可以点“听一遍”重试。');}
  finally{if(feedbackReceived&&speechController.current===ctrl&&alive.current)setSpeechLoading(false);}
 }

 async function record(){stopPlayback();timing.current=null;stopTime.current=null;if(draft.trim()&&!window.confirm('重新录音会替换还没发送的文字，确定重新说吗？'))return;playRequest.current=null;audio.current?.pause();ownAudio.current?.pause();setDraft('');setVoiceToken(null);setCorrectsTurnId(null);setError('');setSeconds(0);
  const generation=++recordingGeneration.current,ownerAtStart=ownerId;
  const isCurrent=()=>alive.current&&activeOwner.current===ownerAtStart&&recordingGeneration.current===generation;
  const sessionAtStart={...current.current.session},turnId=id(),useRealtime=!!cap?.realtimeAvailable&&automaticVoice;let upload=null;
  const createRecorder=useRealtime?createLearningRealtimeRecorder:createDictationRecorder;
  recorder.current=createRecorder({maxDurationMs:120000,onRecordingReady:()=>{if(!isCurrent())return;upload=createRealtimeUpload({api,sessionId:sessionAtStart.id,revision:sessionAtStart.revision,clientTurnId:turnId,onError:e=>{if(!isCurrent())return;setError(e.message);if(e.status===401||e.code==='ACCOUNT_CONTEXT_MISMATCH')onSessionExpired?.();}});realtimeUpload.current=upload;},onChunk:bytes=>{if(!isCurrent())return;try{upload?.push(bytes);}catch(e){if(isCurrent())setError(e.message);}},onStateChange:state=>{if(isCurrent())setRecording(state==='recording'||state==='requesting_permission');},onProgress:p=>{if(isCurrent())setSeconds(Math.floor((p.durationMs||0)/1000));},onError:e=>{upload?.cancel();if(isCurrent()){setError(e.message);setRecording(false);}},onAudioReady:({blob})=>{if(!isCurrent()){upload?.cancel();return;}replaceUrl(blob,true);setRecording(false);void work('正在听你说',async signal=>{if(automaticVoice){pendingAudio.current={blob,id:turnId,sessionId:sessionAtStart.id,revision:sessionAtStart.revision,realtime:upload};await sendAudio(signal);}else{const r=await api(`/sessions/${current.current.session.id}/transcribe`,{method:'POST',body:blob,signal});setDraft(r.transcript);setVoiceToken(r.voiceToken);}});}});
  await recorder.current.start();
 }
 async function submit(){if(!draft.trim())return;await work('正在回应你',signal=>sendTurn(draft,voiceToken,correctsTurnId,signal));}
 async function action(kind){if(kind!=='delete'&&draft.trim()&&!window.confirm('这句话还没有发送。结束练习会丢弃这句话，已提交的记录保留。确定结束吗？'))return;await work('正在保存',async signal=>{const next=await api(`/sessions/${view.session.id}/${kind==='delete'?'':'action'}`.replace(/\/$/,''),{method:kind==='delete'?'DELETE':'POST',body:{action:kind,revision:view.session.revision},signal});if(kind==='delete'){clearAudio(true);setView(null);setDraft('');setVoiceToken(null);setConfirmDelete(false);await refresh();}else apply(next);});}
 async function leavePractice(){stopPlayback();if(draft.trim()&&!window.confirm('这句话还没有发送。离开会丢弃这句话，已提交的练习记录不受影响。确定离开吗？'))return;cancelRecording();audio.current?.pause();ownAudio.current?.pause();await work('正在返回',async signal=>{if(!view.session.persist)await api(`/sessions/${view.session.id}`,{method:'DELETE',body:{revision:view.session.revision},signal});else if(view.session.status==='active')await api(`/sessions/${view.session.id}/action`,{method:'POST',body:{action:'pause',revision:view.session.revision},signal});clearAudio(true);setView(null);setDraft('');setHint('');await refresh();});}
 async function exportProgress(){await work('正在导出',async signal=>{const r=await api('/export',{signal});const url=URL.createObjectURL(new Blob([JSON.stringify(r.data,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='我的英语学习记录.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});}
 const blocked=!!busy||recording;
 const done=view&&['completed','ended_early'].includes(view.session.status);
 const nextStep=nextLearningStep(dashboard,level);
 const activePractice=!!view&&!done;
 const courses=dashboard?.catalog.filter(c=>c.level===level)||[];
 const reviewPoints=view?.turns.flatMap((t,index)=>t.reply.feedback.map(f=>({...f,turnId:t.id,number:index+1}))).slice(-3)||[];
 function showSource(turnId){const details=document.querySelector('.al-transcript-history');if(details)details.open=true;document.getElementById(`al-turn-${turnId}`)?.scrollIntoView({block:'center',behavior:'auto'});}
 async function practiceAgain(lesson){await work('正在准备下一次',async signal=>{if(current.current?.session&&!current.current.session.persist)await api(`/sessions/${current.current.session.id}`,{method:'DELETE',body:{revision:current.current.session.revision},signal});clearAudio(true);setView(null);setDraft('');setCorrectsTurnId(null);setSelected(lesson);startOperation.current=null;});}
 return <section className={`af-learning ${activePractice?'is-immersive':''}`} aria-label="学习英语">
  <header className="al-header"><button type="button" aria-label={view?'返回学习':'返回首页'} className="al-back" disabled={blocked} onClick={view?leavePractice:()=>selected?setSelected(null):onBack()}>‹</button><div><span className="al-eyebrow">AI分身 · 学习</span><strong>{view?view.lesson.title:'每天，开口多一点'}</strong></div><span className="al-language">EN<span>英语</span></span></header>
  <div ref={scrollArea} className={`al-scroll ${activePractice?'al-practice-scroll':''}`}>
  {error&&!activePractice&&<div role="alert" className="al-error">{error}<SmallButton onClick={()=>{setError('');if(!dashboard)refresh().catch(e=>setError(e.message));}}>重试 / 收起</SmallButton></div>}
  {!dashboard&&!error&&<p role="status">正在打开你的学习空间…</p>}
  {selected&&!view?<div className="al-onboarding"><div className="al-big-emoji">{selected.emoji}</div><h1>{selected.title}</h1><p>{selected.goal}</p>{!busy&&<button className="al-primary" onClick={start}>重新进入练习 →</button>}<SmallButton disabled={blocked} onClick={()=>setSelected(null)}>返回课程</SmallButton></div>:null}
  {!selected&&!view&&dashboard?<>
    <nav className="al-levels" aria-label="英语等级">{LEVELS.map(([key,label,sub])=><button key={key} aria-pressed={key===level} onClick={()=>setLevel(key)}><strong>{label}</strong><span>{sub}</span></button>)}</nav>
    <article className="al-continue-card"><span className="al-eyebrow">{nextStep.hasHistory?'你的进度已接上':'今天的第一小关'}</span><h1>{nextStep.session?'接着上次，开口就好':nextStep.hasHistory?'再解锁一句新表达':'从 Hello 开始闯关'}</h1><p>{nextStep.lesson?.emoji} {nextStep.lesson?.title} {nextStep.session?`· 已练 ${nextStep.session.turnCount} 轮`:''}</p><div className="al-progress-summary"><span>已完成 <b>{nextStep.completed}</b> 次练习</span><span>已交流 <b>{nextStep.attempts}</b> 轮</span></div><button className="al-primary" disabled={blocked||!nextStep.lesson} onClick={()=>{if(nextStep.session)open(nextStep.session);else{setSelected(nextStep.lesson);startOperation.current=null;}}}>{nextStep.session?'继续学习':nextStep.hasHistory?'开始下一关':'开始学习'} →</button></article>
    <p className="al-default-notice">进度自动保存。开始练习后，由AI与语音服务提供识别和陪练；录音不长期保存。</p>
    <div className="al-heading"><h2>选一个想去的情境</h2><span>每次 5—10 分钟</span></div>
    <div className="al-filters"><label>想练什么<select aria-label="练习兴趣" value={interest} onChange={e=>setInterest(e.target.value)}>{['全部','零基础开口','生活','旅行','工作','开口游戏'].map(x=><option key={x}>{x}</option>)}</select></label><label>今天有多久<select aria-label="建议练习时长" value={minutes} onChange={e=>setMinutes(e.target.value)}><option value="不限">不限</option><option value="5">5 分钟</option><option value="10">10 分钟</option></select></label></div>
    <div className="al-courses">{courses.filter(c=>c.id!=='hello'&&(interest==='全部'||c.category===interest)&&(minutes==='不限'||c.estimatedMinutes<=Number(minutes))).map(c=><button key={c.id} onClick={()=>{setSelected(c);startOperation.current=null;}}><span className="al-course-emoji" aria-hidden="true">{c.emoji}</span><strong>{c.title}</strong><span>{c.goal}</span><small>{c.category} · {c.estimatedMinutes} 分钟</small></button>)}</div>
    {!courses.some(c=>c.id!=='hello'&&(interest==='全部'||c.category===interest)&&(minutes==='不限'||c.estimatedMinutes<=Number(minutes)))&&<p className="al-muted">这个选择下暂时没有课程。可以换个兴趣或时长，也可以直接从上面的推荐开始。</p>}
    <div className="al-heading"><h2>你走过的小步</h2><SmallButton onClick={exportProgress} disabled={blocked}>导出记录</SmallButton></div><div className="al-stats"><div><strong>{dashboard.completed}</strong><span>完成练习</span></div><div><strong>{dashboard.independentAttempts}</strong><span>独立口语尝试</span></div></div><p className="al-muted">这是练习记录，不是能力等级或发音分数。换一天、换个情境还能说出来，才说明越来越会用。</p>
    {!!dashboard.reviews.length&&<div className="al-reviews"><h3>回来再用一次</h3>{dashboard.reviews.map(r=><button key={r.lessonId+r.level} onClick={()=>setSelected(dashboard.catalog.find(c=>c.id===r.lessonId&&c.level===r.level))}><span>{r.title}</span><small>{r.due?'可以复习了':new Date(r.dueAt).toLocaleDateString('zh-CN')+' 再试试'} →</small></button>)}</div>}
    {!!dashboard.expressions?.length&&<details className="al-expression-list"><summary>值得再用的表达（{dashboard.expressions.length}）</summary>{dashboard.expressions.map(item=><article key={item.id}><p lang="en">{item.text}</p><small>{item.reasonZh}</small><small>{item.review?.passed?'已复习通过：不同日期、不同情境各有一次独立口语记录。':'还在练习中。换一天、换个情境再用一次。'}</small>{item.review?.dueAt&&<small>建议复习：{new Date(item.review.dueAt).toLocaleDateString('zh-CN')}</small>}<div>{item.review?.sources.map((source,index)=><SmallButton key={source.turnId} onClick={async()=>{await open(dashboard.sessions.find(s=>s.id===source.sessionId));requestAnimationFrame(()=>showSource(source.turnId));}}>查看第 {index+1} 次口语依据</SmallButton>)}<SmallButton onClick={()=>open(dashboard.sessions.find(s=>s.id===item.sessionId))}>回到原练习</SmallButton><SmallButton onClick={()=>{setSelected(dashboard.catalog.find(c=>c.id===item.lessonId&&c.level===item.level));startOperation.current=null;}}>再用一次</SmallButton></div></article>)}</details>}{!!dashboard.sessions.length&&<details className="al-history"><summary>学习记录（{dashboard.sessions.length}）</summary>{dashboard.sessions.map(s=><button key={s.id} onClick={()=>open(s)}><span>{dashboard.catalog.find(c=>c.id===s.lessonId&&c.level===s.level)?.title} · {LEVELS.find(l=>l[0]===s.level)?.[1]}</span><small>{labels[s.status]} · {new Date(s.updatedAt).toLocaleDateString('zh-CN')} →</small></button>)}</details>}
  </>:null}
  {view?<>
    {!activePractice&&<div className="al-session-meta"><span>{LEVELS.find(l=>l[0]===view.session.level)?.[1]} · {view.session.persist?'进度已保存':'本次不保存'}</span><span>{view.lesson.kind==='foundation'?`${Math.min(view.foundationStep,3)} / 3 小步`:`已交流 ${view.session.turnCount} 轮`}</span></div>}
    {!activePractice&&<p className="al-goal">这次的小目标：{view.lesson.goal}</p>}
    {done?<article className="al-finish"><div className="al-big-emoji">🌱</div><h1>{view.session.status==='completed'?'又迈出了一小步':'今天先练到这里'}</h1><p>{view.session.goalReached?'本次目标已完成。下一次换个情境再试，让它变成自己的表达。':'这次练习已记录。休息一下，随时可以重新来。'}</p><div className="al-stats"><div><strong>{view.session.turnCount}</strong><span>交流轮次</span></div><div><strong>{view.session.independentCount}</strong><span>独立口语尝试</span></div></div><section className="al-end-review"><h2>带走这次的一小步</h2>{reviewPoints.length?reviewPoints.map((f,i)=><article className="al-feedback" key={i}><span>刚才你说：<q lang="en">{f.original}</q></span><strong lang="en">{f.suggestion}</strong><p>{f.reasonZh}</p><SmallButton onClick={()=>showSource(f.turnId)}>回看第 {f.number} 轮原话</SmallButton></article>):<p>这次没有需要展示的语言修改建议。回听自己的表达，下一次试着少看一点提示。</p>}<SmallButton disabled={blocked} onClick={()=>practiceAgain(view.lesson)}>再练一次，试着少看提示</SmallButton><SmallButton disabled={blocked} onClick={()=>practiceAgain(dashboard.catalog.find(c=>c.level===view.session.level&&c.kind==='scenario'&&c.id!==view.lesson.id))}>换个情境再试</SmallButton></section><button className="al-primary" onClick={leavePractice} disabled={blocked}>回到学习</button></article>:<>
      <PracticeStage view={view} cap={cap} busy={busy} recording={recording} seconds={seconds} translation={translation} setTranslation={setTranslation} speak={speak} audio={audio} audioUrl={audioUrl} audioReady={audioReady} record={record} stop={stopRecording} cancelRecord={()=>{cancelRecording();setRecording(false);}} leave={leavePractice} hint={hint} requestHint={requestHint} speechLoading={speechLoading} listenRate={listenRate} setListenRate={setListenRate} stopPlayback={stopPlayback} firstAudio={firstAudio} feedback={roundFeedback} error={error} retryAudio={()=>work('正在重新处理录音',sendAudio)} canRetry={pendingAudio.current?.sessionId===view.session.id} controller={controller} draft={draft} setDraft={setDraft} submit={submit} correctsTurnId={correctsTurnId} setCorrectsTurnId={setCorrectsTurnId} textMode={textMode} setTextMode={setTextMode} ownAudio={ownAudio} ownAudioUrl={ownAudioUrl} automaticVoice={automaticVoice} setAutomaticVoice={setAutomaticVoice} complete={()=>action('complete')} end={()=>action('end')} finishReward={finishReward}/>
    </>}
    {done&&!!view.turns.length&&<details className="al-transcript-history"><summary>回看刚才的对话（{view.turns.length} 轮）</summary>{view.turns.map(t=><div key={t.id} id={`al-turn-${t.id}`}><p lang="en"><b>我：</b>{t.transcript}</p><p lang="en"><b>AI：</b>{t.reply.replyEn}</p><small>{t.inputMode==='text'?'文字练习':t.transcriptCorrected?'已修改识别文字':t.hint!=='none'?'有提示的口语练习':'本次口语尝试'}</small></div>)}</details>}
    {done&&<div className="al-delete">{confirmDelete?<><p>删除这次练习及文字记录？此操作无法撤销。</p><SmallButton disabled={blocked} onClick={()=>action('delete')}>确认删除本次练习</SmallButton><SmallButton onClick={()=>setConfirmDelete(false)}>保留</SmallButton></>:<SmallButton disabled={blocked} onClick={()=>setConfirmDelete(true)}>删除本次练习</SmallButton>}</div>}
  </>:null}
  </div>
  {busy&&!activePractice&&<div className="al-status" role="status"><span>{slowOperation?'等待较久，你可以取消后重试。':`${busy}…`}</span><button onClick={()=>{controller.current?.abort();}}>取消</button></div>}
 </section>;
}
