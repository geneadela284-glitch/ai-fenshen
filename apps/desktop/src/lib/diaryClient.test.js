import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiaryClient, diaryLocalToIso, diaryIsoToLocal, diaryTimezoneLabel } from './diaryClient.js';

function mock(body, status = 200) { return {ok: status < 400, status, json: async () => body}; }
test('日记查询编码条件，使用认证会话并保持原文', async () => {
  const calls = [];
  const client = createDiaryClient({fetchImpl: async (...args) => {calls.push(args); return mock({ok:true,entries:[{id:'a',body:'  原文\n第二行  '}]});}});
  assert.equal((await client.list({q:'小李 & 借款',date:'2026-09-09'}))[0].body,'  原文\n第二行  ');
  assert.equal(new URL(calls[0][0], 'http://test').searchParams.get('q'),'小李 & 借款');
  assert.equal(calls[0][1].credentials,'include');
});
test('保存仅传合同字段，保留幂等键、版本号和原文', async () => {
  const calls=[]; const client=createDiaryClient({fetchImpl:async (...args)=>{calls.push(args);return mock({ok:true,entry:{id:'a',revision:2}});}});
  await client.create({body:'  空格\n',title:'日记',occurredOn:'2026-09-09',ownerId:'forged',idempotencyKey:'retry-1'});
  await client.update('a/b',{revision:1,body:'新的原文',ownerId:'forged',reminder:null});
  const created=JSON.parse(calls[0][1].body); assert.equal(created.body,'  空格\n'); assert.equal(created.idempotencyKey,'retry-1'); assert.equal(created.ownerId,undefined);
  assert.equal(calls[1][0],'/api/diary/a%2Fb'); assert.equal(JSON.parse(calls[1][1].body).revision,1);
});
test('删除和提醒操作携带明确确认及版本', async () => {
  const calls=[]; const client=createDiaryClient({fetchImpl:async (...args)=>{calls.push(args);return mock({ok:true,entry:{id:'a'}});}});
  await client.remove('a',3); await client.reminderAction('a',{revision:3,action:'snooze',scheduledAt:'2026-09-10T01:00:00.000Z'});
  assert.deepEqual(JSON.parse(calls[0][1].body),{revision:3,confirmed:true});
  assert.equal(JSON.parse(calls[1][1].body).action,'snooze');
});
test('版本冲突和网络错误可区分，不泄漏后台错误', async () => {
  const conflict=createDiaryClient({fetchImpl:async()=>mock({code:'DIARY_REVISION_CONFLICT',message:'secret database'},409)});
  await assert.rejects(conflict.update('a',{revision:1}),error=>error.code==='VERSION_CONFLICT' && !error.message.includes('secret'));
  const offline=createDiaryClient({fetchImpl:async()=>{throw new Error('network');}});
  await assert.rejects(offline.list(),error=>error.code==='NETWORK_ERROR');
});
test('无效成功载荷不可被当作已保存，导出返回真实服务器数据',async()=>{
  const invalid=createDiaryClient({fetchImpl:async()=>mock({ok:true})});
  await assert.rejects(invalid.create({body:'原文'}),error=>error.code==='INVALID_RESPONSE');
  const data={ok:true,entries:[{body:'我的日记'}]};
  const client=createDiaryClient({fetchImpl:async()=>mock(data)}); assert.deepEqual(await client.exportAll(),data);
});
test('日历输入按所示时区转换，保留明确时间并拒绝不存在的夏令时',()=>{
  assert.equal(diaryLocalToIso('2027-09-09T09:00','Asia/Shanghai'),'2027-09-09T01:00:00.000Z');
  assert.equal(diaryIsoToLocal('2027-09-09T01:00:00.000Z','Asia/Shanghai'),'2027-09-09T09:00');
  assert.equal(diaryLocalToIso('2026-12-31T23:45','America/New_York'),'2027-01-01T04:45:00.000Z');
  assert.throws(()=>diaryLocalToIso('2026-03-08T02:30','America/New_York'));
  assert.throws(()=>diaryLocalToIso('2026-11-01T01:30','America/New_York'));
  assert.throws(()=>diaryLocalToIso('2026-02-30T09:00','Asia/Shanghai'));
});

test('时区中文标签只用于显示，不改变转换标识',()=>{
  assert.equal(diaryTimezoneLabel('Asia/Shanghai'),'北京时间');
  assert.equal(diaryTimezoneLabel('America/New_York'),'纽约时间');
  assert.equal(diaryTimezoneLabel('Europe/Paris'),'Europe/Paris');
  assert.equal(diaryLocalToIso('2027-09-09T09:00','Asia/Shanghai'),'2027-09-09T01:00:00.000Z');
});
