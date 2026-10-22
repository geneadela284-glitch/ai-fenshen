import test from 'node:test';
import assert from 'node:assert/strict';
const module=await import('./runtime.js').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e});
const create=async args=>{assert.equal(typeof module.createMobileMemoryRuntime,'function','必须提供复用现有V2治理的手机持久适配');return module.createMobileMemoryRuntime(args)};
function storage(){const files=new Map();return {files,fail:false,async load(scope){return structuredClone(files.get(scope)||{revision:0,data:null})},async commit(scope,{expectedRevision,data}){if(this.fail)throw Object.assign(Error('write failed'),{code:'LOCAL_MEMORY_WRITE_FAILED'});const old=files.get(scope);if((old?.revision||0)!==expectedRevision)throw Object.assign(Error('stale'),{code:'LOCAL_MEMORY_CONFLICT'});const revision=expectedRevision+1;files.set(scope,{revision,data});return {revision}}};}
const remember=(text,id='remember-1')=>({operation:'remember',requestId:id,text:`请记住：${text}`,source:{type:'user_text',id:`message-${id}`}});
test('同一V2记录重启后可召回，记录来源完整，模型变化不改变存储',async()=>{
 const disk=storage(),a=await create({ownerUserId:'a',storage:disk});
 const saved=await a.execute(remember('我喜欢喝龙井。'));
 assert.equal(saved.status,'stored');assert.ok(saved.receipt.durable);a.close();
 const restarted=await create({ownerUserId:'a',storage:disk});
 for(const model of ['synthetic-model-a','synthetic-model-b']){
  const recalled=await restarted.execute({operation:'query',text:'我喜欢喝什么？',model});
  assert.equal(recalled.items.length,1);assert.match(recalled.items[0].text,/龙井/);assert.equal(recalled.items[0].source.id,'message-remember-1');
 }
});
test('多个事实保存在同一V2存储，纠正及删除不影响其它事实',async()=>{
 const disk=storage(),r=await create({ownerUserId:'a',storage:disk});
 const a=await r.execute(remember('我经营家具工厂。','a')),b=await r.execute(remember('我喜欢喝龙井。','b'));
 const corrected=await r.execute({operation:'correct',requestId:'correct',memoryId:b.memoryId,expectedVersion:1,text:'我喜欢喝红茶。',confirmed:true});
 assert.equal(corrected.status,'corrected');
 const newRuntime=await create({ownerUserId:'a',storage:disk});
 const recalled=await newRuntime.execute({operation:'query',text:'我喜欢喝什么？'});assert.match(JSON.stringify(recalled.items),/红茶/);assert.doesNotMatch(JSON.stringify(recalled.items),/龙井/);
 assert.equal(corrected.version,2,'纠正继承既有V2递增版本契约');
 const del=await newRuntime.execute({operation:'delete',requestId:'delete',memoryId:corrected.memoryId,expectedVersion:2,confirmed:true});assert.equal(del.status,'deleted');
 assert.equal((await newRuntime.execute({operation:'list'})).items.length,1);
 assert.equal((await newRuntime.execute({operation:'list'})).items[0].memoryId,a.memoryId);
 await assert.rejects(newRuntime.execute(remember('我喜欢喝龙井。','b')),{code:'MEMORY_REQUEST_OBSOLETE'});
});
test('写失败不产生成功回执、内存记录或重启后的记录',async()=>{
 const disk=storage(),r=await create({ownerUserId:'a',storage:disk});disk.fail=true;
 await assert.rejects(r.execute(remember('我经营家具工厂。')),{code:'LOCAL_MEMORY_WRITE_FAILED'});
 assert.equal((await r.execute({operation:'list'})).items.length,0);disk.fail=false;r.close();
 assert.equal((await (await create({ownerUserId:'a',storage:disk})).execute({operation:'list'})).items.length,0);
});
test('owner及空间不能由调用方伪造，独立owner不能读取另一人的事实',async()=>{
 const disk=storage(),a=await create({ownerUserId:'a',storage:disk}),b=await create({ownerUserId:'b',storage:disk});
 await a.execute(remember('我喜欢喝龙井。'));
 assert.equal((await b.execute({operation:'query',text:'我喜欢喝什么？'})).items.length,0);
 await assert.rejects(a.execute({operation:'query',ownerUserId:'b',text:'偏好'}),{code:'OWNER_SCOPE_MISMATCH'});
 await assert.rejects(a.execute({operation:'query',spaceId:'another-space',text:'偏好'}),{code:'SPACE_SCOPE_MISMATCH'});
});
test('只接受用户明确记住；附件指令、普通草稿和秘密不会自动保存',async()=>{
 const r=await create({ownerUserId:'a',storage:storage()});
 assert.equal((await r.execute({...remember('普通事实'),source:{type:'attachment',id:'file-a'}})).status,'rejected');
 assert.equal((await r.execute({...remember('普通事实'),text:'我今天在看展会。'})).status,'ignored');
 assert.equal((await r.execute(remember('我的密码是 test-secret。'))).status,'rejected');
 assert.equal((await r.execute({operation:'list'})).items.length,0);
});
test('敏感信息需确认；确认token绑定原内容和当前用户',async()=>{
 const r=await create({ownerUserId:'a',storage:storage()});
 const pending=await r.execute(remember('我的工资是测试数值一万元。'));
 assert.equal(pending.status,'confirmation_required');assert.equal((await r.execute({operation:'list'})).items.length,0);
 const saved=await r.execute({operation:'confirm',confirmationToken:pending.confirmationToken});
 assert.equal(saved.status,'stored');assert.equal(saved.receipt.durable,true);
});
test('相同请求重试只写一份，改变内容则拒绝，版本冲突也拒绝',async()=>{
 const r=await create({ownerUserId:'a',storage:storage()});const a=await r.execute(remember('我经营家具厂。'));
 assert.equal((await r.execute(remember('我经营家具厂。'))).memoryId,a.memoryId);assert.equal((await r.execute({operation:'list'})).items.length,1);
 await assert.rejects(r.execute(remember('我经营饭店。')),{code:'IDEMPOTENCY_CONFLICT'});
 await assert.rejects(r.execute({operation:'delete',requestId:'bad-version',memoryId:a.memoryId,expectedVersion:99,confirmed:true}),{code:'CAS_CONFLICT'});
});
test('损坏的快照、过期确认及旧运行时写入均不静默创建新库',async()=>{
 const disk=storage(),a=await create({ownerUserId:'a',storage:disk}),stale=await create({ownerUserId:'a',storage:disk});
 await a.execute(remember('我经营家具厂。'));
 await assert.rejects(stale.execute(remember('我经营饭店。','other')),{code:'LOCAL_MEMORY_CONFLICT'});
 assert.equal((await (await create({ownerUserId:'a',storage:disk})).execute({operation:'list'})).items.length,1);
 const [scope,value]=[...disk.files][0];disk.files.set(scope,{...value,data:'corrupt'});
 await assert.rejects(create({ownerUserId:'a',storage:disk}),{code:'LOCAL_MEMORY_CORRUPT'});
 let time='2026-10-03T00:00:00.000Z';const r=await create({ownerUserId:'c',storage:storage(),now:()=>time});
 const pending=await r.execute({...remember('我的工资是一万元。'),confirmed:true});
 assert.equal(pending.status,'confirmation_required','记忆保存不能用调用方布尔值替代敏感内容确认');
 time='2026-10-03T00:10:00.000Z';await assert.rejects(r.execute({operation:'confirm',confirmationToken:pending.confirmationToken}),{code:'MEMORY_CONFIRMATION_EXPIRED'});
});
test('纠正为敏感事实必须再次确认，并保留严格敏感等级',async()=>{
 const r=await create({ownerUserId:'a',storage:storage()});const a=await r.execute(remember('我喜欢喝茶。'));
 const p=await r.execute({operation:'correct',requestId:'sensitive-correct',memoryId:a.memoryId,expectedVersion:1,text:'我的工资是测试数值一万元。',confirmed:true});
 assert.equal(p.status,'confirmation_required');assert.match((await r.execute({operation:'list'})).items[0].text,/喝茶/);
 await r.execute({operation:'confirm',confirmationToken:p.confirmationToken});assert.equal((await r.execute({operation:'list'})).items[0].sensitivity,'high');
});
