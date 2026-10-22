export const normalizedSpeech=text=>String(text||'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
export const isExplicitInterruption=text=>/^(?:停|停下|停一下|停止|别说了|等一下|等会|等等|不对|不是|不行|不要|打断一下|我来说)$/.test(normalizedSpeech(text));
export function hasMeaningfulInterruptionText(text){
 return (String(text).match(/\p{Script=Han}/gu)||[]).length>=4||(String(text).match(/[\p{L}\p{N}]+/gu)||[]).length>=2;
}
export function hasFreshCandidate(session,now){
 const c=session.speechCandidate;
 return Boolean(c&&c.turnId===session.turn?.id&&c.inputEpoch===session.inputEpoch&&c.durationMs>=400&&now>=c.receivedAt&&now-c.receivedAt<=3000);
}
export function receiveSpeechCandidate(session,body,now){
 if(!Number.isSafeInteger(body.inputEpoch)||body.inputEpoch<0||typeof body.turnId!=='string'||
  !Number.isFinite(body.durationMs)||body.durationMs<400||body.durationMs>10000||
  !Number.isFinite(body.peakRms)||body.peakRms<.014||body.peakRms>1||
  !Number.isSafeInteger(body.candidateSequence)||body.candidateSequence<0)throw Object.assign(new Error('VOICE_CONTROL_INVALID'),{code:'VOICE_CONTROL_INVALID'});
 if(!session.coreOptions.conservativeInterruption||session.muted||body.turnId!==session.turn?.id||body.inputEpoch!==session.inputEpoch||body.candidateSequence<=session.lastCandidateSequence)return;
 session.lastCandidateSequence=body.candidateSequence;
 session.speechCandidate={turnId:body.turnId,inputEpoch:body.inputEpoch,durationMs:body.durationMs,peakRms:body.peakRms,receivedAt:now};
}

// These commands only control an answer. They never confirm a business action.
export const isStopRequest=text=>/^(?:停|停下|停一下|停止|别说了|等一下|等会|等等|打断一下|我来说)$/.test(normalizedSpeech(text));
export const isReplyContinuation=text=>/^(?:继续|接着说|继续说|继续讲|接着讲|继续刚才的回答|继续刚才的话题|接着刚才说|刚才没说完|你刚才没说完|刚才没听清|再说一遍)$/.test(normalizedSpeech(text));
export const REPLY_RECOVERY_TTL_MS=5*60*1000;
export const MAX_RECOVERABLE_ANSWER_CHARS=8000;
