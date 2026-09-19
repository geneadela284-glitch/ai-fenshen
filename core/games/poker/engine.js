import { evaluateHand, requireCards, shuffledDeck, randomBelow } from './rules.js';
export const STAKES=Object.freeze([10,20,50,100,200]);
export const emptyPrizePool=()=>({balance:0,lossCount:0,totalContributed:0,totalClaimed:0,cycles:0});
const phases=new Set(['HOLDING','REWARD_PENDING','GAMBLE_REVEALED']);
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const need=(condition,message='当前牌局不支持此操作，请刷新状态。')=>{if(!condition)throw Error(message);};
export function createGame(ownerId,revision=0) {
  need(typeof ownerId==='string'&&ownerId.length>0,'请先登录。');
  return {schemaVersion:1,ownerId,revision,balance:1000,prizePool:emptyPrizePool(),selectedStake:10,soundEnabled:true,volume:0.4,completedRounds:0,bestPayout:0,round:null,lastRound:null,events:[{operationId:'initial',kind:'INITIAL',amount:1000,balanceBefore:0,balanceAfter:1000,createdAt:Date.now()}],updatedAt:Date.now()};
}
export function validateGame(g,ownerId) {
  need(g?.schemaVersion===1&&g.ownerId===ownerId,'游戏记录归属或版本不符，请保留记录。');
  need(integer(g.revision)&&integer(g.balance)&&integer(g.completedRounds)&&integer(g.bestPayout)&&STAKES.includes(g.selectedStake)&&typeof g.soundEnabled==='boolean'&&Number.isFinite(g.volume)&&g.volume>=0&&g.volume<=1,'游戏记录校验失败，请保留记录。');
  if(g.prizePool!==undefined){const p=g.prizePool;need(p&&['balance','lossCount','totalContributed','totalClaimed','cycles'].every(k=>integer(p[k]))&&p.totalContributed===p.balance+p.totalClaimed,'奖池记录校验失败，请保留记录。');}
  need(Array.isArray(g.events)&&g.events.length<=200&&g.events.every(e=>typeof e.operationId==='string'&&integer(e.balanceAfter)),'积分记录校验失败。');
  for(const r of [g.round,g.lastRound].filter(Boolean)) {
    need([1,2,3,4,5].includes(r.rulesVersion));const size=r.rulesVersion>=3?54:52;requireCards(r.deck,size,size);requireCards(r.hand,5,size);need(STAKES.includes(r.stake)&&integer(r.pendingPayout)&&r.gambleCount>=0&&r.gambleCount<=3&&Number.isInteger(r.gambleCount));
    need(Array.isArray(r.held)&&r.held.length===5&&r.held.every(b=>typeof b==='boolean')&&Number.isInteger(r.drawCursor)&&r.drawCursor>=5&&r.drawCursor<=10);
    need(r.hand.every(c=>r.deck.slice(0,r.drawCursor).includes(c)));
    if(r===g.round)need(phases.has(r.phase));
    if(r.phase==='HOLDING')need(r.drawCursor===5&&r.pendingPayout===0&&r.hand.every((c,i)=>c===r.deck[i]));
    else {const rank=evaluateHand(r.hand,r.rulesVersion);need(r.handRank?.id===rank.id&&r.basePayout===r.stake*rank.multiplier);need(r.pendingPayout===0||r.pendingPayout===r.basePayout*2**r.gambleCount);}
    if(r.phase==='REWARD_PENDING')need(r.pendingPayout>0);
    if(r.phase==='GAMBLE_REVEALED')need(r.gambleResult&&['big','small'].includes(r.gambleResult.pick)&&Number.isInteger(r.gambleResult.card)&&r.gambleResult.card>=0&&r.gambleResult.card<size);
  }
  return g;
}
export function transition(previous,command,random={}) {
  validateGame(previous,previous.ownerId);
  need(command&&typeof command.operationId==='string'&&command.operationId.length>0&&command.operationId.length<=160);
  if(previous.events.some(e=>e.operationId===command.operationId))return previous;
  const g=structuredClone(previous),r=g.round,before=g.balance;g.prizePool??=emptyPrizePool();const poolBefore=g.prizePool.balance;
  const finish=()=>{g.lastRound={...g.round,phase:'FINISHED'};g.round=null;g.completedRounds++;};
  switch(command.type) {
    case 'SETTINGS':
      if(command.stake!==undefined){need(!r&&STAKES.includes(command.stake));g.selectedStake=command.stake;}
      if(command.soundEnabled!==undefined){need(typeof command.soundEnabled==='boolean');g.soundEnabled=command.soundEnabled;}
      if(command.volume!==undefined){need(Number.isFinite(command.volume)&&command.volume>=0&&command.volume<=1);g.volume=command.volume;}
      break;
    case 'DEAL': {
      need(!r&&g.balance>=g.selectedStake,'积分不足，可调低本局积分或免费补充。');
      const deck=random.deck?[...random.deck]:shuffledDeck();requireCards(deck,54,54);
      g.balance-=g.selectedStake;
      g.round={id:command.operationId,rulesVersion:5,phase:'HOLDING',stake:g.selectedStake,deck,hand:deck.slice(0,5),held:Array(5).fill(false),drawCursor:5,pendingPayout:0,basePayout:0,handRank:null,gambleCount:0,gambleResult:null};
      break;
    }
    case 'HOLD':need(r?.phase==='HOLDING'&&Number.isInteger(command.index)&&command.index>=0&&command.index<5&&typeof command.held==='boolean');r.held[command.index]=command.held;break;
    case 'HOLD_ALL':need(r?.phase==='HOLDING');r.held.fill(true);break;
    case 'DRAW':
      need(r?.phase==='HOLDING');r.hand=r.hand.map((c,i)=>r.held[i]?c:r.deck[r.drawCursor++]);r.handRank=evaluateHand(r.hand,r.rulesVersion);r.basePayout=r.stake*r.handRank.multiplier;r.pendingPayout=r.basePayout;r.phase='REWARD_PENDING';
      if(!r.pendingPayout)finish();break;
    case 'GAMBLE': {
      need(r?.phase==='REWARD_PENDING'&&r.gambleCount<3&&['big','small'].includes(command.pick));
      const size=r.rulesVersion>=3?54:52,card=random.gambleCard??randomBelow(size);need(Number.isInteger(card)&&card>=0&&card<size);
      const rank=card%13+2,outcome=card>=52?'win':rank===8?'push':((rank>=9)===(command.pick==='big')?'win':'loss');
      const amountBefore=r.pendingPayout;r.gambleResult={card,pick:command.pick,outcome,amountBefore};
      if(outcome!=='push')r.gambleCount++;
      if(outcome==='loss'){
        const p=g.prizePool,contribution=Math.floor(amountBefore/5);p.balance+=contribution;p.totalContributed+=contribution;p.lossCount++;r.gambleResult.poolContribution=contribution;
        if(p.lossCount>=10){r.gambleResult.poolAward=p.balance;g.balance+=p.balance;p.totalClaimed+=p.balance;p.balance=0;p.lossCount=0;p.cycles++;}
      }
      r.pendingPayout=outcome==='win'?amountBefore*2:outcome==='loss'?0:amountBefore;r.phase='GAMBLE_REVEALED';break;
    }
    case 'ACK_GAMBLE':need(r?.phase==='GAMBLE_REVEALED');if(r.pendingPayout)r.phase='REWARD_PENDING';else finish();break;
    case 'COLLECT':need(r?.phase==='REWARD_PENDING');g.balance+=r.pendingPayout;g.bestPayout=Math.max(g.bestPayout,r.pendingPayout);r.collected=r.pendingPayout;r.pendingPayout=0;finish();break;
    case 'CLAIM_POOL':{const p=g.prizePool;need(p.lossCount>=10&&p.balance>0,'累计猜错10次后可领取奖池。');g.balance+=p.balance;p.totalClaimed+=p.balance;p.balance=0;p.lossCount=0;p.cycles++;break;}
    case 'TOPUP':need(!r&&g.balance<10);g.balance=1000;break;
    default:throw Error('无法识别的游戏操作。');
  }
  g.revision++;g.updatedAt=Date.now();g.events=[...g.events,{operationId:command.operationId,roundId:r?.id||g.round?.id||null,kind:command.type,poolBefore,poolAfter:g.prizePool.balance,poolChange:g.prizePool.balance-poolBefore,amount:g.balance-before,balanceBefore:before,balanceAfter:g.balance,revision:g.revision,createdAt:g.updatedAt}].slice(-200);
  return validateGame(g,g.ownerId);
}
