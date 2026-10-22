// Reuse the already-recorded real role-play replies, then run the new assessment
// once per case. This avoids spending another 144 calls regenerating dialogue.
import fs from 'node:fs';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {curriculumCases} from './learningCurriculumCases.mjs';
import {createRemoteSyntheticModel} from './learningRemoteModel.mjs';
import {assessLearningTurn} from '../../server/learning/assessment.js';
import {lessonFor} from '../../core/learning/catalog.js';
const base='/private/tmp/ai-learning-evidence-20260910',label=process.argv[2]||'curriculum-assessed-144';
if(!/^[a-z0-9-]+$/.test(label))throw Error('INVALID_REPORT_LABEL');
const out=base+'/'+label+'.json';if(fs.existsSync(out))throw Error('REPORT_EXISTS');
const original=fs.readFileSync(base+'/curriculum-144-final.json'),supplement=fs.readFileSync(base+'/assessment-targeted.json');
const source=JSON.parse(original),extra=JSON.parse(supplement);assert.equal(source.rows.length,144);assert.equal(extra.failed,0);
const sourceMap=new Map(source.rows.map(r=>[r.id,r])),extraMap=new Map(extra.rows.map(r=>[r.id,r]));
const aiService=createRemoteSyntheticModel({evaluationScope:'curriculum-144'});
const report={scope:'144 synthetic cases with recorded real dialogue plus a separate live teaching review. Not human or real-device acceptance.',dialogueSourceSha256:createHash('sha256').update(original).digest('hex'),supplementSha256:createHash('sha256').update(supplement).digest('hex'),plannedCases:144,calls:0,rows:[]};
for(const c of curriculumCases){
 const sourceRow=sourceMap.get(c.id)?.teacher?sourceMap.get(c.id):extraMap.get(c.id);assert.ok(sourceRow?.teacher,c.id);
 const row={id:c.id,level:c.level,lesson:c.lesson,kind:c.kind,text:c.text,dialogueSource:sourceMap.get(c.id)?.teacher?'curriculum-144-final':'assessment-targeted'},start=Date.now();
 try{
  for(let attempt=1;attempt<=2;attempt++){
   try{report.calls++;row.teacher=await assessLearningTurn({aiService,lesson:lessonFor(c.lesson,c.level),transcript:c.text,teacher:sourceRow.teacher,owner:'synthetic-curriculum-review',conversationId:c.id});break;}
   catch(error){if(attempt===2||!['REMOTE_EVALUATION_UNAVAILABLE','REMOTE_EVALUATION_STOPPED','LEARNING_TEACHER_UNAVAILABLE','TEACHER_REPLY_INVALID'].includes(error.code))throw error;row.firstTransportFailure=error.code;}
  }
  assert.equal(row.teacher.feedback.length>0,c.corrections,'Correction presence disagrees with benchmark');
  if(c.goal!==undefined)assert.equal(row.teacher.goalReached,c.goal,'Goal decision disagrees with benchmark');
  row.status='passed';
 }catch(error){row.status='failed';row.error=error.message;row.code=error.code;}
 row.elapsedMs=Date.now()-start;report.rows.push(row);report.passed=report.rows.filter(r=>r.status==='passed').length;report.failed=report.rows.length-report.passed;
 fs.writeFileSync(out,JSON.stringify(report,null,2));console.log(JSON.stringify({case:report.rows.length,id:row.id,status:row.status,error:row.error}));
}
if(report.failed)process.exitCode=1;
