import test from 'node:test';import assert from 'node:assert/strict';
import {nextLearningStep,matchFeedback,splitSpeech} from './experience.js';
test('recent unfinished saved session is prominent, completed lessons lead to next lesson',()=>{
 const catalog=[{id:'hello',level:'beginner'},{id:'thanks',level:'beginner'}];
 assert.equal(nextLearningStep({catalog,sessions:[{id:'a',lessonId:'hello',level:'beginner',status:'paused',updatedAt:'2026-09-10'}]},'beginner').session.id,'a');
 const step=nextLearningStep({catalog,sessions:[{id:'b',lessonId:'hello',level:'beginner',status:'completed',updatedAt:'2026-09-10'}]},'beginner');assert.equal(step.lesson.id,'thanks');assert.equal(step.completed,1);
});
test('matching score names its text source and never pretends to measure pronunciation',()=>{
 assert.equal(matchFeedback('Hello!','hello').score,100);assert.equal(matchFeedback('good morning','good evening').score,50);assert.equal(matchFeedback('','hello').score,0);assert.equal(matchFeedback('hello',null).score,null);assert.match(matchFeedback('Hello','hello').label,/词句/);
});
test('long spoken text paginates without losing words',()=>{const t=Array.from({length:70},(_,i)=>'word'+i).join(' ');const p=splitSpeech(t,100);assert.ok(p.length>1);assert.equal(p.join(' '),t);assert.ok(p.every(x=>x.length<=110));});
test('reward encourages a low match without inflating it, and makes a real high score visible',async()=>{
 const {rewardPresentation}=await import('./experience.js');
 const low=rewardPresentation({score:22,passed:false});assert.equal(low.displayScore,null);assert.equal(low.celebrate,false);assert.match(low.title,/开口|再试/);
 const high=rewardPresentation({score:97,passed:true});assert.equal(high.displayScore,97);assert.equal(high.durationMs,3200);assert.equal(high.celebrate,true);
 assert.equal(rewardPresentation({score:null,passed:true}).displayScore,null);
});
