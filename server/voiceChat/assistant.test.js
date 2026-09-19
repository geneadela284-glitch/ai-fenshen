import test from'node:test';import assert from'node:assert/strict';import{VoiceWriteGate}from'./writeGate.js';import{createVoiceAssistant,confirmationSummary,confirmationResult}from'./assistant.js';
test('a pure greeting after business history remains ordinary chat without executing the pending business',async()=>{
 const gate=new VoiceWriteGate();let plans=0;
 const agent=createVoiceAssistant({ordinaryChatEnabled:true,gate,semanticPlanner:{plan(){plans++;return{ok:false,code:'SEMANTIC_PLAN_INVALID'};}}});
 const input={ownerId:'a',conversationId:'c',clientRequestId:'hello',message:'你好。',conversationMessages:[{role:'user',content:'明天提醒我开会'},{role:'assistant',content:'几点？'},{role:'user',content:'你好。'}]};
 const result=await agent.processUserMessage(input);
 assert.equal(result.domain,'ordinary_chat');assert.equal(result.handled,undefined);assert.equal(gate.pending.size,0);assert.equal(plans,0);
 const followup=await agent.processUserMessage({...input,message:'改成下午吧',clientRequestId:'followup',conversationMessages:[...input.conversationMessages,{role:'assistant',content:'你好。'},{role:'user',content:'改成下午吧'}]});
 assert.notEqual(followup.domain,'ordinary_chat');assert.equal(plans,1);
});
test('independent ordinary advice after business history bypasses semantic planning',async()=>{
 const gate=new VoiceWriteGate();let plans=0;
 const agent=createVoiceAssistant({ordinaryChatEnabled:true,gate,semanticPlanner:{plan(){plans++;return{ok:false,code:'SEMANTIC_PLAN_INVALID'};}}});
 const history=[{role:'user',content:'明天提醒我开会'},{role:'assistant',content:'几点？'}];
 const greeting='我说：“嗨，你好啊。”';
 const hello=await agent.processUserMessage({ownerId:'a',conversationId:'c',clientRequestId:'hello',message:greeting,conversationMessages:[...history,{role:'user',content:greeting}]});
 assert.equal(hello.domain,'ordinary_chat');
 const message='周末想出去散步，给我一个简单建议。';
 const advice=await agent.processUserMessage({ownerId:'a',conversationId:'c',clientRequestId:'advice',message,conversationMessages:[...history,{role:'user',content:greeting},{role:'assistant',content:'嗨，你好。'},{role:'user',content:message}]});
 assert.equal(advice.domain,'ordinary_chat');assert.equal(plans,0);
 const continuation='改成下午吧';
 const business=await agent.processUserMessage({ownerId:'a',conversationId:'c',clientRequestId:'business',message:continuation,conversationMessages:[...history,{role:'user',content:greeting},{role:'assistant',content:'嗨，你好。'},{role:'user',content:message},{role:'assistant',content:'周末可以选一条熟悉、光线好的路线。'},{role:'user',content:continuation}]});
 assert.notEqual(business.domain,'ordinary_chat');assert.equal(plans,1);
});
test('ordinary advice followup stays ordinary despite stale business history',async()=>{
 const gate=new VoiceWriteGate();let plans=0;
 const agent=createVoiceAssistant({ordinaryChatEnabled:true,gate,semanticPlanner:{plan(){plans++;return{ok:true,plan:{domain:'ordinary_chat',intent:'ordinary_chat',action:'ordinary_chat',entity:{type:null,reference:null,relation_to_owner:null},relation_to_owner:null,predicate:null,value:null,qualifiers:{},arguments:{},required_evidence:[],explicit_fields:[],inherited_fields:[],ambiguity_reasons:[],requires_confirmation:false,confidence:1,source_message_id:null}};}}});
 const history=[{role:'user',content:'明天提醒我开会'},{role:'assistant',content:'几点？'}];
 const advice='周末想出去散步，给我一个简单建议。';
 await agent.processUserMessage({ownerId:'a',conversationId:'c',clientRequestId:'advice',message:advice,conversationMessages:history});
 const followup=await agent.processUserMessage({ownerId:'a',conversationId:'c',clientRequestId:'followup',message:'那下雨的话呢？',conversationMessages:[...history,{role:'user',content:advice},{role:'assistant',content:'可以去公园散步。'}]});
 assert.equal(followup.domain,'ordinary_chat');
 assert.equal(plans,0);
});
test('business rewrite remains protected when it uses an ordinary advice connective',async()=>{
 const gate=new VoiceWriteGate();let plans=0;
 const agent=createVoiceAssistant({ordinaryChatEnabled:true,gate,semanticPlanner:{plan(){plans++;return{ok:false,code:'SEMANTIC_PLAN_INVALID'};}}});
 const history=[{role:'user',content:'明天提醒我开会'},{role:'assistant',content:'几点？'}];
 const advice='周末想出去散步，给我一个简单建议。';
 await agent.processUserMessage({ownerId:'a',conversationId:'c',clientRequestId:'advice',message:advice,conversationMessages:history});
 const rewrite=await agent.processUserMessage({ownerId:'a',conversationId:'c',clientRequestId:'rewrite',message:'那就改成下午吧',conversationMessages:[...history,{role:'user',content:advice},{role:'assistant',content:'可以去公园散步。'}]});
 assert.notEqual(rewrite.domain,'ordinary_chat');
 assert.equal(plans,1);
});
test('ordinary advice followup does not override a newer business context',async()=>{
 const gate=new VoiceWriteGate();let plans=0;
 const agent=createVoiceAssistant({ordinaryChatEnabled:true,gate,semanticPlanner:{plan(){plans++;return{ok:false,code:'SEMANTIC_PLAN_INVALID'};}}});
 const advice='周末想出去散步，给我一个简单建议。';
 const history=[{role:'user',content:advice},{role:'assistant',content:'可以按天气选路线。'},{role:'user',content:'明天提醒我开会'},{role:'assistant',content:'几点？'}];
 const result=await agent.processUserMessage({ownerId:'a',conversationId:'c',clientRequestId:'business-followup',message:'那么可以吗？',conversationMessages:[...history,{role:'user',content:'那么可以吗？'}]});
 assert.notEqual(result.domain,'ordinary_chat');
 assert.equal(plans,1);
});
test('repeat requests reuse the last answer without semantic or answer model calls',async()=>{
 const agent=createVoiceAssistant({gate:new VoiceWriteGate(),semanticPlanner:{plan(){throw Error('repeat must not invoke a planner');}}});
 const result=await agent.processUserMessage({ownerId:'a',conversationId:'existing',clientRequestId:'t',message:'再说一遍。',conversationMessages:[{role:'user',content:'周六我去哪里？'},{role:'assistant',content:'[这条语音未确认完整播放，用户可能没有听完。]\n周六去海边散步。<!-- private metadata -->'},{role:'user',content:'再说一遍。'}]});
 assert.equal(result.handled,true);assert.equal(result.content,'周六去海边散步。');assert.equal(result.domain,'voice_repeat');
});
test('spoken greeting restatements after business are not mistaken for business continuations',async()=>{
 const agent=createVoiceAssistant({ordinaryChatEnabled:true,gate:new VoiceWriteGate(),semanticPlanner:{plan:()=>({ok:false,code:'SEMANTIC_PLAN_INVALID'})}});
 for(const message of ['嗨，你好啊。','我说嗨，你好啊。','我说你好。','我说：“嗨，你好啊。”']){
  const result=await agent.processUserMessage({ownerId:'a',conversationId:message,clientRequestId:'t',message,conversationMessages:[{role:'user',content:'明天提醒我开会'}]});
  assert.equal(result.domain,'ordinary_chat',message);
 }
 for(const message of ['你好，明天提醒我开会','我说你好，帮我删除账目']){
  const result=await agent.processUserMessage({ownerId:'a',conversationId:message,clientRequestId:'t',message,conversationMessages:[]});assert.notEqual(result.domain,'ordinary_chat',message);
 }
});
test('a fresh voice assistant restores business protection across greeting-only history',async()=>{
 const input={ownerId:'a',conversationId:'c',clientRequestId:'t',message:'改成下午吧',conversationMessages:[{role:'user',content:'明天提醒我开会'},{role:'assistant',content:'几点？'},{role:'user',content:'我说：“嗨，你好啊。”'},{role:'assistant',content:'嗨，你好。'}]};
 const agent=createVoiceAssistant({ordinaryChatEnabled:true,gate:new VoiceWriteGate(),semanticPlanner:{plan:()=>({ok:false,code:'SEMANTIC_PLAN_INVALID'})}});
 assert.notEqual((await agent.processUserMessage(input)).domain,'ordinary_chat');
 const denied=createVoiceAssistant({ordinaryChatEnabled:true,gate:new VoiceWriteGate(),semanticPlanner:{plan:()=>({ok:false,code:'ACCOUNT_USAGE_LIMIT_REACHED'})}});
 await assert.rejects(denied.processUserMessage(input),{code:'ACCOUNT_USAGE_LIMIT_REACHED'});
});
test('greetings and ordinary followups avoid a separate planner, with conversation-local scope',async()=>{
 let plans=0;const agent=createVoiceAssistant({gate:new VoiceWriteGate(),semanticPlanner:{plan(){plans++;return{ok:false};}}});
 const input={ownerId:'a',conversationId:'c',clientRequestId:'t',message:'你好。',conversationMessages:[]};
 assert.equal((await agent.processUserMessage(input)).domain,'ordinary_chat');assert.equal(plans,0);
 await agent.processUserMessage({...input,message:'具体说说',conversationMessages:[{role:'assistant',content:'上轮回答'}]});assert.equal(plans,0);
 await agent.processUserMessage({...input,conversationId:'other',message:'具体说说'});assert.equal(plans,1);
 await agent.processUserMessage({...input,message:'帮我记住我的生日是五月六号'});assert.equal(plans,2);
 await agent.processUserMessage({...input,message:'具体说说'});assert.equal(plans,3);
});
test('existing diary parser is reused but its save is captured before the domain service runs',async()=>{const gate=new VoiceWriteGate(),writes=[];const agent=createVoiceAssistant({gate,diaryRuntime:{clock:()=>new Date('2026-09-11T04:00:00Z'),service:{async create(owner,record){writes.push({owner,record});return{id:'diary-new'};},list:()=>[]}},getMessages:()=>[]});
 const input={ownerId:'a',conversationId:'c',clientRequestId:'turn',sourceMessageId:'m',message:'记录今天在公园散步二十分钟。',conversationMessages:[]};const result=await agent.processUserMessage(input);assert.equal(result.action,'voice_confirmation');assert.equal(writes.length,0);assert.match(confirmationSummary(result.voiceProposal).text,/2026-09-11/);const outcome=await gate.confirm(result.voiceProposal.id,{ownerId:'a',conversationId:'c',turnId:'turn'});assert.equal(writes.length,1);assert.equal(writes[0].record.body,input.message);assert.equal(confirmationResult(outcome),'日记已经保存。');});
