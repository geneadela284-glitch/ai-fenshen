import {test} from 'node:test';import assert from 'node:assert/strict';
import {identifyTile,decodeDisplay,mayDiscard,readSprites} from './display-model.js';
test('verified sprite families preserve all 34 faces and concealed tile; unknown is never guessed',()=>{for(let n=0;n<35;n++){assert.equal(identifyTile({addr:69486+n*1260,w:36,h:35}),n);assert.equal(identifyTile({addr:123666+n*891,w:33,h:27}),n);}assert.equal(identifyTile({addr:70747,w:36,h:35}),null);assert.equal(identifyTile({addr:70746,w:33,h:27}),null);});
test('only actual letter positions authorize a tile; changed hand rejects stale tap',()=>{const ss=[{x:10,y:202,w:36,h:35,addr:70746},{x:20,y:191,w:18,h:10,addr:66966},{x:60,y:4,w:36,h:35,addr:112326}];const m=decodeDisplay(ss,[],0);assert.equal(m.hand[0].slot,0);assert.equal(m.table[0].tile,34);assert.ok(mayDiscard(m,0,m.signature));assert.ok(!mayDiscard(m,0,'old'));assert.ok(!mayDiscard(m,13,m.signature));assert.equal(m.credit,null);});
test('score uses validated original digit codes; blank and invalid display never invent balance',()=>{const mem=new Uint8Array(8200),ptr=4;const set=(y,x,c)=>{const o=ptr+(y*64+x)*4;mem[o]=c&255;mem[o+1]=c>>8;};[7763,7763,7727,7759].forEach((c,i)=>set(10,53+i*2,c));[7807,7771].forEach((c,i)=>set(12,57+i*2,c));let d=decodeDisplay([],mem,ptr);assert.equal(d.credit,19);assert.equal(d.bet,1);set(10,59,999);assert.equal(decodeDisplay([],mem,ptr).credit,null);});
test('sprite end marker stops stale tail reads',()=>{const mem=new Uint8Array(2048);mem[1]=2;assert.deepEqual(readSprites(mem,0),[]);});
test('ready-screen score sprites decode original credit and bet independently',()=>{const d=decodeDisplay([{addr:5568381},{x:239,y:193,w:15,h:13,addr:5791674},{x:255,y:193,w:15,h:13,addr:5791284},{x:374,y:193,w:15,h:13,addr:5792064}],[],0);assert.ok(d.betting);assert.equal(d.credit,20);assert.equal(d.bet,4);});
test('laid and highlighted tile families match native faces; unverified boundary is rejected',()=>{for(let n=0;n<34;n++){assert.equal(identifyTile({addr:239334+n*990,w:33,h:30}),n);assert.equal(identifyTile({addr:162870+n*891,w:33,h:27}),n);}assert.equal(identifyTile({addr:162870+34*891,w:33,h:27}),null);});
test('native draw and discard prompts remain distinct after claiming a meld',()=>{
 assert.equal(decodeDisplay([{addr:42480,w:81,h:26}],[],0).turnPrompt,'draw');
 assert.equal(decodeDisplay([{addr:46692,w:81,h:26}],[],0).turnPrompt,'discard');
 assert.equal(decodeDisplay([],[],0).turnPrompt,null);
});
test('native choice underline maps only to matching hand tiles',()=>{
 const sprites=[{x:112,y:202,w:36,h:35,addr:73266},{x:122,y:191,w:18,h:10,addr:67506},{x:117,y:204,w:24,h:5,addr:42360},{x:500,y:204,w:24,h:5,addr:42360}];
 assert.deepEqual(decodeDisplay(sprites,[],0).choiceSlots,[3]);
 assert.deepEqual(decodeDisplay([],[],0).choiceSlots,[]);
});
test('native action blink does not remove a current offer; changed hand expires it',async()=>{
 const {stabilizeActions}=await import('./display-model.js');
 const base={signature:'0:2',table:[],turnPrompt:'draw',choiceSlots:[],actions:[{code:226,available:true}]};
 const first=stabilizeActions(base);
 assert.equal(stabilizeActions({...base,actions:[{code:226,available:false}]},first).actions[0].available,true);
 assert.equal(stabilizeActions({...base,signature:'0:3',actions:[{code:226,available:false}]},first).actions[0].available,false);
});
test('native post-win choice exposes exact credit and unclaimed win without guessing',()=>{
 const s=[2173059,2173635,2175363,2175939].map(addr=>({addr}));
 s.push({addr:1889355,x:96,y:218,w:18,h:16},{addr:1888203,x:453,y:218,w:18,h:16});
 const d=decodeDisplay(s,[],0);assert.equal(d.special.bonusChoice,true);assert.equal(d.credit,8);assert.equal(d.pendingWin,4);
 assert.equal(decodeDisplay(s.slice(1),[],0).special.bonusChoice,false);
});
test('the original M-key continuation is distinct from C-key choice',()=>{
 const d=decodeDisplay([1816194,2173059,2173635,2180547].map(addr=>({addr})),[],0);
 assert.equal(d.special.bonusChoice,false);assert.equal(d.special.bonusContinue,true);
});
