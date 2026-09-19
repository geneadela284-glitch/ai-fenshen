import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTasksRuntime } from '../tasks/runtime.js';
import { createDiaryRuntime } from './runtime.js';
import { handleDiaryApi } from './httpApi.js';

function setup(options = {}) {
  const db = options.database || new DatabaseSync(':memory:');
  let now = new Date('2026-09-09T04:00:00Z');
  const clock = () => now;
  const tasks = createTasksRuntime({database:db,applyMigrations:true,clock});
  const runtime = createDiaryRuntime({database:db,tasksService:tasks.service,encryptionKey:options.key || Buffer.alloc(32,9),applyMigrations:true,clock});
  return {...runtime,tasks,setNow(value){now = new Date(value);}};
}
const input = (extra = {}) => ({title:'私密约定',body:'小李借了10000元。  原文\n保留！',occurredOn:'2026-09-09',idempotencyKey:'save-1',...extra});
const reminder = {scheduledAt:'2026-12-09T01:00:00Z',timezone:'Asia/Shanghai',repeat:'none'};

test('encrypted persistence, restart, owner filtering, exact original and date/keyword search', () => {
  const dir=mkdtempSync(path.join(tmpdir(),'diary-test-')); const file=path.join(dir,'db.sqlite'); const key=randomBytes(32);
  let db=new DatabaseSync(file); let r=setup({database:db,key});
  const e=r.service.create('alice',input());
  assert.equal(e.body,input().body); assert.equal(r.service.list('alice',{q:'10000',date:'2026-09-09'}).length,1);
  assert.equal(r.service.list('bob',{}).length,0); assert.throws(()=>r.service.get('bob',e.id),{code:'DIARY_NOT_FOUND'});
  db.close(); assert.equal(readFileSync(file).includes(Buffer.from(input().body)),false);
  db=new DatabaseSync(file); r=setup({database:db,key}); assert.equal(r.service.get('alice',e.id).body,input().body); db.close(); rmSync(dir,{recursive:true});
});

test('idempotency and revision prevent duplicate writes and lost updates',()=>{
  const r=setup(); const e=r.service.create('a',input({reminder}));
  assert.equal(r.service.create('a',input({reminder})).id,e.id);
  assert.throws(()=>r.service.create('a',input({body:'changed',reminder})),{code:'DIARY_IDEMPOTENCY_CONFLICT'});
  const changed=r.service.update('a',e.id,{revision:e.revision,body:'新内容'}); assert.equal(changed.revision,2);
  assert.throws(()=>r.service.update('a',e.id,{revision:1,body:'旧内容'}),{code:'DIARY_REVISION_CONFLICT'});
  assert.equal(r.tasks.repository.exportForOwner('a').length,1);
  assert.equal(r.service.create('b',input()).revision,1);
});

test('shared transaction rolls back diary and Tasks when diary write fails',()=>{
  const r=setup(); r.database.exec("CREATE TRIGGER fail_diary BEFORE INSERT ON diary_entries BEGIN SELECT RAISE(ABORT, 'injected'); END;");
  assert.throws(()=>r.service.create('a',input({reminder})));
  assert.equal(r.tasks.repository.exportForOwner('a').length,0);
  assert.equal(r.service.list('a',{}).length,0);
});

test('delete requires confirmation and cancels linked Tasks; audit and tombstone contain no body',()=>{
  const r=setup(); const e=r.service.create('a',input({reminder}));
  assert.throws(()=>r.service.delete('a',e.id,{revision:1}),{code:'DIARY_DELETE_CONFIRMATION_REQUIRED'});
  r.service.delete('a',e.id,{revision:1,confirmed:true});
  assert.equal(r.tasks.repository.getForOwner('a',e.reminder.taskId).status,'cancelled');
  assert.equal(r.service.list('a',{}).length,0);
  assert.throws(()=>r.service.create('a',input({reminder})),{code:'DIARY_IDEMPOTENCY_DELETED'});
  assert.equal(JSON.stringify(r.database.prepare('SELECT * FROM diary_audit').all()).includes('10000'),false);
});

