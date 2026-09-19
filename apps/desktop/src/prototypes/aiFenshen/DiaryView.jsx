import { useEffect, useMemo, useRef, useState } from 'react';
import { createDiaryClient, diaryIsoToLocal, diaryLocalToIso, diaryTimezoneLabel } from '../../lib/diaryClient.js';
import './diary.css';

const DEVICE_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
const today = () => diaryIsoToLocal(new Date().toISOString(), DEVICE_ZONE).slice(0, 10);
const dateLabel = date => date ? date.replace(/-/g, '.') : '未注明日期';
const key = () => globalThis.crypto?.randomUUID?.() || `diary-${Date.now()}-${Math.random().toString(36).slice(2)}`;
function draftOf(entry) {
  const timezone = entry?.reminder?.timezone || DEVICE_ZONE;
  return { title:entry?.title || '', body:entry?.body || '', occurredOn:entry?.occurredOn || today(),
    hasReminder:!!entry?.reminder && entry.reminder.status !== 'cancelled',
    reminderAt:entry?.reminder?.scheduledAt ? diaryIsoToLocal(entry.reminder.scheduledAt, timezone) : `${today()}T09:00`,
    timezone, repeat:entry?.reminder?.repeat || 'none' };
}
function reminderLabel(reminder) {
  if (!reminder?.scheduledAt) return '';
  return `${diaryIsoToLocal(reminder.scheduledAt, reminder.timezone || DEVICE_ZONE).replace('T',' ')} · ${diaryTimezoneLabel(reminder.timezone || DEVICE_ZONE)}`;
}
function downloadJson(data, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json;charset=utf-8'}));
  const anchor=document.createElement('a'); anchor.href=url; anchor.download=filename; document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export default function DiaryView({onBack,onStartChat,initialEntryId,onChanged}) {
  const client=useMemo(()=>createDiaryClient(),[]);
  const [entries,setEntries]=useState([]), [selected,setSelected]=useState(null);
  const [filters,setFilters]=useState({date:'',q:''}), [query,setQuery]=useState({date:'',q:''});
  const [loading,setLoading]=useState(true), [busy,setBusy]=useState(false), [error,setError]=useState(''), [notice,setNotice]=useState('');
  const [catalog,setCatalog]=useState(false), [editor,setEditor]=useState(null), [draft,setDraft]=useState(null);
  const [conflict,setConflict]=useState(null), [dialog,setDialog]=useState(null), [snoozeAt,setSnoozeAt]=useState('');
  const fetchSequence=useRef(0), firstLoad=useRef(true), touch=useRef(null), paper=useRef(null), bookRoot=useRef(null), dialogRef=useRef(null), retry=useRef(null), lastRequestedId=useRef(initialEntryId), lastPageId=useRef(null), pageDirection=useRef(1);
  const dirty=!!draft && JSON.stringify(draft)!==editor?.baseline;
  const selectedIndex=entries.findIndex(entry=>entry.id===selected?.id);
  async function refresh(activeFilters=filters, preferredId) {
    const sequence=++fetchSequence.current; setLoading(true); setError('');
    try {
      const next=await client.list(Object.fromEntries(Object.entries(activeFilters).filter(([,value])=>value)));
      const wanted=preferredId || (firstLoad.current ? initialEntryId : null);
      let nextSelected=next.find(entry=>entry.id===wanted) || (!wanted ? next[0] : null);
      if (wanted && !nextSelected) nextSelected=await client.get(wanted);
      if(sequence!==fetchSequence.current)return;
      firstLoad.current=false; setEntries(next); setSelected(nextSelected || null);
    } catch(cause) { if(sequence===fetchSequence.current)setError(cause.message); }
    finally { if(sequence===fetchSequence.current)setLoading(false); }
  }
  useEffect(()=>{refresh(filters); return ()=>{fetchSequence.current+=1;};},[filters,client]);
  useEffect(()=>{if(paper.current)paper.current.scrollTop=0;if(bookRoot.current)bookRoot.current.scrollTop=0;},[selected?.id,editor?.id]);
  useEffect(()=>{
    if(initialEntryId===lastRequestedId.current || busy)return;
    lastRequestedId.current=initialEntryId;
    if(!initialEntryId || (initialEntryId===selected?.id && !editor))return;
    guard(()=>{setCatalog(false);refresh(filters,initialEntryId);});
  },[initialEntryId,busy,selected?.id,dirty]);
  useEffect(()=>{
    const previous=lastPageId.current;
    lastPageId.current=selected?.id || null;
    if(editor || !previous || !selected?.id || previous===selected.id || !paper.current?.animate)return undefined;
    const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const animation=paper.current.animate(reduced ? [{opacity:.82},{opacity:1}] : [
      {opacity:.48,transform:`perspective(1200px) rotateY(${pageDirection.current * -4}deg) translateX(${pageDirection.current * 9}px)`,transformOrigin:'left center'},
      {opacity:1,transform:'perspective(1200px) rotateY(0deg) translateX(0)',transformOrigin:'left center'}
    ],{duration:reduced ? 70 : 260,easing:'cubic-bezier(.2,.65,.3,1)'});
    return()=>animation.cancel();
  },[selected?.id,!!editor]);

  useEffect(()=>{
    if(!dialog)return undefined;
    const previous=document.activeElement;
    const trap=event=>{
      if(event.key==='Escape' && !busy){event.preventDefault();setDialog(null);}
      if(event.key!=='Tab')return;
      const controls=[...dialogRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
      const first=controls[0], last=controls[controls.length-1];
      if(event.shiftKey && document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus();}
    };
    document.addEventListener('keydown',trap);return()=>{document.removeEventListener('keydown',trap);previous?.focus?.();};
  },[dialog,busy]);
  useEffect(()=>{
    if(!dirty)return undefined;
    const prevent=event=>{event.preventDefault();event.returnValue='';};
    window.addEventListener('beforeunload',prevent); return()=>window.removeEventListener('beforeunload',prevent);
  },[dirty]);
  function guard(action) { if(busy)return; if(dirty)setDialog({kind:'discard',action}); else {setEditor(null);setDraft(null);setConflict(null);action();} }
  function startEdit(entry) {
    const next=draftOf(entry);setEditor({id:entry?.id || null,revision:entry?.revision,baseline:JSON.stringify(next)});setDraft(next);setConflict(null);setCatalog(false);setError('');setNotice('');retry.current=null;
  }
  function change(field,value) {setDraft(current=>({...current,[field]:value}));setNotice('');}
  function choose(entry) {guard(()=>{pageDirection.current=entries.findIndex(item=>item.id===entry.id)>=selectedIndex?1:-1;setSelected(entry);setCatalog(false);setError('');setNotice('');});}
  function flip(direction) {if(editor || busy || loading)return; const next=entries[selectedIndex+direction];if(next)choose(next);}
  async function save(event) {
    event.preventDefault(); if(busy || conflict)return; setBusy(true);setError('');setNotice('');
    try {
      if(!draft.body.trim())throw new Error('先写下一点内容，再保存这篇日记。');
      const input={title:draft.title,body:draft.body,occurredOn:draft.occurredOn,reminder:draft.hasReminder ? {scheduledAt:diaryLocalToIso(draft.reminderAt,draft.timezone),timezone:draft.timezone,repeat:draft.repeat} : null};
      let saved;
      if(editor.id)saved=await client.update(editor.id,{...input,revision:editor.revision});
      else {
        const signature=JSON.stringify(input);if(retry.current?.signature!==signature)retry.current={signature,id:key()};
        saved=await client.create({...input,source:{kind:'manual'},idempotencyKey:retry.current.id});
      }
      setEditor(null);setDraft(null);setConflict(null);setSelected(saved);await refresh(filters,saved.id);
      setNotice(`日记已保存${saved.reminder && saved.reminder.status !== 'completed' ? `，提醒：${reminderLabel(saved.reminder)}` : ''}。`);onChanged?.();
    } catch(cause) {
      setError(cause.message);
      if(cause.code==='VERSION_CONFLICT' && editor.id) {
        setConflict({loading:true});
        try {setConflict({entry:await client.get(editor.id)});} catch {setConflict({unavailable:true});}
      }
    } finally {setBusy(false);}
  }
  async function performDelete() {
    setBusy(true);setError('');
    try {await client.remove(selected.id,selected.revision);setDialog(null);setEntries(current=>current.filter(entry=>entry.id!==selected.id));setSelected(entries.find(entry=>entry.id!==selected.id) || null);setNotice('日记已删除，关联提醒已取消。');onChanged?.();}
    catch(cause){setError(cause.message);setDialog(null);}finally{setBusy(false);}
  }
  async function reminderAction(action) {
    setBusy(true);setError('');setNotice('');
    try {
      const saved=await client.reminderAction(selected.id,{action,revision:selected.revision,...(action==='snooze'?{scheduledAt:diaryLocalToIso(snoozeAt,selected.reminder.timezone || DEVICE_ZONE)}:{})});
      setSelected(saved);setEntries(current=>current.map(entry=>entry.id===saved.id?saved:entry));setDialog(null);
      setNotice(action==='snooze'?`已改为 ${reminderLabel(saved.reminder)} 提醒。`:saved.reminder?.repeat==='yearly' && saved.reminder?.status!=='completed'?`本次已完成，下次提醒：${reminderLabel(saved.reminder)}。`:'提醒已完成。');onChanged?.();
    }catch(cause){setError(cause.message);}finally{setBusy(false);}
  }
  async function exportAll() {setBusy(true);setError('');try{downloadJson(await client.exportAll(),`AI分身-日记-${today()}.json`);setNotice('日记导出文件已生成。');}catch(cause){setError(cause.message);}finally{setBusy(false);}}
  const reminder=selected?.reminder;
  return <main className="af-diary" data-testid="feature-diary" ref={bookRoot}>
    <header className="af-diary-topbar">
      <button type="button" onClick={()=>guard(onBack)} disabled={busy} className="af-diary-back" aria-label="返回首页">‹ <span>返回首页</span></button>
      <div className="af-diary-brand"><span aria-hidden="true">▤</span><h1>日记</h1><small>把生活，好好记下来</small></div>
      <button type="button" className="af-diary-primary" onClick={()=>guard(()=>startEdit(null))} disabled={busy}>＋ 写一篇</button>
    </header>
    <div className="af-diary-mobile-tools"><button type="button" onClick={()=>guard(()=>setCatalog(!catalog))} aria-expanded={catalog}>日期与目录</button><span>{entries.length} 篇记录</span></div>
    {notice && <p className="af-diary-notice" role="status">{notice}</p>}
    {error && <div className="af-diary-error" role="alert">{error}{!editor && !dialog && <button type="button" disabled={busy} onClick={()=>refresh(filters,selected?.id)}>重新读取</button>}</div>}
    <section className={`af-diary-book ${catalog?'is-catalog-open':''} ${editor?'is-editing':''}`} aria-label="我的日记本">
      <aside className="af-diary-catalog" aria-label="日记目录">
        <div className="af-diary-page-heading"><span>我的日记本</span><small>目录 · {entries.length} 篇</small></div>
        <form className="af-diary-search" onSubmit={event=>{event.preventDefault();guard(()=>setFilters({...query}));}}>
          <label><span>寻找一段记忆</span><input type="search" placeholder="搜索标题或原文" aria-label="搜索日记" value={query.q} onChange={event=>setQuery(current=>({...current,q:event.target.value}))}/></label>
          <label><span>事件日期</span><input type="date" aria-label="按事件日期查询" value={query.date} onChange={event=>setQuery(current=>({...current,date:event.target.value}))}/></label>
          <div><button type="submit" disabled={busy}>查找日记</button>{(filters.date || filters.q) && <button type="button" disabled={busy} onClick={()=>guard(()=>{setQuery({date:'',q:''});setFilters({date:'',q:''});})}>查看全部</button>}</div>
        </form>
        <nav className="af-diary-index" aria-label="按日期选择日记">
          {loading?<p className="af-diary-muted" role="status">正在翻开日记本…</p>:entries.length?entries.map(entry=><button type="button" key={entry.id} aria-current={selected?.id===entry.id?'page':undefined} onClick={()=>choose(entry)} disabled={busy}>
            <time dateTime={entry.occurredOn}>{dateLabel(entry.occurredOn)}</time><strong>{entry.title || '无标题日记'}</strong><span>{entry.body?.slice(0,72)}</span>{entry.reminder?.status==='pending' && <small>有约定提醒</small>}
          </button>):<p className="af-diary-muted">{filters.date||filters.q?'没有找到匹配的日记。试试其他日期或关键词。':'这里会按日期收好你的每一篇日记。'}</p>}
        </nav>
        <footer className="af-diary-catalog-footer"><button type="button" onClick={exportAll} disabled={busy}>导出全部日记</button><button type="button" onClick={()=>guard(onStartChat)} disabled={busy}>回到对话记录</button></footer>
      </aside>
      <article className="af-diary-paper" ref={paper} onTouchStart={event=>{if(!editor && !dialog && !/INPUT|TEXTAREA|BUTTON|SELECT/.test(event.target.tagName))touch.current={x:event.touches[0].clientX,y:event.touches[0].clientY};else touch.current=null;}} onTouchEnd={event=>{const start=touch.current;touch.current=null;if(!start || editor)return;const dx=event.changedTouches[0].clientX-start.x,dy=event.changedTouches[0].clientY-start.y;if(Math.abs(dx)>80 && Math.abs(dx)>Math.abs(dy)*1.6)flip(dx<0?1:-1);}} aria-label={editor?'书写日记':'日记原文'}>
        {editor ? <form className="af-diary-editor" onSubmit={save}>
          <div className="af-diary-page-heading"><span>{editor.id?'编辑这一篇':'新的一页'}</span><small>{dirty?'草稿尚未保存':'准备书写'}</small></div>
          <label className="af-diary-date-field"><span>事件日期</span><input required type="date" value={draft.occurredOn} disabled={busy} onChange={event=>change('occurredOn',event.target.value)}/></label>
          <label className="af-diary-title-field"><span className="af-diary-sr">日记标题</span><input maxLength={200} placeholder="给这一页起个名字（选填）" value={draft.title} disabled={busy} onChange={event=>change('title',event.target.value)}/></label>
          <label className="af-diary-body-field"><span className="af-diary-sr">日记原文</span><textarea required maxLength={30000} placeholder={'今天，想记住什么？\n在这里写下原文，也可以用键盘的手写输入。'} value={draft.body} disabled={busy} onChange={event=>change('body',event.target.value)}/></label>
          <div className="af-diary-word-count">{draft.body.length.toLocaleString()} / 30,000 字</div>
          <fieldset className="af-diary-reminder-edit" disabled={busy}><legend>为这件事留一个提醒</legend>
            <label className="af-diary-check"><input type="checkbox" checked={draft.hasReminder} onChange={event=>change('hasReminder',event.target.checked)}/><span>到时候提醒我</span></label>
            {draft.hasReminder && <><label><span>提醒日期与时间</span><input type="datetime-local" required value={draft.reminderAt} onChange={event=>change('reminderAt',event.target.value)}/></label><label><span>时区</span><select value={draft.timezone} onChange={event=>change('timezone',event.target.value)}>{[...new Set([DEVICE_ZONE,draft.timezone,'Asia/Shanghai','Asia/Hong_Kong','Asia/Tokyo','Europe/London','America/New_York','America/Los_Angeles','UTC'])].map(zone=><option key={zone} value={zone}>{diaryTimezoneLabel(zone)}</option>)}</select></label><label><span>重复</span><select value={draft.repeat} onChange={event=>change('repeat',event.target.value)}><option value="none">仅这一次</option><option value="yearly">每年这一天</option></select></label><small>默认 09:00；以这里显示的日期、时间和时区为准。</small></>}
          </fieldset>
          {conflict && <section className="af-diary-conflict" aria-label="核对并发修改"><h3>草稿已保留，请核对最新内容</h3>{conflict.entry?<><p>最新原文 · {dateLabel(conflict.entry.occurredOn)} · {conflict.entry.title || '无标题'}</p><pre>{conflict.entry.body}</pre>{conflict.entry.reminder && <p>最新提醒：{reminderLabel(conflict.entry.reminder)} · {conflict.entry.reminder.status==='completed'?'已完成':conflict.entry.reminder.status==='cancelled'?'已取消':'待提醒'}</p>}<p>你的草稿仍在上方。核对并修改后，再确认保存。</p><button type="button" onClick={()=>{setEditor(current=>({...current,revision:conflict.entry.revision}));setConflict(null);setError('');setNotice('已使用最新版本号，请核对上方草稿后点击保存。');}}>已核对，继续编辑当前草稿</button></>:<p>{conflict.loading?'正在读取最新原文…':'最新原文暂时无法读取。请先导出草稿，再稍后重试。'}</p>}<button type="button" onClick={()=>downloadJson(draft,`日记草稿-${today()}.json`)}>导出当前草稿</button></section>}
          <div className="af-diary-editor-actions"><button type="button" disabled={busy} onClick={()=>guard(()=>{})}>取消</button><button type="submit" disabled={busy || !!conflict} className="af-diary-primary">{busy?'正在保存…':'保存日记'}</button></div>
        </form> : loading ? <div key="diary-loading" className="af-diary-empty" role="status"><span aria-hidden="true">▤</span><h2>正在翻开日记本</h2><p>稍等片刻，你的记录就会出现在这里。</p></div> : selected ? <>
          <div key="diary-entry-heading" className="af-diary-page-heading"><span>生活的记录</span><small>{selectedIndex>=0?`${String(selectedIndex+1).padStart(2,'0')} / ${String(entries.length).padStart(2,'0')}`:'当前日记'}</small></div>
          <time className="af-diary-entry-date" dateTime={selected.occurredOn}>{dateLabel(selected.occurredOn)}</time>
          <h2 className="af-diary-entry-title">{selected.title || '无标题日记'}</h2>
          <p className="af-diary-entry-origin">记录于 {selected.createdAt ? diaryIsoToLocal(selected.createdAt,DEVICE_ZONE).replace('T',' ') : '—'}{selected.source?.kind==='conversation'?' · 来自主对话':' · 自主书写'}</p>
          <div className="af-diary-original">{selected.body}</div>
          {reminder && reminder.status!=='cancelled' && <section className="af-diary-reminder"><div><span className="af-diary-reminder-dot" aria-hidden="true"/><strong>{reminder.status==='completed'?'这件事已完成':'留给未来的提醒'}</strong></div><p>{reminderLabel(reminder)}</p><small>{reminder.repeat==='yearly'?'每年这一天':'仅这一次'}</small>{reminder.status!=='completed' && <div className="af-diary-reminder-actions"><button type="button" disabled={busy} onClick={()=>reminderAction('complete')}>标记完成</button><button type="button" disabled={busy} onClick={()=>{setSnoozeAt(diaryIsoToLocal(new Date(Date.now()+86400000).toISOString(),reminder.timezone || DEVICE_ZONE).slice(0,10)+'T09:00');setDialog({kind:'snooze'});}}>稍后提醒</button></div>}</section>}
          <div className="af-diary-entry-actions"><button type="button" disabled={busy} onClick={()=>startEdit(selected)}>编辑原文</button><button type="button" className="af-diary-delete" disabled={busy} onClick={()=>setDialog({kind:'delete'})}>删除这篇</button></div>
        </> : <div className="af-diary-empty"><span aria-hidden="true">✎</span><small>属于你的一本日记</small><h2>{filters.date||filters.q?'这一页，还没有记录':'从今天，写下第一篇'}</h2><p>{filters.date||filters.q?'换个日期或关键词，寻找你记下的故事。':'记住一段经历、一句约定，\n或一个不想忘记的普通瞬间。'}</p><button type="button" className="af-diary-primary" onClick={()=>startEdit(null)}>写下第一篇</button><button type="button" onClick={onStartChat}>也可以在对话中告诉我</button></div>}
      </article>
    </section>
    {!editor && selected && <nav className="af-diary-pagination" aria-label="逐篇翻页"><button type="button" disabled={busy || loading || selectedIndex<=0} onClick={()=>flip(-1)}>‹ 上一篇</button><span>{selectedIndex>=0?`第 ${selectedIndex+1} 篇，共 ${entries.length} 篇`:'日记原文'}<small>左右轻滑翻篇</small></span><button type="button" disabled={busy || loading || selectedIndex<0 || selectedIndex>=entries.length-1} onClick={()=>flip(1)}>下一篇 ›</button></nav>}
    {dialog && <div className="af-diary-dialog-backdrop"><section className="af-diary-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="diary-dialog-title">
      <h2 id="diary-dialog-title">{dialog.kind==='delete'?'删除这篇日记？':dialog.kind==='discard'?'离开前，保留这份草稿？':'稍后提醒我'}</h2>
      {dialog.kind==='delete'?<p>删除后，这篇原文将不再出现在日记中，关联的提醒也会一并取消。此操作无法撤销。</p>:dialog.kind==='discard'?<p>当前修改尚未保存。继续编辑可保留草稿；放弃后将无法恢复这些修改。</p>:<label><span>新的提醒日期与时间</span><input autoFocus type="datetime-local" value={snoozeAt} onChange={event=>setSnoozeAt(event.target.value)}/><small>{diaryTimezoneLabel(reminder?.timezone || DEVICE_ZONE)}</small></label>}
      {error && dialog.kind==='snooze' && <p role="alert">{error}</p>}
      <div><button autoFocus={dialog.kind!=='snooze'} type="button" disabled={busy} onClick={()=>setDialog(null)}>{dialog.kind==='discard'?'继续编辑':'取消'}</button><button type="button" disabled={busy || (dialog.kind==='snooze' && !snoozeAt)} className={dialog.kind==='delete'?'af-diary-danger':'af-diary-primary'} onClick={()=>{if(dialog.kind==='delete')performDelete();else if(dialog.kind==='snooze')reminderAction('snooze');else {const action=dialog.action;setDialog(null);setEditor(null);setDraft(null);setConflict(null);action();}}}>{busy?'正在处理…':dialog.kind==='delete'?'确认删除并取消提醒':dialog.kind==='discard'?'放弃草稿':'确认延期'}</button></div>
    </section></div>}
  </main>;
}