test('read-only diary lookup stays automatic and ordinary conversation does not become a write',async()=>{const gate=new VoiceWriteGate();let queried=0;const agent=createVoiceAssistant({gate,diaryRuntime:{clock:()=>new Date('2026-09-11T04:00:00Z'),service:{list(){queried++;return[];},create(){throw Error('WRITE_NOT_ALLOWED');}}},getMessages:()=>[]});const input={ownerId:'a',conversationId:'c',clientRequestId:'turn',sourceMessageId:'m',conversationMessages:[]};const query=await agent.processUserMessage({...input,message:'查看我的日记'});assert.equal(query.action,'query');assert.equal(queried,1);const ordinary=await agent.processUserMessage({...input,message:'聊聊今天的安排'});assert.equal(ordinary.domain,'ordinary_chat');assert.equal(gate.pending.size,0);});

test('voice uses the shared creator identity with no model or business calls',async()=>{
 const agent=createVoiceAssistant({gate:new VoiceWriteGate(),semanticPlanner:{plan(){throw Error('identity must not call a model');}}});
 for(const [message,expected] of [['你是谁创造出来的','我是由示例维护者创建的。'],['谁创造了你','我是由示例维护者创建的。'],['你是由谁开发出来的','我是由示例维护者创建的。'],['维护者是谁','示例维护者，身份信息已脱敏。']]){
 const result=await agent.processUserMessage({ownerId:'a',conversationId:'c',message,clientRequestId:'t',conversationMessages:[]});assert.equal(result.content,expected);assert.equal(result.handled,true);}
});

