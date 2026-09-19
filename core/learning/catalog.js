import { learningError } from './contract.js';

const foundation = [
  ['hello', '第一声 Hello', '从一句你好开始', '👋', [
    ['Hello', '你好。先听一遍，再跟着说。', ['hello', 'hi', 'hello there'], 'Hi!'],
    ['Hi', '换一种打招呼的方法。你也可以说 Hello。', ['hi', 'hello', 'hi there'], 'Your turn.'],
    ['Hello', '试试不看提示，向我打个招呼。', ['hello', 'hi', 'hello there', 'hi there'], 'Hello! Nice to meet you.']
  ]],
  ['thanks', '说一声谢谢', '收到帮助时，轻松回应', '🌷', [
    ['Thank you', '谢谢你。可以先慢慢听两个词。', ['thank you', 'thanks', 'thank you very much'], 'You are welcome.'],
    ['Thanks', '这是更简短的“谢谢”。', ['thanks', 'thank you'], 'Here is your coffee.'],
    ['Thank you', '收到咖啡，用刚才学的表达回应。', ['thanks', 'thank you', 'thank you very much'], 'You are welcome!']
  ]],
  ['yes-no', '说出你的选择', '会说愿意，也会说不需要', '☀️', [
    ['Yes, please', '好的，谢谢。', ['yes please', 'yes'], 'Would you like some water?'],
    ['No, thank you', '不用了，谢谢。', ['no thank you', 'no thanks'], 'Would you like some tea?'],
    ['Yes, please', '选择你自己的回答，接受或婉拒都可以。', ['yes please', 'yes', 'no thank you', 'no thanks', 'no'], 'Thank you for telling me.']
  ]],
  ['repeat', '听不懂也能继续', '请对方重复或慢一点', '🎧', [
    ['Again, please', '请再说一次。', ['again please', 'please say it again'], 'Hello!'],
    ['Slowly, please', '请慢一点说。', ['slowly please', 'please speak slowly'], 'Of course.'],
    ['Again, please', '试着自己请求重复。', ['again please', 'please say it again', 'could you repeat that please'], 'Of course. Hello!']
  ]]
].map(([id, title, goal, emoji, steps]) => ({ id, title, goal, emoji, level: 'beginner', kind: 'foundation', language: 'en', version: 1,
  category: '零基础开口', estimatedMinutes: 5, steps: steps.map(([say, help, accept, response]) => ({ say, help, accept, response })),
  helpZh: '不用先背单词或学音标。听一句、试着说一句，再用它回应。' }));

