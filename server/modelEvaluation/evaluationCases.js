const gregorianBirthdayContext = Object.freeze({
  confirmed_memory: {
    relation_to_owner: 'mother',
    predicate: 'birthday',
    value: { calendar_type: 'gregorian', month: 5, day: 20, recurrence: 'yearly' }
  }
});

const lunarBirthdayContext = Object.freeze({
  confirmed_memory: {
    relation_to_owner: 'mother',
    predicate: 'birthday',
    value: {
      calendar_type: 'lunar',
      month: 7,
      day: 16,
      lunar_leap_month: false,
      recurrence: 'yearly'
    }
  }
});

function entry(id, category, title, message, expected, context = {}) {
  return Object.freeze({
    id,
    category,
    title,
    message,
    context: structuredClone(context),
    expected: structuredClone(expected),
    synthetic: true
  });
}

export const EVALUATION_CASES = Object.freeze([
  entry('A01', 'ordinary_chat', '自我介绍', '你是谁？', {
    domain: 'ordinary_chat', action: 'ordinary_chat', no_clarification: true,
    manual_review: ['identity_ai_secretary', 'natural_chinese']
  }),
  entry('A02', 'ordinary_chat', '开放式常识问题', '为什么天空通常看起来是蓝色的？', {
    domain: 'ordinary_chat', action: 'ordinary_chat', no_clarification: true,
    manual_review: ['relevance', 'factual_caution', 'natural_chinese']
  }),
  entry('A03', 'ordinary_chat', '简单分析', '从时间、成本和稳定性三个方面，简要比较坐高铁和坐飞机。', {
    domain: 'ordinary_chat', action: 'ordinary_chat', no_clarification: true,
    manual_review: ['instruction_following', 'natural_chinese']
  }),
  entry('A04', 'ordinary_chat', '中文自然表达质量', '请用自然、简洁的中文安慰一个面试失利的朋友。', {
    domain: 'ordinary_chat', action: 'ordinary_chat', no_clarification: true,
    manual_review: ['empathy', 'natural_chinese']
  }),

  entry('B01', 'semantic', '普通聊天合法Canonical结果', '你好，今天过得怎么样？', {
    domain: 'ordinary_chat', action: 'ordinary_chat', no_clarification: true
  }),
  entry('B02', 'semantic', '明确支出', '今天打车花了18元', {
    domain: 'finance', action: 'finance.create', direction: 'expense',
    amount_minor: 1800, local_date: '2026-07-27'
  }),
  entry('B03', 'semantic', '明确收入', '收到工资5000元', {
    domain: 'finance', action: 'finance.create', direction: 'income',
    amount_minor: 500000
  }),
  entry('B04', 'semantic', 'Memory保存', '请记住我女儿叫小雨', {
    domain: 'memory', action: 'memory.capture', relation_to_owner: 'daughter',
    predicate: 'name', scalar_value: '小雨'
  }),
  entry('B05', 'semantic', 'Calendar请求', '妈妈的下一个生日是哪天？', {
    domain: 'tool', action: 'calendar.next_occurrence',
    relation_to_owner: 'mother', predicate: 'birthday',
    deterministic_result: { date: '2027-05-20' }
  }, gregorianBirthdayContext),
  entry('B06', 'semantic', '真正歧义请求', '下周帮我安排一下', {
    domain: 'ambiguous', action: 'ambiguous', ambiguity_required: true
  }),

  entry('C01', 'finance', '今天打车花了18元', '今天打车花了18元', {
    domain: 'finance', action: 'finance.create', direction: 'expense',
    amount_minor: 1800, local_date: '2026-07-27'
  }),
  entry('C02', 'finance', '昨晚吃饭花了86元', '昨晚吃饭花了86元', {
    domain: 'finance', action: 'finance.create', direction: 'expense',
    amount_minor: 8600, local_date: '2026-07-26'
  }),
  entry('C03', 'finance', '收到工资5000元', '收到工资5000元', {
    domain: 'finance', action: 'finance.create', direction: 'income',
    amount_minor: 500000
  }),
  entry('C04', 'finance', '今天花了18元但未说明分类', '今天花了18元', {
    domain: 'finance', action: 'finance.create', direction: 'expense',
    amount_minor: 1800, category: null, local_date: '2026-07-27'
  }),

  entry('D01', 'memory', '保存人物关系和生日', '请记住我妈妈是公历5月20日生日', {
    domain: 'memory', action: 'memory.capture', relation_to_owner: 'mother',
    predicate: 'birthday', calendar_type: 'gregorian', month: 5, day: 20
  }),
  entry('D02', 'memory', '新会话召回', '我妈妈生日是哪天？', {
    domain: 'memory', action: 'memory.query', relation_to_owner: 'mother',
    predicate: 'birthday', no_inherited_context: true
  }),
  entry('D03', 'memory', '修改已有记忆', '把我妈妈的生日改为公历5月21日', {
    domain: 'memory', action: 'memory.supersede', relation_to_owner: 'mother',
    predicate: 'birthday', calendar_type: 'gregorian', month: 5, day: 21
  }, gregorianBirthdayContext),
  entry('D04', 'memory', '多值偏好去重', '请记住我女儿喜欢苹果、草莓和苹果', {
    domain: 'memory', action: 'memory.capture', relation_to_owner: 'daughter',
    predicate: 'likes_food', unique_values: ['苹果', '草莓']
  }),

  entry('E01', 'calendar', '公历生日下一次日期', '妈妈的下一个生日是哪天？', {
    domain: 'tool', action: 'calendar.next_occurrence',
    relation_to_owner: 'mother', predicate: 'birthday',
    deterministic_result: { date: '2027-05-20' }
  }, gregorianBirthdayContext),
  entry('E02', 'calendar', '公历生日剩余天数', '距离妈妈下一个生日还有多少天？', {
    domain: 'tool', action: 'calendar.days_until',
    relation_to_owner: 'mother', predicate: 'birthday',
    deterministic_result: { date: '2027-05-20', remaining_days: 297 }
  }, gregorianBirthdayContext),
  entry('E03', 'calendar', '农历生日换算', '妈妈今年的农历生日换成公历是哪天？', {
    domain: 'tool', action: 'calendar.convert',
    relation_to_owner: 'mother', predicate: 'birthday',
    deterministic_result: { date: '2026-08-28' }
  }, lunarBirthdayContext),
  entry('E04', 'calendar', '连续追问继承', '那还有多少天？', {
    domain: 'tool', action: 'calendar.days_until',
    relation_to_owner: 'mother', predicate: 'birthday',
    inherited_fields: ['relation_to_owner', 'predicate'],
    deterministic_result: { date: '2026-08-28', remaining_days: 32 }
  }, {
    ...lunarBirthdayContext,
    previous_turn: {
      message: '妈妈今年的农历生日换成公历是哪天？',
      action: 'calendar.convert',
      result: { date: '2026-08-28' }
    }
  }),

  entry('F01', 'stability', '严格JSON结构输出', '你好', {
    domain: 'ordinary_chat', action: 'ordinary_chat', strict_json: true
  }),
  entry('F02', 'stability', '缺失关键字段时明确失败', '记住这个', {
    domain: 'ambiguous', action: 'ambiguous', ambiguity_required: true
  })
]);
