import test from 'node:test';import assert from 'node:assert/strict';
import { createHealthHarness,request } from './testHarness.js';
import { createHealthConversationHandler } from './conversation.js';
const payload={subject:'self',consentStorage:true,consentAI:false};
test('对话本人健康保存真实数据，意向/他人/未来不误记；缺单位草稿',async t=>{
 const h=await createHealthHarness();t.after(()=>h.close());const owner=h.account.id;h.instance.healthRuntime.service.saveProfile(owner,{payload,idempotencyKey:'profile'});
 const handler=createHealthConversationHandler({...h.instance.healthRuntime,clock:()=>new Date('2026-09-09T04:00:00Z')});let n=0;
 const chat=message=>handler.processUserMessage({ownerId:owner,conversationId:'chat-a',sourceMessageId:'m'+n++,message,taskTimezone:'Asia/Shanghai'});
 for(const message of ['记录同事今天08:00体重72公斤','记录张三今天08:00体重72公斤','记录今天晚餐想吃鱼','记录明天08:00体重72公斤']){const r=await chat(message);assert.equal(r.action,'clarify',message);}
 assert.equal(h.instance.healthRuntime.service.list(owner).filter(r=>r.kind!=='profile').length,0);
 const metric=await chat('记录今天08:00体重72.4公斤');assert.equal(metric.action,'saved');
 const bp=await chat('记录刚量的血压128/82');assert.equal(bp.action,'saved',bp.content);
 assert.equal(await chat('记录今天验收健康页面的日记'),null);
 const draft=await chat('记录刚量的血糖6.2');assert.equal(draft.action,'saved');assert.ok(h.instance.healthRuntime.service.list(owner).some(r=>r.payload.status==='draft'&&r.payload.unit===''));
 const reminder=await chat('从今天起三个月后09:00提醒我复查');assert.equal(reminder.action,'proposal');
});
test('真实对话流后续普通聊天不发历史健康内容给模型',async t=>{
 let calls=[];const aiService={getStatus:()=>({available:true}),async run(task){calls.push(task);return{ok:false};},async stream(task,{onDelta}){calls.push(task);await onDelta('普通答复');return{ok:true,content:'普通答复'};}};
 const h=await createHealthHarness({aiServiceOverride:aiService});t.after(()=>h.close());const cookie=h.login.setCookie;
 await request(h,'/api/health/profile',cookie,{method:'PUT',body:{payload}});
 const c=await request(h,'/api/ai/conversations',cookie,{method:'POST',body:{title:'健康测试'}});
 const id=c.body.conversation?.id||c.body.id;assert.ok(id,JSON.stringify(c.body));let seq=0;
 async function send(message){const r=await fetch(h.baseUrl+'/api/ai/chat/stream',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({conversationId:id,message,clientRequestId:'health-chat-'+seq++,timezone:'Asia/Shanghai'})});assert.equal(r.status,200);return r.text();}
 await send('记录今天08:00体重72.4公斤');await send('看看最近一个月体重');calls=[];
 await send('帮我写一份午间开会的通知');
 assert.ok(calls.length);assert.equal(JSON.stringify(calls).includes('72.4'),false);assert.equal(JSON.stringify(calls).includes('health-proposal'),false);
 calls=[];await send('给我一些健身常识');assert.ok(calls.some(t=>t.messages?.some(m=>m.role==='user'&&m.content.includes('给我一些健身常识'))));assert.equal(JSON.stringify(calls).includes('72.4'),false);
});
