import { groundedClaimsSchema, normalizeGroundedClaims } from './groundedClaims.js';
import { RESOURCE_PLAN_SCHEMA, RESOURCE_UPDATE_SCHEMA, resourceSelectionSchema, resourceChangeSchema } from '../tools/resourcePlan.js';
import { ANSWER_TOOL_DEFINITIONS, PUBLIC_LOOKUP_DEFINITION } from '../tools/answerTools.js';
// Invoked only through ProviderManager/AIRouter: credentials, quota and audit
// remain owned by their existing boundaries. No local business tools exposed.
const REVIEW_TOOL = {type:'function',name:'submit_review',description:'提交经核验的最终回答。检查计算、逻辑、用户约束及资料是否支持结论。资料不足必须明确说明，不编造来源或完成状态。',parameters:{type:'object',properties:{resourceUpdate:RESOURCE_UPDATE_SCHEMA,resourcePlan:RESOURCE_PLAN_SCHEMA,verdict:{type:'string',enum:['accept','revise','insufficient']},answer:{type:'string'},citations:{type:'array',items:{type:'object',properties:{url:{type:'string'},quote:{type:'string'}},required:['url','quote'],additionalProperties:false}}},required:['verdict','answer','citations','resourcePlan','resourceUpdate'],additionalProperties:false}};
const DIRECT_ANSWER_BASES=['general_explanation','stable_common_knowledge','reason_from_input','rewrite_or_create','general_advice','uncertain_without_search'];
const PREPARATION_SCHEMA={type:'object',properties:{decision:{anyOf:[
 {type:'object',properties:{type:{type:'string',enum:['clarify']},question:{type:'string',maxLength:200,description:'缺少用户指代对象、必要条件或个人事项信息时，只问一个最必要的问题；不是公开搜索词。'}},required:['type','question'],additionalProperties:false},
 {type:'object',description:'适用于通用原理、稳定基础常识、推理、创作与一般建议；具体陌生对象或不确定、时效性事实使用lookup_public，不凭印象补齐姓名、日期或参数。',properties:{type:{type:'string',enum:['answer']},basis:{type:'string',enum:DIRECT_ANSWER_BASES,description:'先确定依据再作答：通用原理；仅从用户给定条件推理；改写或创作；不依赖具体外部事实的建议；无法联网时明确说明未核实。'},answer:{type:'string'}},required:['type','basis','answer'],additionalProperties:false},
 {type:'object',properties:{type:{type:'string',enum:['calculate']},expressions:{...ANSWER_TOOL_DEFINITIONS[0].parameters.properties.expressions,description:'独立、可直接执行的纯数字算式；不含变量、中文标签、赋值或前项结果引用。'}},required:['type','expressions'],additionalProperties:false},
 {type:'object',properties:{type:{type:'string',enum:['lookup_public']},query:{type:'string',maxLength:200,description:'具体公开事实的检索词；不能填写内部判断、对用户说的话或澄清请求。'}},required:['type','query'],additionalProperties:false}
]}},required:['decision'],additionalProperties:false};
const fail=code=>Object.assign(new Error(code),{code});
function safeSource(source){
 try{const u=new URL(source.url);if(u.protocol!=='https:'||u.username||u.password||!u.hostname.includes('.')||u.hostname.endsWith('.local')||u.hostname.endsWith('.internal')||/^(?:\d|\[)/.test(u.hostname))return null;
 return {url:u.href,title:String(source.title||u.hostname).replace(/[\[\]<>\r\n]/g,' ').slice(0,120)};}catch{return null;}
}
export async function runVoiceReasonedAnswer(request,settings,{signal,onDelta=()=>{}}={}){
 const context=request.metadata?.voiceAnswerContext;
 if(!context||!Array.isArray(context.messages)||typeof context.instructions!=='string')throw fail('VOICE_ANSWER_CONTEXT_REQUIRED');
 const checked=context.protocol==='checked-v1', review=checked&&context.phase==='review', lookup=checked&&context.phase==='search', prepare=checked&&context.phase==='prepare',plan=checked&&context.phase==='plan';
 const base=new URL(settings.baseUrl);
 if(base.protocol!=='https:'||!['dashscope.aliyuncs.com','dashscope-intl.aliyuncs.com','dashscope-us.aliyuncs.com'].includes(base.hostname)||base.port||base.username||base.password)throw fail('VOICE_ANSWER_ENDPOINT_UNSUPPORTED');
 if(!settings.apiKey)throw fail('INVALID_API_KEY');
 const controller=new AbortController(),abort=()=>controller.abort();let timedOut=false;
 if(signal?.aborted)throw fail('ABORTED');signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>{timedOut=true;controller.abort();},Math.min(settings.timeoutMs||30000,30000));
 try{
  // Review is structured data, not an action/tool call. Use the provider's
  // strict JSON Schema mode and still validate completion and contents locally.
  const outputLimit=Math.min(1000,settings.maxTokens||1000);
  const reviewBudget=context.requireResourcePlan?256:128;
  const passageMode=review&&Array.isArray(context.citationPassages);
  const groundedMode=passageMode&&context.groundedClaims===true&&!context.requireResourcePlan&&!context.hasResourceState;
  const literalSourceReview=passageMode&&context.citationPassages.length>0&&context.simplePublicLookup===true&&!context.requireResourcePlan&&!context.hasResourceState;
  const reviewParameters=passageMode?{...REVIEW_TOOL.parameters,required:REVIEW_TOOL.parameters.required.map(k=>k==='citations'?'citationIds':k),properties:{...Object.fromEntries(Object.entries(REVIEW_TOOL.parameters.properties).filter(([k])=>k!=='citations')),citationIds:{type:'array',items:{type:'string',enum:context.citationPassages.length?context.citationPassages.map(p=>p.id):['unused']},maxItems:context.citationPassages.length?3:0}}}:REVIEW_TOOL.parameters;
  const body=plan?{
   model:settings.model,messages:[{role:'system',content:context.instructions},...context.messages],
   response_format:{type:'json_schema',json_schema:{name:'checked_resource_plan',strict:true,schema:{type:'object',properties:{resourcePlan:resourceSelectionSchema(context.resourceCandidates||[],{allowAlternatives:context.allowResourceAlternatives===true}),expression:{type:'string',description:'完整总需求的纯数字算式，不含变量、赋值、中文标签'}},required:['resourcePlan','expression'],additionalProperties:false}}},
   enable_thinking:true,thinking_budget:Math.min(256,Math.max(1,outputLimit-128)),max_tokens:outputLimit,stream:false
  }:prepare?{
   model:settings.model,messages:[{role:'system',content:context.instructions},...context.messages],
   response_format:{type:'json_schema',json_schema:{name:'answer_preparation',strict:true,schema:{...PREPARATION_SCHEMA,properties:{decision:{anyOf:PREPARATION_SCHEMA.properties.decision.anyOf.filter(s=>(context.allowSearch||s.properties.type.enum[0]!=='lookup_public')&&(!context.requireResourcePlan||s.properties.type.enum[0]!=='answer')).map(s=>s.properties.type.enum[0]==='calculate'&&context.requireResourcePlan?{...s,properties:{...s.properties,expressions:{...s.properties.expressions,maxItems:1}}}:s)}}}}},
   enable_thinking:false,max_tokens:outputLimit,stream:false
  }:review?{
   model:settings.model,messages:[{role:'system',content:context.instructions},...context.messages],
   response_format:{type:'json_schema',json_schema:{name:'answer_review',strict:true,schema:groundedMode?groundedClaimsSchema(context.citationPassages,{current:context.currentPublicLookup===true}):{...reviewParameters,properties:{...reviewParameters.properties,answer:context.requireResourcePlan?{type:'string',enum:['']}:{type:'string'},resourceUpdate:context.hasResourceState&&!context.requireResourcePlan?resourceChangeSchema(context.verifiedResourcePlan,context.resourceCandidates||[]):{type:'null'},resourcePlan:context.allowResourcePlan?resourceSelectionSchema(context.resourceCandidates||[],{allowAlternatives:context.allowResourceAlternatives===true}):{type:'null'}}}}},enable_thinking:!literalSourceReview,...(!literalSourceReview?{thinking_budget:Math.min(reviewBudget,Math.max(1,outputLimit-128))}:{}),
   max_tokens:outputLimit,stream:false
  }:{model:settings.model,input:context.messages,instructions:context.instructions,tools:checked?lookup?(context.allowSearch?[{type:'web_search'}]:[]):[...ANSWER_TOOL_DEFINITIONS,...(context.allowSearch?[PUBLIC_LOOKUP_DEFINITION]:[])]:context.allowSearch?[{type:'web_search'}]:[],...(lookup&&context.allowSearch?{tool_choice:'required'}:{}),reasoning:{effort:checked?'none':'low'},max_output_tokens:outputLimit,store:false};
  let dispatcher;
  if(checked&&typeof process!=='undefined'&&process.versions?.node){const modulePath='./ordinaryVoiceTransport.node.js';dispatcher=(await import(/* @vite-ignore */ modulePath)).getOrdinaryVoiceDispatcher();}
  const response=await fetch(`${base.origin}/compatible-mode/v1/${review||prepare||plan?'chat/completions':'responses'}`,{...(dispatcher?{dispatcher}:{}),method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${settings.apiKey}`},signal:controller.signal,body:JSON.stringify(body)});
  if(!response.ok)throw fail(response.status===429?'RATE_LIMIT':response.status===401?'INVALID_API_KEY':'VOICE_ANSWER_FAILED');
  let result=await response.json();
  let structuredReview;
  if(review||prepare||plan){
   const choices=result.choices;
   if(!Array.isArray(choices)||choices.length!==1||choices[0].finish_reason!=='stop'||choices[0].message?.tool_calls?.length)throw fail('VOICE_ANSWER_REVIEW_REQUIRED');
   const raw=choices[0].message?.content;
   if(typeof raw!=='string'||raw.length>8000)throw fail('VOICE_ANSWER_PROTOCOL_INVALID');
   try{structuredReview=JSON.parse(raw);}catch{throw fail('VOICE_ANSWER_PROTOCOL_INVALID');}
   if(!structuredReview||typeof structuredReview!=='object'||Array.isArray(structuredReview))throw fail('VOICE_ANSWER_PROTOCOL_INVALID');
   if(groundedMode){
    if(Object.keys(structuredReview).join(',')!=='decision')throw fail('VOICE_ANSWER_EVIDENCE_MISMATCH');
    structuredReview=normalizeGroundedClaims(structuredReview.decision,context.citationPassages,{current:context.currentPublicLookup===true});
   }else if(passageMode){
    const ids=structuredReview.citationIds,byId=new Map(context.citationPassages.map(p=>[p.id,p]));
    if(Object.hasOwn(structuredReview,'citations')||!Array.isArray(ids)||ids.length>3||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!byId.has(id)))throw fail('VOICE_ANSWER_EVIDENCE_MISMATCH');
    const {citationIds,...rest}=structuredReview;structuredReview={...rest,citations:ids.map(id=>({url:byId.get(id).url,quote:byId.get(id).text}))};
   }

   result={status:'completed',model:result.model,output:[],usage:{input_tokens:result.usage?.prompt_tokens||0,output_tokens:result.usage?.completion_tokens||0,total_tokens:result.usage?.total_tokens||0}};
  }
  if(signal?.aborted||controller.signal.aborted)throw fail(timedOut?'TIMEOUT':'ABORTED');
  if(result.status!=='completed')throw fail('INCOMPLETE_PROVIDER_RESPONSE');
  if(result.model&&result.model!==settings.model)throw fail('PROVIDER_MODEL_MISMATCH');
  if(plan){
   if(Object.keys(structuredReview).sort().join(',')!=='expression,resourcePlan'||typeof structuredReview.expression!=='string'||!structuredReview.expression.trim()||structuredReview.expression.length>240||!structuredReview.resourcePlan)throw fail('VOICE_ANSWER_PROTOCOL_INVALID');
   return {provider:'qwen',model:settings.model,mode:'chat',content:JSON.stringify({draft:'',calls:[{name:'calculate',call_id:'prepared-plan-total',arguments:JSON.stringify({expressions:[structuredReview.expression]})}],sources:[],extracts:[],searched:false,preparedResourcePlan:true,review:{verdict:'accept',answer:'',citations:[],resourcePlan:structuredReview.resourcePlan,resourceUpdate:null}}),usage:result.usage,mocked:false,createdAt:new Date().toISOString()};
  }
  if(prepare){
   const d=structuredReview.decision;
   if(Object.keys(structuredReview).some(k=>k!=='decision')||!d||typeof d!=='object'||Array.isArray(d))throw fail('VOICE_ANSWER_PROTOCOL_INVALID');
   let reviewResult,calls=[];
   const keys=Object.keys(d).sort().join(',');
   if(d.type==='clarify'&&keys==='question,type'&&typeof d.question==='string'&&d.question.trim()&&d.question.length<=200){
    reviewResult={verdict:'insufficient',answer:d.question,citations:[],resourcePlan:null,resourceUpdate:null};
   }else if(d.type==='answer'&&keys==='answer,basis,type'&&DIRECT_ANSWER_BASES.includes(d.basis)&&typeof d.answer==='string'&&d.answer.trim()&&d.answer.length<=2000){
    reviewResult={verdict:'accept',answer:d.answer,citations:[],resourcePlan:null,resourceUpdate:null};
   }else if(d.type==='calculate'&&keys==='expressions,type'&&Array.isArray(d.expressions)&&d.expressions.length>0&&d.expressions.length<=(context.requireResourcePlan?1:12)&&d.expressions.every(x=>typeof x==='string'&&x.length<=240)){
    calls=[{name:'calculate',call_id:'prepared-calculation',arguments:JSON.stringify({expressions:d.expressions})}];
   }else if(d.type==='lookup_public'&&keys==='query,type'&&context.allowSearch&&typeof d.query==='string'&&d.query.trim()&&d.query.length<=200){
    calls=[{name:'lookup_public',call_id:'prepared-search',arguments:JSON.stringify({query:d.query})}];
   }else throw fail('VOICE_UNEXPECTED_TOOL');
   return {provider:'qwen',model:settings.model,mode:'chat',content:JSON.stringify({draft:'',calls,sources:[],extracts:[],searched:false,...(reviewResult?{review:reviewResult}:{})}),usage:result.usage,mocked:false,createdAt:new Date().toISOString()};
  }

  const output=Array.isArray(result.output)?result.output:[];
  if(output.some(x=>![...['message','reasoning','web_search_call','web_extractor_call'],...(checked?['function_call']:[])].includes(x.type)))throw fail('VOICE_UNEXPECTED_TOOL');
  const toolCalls=output.filter(x=>['web_search_call','web_extractor_call'].includes(x.type));
  if(toolCalls.length&&(!context.allowSearch||review))throw fail('VOICE_UNEXPECTED_TOOL');
  const searches=output.filter(x=>x.type==='web_search_call');
  const sources=[...new Map(searches.flatMap(x=>x.action?.sources||[]).map(safeSource).filter(Boolean).map(s=>[s.url,s])).values()].slice(0,10);
  if((searches.length||lookup)&&!sources.length)throw fail('PUBLIC_SEARCH_UNAVAILABLE');
  let content=output.filter(x=>x.type==='message'&&x.role==='assistant').flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('').trim();
  if(checked){
   const calls=output.filter(x=>x.type==='function_call').map(x=>({name:x.name,arguments:x.arguments,call_id:x.call_id}));
   if(calls.length>4||calls.some(x=>!(review?['submit_review']:lookup?[]:['calculate',...(context.allowSearch?['lookup_public']:[])]).includes(x.name)||typeof x.arguments!=='string'||x.arguments.length>8000||typeof x.call_id!=='string'))throw fail('VOICE_UNEXPECTED_TOOL');
   if(!content&&!calls.length&&!structuredReview)throw fail('EMPTY_PROVIDER_RESPONSE');
   const extracts=output.filter(x=>x.type==='web_extractor_call'&&typeof x.output==='string').slice(0,3).map(x=>({urls:(x.urls||[]).map(url=>safeSource({url})?.url).filter(Boolean),text:x.output.slice(0,12000)}));
   return {provider:'qwen',model:settings.model,mode:'chat',content:JSON.stringify({draft:content,calls,sources,extracts,searched:searches.length>0,...(review?{review:structuredReview}:{})}),usage:result.usage||null,mocked:false,createdAt:new Date().toISOString()};
  }
  if(!content)throw fail('EMPTY_PROVIDER_RESPONSE');
  if(searches.length)content+=`\n\n检索日期：${context.asOf}\n来源：\n`+sources.map((s,i)=>`[${i+1}] [${s.title}](${s.url})`).join('\n');
  await onDelta(content);
  return {provider:'qwen',model:settings.model,mode:'chat',content,usage:result.usage||null,mocked:false,createdAt:new Date().toISOString()};
 }catch(e){if(signal?.aborted)throw fail('ABORTED');if(timedOut)throw fail('TIMEOUT');throw e;}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
