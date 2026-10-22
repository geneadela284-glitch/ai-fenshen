import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {buildAnswerContext} from '../voiceChat/answerContext.js';
import {ConversationService} from './conversationService.js';
import {ConversationRepository,MessageRepository} from './repositories.js';
import {applyConversationMigrations} from './migrations.js';
import {ActiveRequestRegistry} from './activeRequestRegistry.js';

function history(turns=20){
 const rows=[];
 for(let n=0;n<turns;n++){
  rows.push({id:`u${n}`,role:'user',content:n===0?'请规划展会。总预算5000元，目标是展示家具。':n===1?'更正：预算只有3000元，5000元作废。':n===turns-1?'按最新预算，继续第二个方案。':`继续比较方案的第${n}个细节。`});
  if(n!==turns-1)rows.push({id:`a${n}`,role:'assistant',status:'completed',content:`比较第${n}个细节。`});
 }
 return rows;
}
function runtime(reply){
 const database=new DatabaseSync(':memory:');applyConversationMigrations(database);
 const registry=new ActiveRequestRegistry(),requests=[];
 const messages=new MessageRepository({database});
 const service=new ConversationService({conversations:new ConversationRepository({database}),messages,registry,aiService:{async stream(task,{onDelta}){requests.push(task);await onDelta(reply);return {ok:true,content:reply};}},memoryPolicy:'disabled'});
 return {service,messages,requests,close(){registry.close();database.close()}};
}
test('20轮语音上下文仍携带早期目标和最新预算纠正',()=>{
 const rows=history(),context=buildAnswerContext({input:rows.at(-1).content,messages:rows});
 const sent=JSON.stringify({messages:context.messages,instructions:context.instructions});
 assert.match(sent,/展示家具/);assert.match(sent,/3000元/);
});
test('长对话提供带原消息引用的阶段上下文，保留最后纠正，预算受控',()=>{
 const rows=history(120);for(const row of rows)if(row.role==='assistant')row.content+='这是历史比较。'.repeat(45);
 rows.at(-1).content='更正：取消展会，不再执行原方案。';
 const context=buildAnswerContext({input:rows.at(-1).content,messages:rows});
 assert.ok(context.stageContext?.excerpts?.some(e=>e.messageId==='u0'));
 assert.equal(context.messages.at(-1).content,rows.at(-1).content);
 assert.ok(JSON.stringify(context.messages).length+JSON.stringify(context.stageContext).length<=14000);
});
test('未经永久存储回执的已记住不能通过流式或最终结果显示',async()=>{
 const r=runtime('好的，已经记住了。');try{
  const prepared=r.service.prepare({ownerId:'synthetic',clientRequestId:'remember',message:'请记住：我偏好简短回答。'}),deltas=[];
  const result=await r.service.execute(prepared,{onDelta:t=>deltas.push(t)});
  assert.doesNotMatch(result.content,/已经记住/);assert.doesNotMatch(deltas.join(''),/已经记住/);
  assert.match(result.content,/未|没能|尚未/);
 }finally{r.close()}
});
test('普通的当前对话回顾仍可正常回复，不误称长期记忆保存',async()=>{
 const r=runtime('刚才我们在比较两个方案。');try{
  const p=r.service.prepare({ownerId:'synthetic',clientRequestId:'recap',message:'刚才我们说到哪了？'});
  assert.equal((await r.service.execute(p)).content,'刚才我们在比较两个方案。');
 }finally{r.close()}
});
test('记忆确认审查过程中取消或失败不能保存未核实的口头成功',async()=>{
 for(const mode of ['cancel','error']){
  const r=runtime('');try{
   const p=r.service.prepare({ownerId:'synthetic',clientRequestId:mode,message:'记住我的测试偏好。'});
   r.service.aiService.stream=async(_task,{onDelta})=>{await onDelta('已经记住了。');if(mode==='cancel'){p.controller.abort();return {ok:false,code:'ABORTED'}}throw Error('synthetic failure')};
   const result=await r.service.execute(p);
   assert.doesNotMatch(result.content,/已经记住/);
   assert.doesNotMatch(r.messages.listForConversationOwner(p.conversation.id,'synthetic').at(-1).content,/已经记住/);
  }finally{r.close()}
 }
});
test('复用幂等键时内容改变应拒绝，不能悄悄重放上一条消息',async()=>{
 const r=runtime('原回答');try{
  const p=r.service.prepare({ownerId:'synthetic',clientRequestId:'same',message:'第一个问题'});await r.service.execute(p);
  assert.throws(()=>r.service.prepare({ownerId:'synthetic',conversationId:p.conversation.id,clientRequestId:'same',message:'不同的问题'}),{code:'REQUEST_CONTENT_CONFLICT'});
 }finally{r.close()}
});
test('公开搜索上下文继续排除先前私密交换与阶段摘录',()=>{
 const rows=history(30);rows[0].content='我的银行卡秘密标记 private-marker-123';rows[1].content='私人信息回声 private-echo-123';rows.at(-1).content='今天杭州天气怎么样？';
 const context=buildAnswerContext({input:rows.at(-1).content,messages:rows});
 assert.equal(context.allowSearch,true);assert.doesNotMatch(JSON.stringify(context),/private-marker|private-echo/);
});

import {createAssistantAgentOrchestrator} from '../agent/assistantAgentOrchestrator.js';
test('语义服务超时如实保留失败状态，同一请求重试成功且不重复消息',async()=>{
 const r=runtime('继续原对话的有效回答');let available=false;
 r.service.assistantAgent=createAssistantAgentOrchestrator({semanticIngress:{interpret:async()=>available?{ok:true,plan:{domain:'ordinary_chat',intent:'ordinary_chat',action:'ordinary_chat'}}:{ok:false,code:'ASSISTANT_SEMANTIC_PLANNER_UNAVAILABLE'}}});
 try{const p=r.service.prepare({ownerId:'synthetic',clientRequestId:'timeout-retry',message:'回顾最初的目标和最新预算。'});const failed=await r.service.execute(p);assert.equal(failed.status,'error');assert.equal(failed.code,'ASSISTANT_SEMANTIC_PLANNER_UNAVAILABLE');assert.equal(r.requests.length,0);
 available=true;const retry=r.service.prepare({ownerId:'synthetic',conversationId:p.conversation.id,clientRequestId:'timeout-retry',message:'回顾最初的目标和最新预算。',retry:true});assert.equal((await r.service.execute(retry)).status,'completed');assert.equal(r.messages.listForConversationOwner(p.conversation.id,'synthetic').length,2);
 }finally{r.close()}
});
