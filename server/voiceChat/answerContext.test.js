import test from 'node:test';import assert from 'node:assert/strict';import {buildAnswerContext} from './answerContext.js';

test('语音再组装保留文字通道已有的可追溯阶段约束，私人旧资料不进入公开搜索',()=>{
 const stage={version:'source-excerpts-v1',policy:'historical_data_latest_user_instruction_wins',excerpts:[{messageId:'u1',ordinal:0,kind:'user_statement',text:'目标是安排我家周末旅行，预算一千元。'}],omittedMessages:0,omittedImportantMessages:0};
 const result=buildAnswerContext({input:'继续第二个方案',messages:[{role:'user',content:'继续第二个方案'}],conversationStageContext:stage});
 assert.match(result.instructions,/预算一千元/);assert.match(result.instructions,/u1/);assert.equal(result.allowSearch,false);
});
