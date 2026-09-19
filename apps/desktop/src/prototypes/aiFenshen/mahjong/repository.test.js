import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {MahjongRepository} from './repository.js';
const snapshot={runtime:'mame0274-lhzb2a-web1',contentHash:'a'.repeat(64),state:new Uint8Array(300).fill(42)};
test('original machine snapshots restore byte-for-byte and stay within their owner',async()=>{
  const indexedDBImpl=new IDBFactory(),a=new MahjongRepository('a',{indexedDBImpl}),b=new MahjongRepository('b',{indexedDBImpl});
  try{const row=await a.read();const next=await a.save(snapshot,row.revision);assert.deepEqual((await a.read()).snapshot.state,snapshot.state);assert.equal((await b.read()).snapshot,null);assert.equal(next.revision,1);}finally{a.close();b.close();}
});
test('two pages cannot overwrite the same revision; deletion cannot resurrect a stale snapshot',async()=>{
  const indexedDBImpl=new IDBFactory(),a=new MahjongRepository('a',{indexedDBImpl}),b=new MahjongRepository('a',{indexedDBImpl});
  try{await a.read();const results=await Promise.allSettled([a.save(snapshot,0),b.save(snapshot,0)]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);const row=await a.read();await a.delete(row.revision);await assert.rejects(()=>b.save(snapshot,row.revision),/另一个页面/);assert.equal((await a.read()).snapshot,null);}finally{a.close();b.close();}
});
test('invalid and late writes never replace a valid snapshot',async()=>{
  const indexedDBImpl=new IDBFactory(),a=new MahjongRepository('a',{indexedDBImpl});
  await a.read();await a.save(snapshot,0);await assert.rejects(()=>a.save({...snapshot,state:new Uint8Array(0)},1));assert.deepEqual((await a.read()).snapshot.state,snapshot.state);a.close();await assert.rejects(()=>a.save(snapshot,1),/关闭/);
});
