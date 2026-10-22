import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {applyConversationMigrations} from '../../server/conversation/migrations.js';
import {LearningRepository,applyLearningMigrations} from '../../server/learning/repository.js';
import {LearningService} from '../../server/learning/service.js';
import {publicCatalog} from '../../core/learning/catalog.js';
import {createRemoteSyntheticModel} from './learningRemoteModel.mjs';
import {curriculumCases} from './learningCurriculumCases.mjs';

const label=process.argv[2],ids=process.argv.slice(3);
if(!label||!/^[a-z0-9-]+$/.test(label))throw Error('REPORT_LABEL_REQUIRED');
const out=`/private/tmp/ai-learning-evidence-20260910/${label}.json`;
if(fs.existsSync(out))throw Error('REPORT_EXISTS');
const expected=publicCatalog().filter(l=>l.kind==='scenario').flatMap(l=>['correct','error','help','unclear'].map(k=>`${l.id}-${l.level}-${k}`));
assert.equal(curriculumCases.length,144);assert.deepEqual(curriculumCases.map(c=>c.id).sort(),expected.sort());
const selected=ids.length?curriculumCases.filter(c=>ids.includes(c.id)):curriculumCases;
assert.ok(selected.length>0);if(ids.length)assert.equal(selected.length,new Set(ids).size);
if(ids.length&&selected.length>20)throw Error('TARGETED_CASE_LIMIT');
const db=new DatabaseSync(':memory:');applyConversationMigrations(db);applyLearningMigrations(db);
const remote=createRemoteSyntheticModel({evaluationScope:ids.length?'targeted':'curriculum-144'});let raw;
const service=new LearningService({repository:new LearningRepository({database:db,encryptionKey:Buffer.alloc(32,42)}),aiService:{async run(...args){raw=await remote.run(...args);return raw;}}});
const report={scope:'Internal original synthetic curriculum benchmark, not independent language review or real speech validation',fixtureSha256:createHash('sha256').update(JSON.stringify(curriculumCases)).digest('hex'),plannedCases:selected.length,rows:[]};
try{
 for(const c of selected){
  const row={...c},began=Date.now();raw=null;
  try{
   let v=service.start('synthetic-curriculum',{lessonId:c.lesson,level:c.level,consentAI:true,persist:true,operationId:c.id});
   v=await service.turn('synthetic-curriculum',v.session.id,{revision:1,clientTurnId:c.id,transcript:c.text});row.teacher=v.teacher;
   assert.ok(!/[\u3400-\u9fff]/.test(v.teacher.replyEn),'Chinese appeared in spoken English');
   assert.ok(/[\u3400-\u9fff]/.test(v.teacher.helpZh),'Chinese support missing');
   assert.equal(v.teacher.feedback.length>0,c.corrections,'Correction presence disagrees with fixed benchmark');
   if(c.goal!==undefined)assert.equal(v.teacher.goalReached,c.goal,'Goal decision disagrees with fixed benchmark');
   if(c.lesson==='product')assert.doesNotMatch(v.teacher.replyEn,/our (?:modular )?(?:desks|chairs)/i,'Customer switched to seller');
   row.status='passed';
  }catch(error){row.status='failed';row.error=error.message;row.code=error.code;if(!row.teacher)row.rawSyntheticReply=raw?.content;}
  row.elapsedMs=Date.now()-began;row.usage=raw?.usage;report.rows.push(row);
  report.passed=report.rows.filter(r=>r.status==='passed').length;report.failed=report.rows.length-report.passed;
  fs.writeFileSync(out,JSON.stringify(report,null,2));console.log(JSON.stringify({case:report.rows.length,id:c.id,status:row.status,error:row.error}));
 }
}finally{db.close();}
if(report.failed)process.exitCode=1;
