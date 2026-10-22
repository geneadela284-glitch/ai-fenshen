import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalMemoryClient } from './localMemoryClient.js';
import { createMobileMemoryRuntime } from '../../../../../memory/mobile/runtime.js';
function storage(){let value={revision:0,data:null};return{load:async()=>structuredClone(value),commit:async(_scope,{expectedRevision,data})=>{assert.equal(expectedRevision,value.revision);value={revision:value.revision+1,data};return{revision:value.revision}}}}
test('真实V2治理结果进入前端准备，取消与假回执均不能冒充成功',async()=>{
 const runtime=await createMobileMemoryRuntime({ownerUserId:'test-owner',storage:storage()}),results=[],changes=[];
 const client=createLocalMemoryClient({ownerId:'test-owner',native:()=>({execute:({expectedOwner,command})=>{assert.equal(expectedOwner,'test-owner');return runtime.execute(command)}}),onResult:(id,result)=>results.push({id,result}),onChanged:()=>changes.push(1)});
 const evidence=await client.prepare({text:'请记住：我喜欢喝龙井。',requestId:'client-1'});
 assert.equal(results[0].result.status,'stored');assert.equal(evidence.items[0].text,'我喜欢喝龙井。');assert.equal(changes.length,1);
 const receipt=await client.execute({operation:'receipt',requestId:'client-1'});assert.equal(receipt.status,'stored');assert.equal(changes.length,1,'读回执不重复触发写入通知');
 await client.execute({operation:'delete',requestId:'del',memoryId:evidence.items[0].memoryId,expectedVersion:1,confirmed:true});
 assert.equal((await client.prepare({text:'我喜欢喝什么？',requestId:'next'})).items.length,0);
 assert.equal((await client.execute({operation:'receipt',requestId:'client-1'})).status,'withdrawn');
 assert.equal((await client.execute({operation:'get',references:[{memoryId:evidence.items[0].memoryId,version:1}]})).items.length,0);
 const forged=createLocalMemoryClient({ownerId:'test-owner',native:()=>({execute:async()=>({status:'stored',memoryId:'forged',receipt:{durable:true,ownerUserId:'other'}})})});
 await assert.rejects(forged.execute({operation:'remember'}),{code:'LOCAL_MEMORY_RECEIPT_INVALID'});
 const abort=new AbortController();abort.abort();await assert.rejects(client.prepare({text:'请记住：未授权的内容。',requestId:'stopped',signal:abort.signal}),{name:'AbortError'});
 assert.equal((await runtime.execute({operation:'list'})).items.length,0);
});
test('普通聊天和附件内容不自动写记忆；平台未接入与读取失败有区别',async()=>{
 let writes=0;const native=()=>({execute:async({command})=>{if(command.operation==='remember')writes++;return{revision:0,items:[],revoked:[]}}});
 const client=createLocalMemoryClient({ownerId:'a',native});await client.prepare({text:'今天在看展会。',requestId:'a'});await client.prepare({text:'请记住：图中人物的身份。',requestId:'b',captureEligible:false});assert.equal(writes,0);
 const missing=createLocalMemoryClient({ownerId:'a',native:()=>null});assert.equal((await missing.prepare({text:'我喜欢喝什么？',requestId:'c'})).state,'unavailable');
 const failed=createLocalMemoryClient({ownerId:'a',native:()=>({execute:async()=>{throw{code:'LOCAL_MEMORY_CORRUPT'}}})});assert.equal((await failed.prepare({text:'我喜欢喝什么？',requestId:'d'})).state,'error');
});
