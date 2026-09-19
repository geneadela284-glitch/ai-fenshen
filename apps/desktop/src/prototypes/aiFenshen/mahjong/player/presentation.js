import {ACTIONS,TILE_NAMES,readSprites,decodeDisplay,mayDiscard,stabilizeActions} from '/host/display-model.js';
// Keep every original pixel and all native rules. This layer only adds touch targets.
export async function createPresentation(original,{pressKey=()=>false}={}){
 const style=document.createElement('link');style.rel='stylesheet';style.href='/host/table.css';document.head.append(style);
 const root=document.createElement('main');root.className='original-mobile';root.setAttribute('aria-label','原版麻将手机牌桌');
 root.innerHTML=`<section class="native-area"><div class="native-frame"><canvas aria-label="原版游戏画面"></canvas><div class="hand-rack"></div><button class="draw-tile" aria-label="摸牌" hidden>摸</button><div class="commandbar">${ACTIONS.map(a=>`<button data-action="${a.code}" hidden>${a.name}</button>`).join('')}<button class="pass-action" hidden>过</button><button class="confirm" hidden>出牌</button><button data-bonus-key="6" hidden>续玩</button></div><div class="sessionbar start-session"><button data-key="30" hidden>开始</button></div><button class="extras" aria-expanded="false">更多</button><div class="extra-tray" hidden><button data-key="230">海底</button><button data-key="228">收分</button><button data-key="229">比倍</button><button data-key="40">大 / 左</button><button data-key="42">小 / 右</button><button class="close-extras">收起</button></div></div></section><aside class="mobile-controls"><button data-key="20">上分</button><div class="sessionbar"><button data-key="32">押注</button></div><button data-bonus-key="30">得分</button></aside>`;
 original.after(root);original.style.visibility='hidden';
 const $=s=>root.querySelector(s),hand=$('.hand-rack'),raw=$('canvas'),ctx=raw.getContext('2d',{alpha:false});
 let sprites=[],model,offer,selected=null,dismissed=null,allowInput=false,closed=false,lastFrame=0,lastHand='',bettingFrames=0,bonusPhase='',bonusSubmitted=false,frameWidth=512,frameHeight=240;
 const offerId=()=>offer?.key;
 const clear=()=>{selected=null;hand.querySelectorAll('button').forEach(b=>{b.classList.remove('selected');b.setAttribute('aria-pressed','false');});$('.confirm').hidden=true;};
 const discard=()=>{if(!allowInput||!selected||!mayDiscard(model,selected.slot,selected.signature)){clear();return;}const code=selected.slot+4;clear();pressKey(code);};
 $('.confirm').onclick=discard;
 const pass=()=>{if(!allowInput)return;dismissed=offerId();clear();if(!model.hand.some(t=>t.slot===13))pressKey(17);update();};
 $('.pass-action').onclick=pass;$('.draw-tile').onclick=()=>{if(!allowInput)return;dismissed=offerId();clear();pressKey(17);update();};
 root.querySelectorAll('[data-key]').forEach(b=>b.onclick=()=>{if(allowInput&&(!b.closest('.sessionbar')||(model?.betting&&bettingFrames>=30))){clear();pressKey(Number(b.dataset.key));$('.extra-tray').hidden=true;$('.extras').setAttribute('aria-expanded','false');}});
 root.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>{if(allowInput&&!b.hidden&&!b.disabled){dismissed=offerId();offer=null;clear();pressKey(Number(b.dataset.action));update();}});
 root.querySelectorAll('[data-bonus-key]').forEach(b=>b.onclick=()=>{if(allowInput&&!b.hidden&&!b.disabled&&!bonusSubmitted){bonusSubmitted=true;pressKey(model.special.bonusContinue&&b.dataset.bonusKey==='6'?16:Number(b.dataset.bonusKey));update();}});
 const tray=()=>{$('.extra-tray').hidden=!$('.extra-tray').hidden;$('.extras').setAttribute('aria-expanded',String(!$('.extra-tray').hidden));};$('.extras').onclick=tray;$('.close-extras').onclick=tray;
 function update(){
  if(!model)return;
  const phase=model.special.bonusChoice?'choice':model.special.bonusContinue?'continue':'';if(phase!==bonusPhase){bonusPhase=phase;bonusSubmitted=false;}
  root.querySelectorAll('[data-key]').forEach(b=>{b.disabled=!allowInput||(!!b.closest('.sessionbar')&&(!model.betting||bettingFrames<30));if(b.closest('.start-session'))b.hidden=!model.betting;});
  root.querySelectorAll('[data-bonus-key]').forEach(b=>{const available=model.special.bonusChoice||(model.special.bonusContinue&&b.dataset.bonusKey==='6');b.hidden=b.dataset.bonusKey==='6'&&!available;b.disabled=!allowInput||bonusSubmitted||!available;});
  const choosing=model.choiceSlots.length===2;
  model.actions.forEach(a=>{const b=$(`[data-action="${a.code}"]`);b.hidden=!(a.available||(choosing&&a.code===44))||dismissed===offerId();b.disabled=!allowInput;});
  $('.pass-action').hidden=!(model.actions.some(a=>a.available)||choosing)||dismissed===offerId();$('.pass-action').disabled=!allowInput;
  const nLetter=sprites.find(s=>s.addr===69306&&s.w===18&&s.h===10);
  const lastTile=model.hand.at(-1);
  const draw=$('.draw-tile');draw.hidden=model.betting;draw.disabled=!allowInput;
  if(!draw.style.width)draw.style.cssText="left:90.625%;top:83.333333%;width:7.03125%;height:14.583333%;";
  if(nLetter&&lastTile)draw.style.cssText=`left:${(nLetter.x-10)/frameWidth*100}%;top:${lastTile.y/frameHeight*100}%;width:${lastTile.w/frameWidth*100}%;height:${lastTile.h/frameHeight*100}%;`;
  const handKey=model.signature+'#'+model.hand.map(t=>`${t.x},${t.y},${t.w},${t.h}`).join('|')+'#'+frameWidth+':'+frameHeight;
  if(handKey!==lastHand){lastHand=handKey;clear();hand.replaceChildren();
   for(const item of model.hand){const button=document.createElement('button');button.dataset.slot=item.slot;button.setAttribute('aria-label',TILE_NAMES[item.tile]);button.setAttribute('aria-pressed','false');button.style.cssText=`left:${item.x/frameWidth*100}%;top:${item.y/frameHeight*100}%;width:${item.w/frameWidth*100}%;height:${item.h/frameHeight*100}%;`;
    button.onclick=()=>{if(!allowInput||!mayDiscard(model,item.slot,model.signature))return;if(model.choiceSlots.length===2){clear();pressKey(item.slot+4);return;}if(selected?.slot===item.slot&&selected.signature===model.signature){discard();return;}clear();selected={slot:item.slot,signature:model.signature};button.classList.add('selected');button.setAttribute('aria-pressed','true');$('.confirm').hidden=false;};hand.append(button);
   }
  }
  hand.querySelectorAll('[data-slot]').forEach(b=>{b.disabled=!allowInput;b.classList.toggle('choice-member',model.choiceSlots.includes(Number(b.dataset.slot)));});
  $('.confirm').disabled=!allowInput;if(choosing)$('.confirm').hidden=true;
 }
 function fit(){const area=$('.native-area'),ratio=frameWidth/frameHeight;const w=Math.min(area.clientWidth,area.clientHeight*ratio);$('.native-frame').style.width=w+'px';$('.native-frame').style.height=w/ratio+'px';}
 let resizeTick=0;const resize=new ResizeObserver(()=>{cancelAnimationFrame(resizeTick);resizeTick=requestAnimationFrame(fit);});resize.observe($('.native-area'));
 return {
  setEnabled(){},
  setInputEnabled(value){allowInput=!!value;if(!allowInput)clear();update();},
  beforeOriginalVideo(pointer){sprites=readSprites(Module.HEAPU8,pointer);return 0;},onOriginalSprite(){return 0;},
  onOriginalVideo(pointer,palette,stride,width,height,black,fg){
   if(closed)return;model=decodeDisplay(sprites,Module.HEAPU8,fg);bettingFrames=model.betting?bettingFrames+1:0;offer=stabilizeActions(model,offer);model.actions=offer.actions;
   if(selected&&selected.signature!==model.signature)clear();
   if(performance.now()-lastFrame<33)return;lastFrame=performance.now();
   if(raw.width!==width||raw.height!==height){raw.width=width;raw.height=height;frameWidth=width;frameHeight=height;fit();}
   const im=ctx.createImageData(width,height),indices=Module.HEAPU16,colors=Module.HEAPU32;
   for(let y=0;y<height;y++)for(let x=0;x<width;x++){const c=colors[(palette>>2)+indices[(pointer>>1)+y*stride+x]],i=(y*width+x)*4;im.data[i]=c>>>16&255;im.data[i+1]=c>>>8&255;im.data[i+2]=c&255;im.data[i+3]=255;}ctx.putImageData(im,0,0);update();
  },
  close(){closed=true;cancelAnimationFrame(resizeTick);resize.disconnect();root.remove();style.remove();original.style.visibility='visible';}
 };
}
