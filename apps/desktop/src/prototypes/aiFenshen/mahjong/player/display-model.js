// Verified against the user's VS221M sprites. Display metadata only; never a rules engine.
export const TILE_NAMES=['一万','二万','三万','四万','五万','六万','七万','八万','九万','一筒','二筒','三筒','四筒','五筒','六筒','七筒','八筒','九筒','一条','二条','三条','四条','五条','六条','七条','八条','九条','东','南','西','北','白','發','中','暗牌'];
export const ACTIONS=[{name:'吃',code:44,base:5869572},{name:'碰',code:226,base:5871642},{name:'杠',code:224,base:5879922},{name:'听',code:225,base:5881992},{name:'胡',code:29,base:5877852}];
export function identifyTile({addr,w,h}){
 for(const [base,width,height] of [[69486,36,35],[123666,33,27],[239334,33,30],[162870,33,27]]){
  const n=(addr-base)/(width*height);if(w===width&&h===height&&Number.isInteger(n)&&n>=0&&n<=(base===162870?33:34))return n;
 }
 return null;
}
export function readSprites(mem,pointer){
 const out=[];
 for(let o=pointer;o<pointer+0x800;o+=8){const y=mem[o]+(mem[o+1]<<8),sy=(y&511)-(y&512);if(sy===-512)break;
  const xr=mem[o+2]+(mem[o+3]<<8),x=xr>>3,addr=((mem[o+4]>>6)|(mem[o+5]<<2)|(mem[o+6]<<10)|((mem[o+7]&15)<<18))*3;
  if(!addr)continue;out.push({x:(x&511)-(x&512),y:sy,w:((((mem[o+4]&63)<<2)|((mem[o+3]&192)>>6))+1)*3,h:((y>>10)|((xr&3)<<6))+1,addr,color:mem[o+7]>>5});
 }return out;
}
function numberAt(mem,fg,y,xs,base){let result='';for(const x of xs){const o=fg+(y*64+x)*4,c=mem[o]+(mem[o+1]<<8);if(c===base+40){result+=' ';continue;}const digit=(c-base)/4;if(!Number.isInteger(digit)||digit<0||digit>9)return null;result+=digit;}return result.trim()?Number(result):null;}
function spriteNumber(items,base,step){
 if(!items.length)return null;const digits=items.sort((a,b)=>a.x-b.x).map(s=>(s.addr-base)/step);
 return digits.every(n=>Number.isInteger(n)&&n>=0&&n<=9)?Number(digits.join('')):null;
}
export function decodeDisplay(sprites,mem,fg){
 const tiles=sprites.map(s=>({...s,tile:identifyTile(s)})).filter(s=>s.tile!==null);
 const letters=sprites.filter(s=>s.w===18&&s.h===10&&s.addr>=66966&&s.addr<=69306&&(s.addr-66966)%180===0);
 const hand=tiles.filter(s=>s.y>=175&&s.x>=0&&letters.some(l=>Math.abs(l.x-(s.x+10))<4)).map(s=>{
  const letter=letters.find(l=>Math.abs(l.x-(s.x+10))<4);return {...s,slot:letter?(letter.addr-66966)/180:null};
 }).sort((a,b)=>a.x-b.x);
 const actions=ACTIONS.map(a=>({...a,available:sprites.some(s=>(s.addr===a.base+690||s.addr===a.base+1380))}));
 const turnPrompt=sprites.some(s=>s.addr===46692)?'discard':sprites.some(s=>s.addr===42480)?'draw':null;
 const choiceSlots=hand.filter(t=>sprites.some(s=>s.addr===42360&&s.w===24&&s.h===5&&Math.abs(s.x-t.x-5)<2&&s.y===t.y+2)).map(t=>t.slot);
 const table=tiles.filter(s=>!hand.some(t=>t.addr===s.addr&&t.x===s.x&&t.y===s.y));
 const active=sprites.some(s=>s.addr===4661499)||hand.length>0;
 const betting=sprites.some(s=>s.addr===5568381);
 const bonusChoice=[2173059,2173635,2175363,2175939].every(addr=>sprites.some(s=>s.addr===addr));
 const bonusContinue=[1816194,2173059,2173635,2180547].every(addr=>sprites.some(s=>s.addr===addr));
 const bonusStage=bonusChoice||sprites.some(s=>s.addr===1816194);
 const bonusDigits=sprites.filter(s=>s.w===18&&s.h===16&&s.y===218);
 const scoreDigits=sprites.filter(s=>s.w===15&&s.h===13&&s.y===193);
 const countdown=spriteNumber(sprites.filter(s=>s.w===24&&s.h===23&&s.addr>=34560&&s.addr<=39528),34560,552);
 return {active,betting,countdown,hand,table,actions,turnPrompt,choiceSlots,pendingWin:bonusStage?spriteNumber(bonusDigits.filter(s=>s.x>390),1887051,288):null,credit:bonusStage?spriteNumber(bonusDigits.filter(s=>s.x<130),1887051,288):betting?spriteNumber(scoreDigits.filter(s=>s.x<280),5791284,195):fg?numberAt(mem,fg,10,[53,55,57,59],7723):null,bet:betting?spriteNumber(scoreDigits.filter(s=>s.x>=345),5791284,195):fg?numberAt(mem,fg,12,[57,59],7767):null,
  signature:hand.map(s=>`${s.slot}:${s.tile}`).join('|'),special:{bonusChoice,bonusContinue,bonusStage,double:sprites.some(s=>s.addr===5885439),donden:sprites.some(s=>s.addr===5888193),flower:sprites.some(s=>s.addr===5890947)}};
}
export function mayDiscard(model,slot,signature){return model.signature===signature&&model.hand.some(t=>t.slot===slot&&t.tile!==34);}
// The original action lamps blink off while an offer is still valid. Retain
// observed availability only within the same displayed hand/table/turn.
export function stabilizeActions(model,previous){
 const key=model.signature+'#'+model.turnPrompt+'#'+model.choiceSlots.join(',')+'#'+model.table.map(t=>`${t.tile}:${t.x}:${t.y}`).join('|');
 return {key,actions:model.actions.map(a=>({...a,available:a.available||(previous?.key===key&&previous.actions.some(p=>p.code===a.code&&p.available))}))};
}
