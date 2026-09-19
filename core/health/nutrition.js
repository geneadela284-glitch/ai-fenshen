import { foods, recipes } from './catalog.js';
const keys = ['kcal', 'protein', 'fat', 'carbs', 'fiber', 'sodium'];
const fail = () => {
  throw Object.assign(new Error('HEALTH_FOOD_AMOUNT_INVALID'), {
    code: 'HEALTH_FOOD_AMOUNT_INVALID',
    status: 400
  });
};
export function nutritionFor(items) {
  if (!Array.isArray(items)) fail();
  if (!items.length) return null;
  const total = Object.fromEntries(keys.map(k => [k, 0]));
  for (const item of items) {
    const food = foods.find(f => f.id === item.foodId);
    if (!food || !Number.isFinite(item.grams) || item.grams <= 0 || item.grams > 20000) fail();
    for (const k of keys) total[k] += food.per100g[k] * item.grams / 100;
  }
  return Object.fromEntries(keys.map(k => [k, Math.round(total[k] * 10) / 10]));
}
export function recipeDetails(r, servings = 1) {
  if (!Number.isFinite(servings) || servings <= 0 || servings > 8) fail();
  const ingredients = r.ingredients.map(i => ({
    ...i,
    grams: Math.round(i.grams * servings * 10) / 10
  }));
  return {
    ...r,
    servings,
    ingredients,
    nutrition: nutritionFor(ingredients),
    sources: [...new Set(ingredients.map(i => foods.find(f => f.id === i.foodId).source))]
  };
}
export function shoppingList(plan, pantry = []) {
  const totals = new Map();
  for (const day of plan.days || []) for (const meal of day.meals || []) {
    const r = recipes.find(r => r.id === meal.recipeId);
    if (!r) fail();
    for (const i of recipeDetails(r, meal.servings).ingredients) totals.set(i.foodId, (totals.get(i.foodId) || 0) + i.grams);
  }
  return [...totals].map(([foodId, grams]) => ({
    foodId,
    name: foods.find(f => f.id === foodId).name,
    grams: Math.round(grams * 10) / 10,
    owned: pantry.includes(foodId)
  }));
}
