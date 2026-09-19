import test from 'node:test';import assert from 'node:assert/strict';
import { createHealthHarness, request } from './testHarness.js';
const profile={subject:'self',consentStorage:true,consentAI:true,goal:'health',experience:'beginner',daysPerWeek:3,minutesPerSession:15,equipment:[],allergies:['花生'],dislikes:[],restrictions:'',adult:true,pregnant:false,medicalDiet:false,servings:1,cookingMinutes:30,favorites:[],pantry:[]};
const metric={kind:'metric',occurredOn:'2026-09-09',payload:{type:'weight',value:72.4,unit:'kg',measuredAt:'2026-09-09T08:00:00+08:00',context:'morning',status:'confirmed'},idempotencyKey:'weight-1'};
async function setup(t){const h=await createHealthHarness();t.after(()=>h.close());const cookie=h.login.setCookie;return{h,cookie};}
test('HTTP本人档案、持久记录、冲突/伪造owner、导出删除',async t=>{
 const {h,cookie}=await setup(t);
 assert.equal((await request(h,'/api/health')).status,401);
 const saved=await request(h,'/api/health/profile',cookie,{method:'PUT',body:{payload:profile}});assert.equal(saved.status,200,JSON.stringify(saved.body));
 const record=await request(h,'/api/health/records',cookie,{method:'POST',body:metric});assert.equal(record.status,200,JSON.stringify(record.body));
 const duplicate=await request(h,'/api/health/records',cookie,{method:'POST',body:metric});assert.equal(duplicate.body.record.id,record.body.record.id);
 const other=await h.accountSession('health_other');const c2=other.login.setCookie;assert.equal((await request(h,'/api/health/records/'+record.body.record.id,c2)).status,404);
 assert.equal((await request(h,'/api/health/records',cookie,{method:'POST',body:{...metric,ownerId:'other'}})).status,403);
 assert.equal((await request(h,'/api/health/records/'+record.body.record.id,cookie,{method:'PATCH',body:{revision:99,payload:metric.payload}})).status,409);
 assert.equal((await request(h,'/api/health/export',cookie)).body.records.length,2);
 assert.equal((await request(h,'/api/health',cookie,{method:'DELETE',body:{confirmed:true}})).status,200);
 assert.equal((await request(h,'/api/health',cookie)).body.records.length,0);
});
test('周计划先草案再确认，换菜重新核验，实际记录独立',async t=>{
 const {h,cookie}=await setup(t);await request(h,'/api/health/profile',cookie,{method:'PUT',body:{payload:profile}});
 const draft=await request(h,'/api/health/plans/draft',cookie,{method:'POST',body:{mode:'rules',startDate:'2026-09-15',request:'三天运动',idempotencyKey:'plan-1'}});assert.equal(draft.status,200,JSON.stringify(draft.body));assert.equal(draft.body.record.payload.status,'draft');
 const id=draft.body.record.id;
 const confirmed=await request(h,`/api/health/plans/${id}/confirm`,cookie,{method:'POST',body:{revision:1}});assert.equal(confirmed.status,200,JSON.stringify(confirmed.body));
 const invalid=await request(h,`/api/health/plans/${id}/change`,cookie,{method:'POST',body:{revision:2,date:'2026-09-15',slot:'dinner',recipeId:'made-up',idempotencyKey:'change-bad'}});assert.equal(invalid.status,400);
 const changed=await request(h,`/api/health/plans/${id}/change`,cookie,{method:'POST',body:{revision:2,date:'2026-09-15',slot:'dinner',recipeId:'tomato-egg',idempotencyKey:'change-1'}});assert.equal(changed.status,200,JSON.stringify(changed.body));assert.equal(changed.body.record.payload.status,'draft');
 const accept=await request(h,`/api/health/plans/${changed.body.record.id}/confirm`,cookie,{method:'POST',body:{revision:1}});assert.equal(accept.status,200,JSON.stringify(accept.body));
 const shop=await request(h,`/api/health/plans/${changed.body.record.id}/shopping`,cookie);assert.ok(shop.body.items.length);
 const summary=await request(h,'/api/health/summary?from=2026-09-01&to=2026-09-30',cookie);assert.equal(summary.body.summary.workoutCount,0);assert.equal(summary.body.summary.mealCount,0);
});
test('提醒泡泡私密标题、越权修改挡住、取消后消失',async t=>{
 const {h,cookie}=await setup(t);await request(h,'/api/health/profile',cookie,{method:'PUT',body:{payload:profile}});
 const record=await request(h,'/api/health/records',cookie,{method:'POST',body:{kind:'reminder',occurredOn:'2026-09-09',payload:{title:'敏感病情复查',scheduledAt:'2026-09-09T08:00:00+08:00',timezone:'Asia/Shanghai',repeat:'none',status:'pending'},idempotencyKey:'reminder-1'}});assert.equal(record.status,200,JSON.stringify(record.body));
 const home=await request(h,'/api/tasks/today-tomorrow?timezone=Asia%2FShanghai',cookie);assert.equal(home.status,200);const bubble=home.body.today.find(x=>x.healthId===record.body.record.id);assert.ok(bubble);assert.equal(bubble.title,'有一项健康提醒');assert.equal(JSON.stringify(bubble).includes('敏感病情'),false);
 const bypass=await request(h,`/api/tasks/${bubble.id}/complete`,cookie,{method:'POST',body:{}});assert.equal(bypass.status,409);
 const cancelled=await request(h,`/api/health/reminders/${record.body.record.id}/action`,cookie,{method:'POST',body:{revision:1,action:'cancel'}});assert.equal(cancelled.status,200);
});

test('草稿确认前重新检查疼痛及档案约束；收藏不误使计划过期',async t=>{
 const {h,cookie}=await setup(t);const service=h.instance.healthRuntime.service,owner=h.account.id;
 const saved=service.saveProfile(owner,{payload:profile,idempotencyKey:'p'});
 const draft=await request(h,'/api/health/plans/draft',cookie,{method:'POST',body:{mode:'rules',startDate:'2026-09-15',request:'每次只有10分钟，没有器材',idempotencyKey:'limit-plan'}});
 assert.equal(draft.status,200,JSON.stringify(draft.body));const record=draft.body.record;
 service.saveProfile(owner,{revision:saved.revision,payload:{...profile,favorites:['apple-oats']},idempotencyKey:'fav'});
 const pain=service.create(owner,{kind:'workout',occurredOn:'2026-09-09',payload:{name:'基础活动',minutes:10,feeling:'pain'},idempotencyKey:'pain'});
 const blocked=await request(h,`/api/health/plans/${record.id}/confirm`,cookie,{method:'POST',body:{revision:1}});assert.equal(blocked.body.code,'HEALTH_PAIN_REVIEW_REQUIRED');
 service.delete(owner,pain.id,{revision:pain.revision,confirmed:true});
 const accepted=await request(h,`/api/health/plans/${record.id}/confirm`,cookie,{method:'POST',body:{revision:1}});assert.equal(accepted.status,200,JSON.stringify(accepted.body));
 const tooLong=await request(h,`/api/health/plans/${record.id}/change`,cookie,{method:'POST',body:{revision:2,date:'2026-09-15',slot:'workout',exerciseIds:['walk'],minutes:15,idempotencyKey:'increase'}});assert.equal(tooLong.status,400);
});
