import test from 'node:test';
import assert from 'node:assert/strict';
import { nutritionFor, shoppingList } from './nutrition.js';
import { allowedRecipes, assertPlanningProfile } from './constraints.js';
import { recipes, foods } from './catalog.js';
test('营养按原始USDA每100g数据乘份量，采购合并',()=>{
 const egg=foods.find(f=>f.id==='egg');const n=nutritionFor([{foodId:'egg',grams:200}]);assert.equal(n.protein,Math.round(egg.per100g.protein*2*10)/10);
 assert.throws(()=>nutritionFor([{foodId:'unknown',grams:100}]));assert.equal(nutritionFor([]),null);
 const recipe=recipes[0];const plan={days:[{meals:[{recipeId:recipe.id,servings:2},{recipeId:recipe.id,servings:1}]}]};
 assert.equal(shoppingList(plan,[]).find(i=>i.foodId===recipe.ingredients[0].foodId).grams,recipe.ingredients[0].grams*3);
});
test('乳和大豆衍生食物过滤，未知过敏词拒绝假安全',()=>{
 const filtered=allowedRecipes({allergies:['牛奶','大豆'],dislikes:[],cookingMinutes:120});assert.ok(filtered.length);assert.ok(!filtered.some(r=>r.ingredients.some(i=>['milk','tofu'].includes(i.foodId))));
 assert.throws(()=>allowedRecipes({allergies:['不明确的复合过敏原']}),e=>e.code==='HEALTH_ALLERGY_UNRESOLVED');
 assert.throws(()=>assertPlanningProfile({adult:false}),e=>e.code==='HEALTH_PROFILE_CONSENT_REQUIRED');
});
