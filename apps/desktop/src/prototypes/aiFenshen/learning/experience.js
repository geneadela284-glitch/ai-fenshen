export function nextLearningStep(dashboard,level){
 const sessions=[...(dashboard?.sessions||[])].sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));
 const catalog=dashboard?.catalog||[],completed=sessions.filter(s=>s.status==='completed').length;
 const session=sessions.find(s=>['active','paused'].includes(s.status));
 const lesson=session?catalog.find(c=>c.id===session.lessonId&&c.level===session.level):catalog.find(c=>c.level===level&&!sessions.some(s=>s.lessonId===c.id&&s.level===c.level&&s.status==='completed'))||catalog.find(c=>c.level===level);
 return {session,lesson,completed,attempts:sessions.reduce((n,s)=>n+(s.turnCount||0),0),hasHistory:sessions.length>0};
}
const words=t=>String(t||'').toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g)||[];
export function matchFeedback(actual,target){
 const a=words(actual),b=words(target);if(!b.length)return {score:null,label:'表达反馈'};
 let prev=Array.from({length:b.length+1},(_,i)=>i);
 for(let i=1;i<=a.length;i++){const row=[i];for(let j=1;j<=b.length;j++)row[j]=Math.min(prev[j]+1,row[j-1]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));prev=row;}
 return {score:Math.max(0,Math.round(100*(1-prev[b.length]/Math.max(a.length,b.length)))),label:'词句匹配',basis:'根据识别文字与示范比较，不是发音评分'};
}
export function splitSpeech(text,max=150){const result=[];let line='';for(const word of String(text||'').split(/\s+/).filter(Boolean)){if(line&&(line+' '+word).length>max){result.push(line);line='';}line+=(line?' ':'')+word;}if(line)result.push(line);return result.length?result:[''];}
export function rewardPresentation(feedback){
 const high=Number.isFinite(feedback?.score)&&feedback.score>=90;
 return {displayScore:high?feedback.score:null,celebrate:!!feedback?.passed,title:feedback?.passed?(high?'这句说得很棒！':'这一小步，做到了！'):'敢开口，就是进步',message:feedback?.passed?'把这份信心，带到下一句。':'听听示范，再试一次会更顺。',durationMs:feedback?.passed?3200:2200};
}
