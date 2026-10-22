import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AttachmentProviderExecutor} from './providerExecutor.js';
import {EvidenceMerger} from './evidenceMerger.js';
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/image-provider-replay-20260928.json',import.meta.url))).cases;
const executorFor=content=>new AttachmentProviderExecutor({aiService:{async runExactCapability(){return {ok:true,content};}}});
const readOcr=content=>executorFor(content).runOcr({attachment:{attachmentId:'a',mimeType:'image/png'},buffer:Buffer.from('local replay only'),trace:{},invocation:{}});
const merge=(question,answer,raw='红色方案')=>new EvidenceMerger().merge({userQuestion:question,attachments:[{attachmentId:'a'}],ocrEvidence:[{attachmentId:'a',rawText:raw,limitations:[]}],visionEvidence:{questionAnswer:answer,sceneSummary:'原场景',limitations:[]}});

for(const c of fixtures){
 test(`recorded ${c.id} response keeps meaningful answer and rejects malformed OCR`,async()=>{
  const ocr=[],errors=[];
  for(const content of c.ocrResponses){try{ocr.push(await readOcr(content));}catch(e){assert.equal(e.code,'OCR_RESULT_INVALID_FORMAT');errors.push({code:e.code});}}
  if(c.id!=='scene')assert.equal(errors.length,1,'Recorded broken coordinates must be a failed OCR step, not text evidence');
  const vision=await executorFor(c.visionResponse).runVision({attachments:[{attachmentId:'a',mimeType:'image/png'}],buffers:[Buffer.from('replay')],userQuestion:c.question,trace:{}});
  const result=new EvidenceMerger().merge({userQuestion:c.question,attachments:[{attachmentId:'a'}],ocrEvidence:ocr,visionEvidence:vision,partialErrors:errors});
  if(c.id==='scene'){assert.match(result.answer,/两个深棕色短腿/);assert.match(result.answer,/浅粉色背景/);}
  if(c.id==='notice'){assert.match(result.answer,/携带产品样本/);assert.match(result.answer,/提交改进建议/);}
  if(c.id==='multi'){assert.match(result.answer,/红色矩形/);assert.match(result.answer,/蓝色矩形/);assert.match(result.answer,/绿色矩形/);assert.match(result.answer,/深棕色支脚/);}
  assert.doesNotMatch(result.answer,/rotate_rect|```|\[object Object\]/);
  if(errors.length){assert.equal(result.answerMode,'partial');assert(result.limitations.includes('OCR_RESULT_INVALID_FORMAT'));}
 });
}
test('ordinary visual quantities remain in descriptions in Chinese and Arabic',()=>{
 for(const answer of ['共两件家具，都是红色。','画面有2个红色方块。','有三张图片，颜色不同。','一个矩形和两个支脚。'])assert.equal(merge('请描述画面',answer).answer,answer);
});
test('money dates dimensions percentages and business quantities remain protected',()=>{
 for(const [question,answer,source] of [
  ['请描述画面','两件家具售价999元','售价100元'],['比较方案','交货日期为2026年10月3日','交货日期待定'],
  ['请描述画面','桌面长三米','长度待确认'],['比较图片','优惠百分之二十','优惠待确认'],
  ['总结库存数量','库存两件','库存一件'],['请描述商品图','库存两件','库存一件'],
  ['请描述画面','画面有2个方块，价格九百元','报价100元'],['请描述画面','周五送货','日期待确认'],
  ['比较这两个方案','两个小时后送达','方案甲 当天送达'],['比较这两个方案','三个工作日内送达','方案甲 当天送达'],
  ['比较方案','估值3个亿','估值待确认'],['比较方案','需要2个星期','期限待确认'],
  ['请总结','餐费18，打车86','餐费86，打车18']
 ]){const r=merge(question,answer,source);assert.equal(r.answer,source);assert(r.limitations.some(x=>String(x).includes('数字对应关系')));}
});
test('malformed or unsupported structured OCR cannot escape as source text',async()=>{
 for(const content of ['```json\n{"raw_text":"费用100元",oops\n```','[{"text":"报价100元","rotate_rect": [100><20]}]','{"raw_text":{"amount":100}}','{"unknown":"data"}','{"table_regions":[{"rows":[["金额","100"]]}]}','{"raw_text":"","blocks":[{"text":{"amount":100}}]}','{"raw_text":"正常文字","blocks":"broken"}','{"raw_text":"正常文字","table_regions":[{"rows":[[{"amount":100}]]}]}'])await assert.rejects(readOcr(content),{code:'OCR_RESULT_INVALID_FORMAT'});
});
test('valid plain OCR and valid empty OCR retain existing meaning',async()=>{
 assert.equal((await readOcr('餐费86，打车18')).rawText,'餐费86，打车18');
 assert.equal((await readOcr('[通知] 请携带样品')).rawText,'[通知] 请携带样品');
 assert.equal((await readOcr('{"raw_text":""}')).rawText,'');
 assert.equal((await readOcr('[]')).rawText,'');
 assert.equal((await readOcr('[{"text":"AI7","rotate_rect":[100,100]}]')).rawText,'AI7');
});

test('failed OCR retains a safe scene description when the detailed answer has unverified counts',()=>{
 const scene='手机端深色模式下的社交媒体个人主页，中部是用户资料，底部是媒体图片列表。';
 const result=new EvidenceMerger().merge({userQuestion:'请描述这张图片的主要内容。',attachments:[{attachmentId:'a'}],ocrEvidence:[],visionEvidence:{questionAnswer:'这是个人主页，有68篇贴文和190万粉丝。',sceneSummary:scene},partialErrors:[{code:'OCR_RESULT_INVALID_FORMAT'}]});
 assert.equal(result.answer,scene);
 assert.equal(result.answerMode,'partial');
 assert(result.limitations.includes('OCR_RESULT_INVALID_FORMAT'));
 assert.doesNotMatch(result.answer,/68|190/);
});
test('scene fallback never supplies protected facts or substitutes for a factual question',()=>{
 for(const [question,scene] of [
  ['请描述这张图片','主页显示190万粉丝。'],
  ['请描述这张图片','报价金额待确认。'],
  ['粉丝数量是多少？','深色模式的个人主页。'],
  ['请提取图片文字','深色模式的个人主页。'],
  ['交货日期是什么？','深色模式的个人主页。']
 ]){
  const result=new EvidenceMerger().merge({userQuestion:question,visionEvidence:{questionAnswer:'190万粉丝。',sceneSummary:scene}});
  assert.notEqual(result.answer,scene);
  assert.doesNotMatch(result.answer,/190/);
 }
});

test('an explicitly requested visual ordinal is a reference, while unverified facts remain blocked',()=>{
 const answer='第二个是圆形。';assert.equal(merge('第二个是什么形状？',answer,'内部测试示意图').answer,answer);
 for(const answer of ['第二个长3米。','第二个价格99元。','第三个是圆形。']){
  assert.notEqual(merge('第二个是什么形状？',answer,'内部测试示意图').answer,answer);
 }
 assert.notEqual(merge('第二个售价多少？','第二个售价99元。','价格待确认').answer,'第二个售价99元。');
});
test('explicit inability to read a receipt amount remains visible instead of returning its title',()=>{
 const answer='不能确认。金额区域被刻意模糊处理，无具体数值。';
 assert.equal(merge('这张图的合计金额是多少？',answer,'内部模拟模糊票据').answer,answer);
 assert.notEqual(merge('金额是多少？','无法确认，但估计83.57元。','内部模拟模糊票据').answer,'无法确认，但估计83.57元。');
});