test('missed reminders remain visible, snooze updates same task, complete removes reminder',()=>{
  const r=setup(); let e=r.service.create('a',input({reminder:{...reminder,scheduledAt:'2026-08-01T01:00:00Z'}}));
  assert.equal(r.service.reminders('a',{timezone:'Asia/Shanghai'}).length,1);
  e=r.service.reminderAction('a',e.id,{revision:e.revision,action:'snooze',scheduledAt:'2026-09-10T01:00:00Z'});
  assert.equal(r.service.reminders('a',{timezone:'Asia/Shanghai'})[0].id,e.reminder.taskId);
  e=r.service.reminderAction('a',e.id,{revision:e.revision,action:'complete'});
  assert.equal(e.reminder.status,'completed'); assert.equal(r.service.reminders('a',{timezone:'Asia/Shanghai'}).length,0);
});

test('yearly reminder keeps leap-day anchor and time across non-leap years',()=>{
  const r=setup(); r.setNow('2024-02-29T02:00:00Z');
  let e=r.service.create('a',input({reminder:{...reminder,scheduledAt:'2024-02-29T01:35:00Z',repeat:'yearly'}}));
  for(const year of [2025,2026,2027,2028]){
    e=r.service.reminderAction('a',e.id,{revision:e.revision,action:'complete'});
    assert.equal(e.reminder.scheduledAt,`${year}-02-${year===2028?'29':'28'}T01:35:00.000Z`);
    r.setNow(e.reminder.scheduledAt);
  }
});

test('yearly rescheduling to a previous date never reuses an already completed next-year task',()=>{
  const r=setup();r.setNow('2026-01-01T00:00:00Z');
  let e=r.service.create('a',input({reminder:{...reminder,scheduledAt:'2026-02-01T01:00:00Z',repeat:'yearly'}}));
  e=r.service.reminderAction('a',e.id,{revision:e.revision,action:'complete'});
  const priorNextTask=e.reminder.taskId;
  e=r.service.reminderAction('a',e.id,{revision:e.revision,action:'complete'});
  e=r.service.update('a',e.id,{revision:e.revision,reminder:{...reminder,scheduledAt:'2026-02-01T01:00:00Z',repeat:'yearly'}});
  e=r.service.reminderAction('a',e.id,{revision:e.revision,action:'complete'});
  assert.equal(e.reminder.scheduledAt,'2027-02-01T01:00:00.000Z');
  assert.notEqual(e.reminder.taskId,priorNextTask);
  assert.equal(r.service.get('a',e.id).reminder.status,'pending');
  assert.equal(r.tasks.repository.getForOwner('a',e.reminder.taskId).status,'pending');
});

test('disabled diary lifecycle exports with key, fails closed without key, and can delete without decryption',async()=>{
  const {createDiaryLifecycleRuntime}=await import('./runtime.js');
  const r=setup();const entry=r.service.create('alice',input({reminder}));r.service.create('bob',input({reminder}));
  const readable=createDiaryLifecycleRuntime({database:r.database,tasksService:r.tasks.service,encryptionKey:Buffer.alloc(32,9)});
  assert.equal(readable.service.list('alice')[0].body,input().body);
  const lifecycle=createDiaryLifecycleRuntime({database:r.database,tasksService:r.tasks.service});
  assert.equal(lifecycle.service.diaryIdForTask('alice',entry.reminder.taskId),entry.id);
  assert.equal(lifecycle.service.diaryIdForTask('bob',entry.reminder.taskId),null);
  assert.equal(lifecycle.service.diaryIdForTask('alice','unknown-task'),null);
  assert.throws(()=>lifecycle.service.list('alice'),{code:'DIARY_KEY_REQUIRED'});
  assert.deepEqual(lifecycle.service.list('empty-owner'),[]);
  assert.equal(lifecycle.service.create,undefined);
  assert.equal(lifecycle.service.deleteAllForOwner('alice'),1);
  assert.equal(lifecycle.service.diaryIdForTask('alice',entry.reminder.taskId),null);
  assert.deepEqual(lifecycle.service.list('alice'),[]);
  assert.equal(r.tasks.repository.getForOwner('alice',entry.reminder.taskId).status,'cancelled');
  for(const table of ['diary_entries','diary_requests','diary_audit','diary_task_links'])assert.equal(r.database.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).get('alice').n,0);
  assert.equal(r.service.list('bob').length,1);
  assert.equal(r.tasks.repository.exportForOwner('bob')[0].status,'pending');
});

