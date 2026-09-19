export const PAYTABLE = Object.freeze([
  { id:'five', label:'五条', multiplier:500 },
  { id:'royal', label:'皇家同花顺', multiplier:250 },
  { id:'straightFlush', label:'同花顺', multiplier:50 },
  { id:'four', label:'四条', multiplier:25 },
  { id:'fullHouse', label:'葫芦', multiplier:12 },
  { id:'flush', label:'同花', multiplier:7 },
  { id:'straight', label:'顺子', multiplier:5 },
  { id:'three', label:'三条', multiplier:3 },
  { id:'twoPair', label:'两对', multiplier:2 },
  { id:'highPair', label:'10 或以上的一对', multiplier:1 },
  { id:'none', label:'本局未成牌', multiplier:0 }
].map(Object.freeze));
const v4Paytable=Object.freeze(PAYTABLE.map(row=>row.id==='highPair'?Object.freeze({...row,label:'8 或以上的一对'}):row));
const jokerPaytable=Object.freeze(v4Paytable.map(row=>Object.hasOwn({fullHouse:9,flush:6,straight:4},row.id)?Object.freeze({...row,multiplier:{fullHouse:9,flush:6,straight:4}[row.id]}):row));
const eightsPaytable=Object.freeze(jokerPaytable.filter(row=>row.id!=='five'));
const legacyPaytable=Object.freeze(eightsPaytable.map(row=>row.id==='highPair'?Object.freeze({...row,id:'jacks',label:'J 或以上的一对'}):row));
export function paytableForRules(version=5){if(![1,2,3,4,5].includes(version))throw Error('不支持的扑克机规则版本，请保留记录。');return version===1?legacyPaytable:version===2?eightsPaytable:version===3?jokerPaytable:version===4?v4Paytable:PAYTABLE;}
const tables=Object.fromEntries([1,2,3,4,5].map(v=>[v,Object.fromEntries(paytableForRules(v).map(row=>[row.id,row]))]));
export function requireCards(cards,length=5,cardCount=52) {
  if(!Array.isArray(cards)||cards.length!==length||new Set(cards).size!==length||cards.some(c=>!Number.isInteger(c)||c<0||c>=cardCount))throw Error('牌面记录无效，请保留记录后重试。');
}
function naturalHand(hand,version) {
  const table=tables[version];
  const ranks=hand.map(c=>c%13+2), sorted=[...ranks].sort((a,b)=>a-b), counts=new Map();
  for(const rank of ranks)counts.set(rank,(counts.get(rank)||0)+1);
  const groups=[...counts.values()].sort((a,b)=>b-a);
  const flush=hand.every(c=>Math.floor(c/13)===Math.floor(hand[0]/13));
  const straight=counts.size===5&&(sorted[4]-sorted[0]===4||sorted.join(',')==='2,3,4,5,14');
  let id='none';
  if(groups[0]===5)id='five';
  else if(flush&&straight)id=sorted[0]===10?'royal':'straightFlush';
  else if(groups[0]===4)id='four';
  else if(groups[0]===3&&groups[1]===2)id='fullHouse';
  else if(flush)id='flush';
  else if(straight)id='straight';
  else if(groups[0]===3)id='three';
  else if(groups[0]===2&&groups[1]===2)id='twoPair';
  else if([...counts].some(([rank,n])=>rank>=(version===1?11:version>=5?10:8)&&n===2))id=version===1?'jacks':'highPair';
  const indices=hand.flatMap((_,i)=>{
    if(id==='none')return[];
    if(['jacks','highPair','twoPair','three','four'].includes(id))return counts.get(ranks[i])>=2?[i]:[];
    return[i];
  });
  return {...table[id],indices};
}
// Each wildcard may stand for any rank/suit, including the fifth card of a rank.
// Exhaust at most 52^2 assignments; never alter the physical hand/deck.
export function evaluateHand(hand,version=5){
  paytableForRules(version);requireCards(hand,5,version>=3?54:52);
  const jokers=hand.flatMap((card,i)=>card>=52?[i]:[]);
  if(!jokers.length)return naturalHand(hand,version);
  const substituted=[...hand];let best=null,bestStrength=null;
  const strength=(cards,id)=>{const ranks=cards.map(c=>c%13+2),counts=new Map();for(const r of ranks)counts.set(r,(counts.get(r)||0)+1);if(['straight','straightFlush','royal'].includes(id))return [ranks.includes(14)&&ranks.includes(2)?5:Math.max(...ranks)];return [...counts].sort((a,b)=>b[1]-a[1]||b[0]-a[0]).map(([rank])=>rank);};
  const higher=(a,b)=>{for(let i=0;i<a.length;i++){if(a[i]!==b[i])return a[i]>b[i];}return false;};
  function choose(depth){
    if(depth===jokers.length){const rank=naturalHand(substituted,version);if(rank.id!=='five'&&new Set(substituted).size!==5)return;const value=strength(substituted,rank.id);if(!best||rank.multiplier>best.multiplier||(rank.multiplier===best.multiplier&&higher(value,bestStrength))){best={...rank,wildcardAs:jokers.map(index=>({index,...cardFace(substituted[index])}))};bestStrength=value;}return;}
    for(let c=0;c<52;c++){substituted[jokers[depth]]=c;choose(depth+1);if(best?.id==='five')return;}
  }
  choose(0);return best;
}
export function randomBelow(bound,word=()=>globalThis.crypto.getRandomValues(new Uint32Array(1))[0]) {
  if(!Number.isInteger(bound)||bound<1||bound>54)throw Error('无效随机范围');
  const limit=Math.floor(4294967296/bound)*bound;
  for(let i=0;i<1024;i++){const value=word();if(Number.isInteger(value)&&value>=0&&value<limit)return value%bound;}
  throw Error('随机发牌暂不可用，请重试。');
}
export function shuffledDeck(randomInt=randomBelow,cardCount=54) {
  if(![52,54].includes(cardCount))throw Error('无效牌堆大小');
  const deck=Array.from({length:cardCount},(_,i)=>i);
  for(let i=cardCount-1;i>0;i--){const j=randomInt(i+1);if(!Number.isInteger(j)||j<0||j>i)throw Error('无效洗牌结果');[deck[i],deck[j]]=[deck[j],deck[i]];}
  return deck;
}
export function cardFace(card) {if(card>=52)return {rank:card===52?'小王':'大王',suit:'★',red:card===53,joker:true};return {rank:['2','3','4','5','6','7','8','9','10','J','Q','K','A'][card%13],suit:['♠','♥','♣','♦'][Math.floor(card/13)],red:[1,3].includes(Math.floor(card/13))};}
