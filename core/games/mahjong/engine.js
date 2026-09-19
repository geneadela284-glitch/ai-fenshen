import {STAKES,RULES_VERSION,assertTiles,isFlower,shuffledWall,sortTiles,tileType} from './tiles.js';
import {scoreHand,waitingTiles,winningHand} from './rules.js';

// Internal experiment only. Not the original LHZB2 rules; do not connect to the product.
// See docs/games/mahjong/DESIGN.md: original-game fidelity is required before integration.

const fail = () => {throw Error('这个操作现在不可用，请按牌桌上的提示继续。');};
const phases = ['HUMAN_DISCARD','BOT_TURN','HUMAN_REACTION','ROUND_END'];
export function createGame(ownerId, revision=0) {
  return {ownerId,schemaVersion:1,rulesVersion:RULES_VERSION,revision,balance:1000,stake:5,sound:true,round:null,events:[],receipts:[]};
}
export function validateGame(g,ownerId) {
  if (!g || g.ownerId!==ownerId || g.schemaVersion!==1 || g.rulesVersion!==RULES_VERSION || !Number.isSafeInteger(g.revision) || g.revision<0 || !Number.isSafeInteger(g.balance) || g.balance<0 || !STAKES.includes(g.stake) || typeof g.sound!=='boolean' || !Array.isArray(g.events) || !Array.isArray(g.receipts)) throw Error('麻将记录无法读取，原记录已保留。');
  const r=g.round;
  if(r){
    if(!phases.includes(r.phase)||!Array.isArray(r.ready)||r.ready.length!==2||r.ready.some(x=>typeof x!=='boolean'))throw Error('牌局状态无效。');
    for(const list of [r.hands,r.melds,r.flowers,r.discards])if(!Array.isArray(list)||list.length!==2)throw Error('牌局区域无效。');
    const all=[...r.wall,...r.hands.flat(),...r.flowers.flat(),...r.discards.flat(),...r.melds.flat().flatMap(m=>m.tiles)];
    assertTiles(all,{flowers:true});if(all.length!==144)throw Error('牌数不一致，原记录已保留。');
    for(let p=0;p<2;p++){
      assertTiles(r.hands[p]);assertTiles(r.discards[p]);
      if(r.flowers[p].some(id=>!isFlower(id))||r.melds[p].length>4)throw Error('副露记录无效。');
      for(const m of r.melds[p]){
        assertTiles(m.tiles);const types=m.tiles.map(tileType).sort((a,b)=>a-b);
        if(!['chow','pong','kong'].includes(m.kind)||m.tiles.length!==(m.kind==='kong'?4:3)||typeof m.concealed!=='boolean')throw Error('副露记录无效。');
        if(m.kind==='chow' ? !(types[0]<27&&types[0]%9<7&&types[1]===types[0]+1&&types[2]===types[0]+2) : !types.every(t=>t===types[0]))throw Error('副露组合无效。');
      }
      if(r.phase!=='ROUND_END'){
        const size=13-r.melds[p].length*3+(p===0&&r.phase==='HUMAN_DISCARD'?1:0);
        if(r.hands[p].length!==size)throw Error('手牌数量无效。');
      }
    }
    if(r.phase==='HUMAN_REACTION'&&(!r.lastDiscard||r.lastDiscard.player!==1||r.discards[1].at(-1)!==r.lastDiscard.tile))throw Error('出牌记录无效。');
    if(r.phase==='ROUND_END'&&(!r.result||!Number.isSafeInteger(r.result.payout)||r.result.payout<0))throw Error('结算记录无效。');
  }
  return g;
}
function finish(g,winner,source,score=null){
  const r=g.round;
  r.phase='ROUND_END';
  r.result={winner,source,score,payout:winner===null?g.stake:winner===0?g.stake*score.multiplier:0};
  r.message=winner===null?'牌墙已空，流局退还本局押分。':winner===0?'胡牌！领取本局得分。':'对手胡牌，本局结束。';
}
function draw(g,player){
  const r=g.round;
  while(r.wall.length){
    const id=r.wall.shift();
    if(isFlower(id)){
      r.flowers[player].push(id);
      if(r.flowers[player].length===8){finish(g,player,'flowers',{multiplier:75,items:[{id:'flowers',label:'八花齐',value:75}]});return null;}
    }else{r.hands[player]=sortTiles([...r.hands[player],id]);r.lastDrawn=id;return id;}
  }
  finish(g,null,'draw');return null;
}
function score(r,p,hand,selfDraw){return scoreHand(hand,r.melds[p],{selfDraw,ready:r.ready[p],flowers:r.flowers[p]});}
function takeDiscard(r,p){
  const d=r.lastDiscard;if(!d||d.player===p||r.discards[d.player].at(-1)!==d.tile)fail();
  r.discards[d.player].pop();r.lastDiscard=null;return d.tile;
}
function ron(g,p){const r=g.round;const points=score(r,p,[...r.hands[p],r.lastDiscard.tile],false);if(!points)fail();r.hands[p]=sortTiles([...r.hands[p],takeDiscard(r,p)]);finish(g,p,'ron',points);}
export function availableActions(g){
  const r=g.round,empty={win:false,pong:false,kong:false,chows:[],kongs:[],readyDiscards:[],waits:[]};
  if(!r||r.phase==='ROUND_END'||r.phase==='BOT_TURN')return empty;
  const h=r.hands[0],m=r.melds[0],a={...empty};
  if(r.phase==='HUMAN_REACTION'){
    const t=tileType(r.lastDiscard.tile),same=h.filter(id=>tileType(id)===t);
    a.win=!!score(r,0,[...h,r.lastDiscard.tile],false);
    a.waits=waitingTiles(h,m.length,m);
    if(r.ready[0])return a;
    a.pong=same.length>=2;a.kong=same.length===3&&r.wall.length>0;
    if(t<27)for(let start=t-2;start<=t;start++){
      if(start<0||Math.floor(start/9)!==Math.floor(t/9)||start%9>6)continue;
      const need=[start,start+1,start+2].filter(x=>x!==t),ids=need.map(type=>h.find(id=>tileType(id)===type));
      if(ids.every(id=>id!==undefined))a.chows.push(ids);
    }
  }else{
    a.win=!!score(r,0,h,true);
    if(!r.ready[0]){
      a.readyDiscards=h.filter(id=>waitingTiles(h.filter(x=>x!==id),m.length,m).length>0);
      if(r.wall.length){
        for(const type of new Set(h.map(tileType)))if(h.filter(id=>tileType(id)===type).length===4)a.kongs.push({kind:'concealed',type});
        m.forEach((meld,index)=>{if(meld.kind==='pong'&&h.some(id=>tileType(id)===tileType(meld.tiles[0])))a.kongs.push({kind:'added',index,type:tileType(meld.tiles[0])});});
      }
    }
    if(r.ready[0]&&r.lastDrawn!==null)a.waits=waitingTiles(h.filter(id=>id!==r.lastDrawn),m.length,m);
  }
  return a;
}
// The opponent evaluates only its own tiles and melds. It never receives the other hand.
export function chooseDiscard(hand,melds=[]){
  const counts=Array(34).fill(0);hand.forEach(id=>counts[tileType(id)]++);
  let best=hand[0],bestValue=-Infinity;
  for(const id of hand){
    const t=tileType(id),remaining=hand.filter(x=>x!==id);
    const waits=waitingTiles(remaining,melds.length,melds);
    let keep=(counts[t]>=3?9:counts[t]===2?6:0);
    if(t<27)for(const delta of [-2,-1,1,2]){const n=t+delta;if(n>=0&&n<27&&Math.floor(n/9)===Math.floor(t/9))keep+=counts[n]*(Math.abs(delta)===1?2:1);}
    const value=waits.length*100-keep+(t>=27?0.2:0);
    if(value>bestValue){bestValue=value;best=id;}
  }
  return best;
}
export function transition(original,c){
  validateGame(original,original.ownerId);
  if(!c||typeof c.id!=='string'||!c.id||c.id.length>150)fail();
  if(original.receipts.includes(c.id))return original;
  const g=structuredClone(original),r=g.round;
  switch(c.type){
    case 'SOUND': if(typeof c.value!=='boolean')fail();g.sound=c.value;break;
    case 'STAKE':if(r||!STAKES.includes(c.value))fail();g.stake=c.value;break;
    case 'TOPUP':if(r||g.balance>=1)fail();g.balance=1000;break;
    case 'START':{
      if(r||g.balance<g.stake)fail();
      const wall=c.wall?[...c.wall]:shuffledWall();assertTiles(wall,{flowers:true});if(wall.length!==144)fail();
      g.balance-=g.stake;g.round={phase:'HUMAN_DISCARD',wall,hands:[[],[]],melds:[[],[]],flowers:[[],[]],discards:[[],[]],ready:[false,false],lastDrawn:null,lastDiscard:null,result:null,message:'选中一张牌，再点「打出」。'};
      for(let i=0;i<13;i++)for(let p=0;p<2;p++){draw(g,p);if(g.round.phase==='ROUND_END')break;}
      if(g.round.phase!=='ROUND_END')draw(g,0);
      break;
    }
    case 'DISCARD':{
      if(r?.phase!=='HUMAN_DISCARD'||!r.hands[0].includes(c.tile)||(r.ready[0]&&c.tile!==r.lastDrawn))fail();
      if(c.ready&&!availableActions(g).readyDiscards.includes(c.tile))fail();
      if(c.ready)r.ready[0]=true;
      r.hands[0]=r.hands[0].filter(id=>id!==c.tile);r.discards[0].push(c.tile);r.lastDiscard={player:0,tile:c.tile};r.lastDrawn=null;r.phase='BOT_TURN';r.message='对手思考中…';break;
    }
    case 'BOT':{
      if(r?.phase!=='BOT_TURN')fail();
      if(r.lastDiscard&&score(r,1,[...r.hands[1],r.lastDiscard.tile],false)){ron(g,1);break;}
      const id=draw(g,1);if(r.phase==='ROUND_END')break;
      const points=score(r,1,r.hands[1],true);if(points){finish(g,1,'selfDraw',points);break;}
      const out=r.ready[1]?id:chooseDiscard(r.hands[1],r.melds[1]);
      r.hands[1]=r.hands[1].filter(x=>x!==out);r.discards[1].push(out);r.lastDiscard={player:1,tile:out};r.lastDrawn=null;
      if(waitingTiles(r.hands[1],r.melds[1].length,r.melds[1]).length)r.ready[1]=true;
      r.phase='HUMAN_REACTION';r.message='对手已出牌，可以吃碰杠，或摸下一张。';break;
    }
    case 'DRAW':if(r?.phase!=='HUMAN_REACTION')fail();draw(g,0);if(r.phase!=='ROUND_END'){r.phase='HUMAN_DISCARD';r.message=r.ready[0]?'已听牌：可胡牌，或打出刚摸到的牌。':'轮到你出牌。';}break;
    case 'WIN':if(!availableActions(g).win)fail();if(r.phase==='HUMAN_REACTION')ron(g,0);else finish(g,0,'selfDraw',score(r,0,r.hands[0],true));break;
    case 'PONG':case 'CHOW':{
      const a=availableActions(g);let own;
      if(c.type==='PONG'){if(!a.pong)fail();own=r.hands[0].filter(id=>tileType(id)===tileType(r.lastDiscard.tile)).slice(0,2);}
      else{own=a.chows.find(ids=>Array.isArray(c.tiles)&&ids.length===c.tiles.length&&ids.every(id=>c.tiles.includes(id)));if(!own)fail();}
      const tile=takeDiscard(r,0);r.hands[0]=r.hands[0].filter(id=>!own.includes(id));r.melds[0].push({kind:c.type==='PONG'?'pong':'chow',tiles:sortTiles([...own,tile]),concealed:false});r.lastDrawn=null;r.phase='HUMAN_DISCARD';r.message='请打出一张牌。';break;
    }
    case 'KONG':{
      const a=availableActions(g);
      if(c.kind==='open'){
        if(!a.kong)fail();const tile=takeDiscard(r,0),own=r.hands[0].filter(id=>tileType(id)===tileType(tile));r.hands[0]=r.hands[0].filter(id=>!own.includes(id));r.melds[0].push({kind:'kong',tiles:sortTiles([...own,tile]),concealed:false});
      }else{
        const choice=a.kongs.find(k=>k.kind===c.kind&&k.type===c.tileType);if(!choice)fail();
        const own=r.hands[0].filter(id=>tileType(id)===choice.type);
        if(c.kind==='added'){
          const tile=own[0],points=score(r,1,[...r.hands[1],tile],false);
          r.hands[0]=r.hands[0].filter(id=>id!==tile);
          if(points){r.hands[1]=sortTiles([...r.hands[1],tile]);finish(g,1,'robKong',points);break;}
          r.melds[0][choice.index].kind='kong';r.melds[0][choice.index].tiles.push(tile);
        }else{r.hands[0]=r.hands[0].filter(id=>!own.includes(id));r.melds[0].push({kind:'kong',tiles:own,concealed:true});}
      }
      draw(g,0);if(r.phase!=='ROUND_END'){r.phase='HUMAN_DISCARD';r.message='杠牌成功，已补一张牌。';}break;
    }
    case 'SETTLE':if(r?.phase!=='ROUND_END')fail();g.balance+=r.result.payout;g.round=null;break;
    default:fail();
  }
  g.revision++;g.receipts=[...g.receipts,c.id].slice(-256);g.events=[...g.events,{revision:g.revision,action:c.type,balance:g.balance,phase:g.round?.phase||'READY'}].slice(-80);
  return validateGame(g,g.ownerId);
}