test('keyless lifecycle deletion rolls back task cancellation when diary purge fails and never creates tables',async()=>{
  const {createDiaryLifecycleRuntime}=await import('./runtime.js');
  const emptyTasks=createTasksRuntime({database:new DatabaseSync(':memory:'),applyMigrations:true});
  assert.equal(createDiaryLifecycleRuntime({database:emptyTasks.database,tasksService:emptyTasks.service}),null);
  assert.equal(emptyTasks.database.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'diary_%'").get().n,0);
  const r=setup();const e=r.service.create('alice',input({reminder}));
  const lifecycle=createDiaryLifecycleRuntime({database:r.database,tasksService:r.tasks.service});
  r.database.exec("CREATE TRIGGER fail_lifecycle_purge BEFORE DELETE ON diary_entries BEGIN SELECT RAISE(ABORT,'injected'); END;");
  assert.throws(()=>lifecycle.service.deleteAllForOwner('alice'));
  assert.equal(r.tasks.repository.getForOwner('alice',e.reminder.taskId).status,'pending');
  assert.equal(r.service.list('alice').length,1);
});

test('invalid calendar dates and ambiguous timestamps are rejected',()=>{
  const r=setup();
  assert.throws(()=>r.service.create('a',input({occurredOn:'2026-02-30'})),{status:400});
  assert.throws(()=>r.service.create('a',input({reminder:{...reminder,scheduledAt:'2026-12-09 09:00'}})),{status:400});
  assert.throws(()=>r.service.create('a',input({reminder:{...reminder,timezone:'Mars/City'}})),{status:400});
  assert.throws(()=>r.service.create('a',input({reminder:{...reminder,scheduledAt:'2026-12-09T24:00:00Z'}})),{status:400});
});

test('update and delete roll back task changes if diary mutation fails',()=>{
  const r=setup();const e=r.service.create('a',input({reminder}));
  r.database.exec("CREATE TRIGGER fail_update BEFORE UPDATE ON diary_entries BEGIN SELECT RAISE(ABORT,'injected'); END;");
  assert.throws(()=>r.service.update('a',e.id,{revision:1,reminder:{...reminder,scheduledAt:'2027-01-01T00:00:00Z'}}));
  assert.equal(r.tasks.repository.getForOwner('a',e.reminder.taskId).scheduledAt,e.reminder.scheduledAt);
  r.database.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON diary_entries BEGIN SELECT RAISE(ABORT,'injected'); END;");
  assert.throws(()=>r.service.delete('a',e.id,{revision:1,confirmed:true}));
  assert.equal(r.tasks.repository.getForOwner('a',e.reminder.taskId).status,'pending');
});

test('account deletion purges only its diary, deduplication and audit, cancelling pending tasks',()=>{
  const r=setup();const e=r.service.create('alice',input({reminder}));r.service.create('bob',input());
  assert.equal(r.service.deleteAllForOwner('alice'),1);
  assert.equal(r.service.list('alice').length,0);assert.equal(r.service.list('bob').length,1);
  assert.equal(r.tasks.repository.getForOwner('alice',e.reminder.taskId).status,'cancelled');
  assert.equal(r.database.prepare('SELECT COUNT(*) AS n FROM diary_requests WHERE user_id=?').get('alice').n,0);
  assert.equal(r.database.prepare('SELECT COUNT(*) AS n FROM diary_audit WHERE user_id=?').get('alice').n,0);
});

test('wrong key and owner binding cannot decrypt stored content',()=>{
  const r=setup();const e=r.service.create('alice',input());
  const wrong=createDiaryRuntime({database:r.database,tasksService:r.tasks.service,encryptionKey:Buffer.alloc(32,3)});
  assert.throws(()=>wrong.service.get('alice',e.id),{code:'AUTHENTICATION_FAILED'});
  r.database.prepare('UPDATE diary_entries SET user_id=? WHERE id=?').run('bob',e.id);
  assert.throws(()=>r.service.get('bob',e.id),{code:'AUTHENTICATION_FAILED'});
});

test('completed reminder stays complete when editing body and removing reminder cancels its task',()=>{
  const r=setup();let e=r.service.create('a',input({reminder}));
  e=r.service.reminderAction('a',e.id,{revision:e.revision,action:'complete'});
  e=r.service.update('a',e.id,{revision:e.revision,body:'编辑后的原文',reminder:e.reminder});
  assert.equal(e.reminder.status,'completed');
  const taskId=e.reminder.taskId;e=r.service.update('a',e.id,{revision:e.revision,reminder:null});
  assert.equal(e.reminder,null);assert.equal(r.tasks.repository.getForOwner('a',taskId).status,'cancelled');
});

test('removing then re-adding reminder creates a new pending task with requested date',()=>{
  const r=setup();let e=r.service.create('a',input({reminder}));const first=e.reminder.taskId;
  e=r.service.update('a',e.id,{revision:e.revision,reminder:null});
  e=r.service.update('a',e.id,{revision:e.revision,reminder:{...reminder,scheduledAt:'2027-01-01T01:00:00Z'}});
  assert.notEqual(e.reminder.taskId,first);assert.equal(e.reminder.status,'pending');
  assert.equal(r.service.get('a',e.id).reminder.scheduledAt,'2027-01-01T01:00:00.000Z');
});

test('reminder response identifies entry without copying plaintext to Tasks and links survive deletion',()=>{
  const r=setup();const e=r.service.create('alice',input({reminder:{...reminder,scheduledAt:'2026-08-01T01:00:00Z'}}));
  assert.equal(r.service.reminders('alice')[0].title,e.title);
  assert.equal(r.tasks.repository.getForOwner('alice',e.reminder.taskId).title,'日记约定提醒');
  assert.equal(r.tasks.repository.getForOwner('alice',e.reminder.taskId).description,null);
  assert.equal(r.service.diaryIdForTask('alice',e.reminder.taskId),e.id);
  assert.equal(r.service.diaryIdForTask('bob',e.reminder.taskId),null);
  r.service.delete('alice',e.id,{confirmed:true,revision:e.revision});
  assert.equal(r.service.diaryIdForTask('alice',e.reminder.taskId),e.id);
  r.service.deleteAllForOwner('alice');assert.equal(r.service.diaryIdForTask('alice',e.reminder.taskId),null);
});

test('HTTP takes identity only from authenticated user; export stays owner scoped',async()=>{
  const runtime=setup(); runtime.service.create('alice',input());
  async function call(method,route,body,user={id:'alice'}) {let result; await handleDiaryApi({req:{method},res:{},url:new URL(route,'http://localhost'),user,runtime,readJson:async()=>body,sendJson:(_res,status,data)=>{result={status,data};}}); return result;}
  assert.equal((await call('POST','/api/diary',{...input(),userId:'bob'})).status,403);
  assert.equal((await call('GET','/api/diary',{},null)).status,401);
  assert.equal((await call('GET','/api/diary/export',{}, {id:'bob'})).data.entries.length,0);
  assert.equal((await call('GET','/api/diary/export')).data.entries[0].body,input().body);
});
