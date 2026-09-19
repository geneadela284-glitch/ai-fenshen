import {assertTiles, tileType} from './tiles.js';

const orphans = [0,8,9,17,18,26,27,28,29,30,31,32,33];
function decompositions(hand, meldCount = 0) {
  assertTiles(hand);
  if (!Number.isInteger(meldCount) || meldCount < 0 || meldCount > 4 || hand.length !== 14 - meldCount * 3) return [];
  const counts = Array(34).fill(0);
  for (const id of hand) counts[tileType(id)]++;
  const results = [];
  if (!meldCount && counts.filter(n => n === 2).length === 7) results.push({kind:'sevenPairs',groups:[]});
  if (!meldCount && orphans.every(t => counts[t] > 0) && orphans.reduce((n,t) => n + counts[t], 0) === 14) results.push({kind:'orphans',groups:[]});
  function search(groups, pair) {
    const t = counts.findIndex(n => n > 0);
    if (t < 0) { results.push({kind:'standard',pair,groups}); return; }
    if (counts[t] >= 3) {
      counts[t] -= 3; search([...groups,{kind:'triplet',type:t}],pair); counts[t] += 3;
    }
    if (t < 27 && t % 9 < 7 && counts[t+1] && counts[t+2]) {
      counts[t]--; counts[t+1]--; counts[t+2]--;
      search([...groups,{kind:'sequence',type:t}],pair);
      counts[t]++; counts[t+1]++; counts[t+2]++;
    }
  }
  for (let pair = 0; pair < 34; pair++) if (counts[pair] >= 2) {
    counts[pair] -= 2; search([],pair); counts[pair] += 2;
  }
  return results;
}
export const winningHand = (hand, meldCount=0) => decompositions(hand,meldCount)[0] || null;
export function waitingTiles(hand, meldCount=0, melds=[]) {
  assertTiles(hand);
  if (hand.length !== 13 - meldCount * 3) return [];
  const owned = new Set([...hand,...melds.flatMap(m => m.tiles)]);
  const waits = [];
  for (let type = 0; type < 34; type++) {
    const id = [0,1,2,3].map(n => type*4+n).find(n => !owned.has(n));
    if (id !== undefined && winningHand([...hand,id],meldCount)) waits.push(type);
  }
  return waits;
}
export function scoreHand(hand, melds=[], {selfDraw=false,ready=false,flowers=[]}={}) {
  assertTiles([...hand,...melds.flatMap(m=>m.tiles)]);
  const ways = decompositions(hand,melds.length);
  if (!ways.length) return null;
  const allTypes = [...hand,...melds.flatMap(m=>m.tiles)].map(tileType);
  const suits = new Set(allTypes.filter(t=>t<27).map(t=>Math.floor(t/9)));
  return ways.map(way => {
    const items = [];
    const add = (id,label,value) => items.push({id,label,value});
    if (way.kind === 'orphans') add('orphans','国士无双',13);
    else {
      add('win','胡牌',1);
      if (selfDraw) add('selfDraw','自摸',1);
      if (melds.every(m=>m.concealed)) add('closed','门清',1);
      if (ready) add('ready','听牌',1);
      if (way.kind === 'sevenPairs') add('sevenPairs','七对',4);
      const groups = [...way.groups,...melds.map(m=>({kind:m.kind==='chow'?'sequence':'triplet',type:tileType(m.tiles[0])}))];
      if (way.kind==='standard' && groups.every(g=>g.kind==='triplet')) add('allTriplets','对对胡',3);
      for (const g of groups) if (g.kind==='triplet' && g.type>=31) add(`dragon${g.type}`,'箭牌刻子',1);
      if (suits.size===1) {
        if (allTypes.every(t=>t<27)) add('fullFlush','清一色',6);
        else add('halfFlush','混一色',3);
      }
    }
    return {kind:way.kind,items,multiplier:items.reduce((n,item)=>n+item.value,0),flowers:flowers.length};
  }).sort((a,b)=>b.multiplier-a.multiplier)[0];
}