test('questions about creating other things are not replaced with creator identity',async()=>{
 const {deterministicIdentityAnswer}=await import('../agent/identityDeterministic.js');
 for(const message of ['谁创造了这个游戏','维护者是谁的同事','你是谁开发的这款软件好不好用','帮我记录维护者是谁','请解释这句话：谁创造了你'])assert.equal(deterministicIdentityAnswer(message),null);
});

test('natural chat bypasses repeated planning but business turns and other owners do not',async()=>{
 let plans=0;const agent=createVoiceAssistant({ordinaryChatEnabled:true,gate:new VoiceWriteGate(),semanticPlanner:{plan(){plans++;return{ok:false,code:'SEMANTIC_PLAN_INVALID'};}}});
 const input={ownerId:'a',conversationId:'c',clientRequestId:'t',message:'你好',conversationMessages:[]};
 await agent.processUserMessage(input);
 for(const message of ['我今天有点难过','朋友一直不回我消息，你怎么看','那我应该怎么回应他','换个话题，聊聊露营'])assert.equal((await agent.processUserMessage({...input,message})).domain,'ordinary_chat');
 assert.equal(plans,0);
 assert.equal((await agent.processUserMessage({...input,message:'谁创造了你'})).content,'我是由示例维护者创建的。');
 await agent.processUserMessage({...input,ownerId:'b',message:'我今天有点难过'});assert.equal(plans,1);
 await agent.processUserMessage({...input,message:'明天三点提醒我给他打电话'});assert.equal(plans,2);
 await agent.processUserMessage({...input,message:'那就下午四点'});assert.equal(plans,3);
});

