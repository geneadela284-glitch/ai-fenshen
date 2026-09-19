const normalized=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
const dayOf=iso=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(iso));
const spans=(text,phrase)=>{
  const found=[];if(!phrase)return found;
  const padded=` ${text} `,needle=` ${phrase} `;
  for(let at=padded.indexOf(needle);at!==-1;at=padded.indexOf(needle,at+1))found.push({start:at,end:at+phrase.length});
  return found;
};

// Conservative phrase evidence, not semantic equivalence or an ability assessment.
// Recomputed from owned source turns, so deletion/correction also removes credit.
export function assessExpressionReview(expression,attempts=[]) {
  const phrase=normalized(expression);let stage=0,lastPracticedAt=null,lastSucceeded=false;
  let successes=[];
  const ordered=[...attempts].filter(t=>Number.isFinite(Date.parse(t.createdAt))).sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt));
  for(const turn of ordered){
    if(!phrase||turn.inputMode!=='voice'||turn.hint!=='none'||turn.transcriptCorrected)continue;
    const transcript=normalized(turn.transcript),matches=spans(transcript,phrase);
    if(!matches.length||!Array.isArray(turn.reply?.feedback))continue;
    // Scene completion is not evidence that every expression was correct. Only
    // feedback grounded in this phrase can revoke its earlier practice credit.
    const affected=turn.reply.feedback.some(f=>spans(transcript,normalized(f.original)).some(error=>matches.some(match=>error.start<match.end&&match.start<error.end)));
    if(affected){stage=0;successes=[];lastPracticedAt=turn.createdAt;lastSucceeded=false;continue;}
    if(turn.evidence!=='independent_this_attempt')continue;
    const day=dayOf(turn.createdAt);
    if(!successes.some(s=>s.day===day)){stage=Math.min(3,stage+1);lastPracticedAt=turn.createdAt;lastSucceeded=true;}
    successes.push({turnId:turn.id,sessionId:turn.sessionId,lessonId:turn.lessonId,day,createdAt:turn.createdAt});
  }
  let sources=[];
  for(let i=successes.length-1;i>=0&&!sources.length;i--){const earlier=successes.slice(0,i).find(s=>s.day!==successes[i].day&&s.lessonId!==successes[i].lessonId);if(earlier)sources=[earlier,successes[i]];}
  const dueAt=lastPracticedAt?(lastSucceeded?new Date(Date.parse(lastPracticedAt)+[0,1,3,7][stage]*86400000).toISOString():lastPracticedAt):null;
  return {ruleVersion:'expression-review-v2',matchedBy:'normalized_phrase',stage,passed:sources.length===2,sources,dueAt,lastPracticedAt};
}
