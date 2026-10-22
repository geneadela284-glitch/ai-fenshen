import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {OriginalPokerRepository,POKER_RUNTIME,POKER_CONTENT_HASH,POKER_DATABASE} from './originalRepository.js';
const bytes=new Uint8Array(400);bytes.set(new TextEncoder().encode('MAMESAVE'));bytes.fill(42,8);
const snapshot={runtime:POKER_RUNTIME,contentHash:POKER_CONTENT_HASH,state:bytes};
test('full original snapshots survive a new repository, isolate owners and never touch legacy records',async()=>{
 const indexedDBImpl=new IDBFactory();
 const legacy=await new Promise(r=>{const q=indexedDBImpl.open('ai-fenshen-games-v1',1);q.onupgradeneeded=()=>q.result.createObjectStore('games',{keyPath:'ownerId'});q.onsuccess=()=>r(q.result);});
 await new Promise(r=>{const t=legacy.transaction('games','readwrite');t.objectStore('games').put({ownerId:'a',credits:777,revision:3});t.oncomplete=r;});
 const a=new OriginalPokerRepository('a',{indexedDBImpl}),b=new OriginalPokerRepository('b',{indexedDBImpl});
 await a.read();await a.save(snapshot,0);a.close();const fresh=new OriginalPokerRepository('a',{indexedDBImpl});
 assert.deepEqual((await fresh.read()).snapshot.state,bytes);assert.equal((await b.read()).snapshot,null);
 const old=await new Promise(r=>{const q=legacy.transaction('games').objectStore('games').get('a');q.onsuccess=()=>r(q.result);});
 assert.deepEqual(old,{ownerId:'a',credits:777,revision:3});fresh.close();b.close();legacy.close();
});
test('racing pages have one winner and stale writes cannot overwrite the newest snapshot',async()=>{
 const indexedDBImpl=new IDBFactory(),a=new OriginalPokerRepository('a',{indexedDBImpl}),b=new OriginalPokerRepository('a',{indexedDBImpl});
 await a.read();const r=await Promise.allSettled([a.save(snapshot,0),b.save(snapshot,0)]);
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal((await a.read()).revision,1);a.close();b.close();
});
test('corrupted, wrong-runtime and non-state files fail without replacing valid state',async()=>{
 const indexedDBImpl=new IDBFactory(),a=new OriginalPokerRepository('a',{indexedDBImpl});await a.read();await a.save(snapshot,0);
 for(const s of [{...snapshot,state:new Uint8Array(400)},{...snapshot,runtime:'wrong'},{...snapshot,contentHash:'b'.repeat(64)}])await assert.rejects(()=>a.save(s,1));
 assert.deepEqual((await a.read()).snapshot.state,bytes);
 const db=await a.db();await new Promise(r=>{const t=db.transaction('snapshots','readwrite'),s=t.objectStore('snapshots'),q=s.get('a');q.onsuccess=()=>{q.result.snapshot.state[99]^=1;s.put(q.result);};t.oncomplete=r;});
 await assert.rejects(()=>a.read(),/校验/);a.close();
});
test('closed owners reject late saves; absent storage and blank owners fail visibly',async()=>{
 assert.throws(()=>new OriginalPokerRepository(''),/登录/);
 const a=new OriginalPokerRepository('a',{indexedDBImpl:new IDBFactory()});await a.read();a.close();await assert.rejects(()=>a.save(snapshot,0),/关闭/);
 const b=new OriginalPokerRepository('b',{indexedDBImpl:null});await assert.rejects(()=>b.read(),/存储/);b.close();assert.equal(POKER_DATABASE,'ai-fenshen-poker-original-v1');
});
