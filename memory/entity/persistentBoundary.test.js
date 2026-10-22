import test from 'node:test';
import assert from 'node:assert/strict';
import {createInMemoryEntityFoundation} from './inMemoryFoundation.js';

test('持久写失败时同一V2事务不得发布成功状态',async()=>{
 const foundation=createInMemoryEntityFoundation({beforeCommit:async()=>{throw Object.assign(Error('disk full'),{code:'LOCAL_MEMORY_WRITE_FAILED'})}});
 await assert.rejects(foundation.unitOfWork.run({ownerUserId:'owner-a'},async({repository})=>repository.ensureSelfEntity('owner-a')),{code:'LOCAL_MEMORY_WRITE_FAILED'});
 assert.equal(foundation.repository.listByOwner('owner-a').length,0);
});
test('V2事务恢复保持同一身份，并在持久提交完成之前不暴露新记录',async()=>{
 let saved=null,release,entered;const ready=new Promise(r=>entered=r);
 const foundation=createInMemoryEntityFoundation({beforeCommit:async state=>{saved=structuredClone(state);entered();await new Promise(r=>release=r)}});
 const pending=foundation.unitOfWork.run({ownerUserId:'owner-a',idempotencyKey:'self'},async({repository})=>repository.ensureSelfEntity('owner-a'));
 assert.equal(await Promise.race([ready.then(()=>true),pending.then(()=>false)]),true,'持久提交钩子必须先于完成回执');assert.equal(foundation.repository.listByOwner('owner-a').length,0);release();const self=await pending;
 const restored=createInMemoryEntityFoundation({initialState:saved});
 assert.equal(restored.repository.listByOwner('owner-a')[0].entityId,self.entityId);
 assert.equal(restored.repository.listByOwner('owner-b').length,0);
});
