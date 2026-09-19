import { useState } from 'react';
import { decodeDocumentMessage, sourceLabel, documentMessageText } from '../../../../../core/documentQa/contract.js';
export default function DocumentContent({content}){
  const [expanded,setExpanded]=useState(false);const message=decodeDocumentMessage(content);if(!message)return null;const data=message.data;
  if(message.kind==='question')return <div className="af-message-content"><p>{data.question}</p><small>资料：{data.filename}</small></div>;
  const long=String(data.text||'').length>220;const button={background:'transparent',color:'inherit',border:'1px solid #8299b788',borderRadius:8,padding:'8px 10px',minHeight:40,cursor:'pointer'};
  const download=()=>{const url=URL.createObjectURL(new Blob([documentMessageText(content)],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='文件问答.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  return <div className="af-message-content" data-testid="document-answer">
    <p style={{whiteSpace:'pre-wrap'}}>{long&&!expanded?`${data.text.slice(0,220)}…`:data.text}</p>
    {long?<button type="button" style={button} onClick={()=>setExpanded(v=>!v)}>{expanded?'收起回答':'展开回答'}</button>:null}
    {(data.citations||[]).map((c,i)=><details key={`${c.blockId}-${i}`} style={{marginTop:8,fontSize:12}}><summary style={{cursor:'pointer',minHeight:32}}> [{i+1}] {sourceLabel(c)}</summary><blockquote style={{margin:'8px 0',paddingLeft:10,borderLeft:'2px solid #819bc0',whiteSpace:'pre-wrap'}}>{c.quote}</blockquote></details>)}
    <div style={{display:'flex',gap:8,marginTop:10}}><button type="button" style={button} onClick={()=>navigator.clipboard?.writeText(documentMessageText(content)).catch(()=>{})}>复制回答</button><button type="button" style={button} onClick={download}>导出回答</button></div>
  </div>;
}
