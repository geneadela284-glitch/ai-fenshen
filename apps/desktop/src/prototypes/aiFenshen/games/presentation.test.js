import test from 'node:test';
import assert from 'node:assert/strict';
import { cardSequence, gambleSequence, collectionPresentation, rewardPresentation } from './presentation.js';
test('five-card reveal follows the reference scale at 195ms intervals',()=>{
 const p=cardSequence([0,1,2,3,4]);
 assert.deepEqual(p.cards.map(x=>x.name),['deal1','deal2','deal3','deal4','deal5']);
 assert.deepEqual(p.cards.map(x=>x.at),[200,395,590,785,980]);
 assert.ok(p.duration>=p.cards.at(-1).at+185);
});
test('held cards keep their position and have no fictitious flip sound',()=>{
 const p=cardSequence([1,4]);assert.deepEqual(p.cards.map(x=>[x.index,x.name,x.at]),[[1,'deal2',200],[4,'deal5',395]]);
 assert.deepEqual(cardSequence([]).events,[]);
});
test('gamble result follows the reveal and never overlaps the entry cue',()=>{
 for(const outcome of ['win','push','loss']){const p=gambleSequence(outcome);assert.ok(p.revealAt>=450);assert.ok(p.events[1].at>=p.revealAt);assert.equal(p.events[1].name,{win:'pair',push:'push',loss:'loss'}[outcome]);}
});
test('score animation is bounded and ends at the exact saved balance',()=>{
 for(const amount of [10,200,2500,100000]){const p=collectionPresentation(123,amount);assert.ok(p.duration>=650&&p.duration<=1800);assert.equal(p.balanceAt(0),123);assert.equal(p.balanceAt(p.duration),123+amount);assert.equal(p.balanceAt(p.duration*2),123+amount);assert.ok(p.balanceAt(p.duration/2)>=123);}
});

test('only four of a kind or better gets fireworks and a bounded crowd celebration',()=>{for(const id of ['highPair','twoPair','three','straight','flush','fullHouse']){const p=rewardPresentation(id);assert.equal(p.fireworks,false);assert.deepEqual(p.events,[{name:'pair',at:0}]);assert.equal(p.duration,1200);}for(const id of ['four','straightFlush','royal','five']){const p=rewardPresentation(id);assert.equal(p.fireworks,true);assert.deepEqual(p.events,[{name:'pair',at:0},{name:'cheer',at:1250,duration:2800}]);assert.ok(p.duration>=1250+2800&&p.duration<=4500);}});
