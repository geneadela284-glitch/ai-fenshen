import test from 'node:test';import assert from 'node:assert/strict';
import { draftPlan, validatePlan, changePlan } from './planner.js';
const p={consentStorage:true,consentAI:true,adult:true,pregnant:false,medicalDiet:false,allergies:['花生'],dislikes:[],equipment:[],daysPerWeek:3,minutesPerSession:15,cookingMinutes:30,servings:1};
test('规则草案明确标记、七天三餐与训练不等于实际完成',async()=>{
 const plan=await draftPlan({profile:p,profileRevision:1,startDate:'2026-09-10',mode:'rules'});assert.equal(plan.mode,'rules');assert.equal(plan.status,'draft');assert.equal(plan.days.length,7);assert.equal(plan.days.filter(d=>d.workout).length,3);assert.ok(plan.days.every(d=>d.meals.length===3));assert.ok(plan.days.every(d=>!d.workout||d.workout.exerciseIds.every(id=>id==='walk')));
 const bad=structuredClone(plan);bad.days[0].meals[0].recipeId='unknown';assert.throws(()=>validatePlan(bad,p));
 assert.throws(()=>changePlan(plan,{date:'2026-09-09',slot:'lunch',recipeId:'tomato-egg'},p,'2026-09-10'));
});
test('AI确实调用统一服务，异常不假装成功；资料撤回不调用',async()=>{
 let called=0;const aiService={async run(){called++;return{ok:false};}};
 await assert.rejects(draftPlan({profile:p,profileRevision:1,startDate:'2026-09-10',mode:'ai',aiService}));assert.equal(called,1);
 await assert.rejects(draftPlan({profile:{...p,consentAI:false},startDate:'2026-09-10',mode:'ai',aiService}));assert.equal(called,1);
});

test('自然语言更严格的时间和食材限制进入确定性校验',async()=>{
 const plan=await draftPlan({profile:{...p,equipment:['dumbbells']},profileRevision:1,startDate:'2026-09-10',mode:'rules',request:'每周有二天，每次10分钟，没有哑铃，不吃牛奶'});
 assert.equal(plan.days.filter(d=>d.workout).length,2);assert.ok(plan.days.every(d=>!d.workout||d.workout.minutes<=10));assert.ok(plan.days.every(d=>d.meals.every(m=>m.recipeId!=='banana-oats')));
 assert.throws(()=>changePlan(plan,{date:'2026-09-10',slot:'workout',exerciseIds:['walk'],minutes:15},p,'2026-09-10'));
 await assert.rejects(draftPlan({profile:p,startDate:'2026-09-10',mode:'rules',request:'我怀孕了'}));
});

test('真实 CoreAiService 与 AIRouter 接口跑通可替换服务生成并拒绝不合规结果',async()=>{
 const {CoreAiService}=await import('../coreAiService.js');const {allowingAccessControl}=await import('../../core/router/testing/allowingAccessControl.js');let calls=0,bad=false;
 const template=await draftPlan({profile:p,profileRevision:1,startDate:'2026-09-10',mode:'rules'});
 const service=new CoreAiService({settings:{load:()=>({provider:'deepseek',router:{routes:{CHAT:{providerId:'deepseek',model:'deepseek-chat'}}},providers:{deepseek:{id:'deepseek',enabled:true,apiKey:'synthetic-only',defaultModel:'deepseek-chat',status:'可用',healthy:true}}})},accessControl:allowingAccessControl,providers:{async generate(request){calls++;assert.equal(request.provider,'deepseek');const data=structuredClone(template);if(bad)data.days[0].meals[0].recipeId='unknown';return{content:JSON.stringify(data),usage:{total_tokens:1}};}}});
 const result=await draftPlan({profile:p,profileRevision:1,startDate:'2026-09-10',mode:'ai',aiService:service});assert.equal(result.mode,'ai');assert.equal(result.status,'draft');assert.equal(calls,1);
 bad=true;await assert.rejects(draftPlan({profile:p,profileRevision:1,startDate:'2026-09-10',mode:'ai',aiService:service}));
});
