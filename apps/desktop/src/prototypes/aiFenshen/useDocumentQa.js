import { createContext, useEffect, useMemo, useRef, useState } from 'react';
import { DocumentSession } from '../../lib/documentSession.js';
import { DocumentRepository, DOCUMENT_DATABASE } from '../../lib/documentRepository.js';
import { parseDocumentFile } from '../../lib/documentParserClient.js';
import { makeProjection, documentError } from '../../../../../core/documentQa/contract.js';
export const DocumentQaContext=createContext(null);
const ERRORS={DOCUMENT_FILE_LIMIT:'文件超过8 MB，请选择较小的文件。',DOCUMENT_PAGE_LIMIT:'文件超过100页，当前无法完整读取。',DOCUMENT_TEXT_LIMIT:'文件文字超过24000字，当前无法完整读取。',DOCUMENT_UNPACK_LIMIT:'文件解压后过大，无法读取。',DOCUMENT_ENCRYPTED:'暂不支持加密文件，请选择未加密的版本。',DOCUMENT_NO_TEXT:'文件包含无法提取文字的页面，暂不支持扫描件。',DOCUMENT_LAYOUT_UNSUPPORTED:'当前支持正文和简单表格；此文件包含暂不支持的版式或嵌入内容。',DOCUMENT_FORMAT_UNSUPPORTED:'请选择文字型PDF或Word DOCX文件。',DOCUMENT_PARSE_TIMEOUT:'读取超时，请换一份较小的文件重试。',DOCUMENT_INVALID:'文件损坏或格式无法读取，请检查文件后重试。',DOCUMENT_QUOTA_EXCEEDED:'本地资料空间不足，请先删除不需要的资料。',DOCUMENT_STORAGE_UNAVAILABLE:'此浏览器暂时不能保存资料。',DOCUMENT_STORAGE_FAILED:'资料未能保存，请重试。',DOCUMENT_DELETE_FAILED:'删除失败，资料仍保留，请重试。',DOCUMENT_NOT_FOUND:'这份资料已不可用，请重新选择。',DOCUMENT_INTEGRITY_FAILED:'资料校验未通过，请重新选择原文件。',DOCUMENT_FEATURE_DISABLED:'文件问答当前未启用。',DOCUMENT_CONTEXT_INVALID:'文件引用已失效，请重新选择。'};
export const documentErrorText=code=>ERRORS[code]||'文件操作未完成，请重试。';
export function useDocumentQa({ownerId,conversationId,onInvalidate,onSelected}){
  const [state,setState]=useState({state:'idle',document:null});const [enabled,setEnabled]=useState(false);const [available,setAvailable]=useState(false);const [libraryOpen,setLibraryOpen]=useState(false);const [items,setItems]=useState([]);const [notice,setNotice]=useState('');const [operation,setOperation]=useState('');
  const callbacks=useRef({onInvalidate,onSelected});callbacks.current={onInvalidate,onSelected};
  const alive=useRef(ownerId);alive.current=ownerId;
  const session=useMemo(()=>new DocumentSession({ownerId,parser:parseDocumentFile,onChange:next=>{if(alive.current===ownerId)setState(next);}}),[ownerId]);
  const repository=useMemo(()=>ownerId?new DocumentRepository({ownerId}):null,[ownerId]);
  useEffect(()=>{setState({state:'idle',document:null});setItems([]);setLibraryOpen(false);setNotice('');setEnabled(false);setAvailable(false);let cancelled=false;
    if(ownerId)fetch('/api/ai/chat/document-capabilities',{credentials:'include'}).then(r=>r.ok?r.json():{}).then(v=>{if(!cancelled){setEnabled(v.enabled===true);setAvailable(v.available===true);}}).catch(()=>{});
    return()=>{cancelled=true;callbacks.current.onInvalidate?.();session.close();repository?.close();};
  },[ownerId,session,repository]);
  useEffect(()=>{const before=session.token();session.bindConversation(conversationId);if(!session.isCurrent(before))callbacks.current.onInvalidate?.();},[conversationId,session]);
  const clear=()=>{callbacks.current.onInvalidate?.();session.clear();setNotice('');};
  useEffect(()=>{
    if(!ownerId||typeof BroadcastChannel!=='function')return;
    const channel=new BroadcastChannel(DOCUMENT_DATABASE);channel.onmessage=({data})=>{if(data.ownerId===ownerId&&data.type==='deleted'){setItems(v=>v.filter(x=>x.documentId!==data.documentId));if(session.current?.record.documentId===data.documentId){callbacks.current.onInvalidate?.();session.clear();setNotice('资料已在另一个页面删除。');}}};return()=>channel.close();
  },[ownerId,session]);
  const run=async(label,action)=>{setOperation(label);setNotice('');try{await action();}catch(error){if(alive.current===ownerId)setNotice(documentErrorText(error?.code));}finally{if(alive.current===ownerId)setOperation('');}};
  const refresh=async(search='')=>{const rows=await repository.list(search);if(alive.current===ownerId)setItems(rows);};
  return {enabled,available,state,session,libraryOpen,items,notice,operation,clear,
    select:async file=>{if(!enabled) return;callbacks.current.onInvalidate?.();setLibraryOpen(false);setNotice('');await session.select(file);if(session.current&&alive.current===ownerId)callbacks.current.onSelected?.();},
    openLibrary:()=>{setLibraryOpen(true);void run('正在读取已保存资料…',()=>refresh());},
    closeLibrary:()=>setLibraryOpen(false),
    search:value=>void run('正在查找…',()=>refresh(value)),
    save:()=>void run('正在保存…',async()=>{const token=session.token();const doc=session.current;if(!doc)return;const saved=await repository.save(doc);if(session.isCurrent(token)){session.current=saved;session.publish('ready');setNotice('已保存到本机资料。');}}),
    choose:id=>void run('正在读取…',async()=>{if(!enabled)throw documentError('DOCUMENT_FEATURE_DISABLED');const epoch=session.epoch;const doc=await repository.get(id);if(!doc)throw documentError('DOCUMENT_NOT_FOUND');if(alive.current!==ownerId||session.epoch!==epoch)return;callbacks.current.onInvalidate?.();session.adopt(doc);setLibraryOpen(false);callbacks.current.onSelected?.();}),
    remove:id=>{if(!window.confirm('删除这份资料及本地原文件？已生成的聊天回答和引用摘录会保留，可在聊天记录中管理。'))return;if(session.current?.record.documentId===id)clear();void run('正在删除…',async()=>{await repository.delete(id);await refresh();setNotice('资料已删除。');});},
    download:id=>void run('正在准备原文件…',async()=>{const doc=id?await repository.get(id):session.current;if(!doc)throw documentError('DOCUMENT_NOT_FOUND');if(alive.current!==ownerId)return;const url=URL.createObjectURL(new Blob([doc.bytes],{type:doc.record.format==='pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}));const a=document.createElement('a');a.href=url;a.download=doc.record.filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}),
    forQuery:async({conversationId:queryConversationId,question})=>{if(!enabled)throw documentError('DOCUMENT_FEATURE_DISABLED');const token=session.token();let doc=session.current;if(!doc)throw documentError('DOCUMENT_NOT_FOUND');if(doc.record.state==='saved'){doc=await repository.get(doc.record.documentId);if(!doc){clear();throw documentError('DOCUMENT_NOT_FOUND');}}if(!session.isCurrent(token))throw documentError('ABORTED');return makeProjection(doc,{conversationId:queryConversationId,question});}
  };
}
