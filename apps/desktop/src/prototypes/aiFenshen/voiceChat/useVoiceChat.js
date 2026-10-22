import {useEffect,useMemo,useRef,useState} from 'react';
import {VoiceChatEngine} from './engine.js';
export function useVoiceChat({ownerId,conversationId,featureView,enabled=true,onEvent,onConversation,prepareContext,onTiming}) {
 const callbacks=useRef({});callbacks.current={onEvent,onConversation,prepareContext,onTiming};
 const [presentation,setPresentation]=useState('hidden'),[state,setState]=useState({phase:'idle',muted:false,error:'',subtitle:'',proposal:null});const consent=useRef(false);
 const engine=useMemo(()=>new VoiceChatEngine({ownerId,onState:setState,onTiming:e=>callbacks.current.onTiming?.(e),onEvent:e=>callbacks.current.onEvent?.(e),onConversation:id=>callbacks.current.onConversation?.(id),prepareContext:args=>callbacks.current.prepareContext?.(args)}),[ownerId]);
 useEffect(()=>{consent.current=false;setPresentation('hidden');return()=>engine.end();},[engine]);
 useEffect(()=>{if(featureView!=='home'||!enabled){engine.end();setPresentation('hidden');}},[engine,featureView,enabled]);
 useEffect(()=>{if(engine.sessionId&&conversationId!==engine.conversationId){engine.end();setPresentation('hidden');}},[engine,conversationId]);
 const start=()=>{consent.current=true;void engine.start({conversationId,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'Asia/Shanghai'});};
 return {visible:presentation==='expanded',compact:presentation==='compact',state,engine,
  open(){setPresentation('expanded');if(engine.sessionId||['permission','connecting'].includes(engine.state.phase))return;if(consent.current)start();else engine.update({phase:'intro',error:'',subtitle:'',proposal:null});},
  expand(){setPresentation('expanded');},minimize(){setPresentation('compact');},start,
  end(){engine.end();setPresentation('hidden');},mute:()=>void engine.mute(),confirm:()=>void engine.confirm(),cancelProposal:()=>engine.cancelProposal()};
}
