// Six bounded synthetic teaching calls. No real learners, production writes or
// credential transfer. The fixed answer is read only from this in-memory fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {applyConversationMigrations} from '../../server/conversation/migrations.js';
import {LearningRepository,applyLearningMigrations} from '../../server/learning/repository.js';
import {LearningService} from '../../server/learning/service.js';
import {createRemoteSyntheticModel} from './learningRemoteModel.mjs';
const db=new DatabaseSync(':memory:');applyConversationMigrations(db);applyLearningMigrations(db);
const repository=new LearningRepository({database:db,encryptionKey:Buffer.alloc(32,42)});
const service=new LearningService({repository,aiService:createRemoteSyntheticModel()}),owner='synthetic-game-evaluation';
const rows=[];
try{
 for(const [id,level,utterance,expected]of [
  ['hedged','beginner',a=>`I'm not sure, but is it ${a==='apple'||a==='umbrella'?'an':'a'} ${a}?`,true],
  ['tag','intermediate',a=>`It is ${a==='apple'||a==='umbrella'?'an':'a'} ${a}, isn't it?`,true],
  ['negative','beginner',a=>`It is not ${a==='apple'||a==='umbrella'?'an':'a'} ${a}.`,false],
  ['mention','intermediate',a=>`I saw ${a==='apple'||a==='umbrella'?'an':'a'} ${a} yesterday. Is it a dog?`,false],
  ['withdrawn','advanced',a=>`It is ${a==='apple'||a==='umbrella'?'an':'a'} ${a}. Actually, no.`,false],
  ['clue','beginner',()=> '我还不知道怎么猜，可以教我怎么用英语提一个问题吗？',false]
 ]){
  let v=service.start(owner,{lessonId:'guess',level,consentAI:true,persist:true,operationId:id});
  const answer=repository.require(owner,v.session.id).gameAnswer,text=utterance(answer),began=Date.now(),row={id,level,text};
  try{
   v=await service.turn(owner,v.session.id,{revision:1,clientTurnId:id,transcript:text});row.teacher=v.teacher;
   assert.equal(v.teacher.goalReached,expected);assert.equal(v.teacher.feedback.length,0,'Valid speech or help request should not receive invented corrections');
   assert.ok(/[\u3400-\u9fff]/.test(v.teacher.helpZh));assert.ok(!/[\u3400-\u9fff]/.test(v.teacher.replyEn));
   assert.equal(Object.hasOwn(v.session,'gameAnswer'),false);
   if(!expected){
    assert.doesNotMatch(v.teacher.replyEn,new RegExp(`\\b${answer}\\b`,'i'),'Teacher must not reveal an unguessed answer');
    const word={apple:'苹果',umbrella:'伞',bicycle:'自行车',book:'书'}[answer];assert.ok(!v.teacher.helpZh.includes(word),'Chinese help must not reveal an unguessed answer');
   }
   row.status='passed';
  }catch(error){row.status='failed';row.error=error.message;row.code=error.code;}
  row.elapsedMs=Date.now()-began;rows.push(row);console.log(JSON.stringify({id,status:row.status,error:row.error}));
  fs.writeFileSync('/private/tmp/ai-learning-evidence-20260910/game-model-regression-220-final.json',JSON.stringify({scope:'Six selected synthetic cases through existing model; not a full content audit or learner acceptance',rows},null,2));
 }
}finally{db.close();}
if(rows.some(r=>r.status==='failed'))process.exitCode=1;
