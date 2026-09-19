// Measured from the user-confirmed ATT reference. Saved game facts stay in engine.js.
export function cardSequence(indices) {
  const cards=indices.map((index,i)=>({index,name:`deal${index+1}`,at:200+i*195}));
  return {cards,events:cards.length?[{name:'shuffle',at:0},...cards]:[],duration:cards.length?200+cards.length*195:0};
}
export function gambleSequence(outcome) {
  return {revealAt:480,events:[{at:0,name:'roll'},{at:600,name:{win:'pair',push:'push',loss:'loss'}[outcome]}]};
}
export function collectionPresentation(from,amount) {
  const duration=Math.min(1800,Math.max(650,amount*3.3));
  return {duration,balanceAt:elapsed=>from+Math.floor(amount*Math.max(0,Math.min(1,elapsed/duration)))};
}

export function rewardPresentation(rankId){const fireworks=['four','straightFlush','royal','five'].includes(rankId);return {fireworks,duration:fireworks?4200:1200,events:fireworks?[{name:'pair',at:0},{name:'cheer',at:1250,duration:2800}]:[{name:'pair',at:0}]};}
