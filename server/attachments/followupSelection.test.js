import test from 'node:test';import assert from 'node:assert/strict';import {selectImageFollowup} from './followupSelection.js';
const groups=[{attachmentIds:['a']},{attachmentIds:['b','c']}];
test('图片追问定位与无关问题分开，多图不猜',()=>{
 assert.deepEqual(selectImageFollowup('第一张图里第二个物体是什么',groups),{attachmentIds:['a']});
 assert.deepEqual(selectImageFollowup('刚才这几张图有什么不同',groups),{attachmentIds:['b','c']});
 assert.ok(selectImageFollowup('刚才那张图多少钱',groups).clarification);
 assert.equal(selectImageFollowup('按照第二个方案继续',groups,{adjacent:true}),null);
 assert.deepEqual(selectImageFollowup('它是什么牌子？',[groups[0]],{adjacent:true}),{attachmentIds:['a']});
 assert.equal(selectImageFollowup('它是什么牌子？',[groups[0]]),null);
});
