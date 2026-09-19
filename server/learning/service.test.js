import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyConversationMigrations } from '../conversation/migrations.js';
import { LearningRepository, applyLearningMigrations } from './repository.js';
import { LearningService } from './service.js';
function setup(t, aiService) { const db = new DatabaseSync(':memory:'); applyConversationMigrations(db); applyLearningMigrations(db); t.after(()=>db.close()); return new LearningService({ repository: new LearningRepository({database:db,encryptionKey:Buffer.alloc(32,4)}), aiService }); }
const start = {consentAI:true,persist:true,operationId:'op1',lessonId:'hello'};
test('foundation progresses on accepted expressions, never on failed attempts; text has no oral evidence', async t=>{
 const s=setup(t,{run(){throw Error('foundation must not need a model');}}); let view=s.start('a',start);
 view=await s.turn('a',view.session.id,{revision:1,clientTurnId:'t1',transcript:'banana'}); assert.equal(view.foundationStep,0); assert.equal(view.session.goalReached,false);
 for (let i=0;i<3;i++) view=await s.turn('a',view.session.id,{revision:view.session.revision,clientTurnId:'good'+i,transcript:'Hello'});
 assert.equal(view.session.goalReached,true); assert.equal(view.session.independentCount,0);
 assert.equal(view.turns.at(-1).evidence,'text_practice');
 assert.equal(view.turns.at(-1).assessmentSource,'guided_drill');
 await assert.rejects(s.turn('b',view.session.id,{revision:1,clientTurnId:'hack',transcript:'Hello'}),{code:'LEARNING_NOT_FOUND'});
});
test('scenario uses teaching capability only, source-validated feedback and cancellation cannot save a late reply',async t=>{
 let task; const s=setup(t,{async run(value){task=value;return {ok:true,content:JSON.stringify({replyEn:'Small or large?',helpZh:'你想要多大的？',feedback:[],goalReached:false})};}});
 let v=s.start('a',{...start,lessonId:'coffee'});v=await s.turn('a',v.session.id,{revision:1,clientTurnId:'t1',transcript:'Coffee please'});
 assert.equal(task.capability,'CHAT');assert.match(task.messages[0].content,/角色/);assert.equal(v.turns.length,1);
 assert.equal(v.turns[0].assessmentSource,'ai_expression_review');
 const ctrl=new AbortController();ctrl.abort();await assert.rejects(s.turn('a',v.session.id,{revision:2,clientTurnId:'t2',transcript:'small'},{signal:ctrl.signal}),{code:'LEARNING_CANCELLED'});assert.equal(s.view('a',v.session.id).turns.length,1);
});
test('teacher context demonstrates the same structured contract for opener and prior replies',async t=>{
 const tasks=[];const reply={replyEn:'Certainly. Would you like a quiet room?',helpZh:'当然，你想要安静的房间吗？',feedback:[],goalReached:false};
 const s=setup(t,{async run(task){tasks.push(task);return {ok:true,content:JSON.stringify(reply)};}});
 let v=s.start('a',{...start,lessonId:'hotel',level:'intermediate'});
 v=await s.turn('a',v.session.id,{revision:1,clientTurnId:'one',transcript:'I have a reservation.'});
 await s.turn('a',v.session.id,{revision:v.session.revision,clientTurnId:'two',transcript:'Could I have a quiet room?'});
 const assistant=tasks.filter(task=>task.metadata?.stage!=='learning_assessment')[1].messages.filter(m=>m.role==='assistant').map(m=>JSON.parse(m.content));
 assert.equal(assistant.length,2);assert.deepEqual(assistant[1],reply);
 assert.equal(typeof assistant[0].helpZh,'string');assert.equal(assistant[0].goalReached,false);
});
test('foundation practice keeps the situation cue and names the completed skill',async t=>{
 const s=setup(t);let v=s.start('a',{...start,lessonId:'thanks'});
 v=await s.turn('a',v.session.id,{revision:1,clientTurnId:'one',transcript:'Thank you'});
 v=await s.turn('a',v.session.id,{revision:v.session.revision,clientTurnId:'two',transcript:'Thanks'});
 assert.equal(v.teacher.replyEn,'Here is your coffee.');assert.equal(v.prompt.example,null);
 v=await s.turn('a',v.session.id,{revision:v.session.revision,clientTurnId:'three',transcript:'Thank you'});
 assert.match(v.teacher.helpZh,/谢谢/);assert.doesNotMatch(v.teacher.helpZh,/问候/);
 assert.equal(v.session.goalReached,true);assert.equal(v.session.independentCount,0);
});
test('hint evidence survives service restart and a repeated voice token cannot count as a fresh recording',async t=>{
 const s=setup(t);const v=s.start('a',{...start,lessonId:'coffee'});s.hint('a',v.session.id);
 const restarted=new LearningService({repository:s.repository,aiService:{async run(){return {ok:true,content:JSON.stringify({replyEn:'Here you are.',helpZh:'给你。',feedback:[],goalReached:true})};}}});
 restarted.voiceEvidence.set('token',{owner:'a',id:v.session.id,transcript:'Coffee please',expires:Date.now()+10000,turnId:null});
 const result=await restarted.turn('a',v.session.id,{revision:1,clientTurnId:'one',transcript:'Coffee please',voiceToken:'token'});assert.equal(result.turns[0].evidence,'supported_practice');
 const next=await restarted.turn('a',v.session.id,{revision:2,clientTurnId:'two',transcript:'Coffee please',voiceToken:'token'});assert.equal(next.turns[1].inputMode,'text');
});
test('correcting the latest recognition replaces its feedback and progress atomically; failures keep the original',async t=>{
 let fail=false;
 const s=setup(t,{async run(task){if(fail)return{ok:false};return{ok:true,content:JSON.stringify({replyEn:'Could you say that again?',helpZh:'请再说一次。',feedback:[],goalReached:task.input==='A small coffee, please.'})};}});
 let v=s.start('a',{...start,lessonId:'coffee'});
 s.voiceEvidence.set('voice',{owner:'a',id:v.session.id,transcript:'A small coffee, please.',expires:Date.now()+10000,turnId:null});
 v=await s.turn('a',v.session.id,{revision:1,clientTurnId:'voice',voiceToken:'voice',transcript:'A small coffee, please.'});
 assert.equal(v.session.independentCount,1);const original=v.turns[0];
 const correction={revision:v.session.revision,clientTurnId:'correction',correctsTurnId:original.id,transcript:'I need help.'};
 fail=true;await assert.rejects(s.turn('a',v.session.id,correction),{code:'LEARNING_TEACHER_UNAVAILABLE'});assert.equal(s.view('a',v.session.id).turns[0].id,original.id);
 fail=false;v=await s.turn('a',v.session.id,correction);assert.equal(v.session.turnCount,1);assert.equal(v.session.independentCount,0);assert.equal(v.session.goalReached,false);assert.equal(v.turns.length,1);assert.equal(v.turns[0].transcriptCorrected,true);assert.equal(v.turns[0].correctsTurnId,original.id);
 assert.equal((await s.turn('a',v.session.id,correction)).session.revision,v.session.revision);
 await assert.rejects(s.turn('a',v.session.id,{...correction,clientTurnId:'stale',revision:v.session.revision}),{code:'LEARNING_CORRECTION_CONFLICT'});
 await assert.rejects(s.turn('b',v.session.id,correction),{code:'LEARNING_NOT_FOUND'});
});
test('a game does not treat a negated answer as a successful guess',async t=>{
 const s=setup(t,{async run(){return{ok:true,content:JSON.stringify({replyEn:'Try another guess.',helpZh:'再猜一次。',feedback:[],goalReached:true})};}});
 let v=s.start('a',{...start,lessonId:'guess'});const answer=s.repository.require('a',v.session.id).gameAnswer;
 v=await s.turn('a',v.session.id,{revision:1,clientTurnId:'negative',transcript:`It is not a ${answer}.`});assert.equal(v.session.goalReached,false);
 v=await s.turn('a',v.session.id,{revision:v.session.revision,clientTurnId:'positive',transcript:`Could it be a ${answer}?`});assert.equal(v.session.goalReached,true);
});
test('expression review keeps a real source and disappears when its source practice is deleted',async t=>{
 const s=setup(t,{async run(){return{ok:true,content:JSON.stringify({replyEn:'Certainly.',helpZh:'当然。',feedback:[{original:'two chair',suggestion:'two chairs',reasonZh:'两个用复数。'}],goalReached:true})};}});
 let v=s.start('a',{...start,lessonId:'product'});v=await s.turn('a',v.session.id,{revision:1,clientTurnId:'review',transcript:'I need two chair.'});s.action('a',v.session.id,{action:'complete',revision:v.session.revision});
 const item=s.dashboard('a').expressions[0];assert.equal(item.text,'two chairs');assert.equal(item.sourceText,'two chair');assert.equal(item.turnId,v.turns[0].id);assert.equal(s.dashboard('b').expressions.length,0);
 s.action('a',v.session.id,{action:'delete',revision:s.view('a',v.session.id).session.revision});assert.equal(s.dashboard('a').expressions.length,0);
});
test('automatic foundation playback does not reveal the final answer before independent recall',async t=>{
 const s=setup(t,{router:{async run(){return {audio:Buffer.alloc(0),contentType:'audio/wav'};}}});
 for(const [lessonId,phrases]of [['hello',['Hello','Hi','Hello']],['thanks',['Thank you','Thanks','Thank you']],['yes-no',['Yes, please','No, thank you','Yes, please']],['repeat',['Again, please','Slowly, please','Again, please']]]){
  let v=s.start('a',{...start,lessonId,operationId:lessonId});
  for(let i=0;i<phrases.length;i++){
   const token=lessonId+i;s.voiceEvidence.set(token,{owner:'a',id:v.session.id,transcript:phrases[i],expires:Date.now()+10000,turnId:null});
   v=await s.turn('a',v.session.id,{revision:v.session.revision,clientTurnId:token,voiceToken:token,transcript:phrases[i]});
   if(lessonId==='hello'&&i===1)assert.doesNotMatch(v.teacher.replyEn,/^(?:hello|hi)[!. ]*$/i,'Final recall cue must not say the answer');
   if(i<2)await s.speak('a',v.session.id,{text:v.teacher.replyEn});
  }
  assert.equal(v.session.independentCount,1,lessonId+' should allow one unprompted final attempt');
  assert.equal(v.turns.at(-1).hint,'none');
 }
});

