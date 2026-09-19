import test from 'node:test';
import assert from 'node:assert/strict';
import { assessExpressionReview } from './reviewEvidence.js';
const attempt=(overrides={})=>({id:'one',sessionId:'s1',lessonId:'coffee',createdAt:'2026-09-10T10:00:00Z',inputMode:'voice',hint:'none',transcriptCorrected:false,evidence:'independent_this_attempt',transcript:'Could you repeat that, please?',reply:{feedback:[]},...overrides});
test('review passes only with dated independent speech in different contexts and keeps the two sources',()=>{
 const first=attempt(),second=attempt({id:'two',sessionId:'s2',lessonId:'hotel',createdAt:'2026-09-12T10:00:00Z'});
 const result=assessExpressionReview('Could you repeat that', [first,second]);assert.equal(result.passed,true);assert.equal(result.stage,2);assert.deepEqual(result.sources.map(s=>s.turnId),['one','two']);assert.equal(result.dueAt,'2026-09-15T10:00:00.000Z');
 assert.equal(assessExpressionReview('Could you repeat that',[first,{...second,createdAt:first.createdAt}]).passed,false);
 assert.equal(assessExpressionReview('Could you repeat that',[first,{...second,lessonId:first.lessonId}]).passed,false);
});
test('typing, hints, corrected recognition and substring matches cannot produce oral review credit',()=>{
 const first=attempt();for(const change of [{inputMode:'text'},{hint:'full'},{transcriptCorrected:true},{transcript:'Could you repeat thatched roof'}]){
  const result=assessExpressionReview('Could you repeat that',[first,attempt({id:'two',lessonId:'hotel',createdAt:'2026-09-12T10:00:00Z',...change})]);assert.equal(result.passed,false);assert.equal(result.stage,1);
 }
});
test('a later error in this expression returns it to practice; removing a source removes its credit',()=>{
 const first=attempt(),second=attempt({id:'two',lessonId:'hotel',createdAt:'2026-09-12T10:00:00Z'});
 const failed=attempt({id:'three',createdAt:'2026-09-13T10:00:00Z',evidence:'needs_practice',transcript:'I could you repeat that.',reply:{feedback:[{original:'I could you repeat that',suggestion:'Could you repeat that?',reasonZh:'用疑问句请求重复。'}]}});
 const result=assessExpressionReview('Could you repeat that',[first,second,failed]);assert.equal(result.passed,false);assert.equal(result.stage,0);assert.equal(result.dueAt,failed.createdAt);assert.equal(assessExpressionReview('Could you repeat that',[second]).passed,false);
});
test('an unfinished scene cannot erase a correct expression that has already been used independently',()=>{
 const first=attempt(),second=attempt({id:'two',lessonId:'hotel',createdAt:'2026-09-12T10:00:00Z'});
 const ongoing=attempt({id:'three',createdAt:'2026-09-13T10:00:00Z',evidence:'needs_practice',reply:{feedback:[],goalReached:false}});
 const result=assessExpressionReview('Could you repeat that',[first,second,ongoing]);assert.equal(result.passed,true);assert.equal(result.stage,2);assert.equal(result.lastPracticedAt,second.createdAt);
});
test('feedback about this expression revokes credit even when the wider task was completed',()=>{
 const first=attempt(),second=attempt({id:'two',lessonId:'hotel',createdAt:'2026-09-12T10:00:00Z'});
 const incorrect=attempt({id:'three',createdAt:'2026-09-13T10:00:00Z',transcript:'I could you repeat that yesterday.',reply:{goalReached:true,feedback:[{original:'I could you repeat that',suggestion:'Could you repeat that?',reasonZh:'请求重复时用疑问句，不在前面加I。'}]}});
 const result=assessExpressionReview('Could you repeat that',[first,second,incorrect]);assert.equal(result.passed,false);assert.equal(result.stage,0);assert.equal(result.dueAt,incorrect.createdAt);
});
test('feedback about other words does not invalidate this expression',()=>{
 const first=attempt(),second=attempt({id:'two',lessonId:'hotel',createdAt:'2026-09-12T10:00:00Z',transcript:'Could you repeat that? I need two room.',reply:{goalReached:true,feedback:[{original:'two room',suggestion:'two rooms',reasonZh:'两间房用复数。'}]}});
 assert.equal(assessExpressionReview('Could you repeat that',[first,second]).passed,true);
});
test('missing feedback cannot add credit or erase earlier evidence',()=>{
 const first=attempt(),unknown=attempt({id:'two',lessonId:'hotel',createdAt:'2026-09-12T10:00:00Z',reply:undefined});
 const result=assessExpressionReview('Could you repeat that',[first,unknown]);assert.equal(result.stage,1);assert.equal(result.passed,false);assert.equal(result.lastPracticedAt,first.createdAt);
});
test('an error on part of the phrase counts, while repeated ambiguous wording never adds credit',()=>{
 const first=attempt(),second=attempt({id:'two',lessonId:'hotel',createdAt:'2026-09-12T10:00:00Z',reply:{feedback:[{original:'repeat that',suggestion:'repeat it',reasonZh:'测试用明确反馈。'}]}});
 assert.equal(assessExpressionReview('Could you repeat that',[first,second]).stage,0);
 const repeated={...second,transcript:'Could you repeat that? I could you repeat that yesterday.',reply:{feedback:[{original:'could you repeat that',suggestion:'could repeat that',reasonZh:'测试用明确反馈。'}]}};
 assert.equal(assessExpressionReview('Could you repeat that',[first,repeated]).passed,false);
});
