export const EXPENSE_CATEGORIES = Object.freeze([
  '餐饮', '交通', '购物', '居家', '娱乐', '医疗', '教育', '人情', '宠物', '旅行', '其他'
]);

export const INCOME_CATEGORIES = Object.freeze([
  '工资', '经营', '客户回款', '退款', '转入', '其他收入'
]);

export function categoriesForType(type) {
  return type === 'income' ? INCOME_CATEGORIES : type === 'expense' ? EXPENSE_CATEGORIES : [];
}

export function isAllowedCategory(type, category) {
  return categoriesForType(type).includes(String(category || ''));
}
