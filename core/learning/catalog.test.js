import test from 'node:test';
import assert from 'node:assert/strict';
import { lessonFor, starterReply, publicCatalog } from './catalog.js';
test('zero beginner can begin with a single spoken greeting, while advanced tasks require reasons and negotiation', () => {
  const hello = lessonFor('hello', 'beginner');
  assert.equal(starterReply(hello).replyEn, 'Hello!');
  assert.equal(hello.kind, 'foundation');
  assert.equal(hello.steps[0].say, 'Hello');
  assert.notEqual(lessonFor('coffee', 'beginner').goal, lessonFor('coffee', 'advanced').goal);
  assert.match(lessonFor('coffee', 'advanced').goal, /解释|协商/);
  assert.throws(() => lessonFor('hello', 'advanced'), { code: 'LESSON_UNAVAILABLE' });
  assert.throws(() => lessonFor('missing', 'beginner'), { code: 'LESSON_UNAVAILABLE' });
  assert.equal(publicCatalog().filter(x => x.kind === 'scenario').length, 36);
});
test('Chinese support translates the opening rather than repeating generic study advice',()=>{
 assert.match(starterReply(lessonFor('coffee','beginner')).helpZh,/咖啡.*茶/);
 assert.match(starterReply(lessonFor('hotel','beginner')).helpZh,/预订/);
 for(const lesson of publicCatalog().filter(l=>l.kind!=='foundation')){
  assert.ok(lesson.openerZh?.trim(),lesson.id+':'+lesson.level);
  assert.equal(starterReply(lesson).helpZh,lesson.openerZh);
 }
});
