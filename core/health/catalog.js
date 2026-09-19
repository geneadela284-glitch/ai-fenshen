import foodData from './foods.json' with { type: 'json' };
export const foods = Object.freeze(foodData);
const ingredients = entries => entries.map(([foodId, grams]) => ({
  foodId,
  grams
}));
const recipe = (id, name, meal, minutes, items, steps, tags = [], budget = '经济') => ({
  id,
  name,
  meal,
  minutes,
  servings: 1,
  ingredients: ingredients(items),
  steps,
  tags,
  budget
});
// Original household cooking compositions; nutrient values come from the separate USDA dataset.
export const recipes = Object.freeze([recipe('banana-oats', '香蕉牛奶燕麦', 'breakfast', 10, [['oats', 45], ['milk', 200], ['banana', 80]], ['燕麦加少量水煮软。', '加入牛奶小火加热，盛出后放切片香蕉。'], ['早餐', '一锅完成']), recipe('apple-oats', '苹果暖燕麦', 'breakfast', 10, [['oats', 50], ['apple', 120]], ['苹果去核切小块，与燕麦加水煮至软糯。', '按口味调整加水量，不另加糖。'], ['无奶配方']), recipe('egg-potato', '鸡蛋土豆早餐盘', 'breakfast', 20, [['egg', 100], ['potato', 180], ['tomato', 100], ['oliveOil', 3]], ['土豆切小块蒸熟，鸡蛋煮至凝固。', '番茄洗净切块，加入所列橄榄油，与土豆鸡蛋装盘。'], ['饱腹家常']), recipe('banana-rice', '香蕉米粥', 'breakfast', 30, [['rice', 60], ['banana', 100]], ['大米加足量清水煮成粥。', '香蕉切片，在粥煮好后加入。'], ['清淡']), recipe('tomato-egg', '番茄炒蛋配米饭', 'main', 25, [['rice', 70], ['tomato', 200], ['egg', 100], ['oliveOil', 5]], ['大米淘洗后加水煮饭。', '鸡蛋打散，用所列油炒至凝固；加入番茄炒软。', '充分熟透后搭配米饭，额外调味需另行记入。'], ['家常', '蛋白质搭配']), recipe('chicken-broccoli', '西兰花鸡肉饭', 'main', 25, [['rice', 70], ['chicken', 120], ['broccoli', 160], ['carrot', 60], ['oliveOil', 5]], ['米饭先下锅煮。', '鸡肉与蔬菜分别切小块，生熟器具分开。', '用所列油炒鸡肉，加蔬菜与少量水焖至鸡肉完全熟透。'], ['一人食']), recipe('tofu-tomato', '番茄豆腐焖饭', 'main', 25, [['rice', 70], ['tofu', 120], ['tomato', 180], ['spinach', 80], ['oliveOil', 5]], ['煮好米饭，豆腐番茄切块。', '少量油炒软番茄，加豆腐与水焖热。', '加入菠菜煮熟，与米饭一起盛出。'], ['植物搭配']), recipe('salmon-potato', '三文鱼土豆蔬菜盘', 'main', 30, [['salmon', 120], ['potato', 200], ['broccoli', 150], ['oliveOil', 5]], ['土豆切块蒸熟，西兰花焯熟。', '三文鱼用所列油煎至内外熟透。', '与土豆蔬菜装盘。'], ['家常鱼餐'], '适中'), recipe('zucchini-chicken', '西葫芦鸡丁饭', 'main', 25, [['rice', 70], ['chicken', 120], ['zucchini', 180], ['carrot', 50], ['oliveOil', 5]], ['先煮米饭。', '鸡肉与西葫芦切丁。', '用所列油炒鸡肉至完全熟透，加入蔬菜和水焖熟。'], ['家常']), recipe('spinach-egg', '菠菜鸡蛋烩土豆', 'main', 20, [['potato', 200], ['spinach', 150], ['egg', 100], ['oliveOil', 5]], ['土豆切薄片蒸熟。', '菠菜洗净焯熟，鸡蛋炒至凝固。', '将食材用所列油和少量水烩匀，充分熟透。'], ['二十分钟']), recipe('vegetable-tofu', '彩蔬豆腐饭', 'main', 25, [['rice', 70], ['tofu', 150], ['broccoli', 100], ['carrot', 80], ['oliveOil', 5]], ['煮米饭，蔬菜切小块。', '豆腐与蔬菜加所列油和水焖熟。', '与米饭装盘。'], ['植物搭配']), recipe('vegetable-rice', '田园蔬菜饭', 'main', 25, [['rice', 80], ['broccoli', 150], ['carrot', 80], ['zucchini', 100], ['oliveOil', 5]], ['大米加水煮熟。', '蔬菜切碎，用所列油翻炒后焖熟。', '与米饭拌匀；此餐蛋白质来源较少，可核对适合自己的其他搭配。'], ['多蔬菜'])]);
const strength = 'https://www.nhs.uk/live-well/exercise/strength-exercises/';
const sitting = 'https://www.nhs.uk/live-well/exercise/sitting-exercises/';
const exercise = (id, name, equipment, minutes, reps, instructions, source = strength) => ({
  id,
  name,
  equipment,
  minutes,
  reps,
  restSeconds: 45,
  instructions,
  source
});
// Concise paraphrases; original illustrated guidance opens at the attributed source.
export const exercises = Object.freeze([exercise('walk', '舒适步行', [], 5, '按舒适速度步行', ['选择平整路线和合脚鞋，按自身能力开始。', '逐步增加活动量，不适时停止。'], 'https://www.nhs.uk/live-well/exercise/walking-for-health/'), exercise('chair-stand', '坐站练习', ['chair'], 4, '1组 × 5次', ['使用稳固无轮椅；双脚平放。', '缓慢站起，再坐下。']), exercise('mini-squat', '扶椅小幅蹲', ['chair'], 4, '1组 × 5次', ['扶稳椅背，背部保持直立。', '在舒适幅度内屈膝，再站直。']), exercise('calf-raise', '扶椅提踵', ['chair'], 3, '1组 × 5次', ['扶住稳固椅背。', '缓慢抬起脚跟，再控制落下。']), exercise('side-leg', '扶椅侧抬腿', ['chair'], 4, '每侧5次', ['扶稳椅背，躯干直立。', '左右腿分别向侧方抬起，再放下。']), exercise('wall-press', '墙壁推撑', ['wall'], 5, '3组 × 5次', ['面向墙壁，双手与胸口齐平。', '缓慢屈肘靠近墙面，再推回。']), exercise('curl', '轻哑铃弯举', ['dumbbells'], 5, '3组 × 每侧5次', ['使用轻重量，上臂靠近身体。', '屈肘举起，再缓慢放下。']), exercise('seated-march', '坐姿抬腿', ['chair'], 4, '每侧5次', ['坐稳，手扶椅边。', '左右腿交替屈膝抬起并放下。'], sitting), exercise('seated-turn', '坐姿转体', ['chair'], 3, '每侧5次，每次5秒', ['双脚着地，骨盆保持稳定。', '上身在舒适范围内左右转动。'], sitting)]);
export const exerciseNotice = '动作仅作一般活动参考，请先打开来源查看示范。选稳固支撑，循序渐进；疼痛或不适时停止，必要时咨询专业人员。';
