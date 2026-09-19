import test from 'node:test';import assert from 'node:assert/strict';
import { VoiceWriteGate } from './writeGate.js';
test('frozen domain services keep their receiver and require confirmation for writes',async()=>{
 const gate=new VoiceWriteGate(),writes=[];
 const original=Object.freeze({label:'protected',read(){assert.equal(this,original);return this.label;},save(value){assert.equal(this,original);writes.push(value);return{id:'saved'};}});
 const guarded=gate.wrap(original,['read'],'memory');
 assert.equal(guarded.read(),'protected');
 assert.throws(()=>guarded.save('unscoped'),{code:'VOICE_WRITE_UNSCOPED'});
 const identity={ownerId:'a',conversationId:'c',turnId:'t'};
 const result=await gate.inspect(identity,()=>guarded.save('confirmed'));
 assert.deepEqual(writes,[]);
 await gate.confirm(result.proposal.id,identity);
 assert.deepEqual(writes,['confirmed']);assert.ok(Object.isFrozen(original));
});
test('writes are captured before invocation; confirmation binds owner, conversation, turn and exact arguments',async()=>{
 let writes=[];const gate=new VoiceWriteGate();const service=gate.wrap({list:()=>['owned'],create:(owner,data)=>{writes.push({owner,...data});return{id:'saved'};}},['list']);
 const args={amount:10};const result=await gate.inspect({ownerId:'a',conversationId:'c',turnId:'t'},async()=>{assert.deepEqual(service.list(),['owned']);try{await service.create('a',args);}catch{}return{content:'must not claim success'};});
 args.amount=999;assert.equal(writes.length,0);assert.equal(result.proposal.details[1].amount,10);
 await assert.rejects(gate.confirm(result.proposal.id,{ownerId:'b',conversationId:'c',turnId:'t'}));assert.equal(writes.length,0);
 const identity={ownerId:'a',conversationId:'c',turnId:'t'};const [a,b]=await Promise.all([gate.confirm(result.proposal.id,identity),gate.confirm(result.proposal.id,identity)]);assert.deepEqual(a,b);assert.deepEqual(writes,[{owner:'a',amount:10}]);
});
test('concurrent turns do not share proposals; cancellation and expiry forbid writes',async()=>{
 let count=0,now=0;const gate=new VoiceWriteGate({clock:()=>now,ttlMs:50});const service=gate.wrap({create:()=>++count},[]);
 const ids=[{ownerId:'a',conversationId:'x',turnId:'1'},{ownerId:'b',conversationId:'y',turnId:'2'}];
 const results=await Promise.all(ids.map(identity=>gate.inspect(identity,async()=>{try{service.create();}catch{};})));
 gate.invalidate(ids[0]);await assert.rejects(gate.confirm(results[0].proposal.id,ids[0]));now=51;await assert.rejects(gate.confirm(results[1].proposal.id,ids[1]));assert.equal(count,0);
});
test('unscoped guarded writes fail closed and unsupported multiple writes never execute',async()=>{
 let count=0;const gate=new VoiceWriteGate();const service=gate.wrap({create:()=>++count},[]);assert.throws(()=>service.create());
 const identity={ownerId:'a',conversationId:'c',turnId:'t'};await assert.rejects(gate.inspect(identity,async()=>{try{service.create(1);}catch{}try{service.create(2);}catch{};}),{code:'VOICE_MULTIPLE_WRITES'});assert.equal(count,0);
});
