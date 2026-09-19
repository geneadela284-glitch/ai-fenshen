import assert from 'node:assert/strict';
import test from 'node:test';

import { createHealthClient, healthLocalDateTimeToIso } from './healthClient.js';

const response=(status,body)=>({ok:status>=200&&status<300,status,json:async()=>body});

test('health client uses authenticated owner-free endpoints and keeps report files separate',async()=>{
  const calls=[];
  const client=createHealthClient({fetchImpl:async(url,options)=>{calls.push({url,options});return response(200,url==='/api/health'?{ok:true,enabled:true,profile:null,records:[]}:{ok:true,record:{id:'m1'}});}});
  await client.load();
  await client.createRecord({kind:'metric',occurredOn:'2026-09-09',payload:{type:'weight'},idempotencyKey:'once'});
  assert.deepEqual(calls.map(call=>[call.url,call.options.method]),[['/api/health','GET'],['/api/health/records','POST']]);
  assert.equal(calls[0].options.credentials,'same-origin');
  assert.doesNotMatch(JSON.stringify(calls),/ownerId|userId|accountId|dataBase64/);
  assert.equal(client.reportFileUrl('report/a'),'/api/health/reports/report%2Fa/file');
});

test('health client exposes plan, summary, reminder and destructive confirmation contracts',async()=>{
  const calls=[];
  const client=createHealthClient({fetchImpl:async(url,options)=>{calls.push({url,options,body:options.body&&JSON.parse(options.body)});return response(200,url.includes('shopping')?{ok:true,items:[]}:url.includes('summary')?{ok:true,summary:{recordedDays:0}}:url==='/api/health'?{ok:true}:{ok:true,record:{id:'p1'}});}});
  await client.draftPlan({request:'温和',startDate:'2026-09-10',mode:'rules',idempotencyKey:'draft'});
  await client.changePlan('p/1',{revision:2,date:'2026-09-10',slot:'workout',minutes:10,idempotencyKey:'change'});
  await client.confirmPlan('p/1',3);
  await client.shopping('p/1');
  await client.summary({from:'2026-09-01',to:'2026-09-09'});
  await client.reminderAction('r/1',{revision:1,action:'complete'});
  await client.deleteAll();
  assert.deepEqual(calls.map(c=>[c.url,c.options.method]),[
    ['/api/health/plans/draft','POST'],['/api/health/plans/p%2F1/change','POST'],['/api/health/plans/p%2F1/confirm','POST'],
    ['/api/health/plans/p%2F1/shopping','GET'],['/api/health/summary?from=2026-09-01&to=2026-09-09','GET'],
    ['/api/health/reminders/r%2F1/action','POST'],['/api/health','DELETE']]);
  assert.deepEqual(calls.at(-1).body,{confirmed:true});
});

test('health client keeps server error code and message so forms can preserve input',async()=>{
  const client=createHealthClient({fetchImpl:async()=>response(409,{ok:false,code:'HEALTH_REVISION_CONFLICT',message:'记录已更新，草稿仍保留。'})});
  await assert.rejects(client.updateRecord('m1',{revision:1,payload:{}}),error=>error.code==='HEALTH_REVISION_CONFLICT'&&error.message==='记录已更新，草稿仍保留。');
});

test('local health time conversion keeps the user selected wall time and an explicit offset',()=>{
  const iso=healthLocalDateTimeToIso('2026-09-09T08:30');
  assert.match(iso,/^2026-09-09T08:30:00(?:\.000)?(?:Z|[+-]\d\d:\d\d)$/);
});
