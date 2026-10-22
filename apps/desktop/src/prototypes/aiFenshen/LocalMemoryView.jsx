import { useEffect, useState } from 'react';
import { useLocalMemory } from './LocalMemoryContext.jsx';
import { memoryErrorText } from './localMemoryClient.js';
import './localMemory.css';
const newId = () => crypto.randomUUID();
export default function LocalMemoryView({ onBack }) {
  const context = useLocalMemory();
  const [items, setItems] = useState([]), [query, setQuery] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false), [editing, setEditing] = useState(null), [text, setText] = useState(''), [confirming, setConfirming] = useState(null), [next, setNext] = useState(null);
  async function load(offset = 0) {
    setBusy(true); setError('');
    try { const result = await context.client.execute({ operation:'list', text:query, offset }); setItems(old => offset ? [...old, ...result.items] : result.items); setNext(result.nextOffset); }
    catch (e) { setError(memoryErrorText(e)); } finally { setBusy(false); }
  }
  useEffect(() => { let alive = true; setBusy(true); context.client.execute({operation:'list'}).then(result => { if(alive){setItems(result.items);setNext(result.nextOffset)} }).catch(e => {if(alive)setError(memoryErrorText(e))}).finally(()=>{if(alive)setBusy(false)}); return()=>{alive=false}; }, [context.client]);
  async function change(command) {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await context.client.execute(command);
      if (result.status === 'confirmation_required') { setConfirming(result); return; }
      if (result.status === 'rejected') { setError('这类秘密信息不能保存为长期记忆。'); return; }
      if (!['corrected','deleted','stored'].includes(result.status)) throw new Error('LOCAL_MEMORY_FAILED');
      setEditing(null);setConfirming(null);setNotice(result.status === 'deleted' ? '已删除这条长期记忆。原始聊天和文件仍保留。' : '记忆已更新，之后使用新内容。');await load();
    } catch(e){setError(memoryErrorText(e))} finally{setBusy(false)}
  }
  return <main className="af-local-memory" aria-label="长期记忆管理">
    <header><button type="button" onClick={onBack}>返回</button><h1>长期记忆</h1></header>
    <p>只保存您明确授权的内容。记忆加密保存在这台设备，模型更换不会改变记录。</p>
    <form onSubmit={e=>{e.preventDefault();void load()}}><input aria-label="搜索长期记忆" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索记忆"/><button disabled={busy}>搜索</button></form>
    {busy?<p role="status">正在读取或保存…</p>:null}{error?<p role="alert">{error}</p>:null}{notice?<p role="status">{notice}</p>:null}
    {!busy&&!error&&!items.length?<p>暂无匹配的长期记忆。可以在主对话中说“请记住……”来保存。</p>:null}
    {items.map(item=><article key={item.memoryId}><p>{item.text}</p><small>来源：您主动保存的内容 · {new Date(item.updatedAt).toLocaleString('zh-CN')}</small>
      <div><button type="button" disabled={busy} onClick={()=>{setEditing({item,operation:'correct'});setText(item.text);setConfirming(null)}}>纠正</button><button type="button" disabled={busy} onClick={()=>{setEditing({item,operation:'delete'});setConfirming(null)}}>删除</button></div>
      {editing?.item.memoryId===item.memoryId?<section aria-label="确认修改记忆">
        {editing.operation==='correct'?<label>新的内容<textarea aria-label="纠正后的记忆" value={text} maxLength={2000} onChange={e=>setText(e.target.value)}/></label>:<p>删除后，AI不再把这条记录用作长期记忆。不会删除原始聊天或文件。</p>}
        <button type="button" disabled={busy} onClick={()=>{setEditing(null);setConfirming(null)}}>取消</button>
        <button type="button" disabled={busy||editing.operation==='correct'&&!text.trim()} onClick={()=>void change(confirming?{operation:'confirm',confirmationToken:confirming.confirmationToken}:{operation:editing.operation,requestId:newId(),memoryId:item.memoryId,expectedVersion:item.version,text,confirmed:true})}>{confirming?'确认保存敏感内容':editing.operation==='delete'?'确认删除':'保存纠正'}</button>
      </section>:null}
    </article>)}
    {next!==null?<button type="button" disabled={busy} onClick={()=>void load(next)}>查看更多</button>:null}
    <p className="af-memory-note">请保留设备备份。卸载应用或丢失设备且没有备份时，无法保证恢复。</p>
  </main>;
}
export function LocalMemoryReceipt({ requestId }) {
  const context = useLocalMemory(); const [loaded,setLoaded]=useState(null),[busy,setBusy]=useState(false);
  const value=context?.results?.[requestId]||loaded;
  useEffect(()=>{let alive=true;if(!context||context.results?.[requestId])return;setLoaded(null);context.client.execute({operation:'receipt',requestId}).then(r=>{if(alive)setLoaded(r)}).catch(e=>{if(alive)setLoaded({status:'error',message:memoryErrorText(e)})});return()=>{alive=false};},[context?.client,context?.revision,context?.results?.[requestId],requestId]);
  const confirm=async()=>{setBusy(true);try{const r=await context.client.execute({operation:'confirm',confirmationToken:value.confirmationToken});context.setResult(requestId,r);setLoaded(r)}catch(e){setLoaded({status:'error',message:memoryErrorText(e)});context.setResult(requestId,null)}finally{setBusy(false)}};
  const status = value?.status;
  const label = status==='stored'?'已记住。':status==='withdrawn'?'这条记忆后来已更正或删除。':status==='confirmation_required'?'这条内容涉及个人敏感信息，确认后才会保存。':status==='rejected'?(value.reason==='cancelled'?'暂未保存。':value.reason==='attachment_not_memory'?'请直接写出要记住的事实；不会把图片或资料推断自动保存。':'这类秘密信息不会保存为长期记忆。'):status==='not_saved'?'没有找到这次保存的成功记录，请重新确认。':status==='error'?value.message:'正在核对本机保存结果…';
  return <div className="af-memory-receipt" role="status"><p>{label}</p>{status==='confirmation_required'?<><p>{value.text}</p><button type="button" disabled={busy} onClick={()=>void confirm()}>{busy?'正在保存…':'确认保存'}</button><button type="button" disabled={busy} onClick={()=>context.setResult(requestId,{status:'rejected',reason:'cancelled'})}>暂不保存</button></>:null}{context?<button type="button" onClick={context.open}>查看长期记忆</button>:null}</div>;
}
export function LocalMemorySources({ references }) {
  const context=useLocalMemory();const [items,setItems]=useState(null),[error,setError]=useState('');
  const [open,setOpen]=useState(false);const key=JSON.stringify(references);
  useEffect(()=>{let alive=true;if(!open||!context)return;context.client.execute({operation:'get',references}).then(r=>{if(alive){setItems(r.items);setError('')}}).catch(e=>{if(alive)setError(memoryErrorText(e))});return()=>{alive=false};},[context?.client,context?.revision,open,key]);
  if(!context)return null;
  return <details className="af-memory-sources" onToggle={e=>setOpen(e.currentTarget.open)}><summary>记忆来源</summary>{error?<p>{error}</p>:items===null?<p>正在读取来源…</p>:items.length?items.map(item=><p key={item.memoryId}>{item.text}<br/><small>{new Date(item.updatedAt).toLocaleString('zh-CN')} · 您主动保存</small></p>):<p>引用的记忆已更正或删除，不再用于后续回答。</p>}<button type="button" onClick={context.open}>管理记忆</button></details>;
}