// Original authored task definitions; content-review status is tracked separately from runtime availability.
const scenarios = [
  ['introduce', '认识新朋友', '👋', '生活', ['介绍自己的称呼', '介绍兴趣并追问对方', '根据交流对象调整介绍方式并说明观点'],
    ['Hi! What is your name?', 'Nice to meet you. What do you enjoy doing outside work?', 'We have just met at an event. What would you like me to know about your work and interests?'], ['My name is Alex.', 'I enjoy reading. How about you?', 'My main focus is helping people solve practical problems.']],
  ['coffee', '街角咖啡店', '☕', '生活', ['说出想要的饮品和大小', '调整配料并处理饮品售罄', '解释订单问题并协商合理处理'],
    ['Hello! Would you like coffee or tea?', 'Welcome! What can I get you? You can customize your drink.', 'Welcome back. You mentioned a problem with your order. Could you explain what happened?'], ['A small coffee, please.', 'Could I have oat milk instead?', 'I ordered a decaf coffee. Could you check the order, please?']],
  ['restaurant', '一起去吃饭', '🍽️', '生活', ['点一道菜并礼貌回应', '说明饮食偏好并询问做法', '解释多人的需求并协商菜单选择'],
    ['Welcome! Would you like rice or noodles?', 'Do you have any preferences before you order?', 'Your group has different dietary preferences. How would you like us to accommodate them?'], ['Noodles, please.', 'Could you make it less spicy?', 'Could we choose dishes that can be served separately?']],
  ['shopping', '挑一件喜欢的', '🛍️', '生活', ['询问价格和颜色', '比较商品并询问更换尺码', '解释商品问题并协商退换方案'],
    ['Hello! What color would you like?', 'What are you looking for, and what matters most to you?', 'I understand the product did not meet your expectations. What would be a fair solution?'], ['How much is it?', 'Do you have a larger size?', 'Would an exchange be possible if a refund is not available?']],
  ['directions', '找到目的地', '🧭', '旅行', ['询问车站在哪里', '听懂方向后再次确认路线', '比较不同路线并解释时间约束'],
    ['Hello! Can I help you?', 'Where are you trying to get to?', 'There are a few ways to get there. What is your priority: time, cost, or accessibility?'], ['Where is the station?', 'So I turn left at the next street?', 'I have limited time, but I would prefer to avoid too many transfers.']],
  ['hotel', '安心住下来', '🧳', '旅行', ['说明有预订并完成简单入住', '提出房间需求并确认早餐安排', '澄清预订差异并协商可接受的替代安排'],
    ['Welcome! Do you have a reservation?', 'Welcome. Do you have any room preferences?', 'The room type on our system differs from your confirmation. Could you explain what you booked?'], ['I have a reservation.', 'Could I have a quiet room?', 'My confirmation states a twin room. What alternatives can you offer?']],
  ['tickets', '出发去旅行', '🚆', '旅行', ['说出目的地并买一张票', '询问时间、票价和换乘', '比较票务方案并说明行程限制'],
    ['Hello! Where would you like to go?', 'What time would you like to arrive?', 'There are flexible and non-refundable options. What changes might you need to make?'], ['One ticket to London, please.', 'Is there a direct train?', 'I may need to change the departure date. How flexible is this ticket?']],
  ['booking', '计划有了变化', '📅', '旅行', ['提出更改预订日期', '说明更改原因并确认新时间', '协商改期费用并确认双方约定'],
    ['Hello! How can I help with your booking?', 'What would you like to change, and why?', 'Your current booking has restrictions. What outcome would work best for you?'], ['Can I change the date?', 'Could we move it to Friday?', 'Could the change fee be waived if I accept a different time?']],
  ['appointment', '打个预约电话', '☎️', '生活', ['提出预约并选择时间', '确认服务内容与到场要求', '协调多人时间并澄清预约细节'],
    ['Hello! Would you like to make an appointment?', 'What service would you like, and when are you available?', 'We need to coordinate several schedules. Which constraints should we consider?'], ['Friday, please.', 'Is there anything I should bring?', 'Could we confirm the duration before choosing a time?']],
  ['smalltalk', '轻松聊两句', '💬', '工作', ['问候同事并回应近况', '聊周末经历并自然追问', '得体接话并自然转换话题'],
    ['Hi! How are you?', 'How was your weekend?', 'We have a few minutes before the meeting. What has been on your mind lately?'], ['I am fine, thank you.', 'I went for a walk. How about you?', 'That reminds me of something we discussed recently.']],
  ['product', '介绍你的产品', '🪑', '工作', ['说出产品是什么和一个特点', '介绍用途并回答比较问题', '针对客户需求解释方案取舍并回应异议'],
    ['Hello! What is this product?', 'Who is this product designed for?', 'Our team has specific constraints. How would your product address them, and what trade-offs should we expect?'], ['This is a chair. It is comfortable.', 'It is designed for small offices.', 'The main advantage is flexibility, although there is a trade-off in cost.']],
  ['delivery', '确认交付安排', '📦', '工作', ['询问交付日期并确认', '说明数量与时间要求', '协商交期冲突并提出替代方案'],
    ['Hello! When do you need the order?', 'Could you confirm the quantity and your preferred delivery date?', 'Your requested date is earlier than our standard lead time. What flexibility do we have?'], ['Next Friday, please.', 'We need twenty chairs by Friday.', 'Could we split the delivery so the essential items arrive first?']]
];
const levels = ['beginner', 'intermediate', 'advanced'];
const beginnerCriteria={
 introduce:'说出自己的称呼即达成，不要求职业或兴趣。',
 coffee:'表达饮品和大小即达成，不要求付款或完成出杯。',
 restaurant:'说出一道菜并使用please或thank you等礼貌表达即达成，不要求补充做法或饮料。',
 shopping:'说明想要的颜色并询问价格即达成，不要求购买或付款。',
 directions:'询问车站在哪里即达成，不要求已经走到目的地。',
 hotel:'说明已有预订并表达入住请求即达成，不要求证件、房型或付款。',
 tickets:'提出一张票的请求并说出目的地即达成，不要求出发时间、支付或实际出票；自然的名词短句也有效。',
 booking:'提出更改预订日期的请求即达成，新日期和费用可在后续继续协商。',
 appointment:'在预约对话中表达预约意愿并选择日期或时间即达成，可结合开场问题理解简短回答。',
 smalltalk:'问候并回应自己的近况即达成，不要求另外的话题。',
 product:'说明产品是什么并说出一个特点即达成，舒适等使用感受也是特点，不要求材料或价格。',
 delivery:'说明或询问交付日期并请求确认即达成，不要求实际发货。'
};
const openingTranslations={
 introduce:['你好！你叫什么名字？','很高兴认识你。工作之外，你喜欢做什么？','我们刚在活动上认识。关于你的工作和兴趣，你想让我了解些什么？'],
 coffee:['你好！你想喝咖啡还是茶？','欢迎！你想喝什么？饮品可以按你的口味调整。','欢迎回来。你说订单有问题，能说说发生了什么吗？'],
 restaurant:['欢迎！你想吃米饭还是面条？','点餐前，你有什么饮食偏好吗？','你们一行人的饮食偏好不同，你希望我们怎样安排？'],
 shopping:['你好！你想要什么颜色？','你想买什么？你最看重什么？','我了解商品没有达到你的预期。你觉得怎样处理比较合适？'],
 directions:['你好！需要帮忙吗？','你想去哪里？','有几条路线可以到达。时间、费用和通行方便程度，你最看重哪一点？'],
 hotel:['欢迎！你有预订吗？','欢迎。你对房间有什么偏好吗？','系统里的房型与你的确认信息不同。你能说明一下预订的房型吗？'],
 tickets:['你好！你想去哪里？','你想几点到达？','有可灵活变更和不可退款的票。你可能需要做哪些行程变更？'],
 booking:['你好！关于预订，有什么可以帮你？','你想更改什么？原因是什么？','你目前的预订有一些限制。怎样的安排对你最合适？'],
 appointment:['你好！你想预约吗？','你想预约什么服务？什么时候有空？','我们需要协调几个人的时间，应考虑哪些限制？'],
 smalltalk:['你好！最近怎么样？','你周末过得怎么样？','开会前还有几分钟。最近你在想些什么？'],
 product:['你好！这是什么产品？','这款产品是为哪些人设计的？','我们团队有一些具体限制。你的产品怎样解决这些问题？需要做哪些取舍？'],
 delivery:['你好！你什么时候需要这批货？','请确认数量和你希望的交付日期，好吗？','你要求的日期比我们的常规交期早。有哪些方面可以灵活调整？']
};
const foundationResponseTranslations={
 hello:['嗨！','轮到你了。','你好！很高兴认识你。'],
 thanks:['不客气。','这是你的咖啡。','不客气！'],
 'yes-no':['你想喝点水吗？','你想喝点茶吗？','谢谢你告诉我。'],
 repeat:['你好！','当然。','当然。你好！']
};
for(const lesson of foundation)lesson.steps.forEach((step,index)=>{step.responseZh=foundationResponseTranslations[lesson.id][index];});
const lessons = [...foundation, ...scenarios.flatMap(([id, title, emoji, category, goals, openings, hints]) => levels.map((level, i) => ({
  id, title, emoji, category, level, kind: 'scenario', language: 'en', version: 1, estimatedMinutes: i === 0 ? 5 : 10,
  goal: goals[i], completionCriteria:i===0?beginnerCriteria[id]:goals[i], opener: openings[i], openerZh:openingTranslations[id][i], hint: hints[i],
  helpZh: i === 0 ? '不必说得很长。先表达你的意思，卡住时可以看一句提示。' : i === 1 ? '试着说明原因，再问对方一个问题。' : '表达观点、给出理由，并回应对方的追问。'
}))), ...levels.map(level => ({ id: 'guess', title: '猜猜我是谁', emoji: '🍎', category: '开口游戏', level, kind: 'game', language: 'en', version: 1,
  estimatedMinutes: 5, goal: '用英语提问，根据线索猜出物品', opener: 'I am thinking of something. Ask me a question!', openerZh:'我心里想了一样东西。向我提个问题吧！',
  hint: 'Is it something we can eat?', helpZh: '你来提问，我给线索。试着用英语猜出答案。' }))];
export function lessonFor(id, level) {
  const lesson = lessons.find(item => item.id === id && item.level === level);
  if (!lesson) throw learningError('LESSON_UNAVAILABLE', 404);
  return structuredClone(lesson);
}
export function publicCatalog() { return lessons.map(({ steps, ...lesson }) => lesson); }
export function starterReply(lesson) {
  return { replyEn: lesson.kind === 'foundation' ? `${lesson.steps[0].say}!` : lesson.opener,
    helpZh: lesson.kind === 'foundation' ? lesson.steps[0].help : lesson.openerZh, feedback: [], goalReached: false };
}
