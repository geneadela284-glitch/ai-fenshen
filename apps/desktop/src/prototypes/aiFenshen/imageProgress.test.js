import test from 'node:test';
import assert from 'node:assert/strict';
import {createOptimisticExchange,applyRealConversationEvent} from './realConversationState.js';
const exchange=()=>applyRealConversationEvent(createOptimisticExchange([],{content:'总结图片',clientRequestId:'c1',attachments:[{attachmentId:'a1',processingState:'ready_for_processing'}]}),{type:'started',data:{requestId:'r1'}},'c1');
test('image stage reaches matching message and attachment without inventing progress',()=>{
 const messages=exchange();
 const updated=applyRealConversationEvent(messages,{type:'attachment_progress',data:{requestId:'r1',stage:'processing_ocr',completedImages:0,totalImages:1}},'c1');
 assert.equal(updated[1].attachmentProgress.stage,'processing_ocr');
 assert.equal(updated[0].attachments[0].processingState,'processing_ocr');
 assert.equal(updated[1].attachmentProgress.percent,undefined);
});
test('foreign, unknown and late image progress cannot overwrite a terminal answer',()=>{
 const messages=exchange();
 for(const data of [{requestId:'foreign',stage:'processing_ocr'},{requestId:'r1',stage:'made_up'}])assert.deepEqual(applyRealConversationEvent(messages,{type:'attachment_progress',data},'c1'),messages);
 const completed=applyRealConversationEvent(messages,{type:'completed',data:{requestId:'r1',status:'processed'}},'c1');
 assert.equal(completed[1].attachmentProgress,undefined);
 assert.deepEqual(applyRealConversationEvent(completed,{type:'attachment_progress',data:{requestId:'r1',stage:'processing_vision'}},'c1'),completed);
});
test('failed image processing retains original attachment and retry identity',()=>{
 const result=applyRealConversationEvent(exchange(),{type:'error',data:{requestId:'r1',code:'VISION_PROVIDER_UNAVAILABLE'}},'c1');
 assert.equal(result[0].attachments[0].attachmentId,'a1');
 assert.equal(result[0].attachments[0].processingState,'processing_failed');
 assert.equal(result[1].attachmentProgress,undefined);
 assert.equal(result[1].attachmentRequest,true);
 assert.equal(result[1].clientRequestId,'c1');
});
