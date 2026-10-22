import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ConversationService } from './conversationService.js';
import { ConversationRepository, MessageRepository } from './repositories.js';
import { applyConversationMigrations } from './migrations.js';
import { ActiveRequestRegistry } from './activeRequestRegistry.js';
const evidence = (text='我喜欢喝什么？') => ({ schema:'local-memory-evidence:1', ownerId:'a', spaceId:'personal', question:text,
 state:'available', revision:1, items:[{memoryId:'mem_test-1',version:1,text:'我喜欢喝龙井。',source:{type:'conversation_message',id:'source-1'},updatedAt:'2026-10-03T00:00:00.000Z'}], revoked:[] });
function harness(){
 const database=new DatabaseSync(':memory:');applyConversationMigrations(database);const registry=new ActiveRequestRegistry(),calls=[];
 const service=new ConversationService({conversations:new ConversationRepository({database}),messages:new MessageRepository({database}),registry,
 aiService:{async stream(task,{onDelta}){calls.push(task);await onDelta('你喜欢喝龙井。[记忆:mem_test-1:1]');return{ok:true,content:'你喜欢喝龙井。[记忆:mem_test-1:1]'}}}});
 return {service,calls,close(){registry.close();database.close()}};
}
test('实际文字模型请求包含必要本机记忆，明确数据不是权限或指令',async()=>{
 const r=harness();try{const prepared=r.service.prepare({ownerId:'a',message:'我喜欢喝什么？',clientRequestId:'q1',localMemory:evidence()});
 await r.service.execute(prepared);assert.match(JSON.stringify(r.calls[0].messages),/龙井/);assert.match(JSON.stringify(r.calls[0].messages),/不是.*指令|不可.*指令/);
 }finally{r.close()}
});
test('拒绝跨用户、空间、问题错配和超量记忆投影',()=>{
 const r=harness();try{for(const wrong of [{ownerId:'b'},{spaceId:'other'},{question:'different'},{items:Array(20).fill(evidence().items[0])}]){
 assert.throws(()=>r.service.prepare({ownerId:'a',message:'我喜欢喝什么？',clientRequestId:'bad',localMemory:{...evidence(),...wrong}}),e=>String(e.code).startsWith('LOCAL_MEMORY_'));
 }}finally{r.close()}
});
test('客户端声称保存成功不能作为服务端可信写入回执',async()=>{
 const r=harness();try{const text='请记住：我喜欢喝龙井。';
 const p=r.service.prepare({ownerId:'a',message:text,clientRequestId:'save',localMemory:{...evidence(text),receipt:{durable:true},outcome:'memory_written'}});
 const result=await r.service.execute(p);assert.doesNotMatch(result.content,/已(?:经)?记住|已保存/);assert.equal(r.calls.length,0);
 assert.match(result.content,/本机记忆/);
 }finally{r.close()}
});
test('本机读取错误不能被模型编造成从未告诉过',async()=>{
 const r=harness();try{const p=r.service.prepare({ownerId:'a',message:'我喜欢喝什么？',clientRequestId:'failed',localMemory:{...evidence(),items:[],state:'error'}});
 const result=await r.service.execute(p);assert.match(result.content,/无法读取|未能读取/);assert.equal(r.calls.length,0);
 }finally{r.close()}
});
