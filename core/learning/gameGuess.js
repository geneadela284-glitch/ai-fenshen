// A conservative check of the final explicit guess, combined with the teacher's
// decision. Mentioning the answer elsewhere is not a guess. This does not grade
// grammar, pronunciation, or arbitrary semantic equivalents.
export function isPositiveGameGuess(transcript,answer) {
  if(!['apple','umbrella','bicycle','book'].includes(answer))return false;
  const text=String(transcript).normalize('NFKC').toLowerCase().replace(/[’‘]/g,"'")
    .replace(/,\s*isn't it\s*\?\s*$/,'?');
  let guess=text.split(/[.!?]+/).map(s=>s.trim()).filter(Boolean).at(-1)||'';
  // Discard only a recognized uncertainty preface, never a negative assertion
  // about the object or a later withdrawal of the answer.
  guess=guess.replace(/^(?:i'm|i am) not sure(?:,\s*(?:but\s+)?|\s+but\s+)/,'')
    .replace(/^(?:maybe|perhaps)[, ]+/,'')
    .replace(/^i (?:think|guess)\s+/,'');
  return new RegExp(`^(?:(?:is it|could it be|can it be|it is|it's|my guess is)\\s+)?(?:an?\\s+)?${answer}$`).test(guess);
}

const answerWords={apple:['apple','苹果'],umbrella:['umbrella','伞'],bicycle:['bicycle','bike','自行车','脚踏车','单车'],book:['book','书']};
export function guardGameReply(reply,transcript,answer) {
  const goalReached=reply.goalReached&&isPositiveGameGuess(transcript,answer);
  const teachingText=`${reply.replyEn} ${reply.helpZh}`;
  const revealsAnswer=(answerWords[answer]||[]).some(word=>/^[a-z]+$/.test(word)?new RegExp(`\\b${word}\\b`,'i').test(teachingText):teachingText.includes(word));
  if(!goalReached&&revealsAnswer){
    // Authored game rule: invite another question without supplying the answer.
    // Keep source-validated language feedback; never convert this into a pass.
    return {...reply,goalReached:false,replyEn:'Try a question about its size or what it is used for.',helpZh:'先不揭晓答案。试着问问它有多大，或者用来做什么。'};
  }
  return {...reply,goalReached};
}