test('hearing a prior greeting with punctuation still counts as help for the final recall',async t=>{
 const s=setup(t,{router:{async run(){return {audio:Buffer.alloc(0)};}}});let v=s.start('a',start);
 for(let i=0;i<2;i++)v=await s.turn('a',v.session.id,{revision:v.session.revision,clientTurnId:'prep'+i,transcript:'Hello'});
 await s.speak('a',v.session.id,{text:v.turns[0].reply.replyEn});
 s.voiceEvidence.set('voice',{owner:'a',id:v.session.id,transcript:'Hello',expires:Date.now()+10000,turnId:null});
 v=await s.turn('a',v.session.id,{revision:v.session.revision,clientTurnId:'voice',voiceToken:'voice',transcript:'Hello'});
 assert.equal(v.session.independentCount,0);assert.equal(v.turns.at(-1).evidence,'supported_practice');
});
test('game understands an uncertain positive guess but does not count an answer mentioned outside the guess',async t=>{
 const s=setup(t,{async run(){return{ok:true,content:JSON.stringify({replyEn:'Let us check your guess.',helpZh:'看看你猜得对不对。',feedback:[],goalReached:true})};}});
 for(const [prefix,make,expected]of [
  ['hedge',a=>`I'm not sure, but is it an ${a}?`,true],
  ['tag',a=>`It is an ${a}, isn't it?`,true],
  ['negative',a=>`It is not an ${a}.`,false],
  ['mention',a=>`I saw an ${a} yesterday. Is it a dog?`,false],
  ['alternative',a=>`Is it an ${a} or a dog?`,false],
  ['changed-mind',a=>`It is an ${a}. Actually, no.`,false]
 ]){
  let v=s.start('a',{...start,lessonId:'guess',operationId:prefix});const answer=s.repository.require('a',v.session.id).gameAnswer;
  v=await s.turn('a',v.session.id,{revision:1,clientTurnId:prefix,transcript:make(answer)});
  assert.equal(v.session.goalReached,expected,prefix);
 }
});
test('game keeps an unguessed answer out of teaching text even if the model reveals it',async t=>{
 let secret,english,help;
 const s=setup(t,{async run(){return{ok:true,content:JSON.stringify({replyEn:english,helpZh:help,feedback:[],goalReached:false})};}});
 const translations={apple:'苹果',umbrella:'雨伞',bicycle:'自行车',book:'书'};
 for(const id of ['english-leak','chinese-leak']){
  let v=s.start('a',{...start,lessonId:'guess',operationId:id});secret=s.repository.require('a',v.session.id).gameAnswer;
  english=id==='english-leak'?`It is actually a ${secret}!`:'You can guess again.';
  help=id==='chinese-leak'?`答案是${translations[secret]}。`:'再猜一下。';
  v=await s.turn('a',v.session.id,{revision:1,clientTurnId:id,transcript:`It is not a ${secret}.`});
  assert.equal(v.teacher.goalReached,false);assert.doesNotMatch(v.teacher.replyEn,new RegExp(`\\b${secret}\\b`,'i'));assert.ok(!v.teacher.helpZh.includes(translations[secret]));
 }
});
test('zero beginner sees the meaning of the teacher response after speaking',async t=>{
 const s=setup(t);let v=s.start('a',{...start,lessonId:'thanks'});
 v=await s.turn('a',v.session.id,{revision:1,clientTurnId:'thanks',transcript:'Thank you'});
 assert.equal(v.teacher.replyEn,'You are welcome.');assert.match(v.teacher.helpZh,/不客气/);
});
test('teaching review supplies grounded correction and progress without replacing the natural response',async t=>{
 const calls=[];const s=setup(t,{async run(task){calls.push(task);const review=task.metadata?.stage==='learning_assessment';return{ok:true,content:JSON.stringify({replyEn:review?'Checked.':'They do not contain meat.',helpZh:review?'已检查。':'它们不含肉。',feedback:review?[{original:'Does these',suggestion:'Do these',reasonZh:'these表示复数，用do。'}]:[],goalReached:review})};}});
 let v=s.start('a',{...start,lessonId:'restaurant'});v=await s.turn('a',v.session.id,{revision:1,clientTurnId:'reviewed',transcript:'Does these noodles contain meat?'});
 assert.equal(calls.length,2);assert.equal(v.teacher.replyEn,'They do not contain meat.');assert.equal(v.teacher.feedback[0].suggestion,'Do these');assert.equal(v.teacher.goalReached,true);
});
test('scenario response and teaching review start together instead of adding their network waits',async t=>{
 const started=[];let releaseRole,releaseReview;
 const role=new Promise(resolve=>{releaseRole=resolve;});
 const review=new Promise(resolve=>{releaseReview=resolve;});
 const s=setup(t,{async run(task){const isReview=task.metadata?.stage==='learning_assessment';started.push(isReview?'review':'role');return isReview?review:role;}});
 const v=s.start('a',{...start,lessonId:'coffee'});
 const pending=s.turn('a',v.session.id,{revision:1,clientTurnId:'parallel',transcript:'A small coffee, please.'});
 await new Promise(resolve=>setImmediate(resolve));
 const startedBeforeRelease=[...started];
 releaseRole({ok:true,content:JSON.stringify({replyEn:'Here you are.',helpZh:'给你。',feedback:[],goalReached:false})});
 await new Promise(resolve=>setImmediate(resolve));
 releaseReview({ok:true,content:JSON.stringify({replyEn:'Checked.',helpZh:'已检查。',feedback:[],goalReached:true})});
 const result=await pending;
 assert.deepEqual(startedBeforeRelease.sort(),['review','role']);
 assert.equal(result.teacher.replyEn,'Here you are.');
 assert.equal(result.teacher.goalReached,true);
});
test('a failed teaching review cannot save an unverified turn or claim completion',async t=>{
 const s=setup(t,{async run(task){return task.metadata?.stage==='learning_assessment'?{ok:false}:{ok:true,content:JSON.stringify({replyEn:'Certainly.',helpZh:'当然。',feedback:[],goalReached:true})};}});
 const v=s.start('a',{...start,lessonId:'coffee'});await assert.rejects(s.turn('a',v.session.id,{revision:1,clientTurnId:'failed-review',transcript:'A small coffee, please.'}),{code:'LEARNING_TEACHER_UNAVAILABLE'});assert.equal(s.view('a',v.session.id).turns.length,0);
});
test('repeat foundation playback reuses bounded session audio, still records help and respects deletion and owner',async t=>{
 let calls=0;const s=setup(t,{router:{async run(){calls++;return {audio:Buffer.alloc(100,1),contentType:'audio/wav'};}}});let v=s.start('a',start);
 await s.speak('a',v.session.id,{text:'Hello!',rate:'normal'});await s.speak('a',v.session.id,{text:'Hello!',rate:'normal'});assert.equal(calls,1);
 await assert.rejects(s.speak('b',v.session.id,{text:'Hello!',rate:'normal'}),{code:'LEARNING_NOT_FOUND'});
 const c=new AbortController();c.abort();await assert.rejects(s.speak('a',v.session.id,{text:'Hello!',rate:'normal'},{signal:c.signal}),{code:'LEARNING_CANCELLED'});
 s.action('a',v.session.id,{action:'delete',revision:v.session.revision});assert.equal(s.foundationAudio.size,0);
});
