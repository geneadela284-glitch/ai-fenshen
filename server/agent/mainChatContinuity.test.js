import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantAgentOrchestrator } from './assistantAgentOrchestrator.js';
const ordinary={domain:'ordinary_chat',intent:'ordinary_chat',action:'ordinary_chat'};
test('旅行计划的预算纠正不被金额关键词强制改为账本操作',async()=>{
 const routes=[];const agent=createAssistantAgentOrchestrator({financeService:{isFinanceCandidate:()=>true},semanticIngress:{interpret:async input=>{routes.push(input.routeDomain);return{ok:true,plan:ordinary}}}});
 const answer=await agent.processUserMessage({ownerId:'a',conversationId:'c',message:'把预算改为一千元',conversationMessages:[{role:'user',content:'我要安排周末两天的旅行计划'}]});
 assert.equal(answer.domain,'ordinary_chat');assert.deepEqual(routes,['semantic_planner']);
 const financial=await agent.processUserMessage({ownerId:'a',conversationId:'c',message:'查询本月支出预算',conversationMessages:[{role:'user',content:'我要安排旅行计划'}]});
 assert.equal(financial.domain,'finance');assert.equal(financial.action,'error');
});
test('本机事实查询经过主入口语义分流仍使用设备证据而不依赖服务器记忆库',async()=>{
 let called=0;const agent=createAssistantAgentOrchestrator({semanticIngress:{interpret:async()=>({ok:true,plan:{domain:'memory',intent:'query_fact'}})},memoryIntegration:{processSemanticPlan(){called++;throw Error('cloud memory must not be used')}}});
 const answer=await agent.processUserMessage({ownerId:'a',conversationId:'c',message:'我做什么工作？',conversationMessages:[],localMemoryEvidence:{ownerId:'a',spaceId:'personal',items:[]}});
 assert.equal(answer.kind,'local_query');assert.equal(called,0);
});

test('旅行、午餐和购物主题的建议不会因财务候选关键词强制变成账本操作',async()=>{
 const agent=createAssistantAgentOrchestrator({financeService:{isFinanceCandidate:()=>true},semanticIngress:{interpret:async()=>({ok:true,plan:ordinary})}});
 for(const message of ['给我一份详细的旅行建议','推荐简单的午餐做法','购物时怎样控制预算','工资谈判有什么建议']){
  assert.equal((await agent.processUserMessage({ownerId:'a',conversationId:'c',message,conversationMessages:[]})).domain,'ordinary_chat',message);
 }
 for(const message of ['查询本月支出','我今天花了多少钱','删除上一笔账目']){
  assert.equal((await agent.processUserMessage({ownerId:'a',conversationId:'c',message,conversationMessages:[]})).domain,'finance',message);
 }
});

test('查过账之后的新建议话题不会继承财务强制路由',async()=>{
 const agent=createAssistantAgentOrchestrator({financeService:{isFinanceCandidate:()=>true,trustedContext:()=>({previous_action:'query'})},semanticIngress:{interpret:async()=>({ok:true,plan:ordinary})}});
 const result=await agent.processUserMessage({ownerId:'a',conversationId:'c',message:'现在给我一些旅行建议',conversationMessages:[]});assert.equal(result.domain,'ordinary_chat');
});

import { DatabaseSync } from 'node:sqlite';
import { applyFinanceMigrations } from '../finance/migrations.js';
import { applyFinanceF201Migration } from '../finance/financeF201Migration.js';
import { createFinanceRuntime } from '../finance/runtime.js';
test('真实财务快捷解析不得把活动预算、禁止购买和假设购买写到账本',async()=>{
 const db=new DatabaseSync(':memory:');applyFinanceMigrations(db);applyFinanceF201Migration(db);
 const finance=createFinanceRuntime({database:db,f201Enabled:true});let semanticCalls=0;
 const agent=createAssistantAgentOrchestrator({financeService:finance.service,semanticIngress:{interpret:async()=>{semanticCalls++;return{ok:true,plan:ordinary}}}});
 try{for(const [i,message] of ['我们规划周末家具小展。总预算3000元，只能用现有桌椅，不购买设备。先给两个方案，80字以内。','如果购买桌子花300元，你觉得合适吗？','不要记账，午餐20元只是预算。','准备买椅子200元，帮我比较方案。'].entries()){
  const answer=await agent.processUserMessage({ownerId:'a',conversationId:'c',message,clientRequestId:'planning-'+i,sourceMessageId:'source-'+i,conversationMessages:[]});assert.equal(answer.domain,'ordinary_chat',message);
 }
 assert.equal(semanticCalls,4);
 const result=await agent.processUserMessage({ownerId:'a',conversationId:'c',message:'早餐14元',clientRequestId:'actual-1',sourceMessageId:'actual-source',conversationMessages:[]});assert.equal(result.domain,'finance');assert.equal(result.action,'create');assert.equal(result.data.entry.amountMinor,1400);
 }finally{finance.close();db.close()}
});
test('用户明确不要记账时，即使模型提出写入也不能执行',async()=>{
 let writes=0;const agent=createAssistantAgentOrchestrator({financeService:{isFinanceCandidate:()=>true,processUserMessage:async()=>{writes++;throw Error('must not write')}},semanticIngress:{interpret:async()=>({ok:true,plan:{domain:'finance',intent:'finance.create',action:'create',arguments:{amount_minor:2000,direction:'expense'}}})}});
 const result=await agent.processUserMessage({ownerId:'a',conversationId:'c',message:'不要记账，午餐20元只是预算。',conversationMessages:[]});assert.equal(writes,0);assert.equal(result.code,'FINANCE_WRITE_NOT_AUTHORIZED');
});

test('模型误把预算纠正分类为财务时回到普通对话，不能调用账本',async()=>{
 let writes=0;const agent=createAssistantAgentOrchestrator({financeService:{isFinanceCandidate:()=>true,processUserMessage:async()=>{writes++;throw Error('must not write')}},semanticIngress:{interpret:async()=>({ok:true,plan:{domain:'finance',intent:'finance.update',action:'update',arguments:{amount_minor:100000,direction:'expense'}}})}});
 const result=await agent.processUserMessage({ownerId:'a',conversationId:'c',message:'更正：预算只有1000元，3000元作废。第二个方案继续，40字以内。',conversationMessages:[{role:'user',content:'我们规划周末家具小展，总预算3000元。'}]});assert.equal(result.domain,'ordinary_chat');assert.equal(writes,0);
});
