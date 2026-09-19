import { useContext, useEffect, useRef, useState } from 'react';
import { DocumentQaContext, documentErrorText } from './useDocumentQa.js';
import Icon from './Icon.jsx';
const button={border:'1px solid var(--af-text-muted, #798da8)',borderRadius:10,padding:'8px 10px',background:'transparent',color:'inherit',minHeight:40,cursor:'pointer',fontSize:12};
const panel={color:'var(--af-text-primary,#ecf2ff)',background:'var(--af-surface,#172438)',border:'1px solid var(--af-text-muted,#798da8)',borderRadius:14,padding:12,fontSize:13,lineHeight:1.5,marginBottom:8,maxHeight:'min(230px, 34dvh)',overflowY:'auto',overflowWrap:'anywhere'};
export function DocumentAttachmentMenu({onSelectImages,onAttach,imageDisabled=false}){
  const qa=useContext(DocumentQaContext);const [open,setOpen]=useState(false);const wrapRef=useRef(null);
  useEffect(()=>{
    if(!open)return undefined;
    const closeOnOutsidePointer=(event)=>{if(!wrapRef.current?.contains(event.target))setOpen(false);};
    document.addEventListener('pointerdown',closeOnOutsidePointer,true);
    return()=>document.removeEventListener('pointerdown',closeOnOutsidePointer,true);
  },[open]);
  if(!qa?.available)return null;
  return <div className="af-attach-wrap" ref={wrapRef}>
    <button className="af-composer-button" type="button" aria-label="添加附件" aria-expanded={open} onClick={()=>setOpen(v=>!v)}><Icon name="paperclip" size={22}/></button>
    {open?<div role="group" aria-label="选择附件" style={{...panel,position:'absolute',bottom:'100%',left:0,width:220,zIndex:50,display:'grid',gap:8}}>
      <label style={{...button,position:'relative'}}>图片<input style={{position:'absolute',inset:0,opacity:0,width:'100%',cursor:'pointer'}} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple aria-label="添加图片" onClick={e=>{if(imageDisabled||qa.state.document||qa.state.state==='parsing'||onAttach?.('image')===false){e.preventDefault();}}} onChange={e=>{const files=[...e.target.files];e.target.value='';setOpen(false);if(files.length)onSelectImages?.(files);}}/></label>
      <label style={{...button,position:'relative'}}>文件（PDF / DOCX）<input style={{position:'absolute',inset:0,opacity:0,width:'100%',cursor:'pointer'}} type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" aria-label="选择文件" onClick={e=>{if(!qa.enabled||onAttach?.('file')===false)e.preventDefault();}} onChange={e=>{const file=e.target.files?.[0];e.target.value='';setOpen(false);if(file)void qa.select(file);}}/></label>
      <button type="button" style={button} onClick={()=>{setOpen(false);qa.openLibrary();}}>已保存资料</button>
      <button type="button" style={button} onClick={()=>setOpen(false)}>收起</button>
    </div>:null}
  </div>;
}
export default function DocumentPanel({busy=false}){
  const qa=useContext(DocumentQaContext);const [search,setSearch]=useState('');
  if(!qa)return null;const {state,notice,operation}=qa;const doc=state.document;
  if(!qa.libraryOpen&&!doc&&state.state==='idle'&&!notice)return null;
  return <div style={panel} data-testid="document-panel" aria-label="文件资料">
    {qa.libraryOpen?<>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><strong>已保存资料 · 仅本机</strong><button type="button" style={button} onClick={qa.closeLibrary}>收起资料</button></div>
      <input aria-label="查找已保存资料" placeholder="按文件名查找" value={search} onChange={e=>{setSearch(e.target.value);qa.search(e.target.value);}} style={{...button,width:'100%',margin:'8px 0'}}/>
      {qa.items.length?qa.items.map(item=><div key={item.documentId} style={{padding:'8px 0',borderTop:'1px solid #69809b55'}}><strong>{item.filename}</strong><small style={{display:'block'}}>{new Date(item.createdAt).toLocaleString()} · {(item.byteSize/1024).toFixed(1)} KB</small><div style={{display:'flex',gap:6,flexWrap:'wrap'}}><button type="button" style={button} disabled={!!operation||!qa.enabled} onClick={()=>qa.choose(item.documentId)}>使用这份资料</button><button type="button" style={button} onClick={()=>qa.download(item.documentId)}>导出原文件</button><button type="button" style={button} disabled={!!operation} onClick={()=>qa.remove(item.documentId)}>删除资料</button></div></div>):!operation?<p>没有匹配的本机资料。</p>:null}
    </>:null}
    {state.state==='parsing'?<><strong>正在读取 {state.filename}</strong><p role="status">{state.progress?.total?`已读取 ${state.progress.completed} / ${state.progress.total} ${/\.pdf$/i.test(state.filename)?'页':'份'}`:'正在解析文件…'}</p><button type="button" style={button} onClick={qa.clear}>取消读取</button></>:null}
    {state.state==='failed'?<><p role="alert">{documentErrorText(state.errorCode)}</p><button type="button" style={button} onClick={qa.clear}>关闭提示</button></>:null}
    {doc?<><strong>{doc.record.filename}</strong><small style={{display:'block'}}> {doc.record.pageCount?`${doc.record.pageCount}页 · `:''}{doc.record.state==='saved'?'已保存到本机':'仅本次使用，刷新后需重选'}</small><small style={{display:'block'}}>发送问题时，仅提取的文字交给AI分析。</small>
      {busy?<p role="status" aria-live="polite">正在对照文件整理回答…</p>:<p>可以概括内容，也可以继续提问。</p>}
      <div style={{display:'flex',gap:6,flexWrap:'wrap'}}><button type="button" style={button} disabled={!!operation||doc.record.state==='saved'} onClick={qa.save}>{doc.record.state==='saved'?'已保存资料':'保存资料'}</button><button type="button" style={button} onClick={qa.clear}>取消引用</button>{doc.record.state==='saved'?<button type="button" style={button} onClick={()=>qa.remove(doc.record.documentId)}>删除资料</button>:null}</div>
    </>:null}
    {operation||notice?<p role="status" aria-live="polite">{operation||notice}</p>:null}
  </div>;
}
