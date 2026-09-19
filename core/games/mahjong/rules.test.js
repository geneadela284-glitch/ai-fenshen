import test from 'node:test';import assert from 'node:assert/strict';
import {winningHand,waitingTiles,scoreHand} from './rules.js';
const ids=types=>{const count={};return types.map(t=>t*4+(count[t]=(count[t]||0)+1)-1);};
test('standard hand needs four groups and one pair; melds reduce concealed length',()=>{assert.ok(winningHand(ids([0,1,2,3,4,5,9,10,11,18,19,20,27,27])));assert.equal(winningHand(ids([0,1,2,3,4,5,9,10,11,18,19,21,27,27])),null);assert.ok(winningHand(ids([3,4,5,9,10,11,18,19,20,27,27]),1));});
test('seven pairs and thirteen orphans are recognized without duplicate-quad pairs',()=>{assert.equal(winningHand(ids([0,0,2,2,5,5,9,9,11,11,18,18,27,27])).kind,'sevenPairs');assert.equal(winningHand(ids([0,8,9,17,18,26,27,28,29,30,31,32,33,33])).kind,'orphans');assert.equal(winningHand(ids([0,0,0,0,5,5,9,9,11,11,18,18,27,27])),null);});
test('waits contain only physically possible tile types',()=>{assert.deepEqual(waitingTiles(ids([0,1,2,3,4,5,9,10,11,18,19,20,27])),[27]);assert.throws(()=>winningHand([0,0]));});
test('scoring reports actual documented multipliers and physical melds',()=>{const h=ids([0,1,2,3,4,5,6,7,8,0,0,0,8,8]);const result=scoreHand(h,[],{selfDraw:true,ready:true,flowers:[]});assert.ok(result.multiplier>=10);assert.ok(result.items.some(x=>x.id==='fullFlush'));assert.equal(scoreHand(ids([0,1,2,3,4,5,9,10,11,18,19,21,27,27]),[],{}),null);});
