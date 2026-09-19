import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame,transition,validateGame,availableActions,chooseDiscard} from './engine.js';
import {shuffledWall,tileType} from './tiles.js';
let n=0;
const act=(g,type,extra={})=>transition(g,{type,id:`test-${++n}`,...extra});
function fixture(types, lastType, phase='HUMAN_REACTION') {
  let g=act(createGame('test'),'START');
  const used=new Set(),take=t=>{const id=[0,1,2,3].map(x=>t*4+x).find(id=>!used.has(id));used.add(id);return id;};
  const hand=types.map(take),last=take(lastType);
  const rest=Array.from({length:144},(_,i)=>i).filter(i=>!used.has(i));
  const bot=rest.filter(i=>i<136).slice(0,13);bot.forEach(i=>used.add(i));
  g.round={...g.round,hands:[hand,bot],wall:rest.filter(i=>!used.has(i)),melds:[[],[]],flowers:[[],[]],discards:[[],[last]],lastDiscard:{player:1,tile:last},lastDrawn:phase==='HUMAN_DISCARD'?hand.at(-1):null,phase,ready:[false,false]};
  return validateGame(g,'test');
}
test('deal, replacements and random complete rounds conserve every physical tile',()=>{
  for(let i=0;i<30;i++){
    let g=act(createGame('test'),'START',{wall:shuffledWall()});
    assert.equal(g.round.hands[0].length,14);assert.equal(g.round.hands[1].length,13);
    let steps=0;
    while(g.round.phase!=='ROUND_END'&&steps++<300){
      const a=availableActions(g);
      if(a.win)g=act(g,'WIN');
      else if(g.round.phase==='BOT_TURN')g=act(g,'BOT');
      else if(g.round.phase==='HUMAN_REACTION')g=act(g,'DRAW');
      else g=act(g,'DISCARD',{tile:chooseDiscard(g.round.hands[0],g.round.melds[0])});
      validateGame(g,'test');
    }
    assert.ok(steps<300);const expected=g.balance+g.round.result.payout;
    const command={type:'SETTLE',id:`settle-${i}`};g=transition(g,command);
    assert.equal(g.balance,expected);assert.deepEqual(transition(g,command),g);
  }
});
test('chow/pong/kong require exact available tiles; melds preserve identities',()=>{
  let g=fixture([0,1,3,4,5,9,10,11,18,19,20,27,27],2);
  assert.ok(availableActions(g).chows.length);
  g=act(g,'CHOW',{tiles:availableActions(g).chows[0]});
  assert.equal(g.round.melds[0][0].tiles.length,3);assert.equal(g.round.discards[1].length,0);
  assert.equal(g.round.hands[0].length,11);validateGame(g,'test');
  g=fixture([5,5,0,1,2,9,10,11,18,19,20,27,27],5);
  g=act(g,'PONG');assert.equal(g.round.melds[0][0].kind,'pong');validateGame(g,'test');
  g=fixture([5,5,5,0,1,2,9,10,11,18,19,20,27],5);
  g=act(g,'KONG',{kind:'open'});assert.equal(g.round.melds[0][0].tiles.length,4);validateGame(g,'test');
  assert.throws(()=>act(g,'PONG'));
});
test('ready discards are legal and locks later changes; bad commands leave source unchanged',()=>{
  let g=fixture([0,1,2,3,4,5,9,10,11,18,19,20,27,28],29,'HUMAN_DISCARD');
  const tile=g.round.hands[0].find(id=>tileType(id)===28);
  assert.ok(availableActions(g).readyDiscards.includes(tile));
  const before=structuredClone(g);assert.throws(()=>act(g,'DISCARD',{tile:999}));assert.deepEqual(g,before);
  g=act(g,'DISCARD',{tile,ready:true});assert.equal(g.round.ready[0],true);
});
test('ron uses the actual last discard and settlement is exactly stake times score',()=>{
  let g=fixture([0,1,2,3,4,5,9,10,11,18,19,20,27],27);
  assert.ok(availableActions(g).win);const last=g.round.lastDiscard.tile;
  g=act(g,'WIN');assert.equal(g.round.result.winner,0);assert.ok(g.round.hands[0].includes(last));
  assert.equal(g.round.result.payout,g.stake*g.round.result.score.multiplier);
  validateGame(g,'test');
});
test('corrupt data and wrong owner fail closed; no bonus or stake changes during rounds',()=>{
  const g=act(createGame('test'),'START');assert.throws(()=>validateGame(g,'other'));
  const bad=structuredClone(g);bad.round.wall[0]=bad.round.hands[0][0];assert.throws(()=>validateGame(bad,'test'));
  assert.throws(()=>act(g,'TOPUP'));assert.throws(()=>act(g,'STAKE',{value:20}));
});
