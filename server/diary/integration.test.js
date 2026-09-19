import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiaryHarness, request } from './testHarness.js';

test('enabled diary HTTP uses authenticated identity, persists entries and participates in privacy export', async () => {
 const h=await createDiaryHarness();
 try {
  assert.equal((await request(h,'/api/diary')).status,401);
  const cookie=h.login.setCookie;
  const draft={title:'与小明的约定',body:'今天与小明约好明年的今天见面。',occurredOn:'2026-09-09',idempotencyKey:'integration-1',reminder:{scheduledAt:'2027-09-09T01:00:00.000Z',timezone:'Asia/Shanghai',repeat:'none'}};
  const create=await request(h,'/api/diary',cookie,{method:'POST',body:draft});
  assert.equal(create.status,201,JSON.stringify(create.body));
  assert.equal(create.body.entry.body,draft.body);
  const blocked=await request(h,`/api/tasks/${create.body.entry.reminder.taskId}/complete`,cookie,{method:'POST',body:{}});
  assert.equal(blocked.status,409,'linked reminder must use diary lifecycle');
  const list=await request(h,'/api/diary?date=2026-09-09',cookie);
  assert.equal(list.body.entries.length,1);
  assert.equal(h.instance.privacyLifecycle.buildExport(h.account.id).diary.length,1);
  const other=await h.accountSession('diary_b');
  assert.equal((await request(h,`/api/diary/${create.body.entry.id}`,other.login.setCookie)).status,404);
  assert.equal((await request(h,'/api/diary',cookie,{method:'POST',body:{...draft,userId:other.account.id}})).status,403);
 } finally { await h.close(); }
});

test('real conversation stream persists explicit record and confirms passive proposal with server history',async()=>{
 const h=await createDiaryHarness();
 try {
  const c=await request(h,'/api/ai/conversations',h.login.setCookie,{method:'POST',body:{title:'日记对话验收'}});
  const conversationId=c.body.conversation.id;
  async function chat(message,key){const res=await fetch(h.baseUrl+'/api/ai/chat/stream',{method:'POST',headers:{cookie:h.login.setCookie,'content-type':'application/json'},body:JSON.stringify({conversationId,message,clientRequestId:key,timezone:'Asia/Shanghai'})});assert.equal(res.status,200);return res.text();}
  const first=await chat('记录今天和小明吃饭约定明年的今天在同一个地方吃饭','diary-stream-a');
  assert.match(first,/已保存日记/);
  assert.equal(h.instance.diaryRuntime.service.list(h.account.id,{}).length,1);
  const second=await chat('今天小李借我1万块钱，他承诺三个月后还','diary-stream-b');
  assert.match(second,/确认记录/);
  assert.equal(h.instance.diaryRuntime.service.list(h.account.id,{}).length,1);
  const confirm=await chat('确认记录','diary-stream-c');
  assert.match(confirm,/已保存日记/);
  assert.equal(h.instance.diaryRuntime.service.list(h.account.id,{}).length,2);
  const query=await chat('小李什么时候说要还钱','diary-stream-d');assert.match(query,/1万/);
 }finally{await h.close();}
});

test('disabled diary keeps old app API behavior and refuses diary writes', async () => {
 const h=await createDiaryHarness({enabled:false});
 try {const r=await request(h,'/api/diary',h.login.setCookie,{method:'POST',body:{body:'不得写入'}});assert.ok([404,503].includes(r.status));assert.equal(h.instance.diaryRuntime,null);}finally{await h.close();}
});

test('switching diary off retains account export and deletion including when the diary key is unavailable',async()=>{
 const h=await createDiaryHarness();const directory=h.directory;
 h.instance.diaryRuntime.service.create(h.account.id,{title:'关闭后仍属于用户',body:'不会因关闭功能遗留',occurredOn:'2026-09-09',idempotencyKey:'disabled-export'});
 await h.close();
 const off=await createDiaryHarness({enabled:false,directory});
 try {assert.equal(off.instance.diaryRuntime,null);assert.equal(off.instance.privacyLifecycle.buildExport(off.account.id).diary.length,1);}finally{await off.close();}
 const noKey=await createDiaryHarness({enabled:false,directory,diaryKeyAvailable:false});
 try {
  const lifecycle=noKey.instance.privacyLifecycle;
  assert.throws(()=>lifecycle.buildExport(noKey.account.id),{code:'DIARY_KEY_REQUIRED'});
  const proposal=lifecycle.initiateDeletion(noKey.account.id);
  const result=lifecycle.executeDeletion({ownerId:noKey.account.id,confirmationToken:proposal.confirmationToken});
  assert.equal(result.status,'completed');
  assert.equal(noKey.instance.tasksRuntime.database.prepare('SELECT count(*) AS n FROM diary_entries').get().n,0);
 }finally{await noKey.close();}
});
