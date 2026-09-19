import test from 'node:test';import assert from 'node:assert/strict';
import { redactHealthHistory,healthPrivateAiService } from './aiPrivacy.js';
test('普通闲聊不携带之前的健康问题与回复，包括长回复尾标记',async()=>{
 const history=[{role:'user',content:'记录刚量的血糖6.2'},{role:'assistant',content:'回复'.repeat(1000)+'<!-- health-turn-v1 -->'},{role:'user',content:'帮我写通知'},{role:'assistant',content:'通知内容'}];
 assert.deepEqual(redactHealthHistory(history),history.slice(2));let task;
 class Ai{run(){return this;} stream(t){task=t;return this;} repairSchema(){return this;}}
 const ai=new Ai(),wrapper=healthPrivateAiService(ai);assert.equal(wrapper.run(),ai);assert.equal(wrapper.repairSchema(),ai);assert.equal(wrapper.stream({messages:history}),ai);assert.deepEqual(task.messages,history.slice(2));
});

test('系统身份、产品边界与可信记忆指令始终保留',()=>{const system={role:'system',content:'AI秘书产品健康管理边界与可信事实'};const messages=[system,{role:'user',content:'记录健康数据'},{role:'assistant',content:'已记录'},{role:'user',content:'写通知'}];assert.deepEqual(redactHealthHistory(messages),[system,messages[3]]);});

test('健康适配保留上游已经过滤的文档对话边界',async()=>{
 const {withHealthAssistant}=await import('./conversation.js');let received;
 const clean=[{role:'user',content:'写一份通知'}];
 const agent=withHealthAssistant({processUserMessage:async i=>{received=i;return{handled:false};}},null,{getMessages:()=>[{role:'assistant',content:'受保护文档内容'}]});
 await agent.processUserMessage({message:'写通知',conversationMessages:clean});assert.deepEqual(received.conversationMessages,clean);
});

test('当前明确提出的健身问题保留，只有历史健康回合被剔除',()=>{
 let task;const service=healthPrivateAiService({stream(t){task=t;return t;}});
 const current={role:'user',content:'给我一些健身常识'};
 service.stream({input:current.content,messages:[{role:'system',content:'AI秘书'},{role:'user',content:'记录体重72.4公斤'},{role:'assistant',content:'已记录'},{role:'user',content:'写通知'},{role:'assistant',content:'通知已写好'},current]});
 assert.equal(task.messages.at(-1),current);assert.equal(JSON.stringify(task.messages).includes('72.4'),false);
});
