import test from 'node:test';
import assert from 'node:assert/strict';
import { diaryMessageDisplay } from './diaryMessage.js';
test('diary proposal metadata never appears in user-facing text and entry links resolve only diary IDs',()=>{
 const result=diaryMessageDisplay('确认记下吗？\n<!-- diary-proposal-v1:eyJmb28iOjF9 -->');
 assert.equal(result.text,'确认记下吗？');
 const link=diaryMessageDisplay('已记录。[查看日记](/#diary=diary_123)');
 assert.deepEqual(link.ids,['diary_123']);
 assert.ok(!link.text.includes('/#diary='));
 assert.deepEqual(diaryMessageDisplay('正常回复'),{text:'正常回复',ids:[]});
});
