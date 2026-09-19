import{useEffect,useMemo,useRef,useState}from'react';
import{VoiceChatEngine}from'./engine.js';
export function useVoiceChat({ownerId,conversationId,featureView,enabled=true,onEvent,onConversation}){
 const callbacks=useRef({onEvent,onConversation});callbacks.current={onEvent,onConversation};
 const [visible,setVisible]=useState(false),[state,setState]=useState({phase:'idle',muted:false,error:'',subtitle:'',proposal:null});const consent=useRef(false);
 const engine=useMemo(()=>new VoiceChatEngine({ownerId,onState:setState,onEvent:e=>callbacks.current.onEvent(e),onConversation:id=>callbacks.current.onConversation(id)}),[ownerId]);
 useEffect(()=>{consent.current=false;setVisible(false);return()=>engine.end();},[engine]);
 useEffect(()=>{if(featureView!=='home'||!enabled){engine.end();setVisible(false);}},[engine,featureView,enabled]);
 useEffect(()=>{if(engine.sessionId&&conversationId!==engine.conversationId){engine.end();setVisible(false);}},[engine,conversationId]);
 const start=()=>{consent.current=true;setVisible(true);void engine.start({conversationId,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'Asia/Shanghai'});};
 return{visible,state,engine,open(){setVisible(true);if(consent.current)start();else engine.update({phase:'intro',error:'',subtitle:'',proposal:null});},start,end(){engine.end();setVisible(false);},mute:()=>void engine.mute(),confirm:()=>void engine.confirm(),cancelProposal:()=>engine.cancelProposal()};
}