test('voice planner failures fall back only for safe generic chat, preserving business and connection errors',async()=>{
 const input={ownerId:'a',conversationId:'c',clientRequestId:'t',conversationMessages:[]};
 for(const message of ['最近总觉得没有动力，你怎么看','为什么天空是蓝色的']){
  const agent=createVoiceAssistant({ordinaryChatEnabled:true,gate:new VoiceWriteGate(),semanticPlanner:{plan:async()=>({ok:false,code:'SEMANTIC_PLAN_INVALID'})}});
  const result=await agent.processUserMessage({...input,message});assert.equal(result.domain,'ordinary_chat');assert.equal(result.handled,undefined);
 }
 for(const message of ['帮我记住我的生日','删除昨天的账目','明天提醒我开会','save this as my preference','查看我的健康记录','把刚才的内容发给小李']){
  const agent=createVoiceAssistant({ordinaryChatEnabled:true,gate:new VoiceWriteGate(),semanticPlanner:{plan:async()=>({ok:false,code:'SEMANTIC_PLAN_INVALID'})}});
  assert.notEqual((await agent.processUserMessage({...input,message})).domain,'ordinary_chat',message);
 }
 const agent=createVoiceAssistant({ordinaryChatEnabled:true,gate:new VoiceWriteGate(),semanticPlanner:{plan:async()=>({ok:false,code:'NO_USABLE_RUNTIME_CONNECTION'})}});
 await assert.rejects(agent.processUserMessage({...input,message:'我有点难过'}),{code:'NO_USABLE_RUNTIME_CONNECTION'});
});

test('text business context invalidates an earlier voice ordinary fast path',async()=>{
 let plans=0;const agent=createVoiceAssistant({ordinaryChatEnabled:true,gate:new VoiceWriteGate(),semanticPlanner:{plan(){plans++;return{ok:false,code:'SEMANTIC_PLAN_INVALID'};}}});
 const input={ownerId:'a',conversationId:'c',clientRequestId:'t',message:'你好',conversationMessages:[]};
 await agent.processUserMessage(input);
 const result=await agent.processUserMessage({...input,message:'改成下午吧',conversationMessages:[{role:'user',content:'你好'},{role:'assistant',content:'你好'},{role:'user',content:'明天提醒我开会'},{role:'assistant',content:'几点？'},{role:'user',content:'改成下午吧'}]});
 assert.equal(plans,1);assert.notEqual(result.domain,'ordinary_chat');
});

test('validated target ambiguity asks one concrete voice question without answering or writing',async()=>{
 const plan={domain:'ambiguous',intent:'ambiguous',action:'ambiguous',entity:{type:null,reference:null,relation_to_owner:null},relation_to_owner:null,predicate:null,value:null,qualifiers:{},arguments:{},required_evidence:[],explicit_fields:[],inherited_fields:[],ambiguity_reasons:['target_missing'],requires_confirmation:true,confidence:.2};
 const gate=new VoiceWriteGate(),agent=createVoiceAssistant({ordinaryChatEnabled:true,gate,semanticPlanner:{plan:async()=>({ok:true,plan})}});
 const result=await agent.processUserMessage({ownerId:'a',conversationId:'c',clientRequestId:'t',sourceMessageId:'m',message:'帮我处理一下',conversationMessages:[]});
 assert.equal(result.domain,'ambiguous');assert.equal(result.action,'clarify');assert.equal(result.handled,true);assert.equal(result.content,'你希望我具体处理哪件事？');assert.equal(gate.pending.size,0);
});

test('voice clarification stays invocation-local and flag-off preserves the shared response',async()=>{
 const base={domain:'ambiguous',intent:'ambiguous',action:'ambiguous',entity:{type:null,reference:null,relation_to_owner:null},relation_to_owner:null,predicate:null,value:null,qualifiers:{},arguments:{},required_evidence:[],explicit_fields:[],inherited_fields:[],requires_confirmation:true,confidence:.2};
 const planner={async plan(input){await new Promise(r=>setTimeout(r,input.ownerId==='a'?5:1));return{ok:true,plan:{...base,ambiguity_reasons:[input.ownerId==='a'?'target_missing':'time_missing']}};}};
 const input={conversationId:'c',clientRequestId:'t',sourceMessageId:'m',message:'帮我处理一下',conversationMessages:[]};
 const agent=createVoiceAssistant({ordinaryChatEnabled:true,gate:new VoiceWriteGate(),semanticPlanner:planner});
 const [a,b]=await Promise.all(['a','b'].map(ownerId=>agent.processUserMessage({...input,ownerId})));
 assert.equal(a.content,'你希望我具体处理哪件事？');assert.equal(b.content,'你希望安排在什么时间？');
 const original=createVoiceAssistant({gate:new VoiceWriteGate(),semanticPlanner:planner});assert.equal((await original.processUserMessage({...input,ownerId:'a'})).content,'请补充一个最必要的明确信息。');
});
