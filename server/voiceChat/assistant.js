import { createAssistantAgentOrchestrator } from '../agent/assistantAgentOrchestrator.js';
import { withDiaryAssistant } from '../diary/integration.js';
import { withHealthAssistant } from '../health/conversation.js';
import { SpeechText } from './speechText.js';
import { createAssistantSemanticIngress } from '../agent/assistantSemanticIngress.js';
import { deterministicIdentityAnswer } from '../agent/identityDeterministic.js';
import { isAccessControlErrorCode } from '../../core/router/AccessControlErrorCodes.js';
import { classifyVoiceRoute,isVoiceBusinessCandidate } from './ordinaryChat.js';
import {AsyncLocalStorage} from 'node:async_hooks';

// A separate invocation boundary reuses domain contracts, without changing the
// accepted text entry. Every write-capable service method is denied by default.
export function createVoiceAssistant({gate,financeRuntime,protectedMemoryRuntime,diaryRuntime,healthRuntime,semanticPlanner,toolRegistry,aiService,getMessages,ordinaryChatEnabled=false}={}) {
 const ordinaryConversations=new Set();
 const clarificationScope=new AsyncLocalStorage();
 const businessConversations=new Set();
 const keyFor=input=>JSON.stringify([input.ownerId,input.conversationId]);
 const candidate=input=>isVoiceBusinessCandidate(input,{financeRuntime,protectedMemoryRuntime});
 const routeFor=input=>classifyVoiceRoute(input,{financeRuntime,protectedMemoryRuntime,diaryRuntime,healthRuntime});
 const remember=(set,key)=>{if(set.size>=100)set.delete(set.values().next().value);set.add(key);};
 const baseIngress=ordinaryChatEnabled&&semanticPlanner?.plan?createAssistantSemanticIngress({planner:semanticPlanner}):null;
 const semanticIngress=baseIngress?{async interpret(input){
  const result=await baseIngress.interpret(input);
  const clarification=clarificationScope.getStore();
  if(clarification&&result?.ok&&(result.plan?.domain==='ambiguous'||result.plan?.intent==='ambiguous')){
   const questions={target_missing:'你希望我具体处理哪件事？',time_missing:'你希望安排在什么时间？',amount_missing:'具体金额是多少？',action_missing:'你希望我对这件事做什么？'};
   clarification.question=result.plan.ambiguity_reasons?.map(reason=>Object.hasOwn(questions,reason)?questions[reason]:undefined).find(Boolean)||'你希望我给建议，还是帮你完成一项具体操作？';
  }
  if(!result?.ok&&input.routeDomain==='semantic_planner'&&!candidate(input)&&!businessConversations.has(keyFor(input))&&
   !isAccessControlErrorCode(result?.code)&&result?.code!=='NO_USABLE_RUNTIME_CONNECTION')return{ok:true,plan:{domain:'ordinary_chat'},source:'voice_generic_recovery'};
  return result;
 }}:undefined;
 const greeting=/^(?:你好[呀啊]?|您好|嗨|哈[喽啰]|hello|hi|早上好|下午好|晚上好|早安|晚安|在吗|听得到吗|能听到吗|你能听到我说话吗|随便聊聊|聊聊天|讲个笑话)[。！？!?，,\s]*$/i;
 const conversationRecall=/^(?:刚才(?:我们)?(?:说|聊|谈)到哪(?:里)?|(?:我们)?刚刚(?:说|聊|谈)(?:了)?什么|(?:接着|继续)(?:刚才|上次)(?:说|聊|谈))[。！？!?，,\s]*$/;
 const followup=/^(?:继续(?:说|讲)?|接着说|然后呢|为什么(?:呢)?|具体说说|详细说说|举个例子|换个说法|说简单一点|没听清(?:楚)?|再说一遍)[。！？!?，,\s]*$/;
 const finance=gate.wrap(financeRuntime?.service,(method,args)=>
  ['clock','trustedContext','isFinanceCandidate','deterministicCreatePlan','deterministicCreateBatchPlan','rememberPendingPlan'].includes(method)||
  (method==='processUserMessage'&&args[0]?.plan?.action==='query'),'finance');
 const memory=gate.wrap(protectedMemoryRuntime,(method,args)=>
  ['trustedContext','isMemoryQuery','isMemoryCandidate','resolveEvidence','getEvidenceBundle','resolveToolEvidence'].includes(method)||
  (method==='processSemanticPlan'&&['memory_query','ordinary_chat','ambiguous'].includes(args[1]?.intent)),'memory');
 const tools=gate.wrap(toolRegistry,(method,args)=>method==='descriptors'||(method==='invoke'&&['calendar.convert','calendar.lunar_to_solar','calendar.solar_to_lunar','calendar.date_diff','calendar.age'].includes(args[0])),'tasks');
 const agent=createAssistantAgentOrchestrator({financeService:finance,memoryIntegration:memory,semanticPlanner,semanticIngress,toolRegistry:tools,timezone:financeRuntime?.timezone||'Asia/Shanghai',clock:financeRuntime?.clock||(()=>new Date())});
 const diary=diaryRuntime?{...diaryRuntime,service:gate.wrap(diaryRuntime.service,['list','get'],'diary')}:null;
 const health=healthRuntime?{...healthRuntime,service:gate.wrap(healthRuntime.service,['list','get','profile'],'health')}:null;
 const wrapped=withHealthAssistant(withDiaryAssistant(agent,diary,{getMessages}),health,{getMessages,aiService});
 return { ...wrapped,async processUserMessage(input){
  const key=JSON.stringify([input.ownerId,input.conversationId]);
  const hasLoadedHistory=Array.isArray(input.conversationMessages);
  const history=hasLoadedHistory?input.conversationMessages:[];
  const priorHistory=history.at(-1)?.role==='user'&&history.at(-1)?.content===input.message?history.slice(0,-1):history;
  const identity=deterministicIdentityAnswer(input.message,{conversationMessages:priorHistory,allowCreatorFollowup:true});
  if(identity)return{domain:'identity',handled:true,...identity};
  if(/^(?:再说一遍|再重复一遍|没听清(?:楚)?|请再说一遍)[。！？!?，,\s]*$/.test(input.message)){
   const previous=input.conversationMessages?.findLast(m=>m.role==='assistant'&&m.content?.trim());
   if(previous&&previous.content.length<=3000){
    const parser=new SpeechText(),source=previous.content.replace(/^\[这条语音未确认完整播放，用户可能没有听完。\]\n/,'');
    const content=[...parser.push(source),...parser.finish()].join('');
    if(content)return{domain:'voice_repeat',handled:true,content};
   }
  }
  if(ordinaryChatEnabled&&conversationRecall.test(input.message)){
   const hasVisiblePriorTurn=priorHistory.some(message=>
    (message.role==='user'||message.role==='assistant')&&typeof message.content==='string'&&message.content.trim());
   if(hasLoadedHistory){
    if(!hasVisiblePriorTurn)return{domain:'voice_recall_empty',handled:true,action:'voice_recall_empty',content:'这段对话里还没有此前内容。你想从哪个话题开始？'};
    remember(ordinaryConversations,key);return{domain:'ordinary_chat',kind:'none',outcome:'ignored'};
   }
  }
  // These two cases need verified context before an open-ended answer is safe.
  const voiceRoute=routeFor(input);
  if(input.localMemoryEvidence&&voiceRoute.kind==='read'&&voiceRoute.capability==='memory')return{domain:'ordinary_chat',kind:'none',outcome:'device_memory_query'};
  if(ordinaryChatEnabled&&voiceRoute.kind==='read'&&!voiceRoute.available){
   const unavailable={
    meeting:'本会话暂未接入会议记录，暂时无法查询。',
    memory:'本会话暂未接入永久记忆，无法核对这项私人事实。',
    finance:'本会话暂未接入账目查询，无法查询这段时间的收支。',
    diary:'本会话暂未接入日记记录，无法查询这项内容。',
    health:'本会话暂未接入健康记录，无法查询这项内容。'
   };
   return{domain:'voice_capability',handled:true,action:'voice_capability_unavailable',content:unavailable[voiceRoute.capability]||'本会话暂未接入这项记录，无法查询。'};
  }
  if(ordinaryChatEnabled&&voiceRoute.kind==='needs_context'){
   const message=String(input.message||'');
   const content=/确认/u.test(message)?'请说明要确认的具体操作。':/(?:删除|删掉|清空)/u.test(message)?'请说明要删除的具体内容。':/(?:保存|记录|记住)/u.test(message)?'请说明要保存的具体内容。':'请说明要处理的具体内容。';
   return{domain:'voice_operation',handled:true,action:'voice_operation_context',content};
  }
  const lastUser = priorHistory.findLast(m=>m.role==='user');
  const businessFollowup = /^(?:改成|改为|那就|就按|换成|确认|取消)/u.test(input.message) && (businessConversations.has(key) || (lastUser && routeFor({...input,message:lastUser.content}).kind!=='ordinary'));
  const targetMissing = /^(?:请|帮我|替我)?(?:处理|办|弄)(?:一下|这件事|这个)?[。！？!?\s]*$/u.test(input.message);
  const protectedPlanner=businessFollowup||targetMissing||(!hasLoadedHistory&&conversationRecall.test(input.message))||/^(?:他|她|它)是谁[。！？!?，,\s]*$/u.test(input.message);
  const currentBusiness=voiceRoute.kind==='read'||voiceRoute.kind==='action';
  if(ordinaryChatEnabled&&voiceRoute.kind==='ordinary'&&!protectedPlanner){
   businessConversations.delete(key);
   remember(ordinaryConversations,key);return{domain:'ordinary_chat',kind:'none',outcome:'ignored'};
  }
  const business=ordinaryChatEnabled&&(currentBusiness||protectedPlanner);
  if(!ordinaryChatEnabled&&!currentBusiness&&(greeting.test(input.message)||(ordinaryConversations.has(key)&&followup.test(input.message)))){
   remember(ordinaryConversations,key);return{domain:'ordinary_chat',kind:'none',outcome:'ignored'};
  }
  ordinaryConversations.delete(key);
  if(business)remember(businessConversations,key);
  const scope={ownerId:input.ownerId,conversationId:input.conversationId,turnId:input.clientRequestId};
  const clarification={};const checked=await clarificationScope.run(clarification,()=>gate.inspect(scope,()=>wrapped.processUserMessage(input)));
  if(!checked.proposal&&checked.result?.domain==='ambiguous'&&checked.result?.action==='clarify'&&clarification.question)return{...checked.result,content:clarification.question};
  if(!checked.proposal&&checked.result?.domain==='ordinary_chat'){remember(ordinaryConversations,key);businessConversations.delete(key);}
  if(!checked.proposal)return checked.result;
  const p=checked.proposal;p.sourceText=input.message;p.sourceMessageId=input.sourceMessageId;
  return{domain:'voice_confirmation',handled:true,action:'voice_confirmation',content:'这条内容需要你的确认。确认后我再保存或执行。',voiceProposal:p};
 }};
}
export function confirmationSummary(proposal){
 const labels={finance:'账本操作',memory:'记忆保存',diary:'日记保存',health:'健康记录或提醒',tasks:'事项操作'};
 const input=proposal.details[0],record=proposal.details[1];
 let details='';
 if(proposal.domain==='diary'&&record)details=`\n事件日期：${record.occurredOn||'待确认'}${record.reminder?.scheduledAt?'\n提醒：'+record.reminder.scheduledAt:''}`;
 if(proposal.domain==='health'&&record)details=`\n日期：${record.occurredOn||'待确认'}${record.payload?.value?'\n数值：'+record.payload.value+(record.payload.secondaryValue?'/'+record.payload.secondaryValue:'')+' '+(record.payload.unit||''):''}`;
 if(proposal.domain==='finance'&&input?.plan){const plans=input.plan.commands||[input.plan];details=plans.map(p=>`\n${p.action==='delete'?'删除账目':p.action==='update'?'修改账目':p.type==='income'?'收入':p.type==='expense'?'支出':'账目'}：${Number.isSafeInteger(p.amount_minor)?(p.amount_minor/100).toFixed(2)+' 元':p.transaction_candidate?.amount_text||'按原文确认'}${p.occurred_at?'\n日期：'+new Intl.DateTimeFormat('zh-CN',{timeZone:p.timezone||'Asia/Shanghai',dateStyle:'medium'}).format(new Date(p.occurred_at)):''}`).join('\n');}
 return{ id:proposal.id,turnId:proposal.turnId,title:labels[proposal.domain]||'操作确认',text:proposal.sourceText+details,expiresAt:proposal.expiresAt };
}
export function confirmationResult(outcome){
 const result=outcome?.result;
 if(outcome.domain==='finance'){
  if(!result?.handled||result.action==='error')throw Object.assign(new Error('VOICE_ACTION_FAILED'),{code:'VOICE_ACTION_FAILED'});
  return result.content||'已按你确认的内容完成账本操作。';
 }
 if(outcome.domain==='memory'){
  if(!['memory_written','memory_corrected','duplicate_detected'].includes(result?.outcome))throw Object.assign(new Error('VOICE_ACTION_FAILED'),{code:'VOICE_ACTION_FAILED'});
  return result.outcome==='duplicate_detected'?'这条信息已经记住了，没有重复保存。':'好的，已经记住了。';
 }
 if(outcome.domain==='tasks'){
  if(result?.decision!=='ACCEPT')throw Object.assign(new Error('VOICE_ACTION_FAILED'),{code:'VOICE_ACTION_FAILED'});
  return result.result?.safe_user_message||'已按你确认的内容完成。';
 }
 if(!result?.id)throw Object.assign(new Error('VOICE_ACTION_FAILED'),{code:'VOICE_ACTION_FAILED'});
 return outcome.domain==='diary'?'日记已经保存。':'健康记录已经保存。';
}
