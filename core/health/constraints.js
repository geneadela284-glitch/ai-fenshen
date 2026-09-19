import { foods, recipes, exercises } from './catalog.js';
export function healthConstraint(code, message, status = 400) {
  return Object.assign(new Error(message), {
    code,
    status
  });
}
const aliases = {
  牛奶: '乳',
  奶: '乳',
  乳糖: '乳',
  乳制品: '乳',
  鸡蛋: '蛋',
  蛋清: '蛋',
  蛋黄: '蛋',
  豆制品: '大豆',
  黄豆: '大豆',
  豆腐: '大豆',
  鱼类: '鱼',
  海鲜: '鱼',
  小麦: '麸质',
  面筋: '麸质',
  gluten: '麸质',
  milk: '乳',
  egg: '蛋',
  soy: '大豆',
  peanut: '花生',
  坚果: '坚果',
  芝麻: '芝麻',
  花生: '花生',
  虾: '甲壳类',
  蟹: '甲壳类',
  贝类: '贝类'
};
export function allowedRecipes(profile = {}) {
  const forbidden = new Set();
  for (const raw of profile.allergies || []) {
    const value = String(raw).trim();
    const mapped = aliases[value.toLowerCase()] || value;
    const known = ['蛋', '乳', '大豆', '鱼', '麸质', '燕麦', '花生', '坚果', '芝麻', '甲壳类', '贝类'].includes(mapped) || foods.some(f => f.name === mapped);
    if (!known) throw healthConstraint('HEALTH_ALLERGY_UNRESOLVED', `“${value}”的过敏成分尚未核对，请先在档案中明确具体食物。`);
    forbidden.add(mapped);
  }
  return recipes.filter(r => r.minutes <= (profile.cookingMinutes || 120) && !r.ingredients.some(i => {
    const f = foods.find(f => f.id === i.foodId);
    return !f || forbidden.has(f.name) || f.allergens.some(a => forbidden.has(a)) || (profile.dislikes || []).some(d => f.name.includes(d) || r.name.includes(d));
  }));
}
export function assertPlanningProfile(profile = {}, {
  requireAI = false
} = {}) {
  if (profile.consentStorage !== true || requireAI && profile.consentAI !== true) throw healthConstraint('HEALTH_PROFILE_CONSENT_REQUIRED', '请先在本人档案确认保存与AI分析的授权。');
  if (profile.adult !== true || profile.pregnant !== false || profile.medicalDiet !== false) throw healthConstraint('HEALTH_PROFILE_REVIEW_REQUIRED', '请先确认成人适用范围；孕期、未成年人和治疗性饮食需要专业人员评估。');
  if (profile.restrictions?.trim()) throw healthConstraint('HEALTH_PROFILE_RESTRICTION_REVIEW', '已记录运动或健康限制，暂不生成通用训练进阶与饮食计划。请与专业人员核对适用范围。');
}
export function allowedExercises(profile = {}) {
  return exercises.filter(e => e.equipment.every(item => (profile.equipment || []).includes(item)) && e.minutes <= (profile.minutesPerSession || 20));
}
export function narrowForRequest(profile, request = '') {
  const result = structuredClone(profile);
  if (/疼痛|膝盖疼|受伤|怀孕|孕期|糖尿病|肾病|用药|治疗|节食|绝食/.test(request)) throw healthConstraint('HEALTH_REQUEST_REVIEW', '本次要求包含需要专业核对的健康限制，请先完善档案并核对适用范围。');
  const minutes = request.match(/(?:只有|每次|单次)\s*(\d+)\s*分钟/);
  if (minutes) result.minutesPerSession = Math.min(result.minutesPerSession || 20, Number(minutes[1]));
  const days = request.match(/每周(?:有)?\s*([一二三四五六七\d])\s*天/);
  if (days) result.daysPerWeek = Math.min(result.daysPerWeek || 3, /\d/.test(days[1]) ? Number(days[1]) : '一二三四五六七'.indexOf(days[1]) + 1);
  if (/没有哑铃|无哑铃/.test(request)) result.equipment = (result.equipment || []).filter(e => e !== 'dumbbells');
  if (/没有器材|无器材/.test(request)) result.equipment = [];
  const negative = [...request.matchAll(/(?:不吃|过敏[：:]?)\s*([^，。；,\s]+)/g)].map(m => m[1]);
  if (negative.length) {
    result.allergies = [...new Set([...(result.allergies || []), ...negative])];
    allowedRecipes(result);
  }
  if (!Number.isInteger(result.minutesPerSession) || result.minutesPerSession < 5 || !Number.isInteger(result.daysPerWeek) || result.daysPerWeek < 1) throw healthConstraint('HEALTH_REQUEST_TIME', '请填写至少5分钟且每周至少1天的基础活动时间。');
  return result;
}
export function combinePlanConstraints(profile, constraints = {}) {
  return {
    ...profile,
    minutesPerSession: Math.min(profile.minutesPerSession || 20, constraints.minutesPerSession || 120),
    daysPerWeek: Math.min(profile.daysPerWeek || 3, constraints.daysPerWeek || 7),
    equipment: (profile.equipment || []).filter(e => (constraints.equipment || profile.equipment || []).includes(e)),
    allergies: [...new Set([...(profile.allergies || []), ...(constraints.allergies || [])])],
    dislikes: [...new Set([...(profile.dislikes || []), ...(constraints.dislikes || [])])]
  };
}
