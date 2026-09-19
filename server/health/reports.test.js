import test from 'node:test';import assert from 'node:assert/strict';import PDFDocument from 'pdfkit';
import { createHealthHarness,request } from './testHarness.js';
function pdfBytes(){return new Promise(resolve=>{const doc=new PDFDocument();const chunks=[];doc.on('data',b=>chunks.push(b));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.text('Health report\nGlucose: 6.2 mmol/L\nWeight: 72.4 kg');doc.end();});}
test('PDF真实原文解析、核对归档、跨owner拒绝与删除原文件',async t=>{
 const h=await createHealthHarness();t.after(()=>h.close());const cookie=h.login.setCookie;
 await request(h,'/api/health/profile',cookie,{method:'PUT',body:{payload:{subject:'self',consentStorage:true,consentAI:false}}});
 const bytes=await pdfBytes();const imported=await request(h,'/api/health/reports/import',cookie,{method:'POST',body:{filename:'health.pdf',dataBase64:bytes.toString('base64'),consent:true,idempotencyKey:'report-1'}});
 assert.equal(imported.status,200,JSON.stringify(imported.body));const r=imported.body.record;assert.equal(r.payload.status,'review');assert.equal(r.payload.dataBase64,undefined);assert.ok(r.payload.pages[0].text.includes('6.2'));
 const confirmed=await request(h,`/api/health/reports/${r.id}/confirm`,cookie,{method:'POST',body:{revision:1,examDate:'2026-09-08',institution:'合成检验机构',items:r.payload.items,confirmedSelf:true}});assert.equal(confirmed.status,200,JSON.stringify(confirmed.body));
 const original=await fetch(h.baseUrl+`/api/health/reports/${r.id}/file`,{headers:{cookie}});assert.deepEqual(Buffer.from(await original.arrayBuffer()),bytes);
 const other=await h.accountSession('health_report_other');assert.equal((await fetch(h.baseUrl+`/api/health/reports/${r.id}/file`,{headers:{cookie:other.login.setCookie}})).status,404);
 await request(h,`/api/health/records/${r.id}`,cookie,{method:'DELETE',body:{revision:2,confirmed:true}});assert.equal((await fetch(h.baseUrl+`/api/health/reports/${r.id}/file`,{headers:{cookie}})).status,404);
});
test('功能关闭无密钥仍可清除本人健康资料，不能继续新写入',async t=>{
 const first=await createHealthHarness();const directory=first.directory,owner=first.account.id;
 first.instance.healthRuntime.service.saveProfile(owner,{payload:{subject:'self',consentStorage:true,consentAI:false},idempotencyKey:'p'});first.instance.healthRuntime.service.create(owner,{kind:'meal',occurredOn:'2026-09-09',payload:{name:'合成晚饭',meal:'dinner'},idempotencyKey:'m'});await first.close();
 const h=await createHealthHarness({directory,healthEnabled:false,healthKeyAvailable:false});t.after(()=>h.close());const cookie=h.login.setCookie;
 assert.equal((await request(h,'/api/health/export',cookie)).status,503);
 assert.equal((await request(h,'/api/health/records',cookie,{method:'POST',body:{}})).status,503);
 assert.equal((await request(h,'/api/health',cookie,{method:'DELETE',body:{confirmed:true}})).status,200);
 assert.equal((await request(h,'/api/health/export',cookie)).body.records.length,0);
});
