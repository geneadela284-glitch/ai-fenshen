import { redactHealthHistory } from './aiPrivacy.js';
import { createHash } from 'node:crypto';
import { resolveDiaryDates, dateTimeInZone } from '../../core/diary/time.js';
import { localDateKey } from '../tasks/time.js';
import { draftPlan, changePlan } from './planner.js';
const marker = /<!-- health-proposal-v1:([A-Za-z0-9_-]+) -->$/;
const topic = /健康|体重|血压|血糖|体温|体检|复查|健身|运动|训练|饮食|菜谱|记餐|早餐|午餐|晚餐/;
const family = /妈妈|爸爸|母亲|父亲|我妈|我爸|孩子|朋友|同事|老板|邻居|同学|小[\u4e00-\u9fff]|小明|小李|妻子|丈夫|女儿|儿子|他(?:的|刚)|她(?:的|刚)/;
const negated = /不要|别(?:记|保存)|不用|不必|假如|假设|如果|例如|举例|引用|[“”"]/;
const capture = /^(?:请)?(?:帮我)?(?:记录|记下|记住|保存|记餐)/;
const response = (action, content) => ({
  domain: 'health',
  handled: true,
  action,
  content: content + '\n<!-- health-turn-v1 -->'
});
const link = id => `[查看健康记录](/#health=${id})`;
const key = input => 'health-chat-' + createHash('sha256').update(input.conversationId + ':' + input.sourceMessageId).digest('hex');
function proposalText(p) {
  return `请核对健康提醒：${p.title}\n提醒日期：${p.dates.reminderDate} ${p.dates.reminderTime}（${p.timezone}）。${p.repeat === 'weekly' ? '每周重复。' : ''}\n回复“确认健康提醒”后保存。\n<!-- health-proposal-v1:${Buffer.from(JSON.stringify(p)).toString('base64url')} -->`;
}
function findProposal(input) {
  const history = (input.conversationMessages || []).filter(m => m.id !== input.sourceMessageId && ['user', 'assistant'].includes(m.role) && m.content?.trim());
  const assistant = history.at(-1),
    user = history.at(-2);
  if (assistant?.role !== 'assistant' || user?.role !== 'user') return null;
  const assistantContent = assistant.content.replace(/\n<!-- health-turn-v1 -->$/, '');
  const match = assistantContent.match(marker);
  if (!match) return null;
  try {
    const p = JSON.parse(Buffer.from(match[1], 'base64url'));
    if (p.owner !== input.ownerId || p.conversationId !== input.conversationId || p.messageId !== user.id || p.text !== user.content || proposalText(p) !== assistantContent) return null;
    const parsed = reminderProposal(p.text, {
      ...input,
      sourceMessageId: p.messageId
    }, new Date(p.now), p.timezone);
    return parsed && proposalText(parsed) === assistantContent ? p : null;
  } catch {
    return null;
  }
}
function reminderProposal(text, input, now, timezone) {
  let dates,
    repeat = 'none';
  const weekly = text.match(/每周([一二三四五六日天]).*?(\d{1,2})[:：点](\d{1,2})?/);
  if (weekly) {
    const weekday = '日一二三四五六'.indexOf(weekly[1] === '天' ? '日' : weekly[1]);
    const today = localDateKey(now, timezone),
      base = new Date(today + 'T00:00:00Z');
    let gap = (weekday - base.getUTCDay() + 7) % 7;
    const time = weekly[2].padStart(2, '0') + ':' + (weekly[3] || '00').padStart(2, '0');
    let date = new Date(base.getTime() + gap * 86400000).toISOString().slice(0, 10);
    if (Date.parse(dateTimeInZone(date, time, timezone)) <= now.getTime()) date = new Date(Date.parse(date) + 7 * 86400000).toISOString().slice(0, 10);
    dates = {
      occurredOn: today,
      reminderDate: date,
      reminderTime: time,
      reminder: {
        scheduledAt: dateTimeInZone(date, time, timezone),
        timezone
      }
    };
    repeat = 'weekly';
  } else {
    if (/月后/.test(text) && !/(今天|\d{4}年\d{1,2}月\d{1,2}[日号]|\d{4}-\d{2}-\d{2})/.test(text)) return null;
    dates = resolveDiaryDates(text, {
      now,
      timezone
    });
    if (dates.error || !dates.reminder) return null;
  }
  return {
    owner: input.ownerId,
    conversationId: input.conversationId,
    messageId: input.sourceMessageId,
    text,
    now: now.toISOString(),
    timezone,
    title: text.replace(capture, '').slice(0, 120),
    dates,
    repeat
  };
}
function metricInput(text, now, timezone) {
  let type, match, unit, value, secondaryValue;
  if (match = text.match(/体重(?:是|为)?\s*(\d+(?:\.\d+)?)\s*(公斤|千克|kg|斤)/i)) {
    type = 'weight';
    unit = match[2] === '斤' ? 'jin' : 'kg';
    value = Number(match[1]);
  } else if (match = text.match(/血压(?:是|为)?\s*(\d+)\s*[/／]\s*(\d+)/)) {
    type = 'bloodPressure';
    unit = 'mmHg';
    value = Number(match[1]);
    secondaryValue = Number(match[2]);
  } else if (match = text.match(/血糖(?:是|为)?\s*(\d+(?:\.\d+)?)\s*(mmol\/L|mg\/dL|毫摩尔\/升)?/i)) {
    type = 'glucose';
    unit = match[2] === '毫摩尔/升' ? 'mmol/L' : match[2] || '';
    value = Number(match[1]);
  } else if (match = text.match(/体温(?:是|为)?\s*(\d+(?:\.\d+)?)\s*(℃|°C|摄氏度|°F|华氏度)/i)) {
    type = 'temperature';
    unit = /F|华氏/i.test(match[2]) ? '°F' : '°C';
    value = Number(match[1]);
  }
  if (!type) return null;
  const today = localDateKey(now, timezone),
    dates = resolveDiaryDates(text.replace(match[0], ''), {
      now,
      timezone
    });
  if (dates.error) return {
    error: '请补充明确的测量日期。'
  };
  if (dates.occurredOn > today) return {
    error: '未来的测量不能记作已经发生，请到时再记录。'
  };
  const time = text.match(/(\d{1,2})[:：点](\d{1,2})?/);
  let measuredAt;
  if (time) {
    let hour = Number(time[1]);
    if (/下午|晚上/.test(text) && hour < 12) hour += 12;
    measuredAt = dateTimeInZone(dates.occurredOn, String(hour).padStart(2, '0') + ':' + (time[2] || '00').padStart(2, '0'), timezone);
  } else if (/刚(?:刚|量|测)?|现在/.test(text) && dates.occurredOn === today) measuredAt = now.toISOString();else return {
    error: '请补充测量时间，例如“记录今天08:00体重72.4公斤”；刚测量的可以说“记录刚量的体重72.4公斤”。本次尚未保存。'
  };
  const context = type === 'glucose' ? /空腹/.test(text) ? 'fasting' : /餐后/.test(text) ? 'afterMeal' : /随机/.test(text) ? 'random' : 'unknown' : 'selfReported';
  return {
    kind: 'metric',
    occurredOn: dates.occurredOn,
    payload: {
      type,
      value,
      ...(secondaryValue ? {
        secondaryValue
      } : {}),
      unit,
      measuredAt,
      context,
      status: unit && context !== 'unknown' ? 'confirmed' : 'draft',
      note: '来源：主对话本人记录',
      source: {
        kind: 'conversation',
        text
      }
    }
  };
}
export function createHealthConversationHandler({
  service,
  repository,
  clock = () => new Date(),
  aiService
}) {
  return {
    async processUserMessage(input) {
      const text = String(input.message || '').trim(),
        now = clock(),
        timezone = input.taskTimezone || 'Asia/Shanghai';
      if (text === '确认健康提醒') {
        const p = findProposal(input);
        if (!p) return response('clarify', '当前没有可确认的健康提醒，请重新说明提醒内容和时间。');
        const record = service.create(input.ownerId, {
          kind: 'reminder',
          occurredOn: p.dates.occurredOn,
          payload: {
            title: p.title,
            ...p.dates.reminder,
            repeat: p.repeat,
            status: 'pending'
          },
          idempotencyKey: 'health-reminder-' + createHash('sha256').update(p.conversationId + ':' + p.messageId).digest('hex')
        });
        return response('saved', `健康提醒已保存。${link(record.id)}`);
      }
      if (!topic.test(text) || /日记/.test(text)) return null;
      const writing = capture.test(text) || /提醒我|帮我.*提醒/.test(text);
      if (writing && (family.test(text) || negated.test(text))) return response('clarify', '这次没有写入本人健康档案。第一版只支持本人明确确认的健康记录。');
      if (/胸痛.*(?:喘|呼吸困难)|呼吸困难|昏迷|突然.*(?:偏瘫|说不清)/.test(text)) return response('safety', '这些症状可能需要紧急评估，请立即联系当地急救服务或就近急诊；中国大陆可拨打120。不要等待AI记录或建议。');
      if (writing && !service.profile(input.ownerId)?.payload.consentStorage) return response('consent', '请先打开健康入口，在本人档案中确认健康资料的保存范围。随后可在这里记录。');
      if (writing && /提醒|复查/.test(text)) {
        const p = reminderProposal(text, input, now, timezone);
        return response('proposal', p ? proposalText(p) : '请补充起算日期和具体提醒时间，例如“从今天起三个月后09:00提醒我复查”，或“每周一08:00提醒我量体重”。本次尚未保存。');
      }
      if (writing) {
        if (/想吃|打算|准备|计划|将要|预计|还没|没吃|没有吃|未吃|没有运动|未运动/.test(text)) return response('clarify', '这段内容是计划或尚未发生的事情，未记作实际饮食或运动。可以在健康页安排计划。');
        const prefix = text.replace(capture, '').split(/体重|血压|血糖|体温|早餐|午餐|晚餐|加餐|运动|训练|步行|健身/)[0];
        const remaining = prefix.replace(/我|今天|昨天|刚刚|刚|现在|早上|上午|下午|晚上|空腹|餐后|随机|测量|测得|量|测|的|一下|年|月|日|号|时|分|点|[\d\s:：.,，-]/g, '');
        if (remaining) return response('clarify', '请明确这是本人的记录，并直接说明测量日期、时间和数值；本次没有写入本人档案。');
        const metric = metricInput(text, now, timezone);
        if (metric?.error) return response('clarify', metric.error);
        if (metric) {
          const record = service.create(input.ownerId, {
            ...metric,
            idempotencyKey: key(input)
          });
          return response('saved', `${record.payload.status === 'draft' ? '已保留草稿，请在健康页补齐单位与测量情境；尚未计入趋势' : '健康记录已保存'}。日期：${record.occurredOn}。${link(record.id)}`);
        }
        const meal = text.match(/(?:早餐|午餐|晚餐|加餐)(?:吃了|吃的|是|：|:)?(.+)/),
          workout = text.match(/(?:运动|训练|步行|健身)(?:了)?\s*(\d+)\s*分钟/);
        const dates = resolveDiaryDates(text, {
          now,
          timezone
        });
        if (dates.error) return response('clarify', '请补充明确的实际记录日期。');
        if (dates.occurredOn > localDateKey(now, timezone)) return response('clarify', '未来安排不能计入已经完成的饮食或运动。');
        if (meal) {
          const record = service.create(input.ownerId, {
            kind: 'meal',
            occurredOn: dates.occurredOn,
            payload: {
              name: meal[1].trim(),
              meal: text.includes('早餐') ? 'breakfast' : text.includes('午餐') ? 'lunch' : text.includes('晚餐') ? 'dinner' : 'snack',
              note: '主对话文字记录，份量未核对，不计算精确热量。'
            },
            idempotencyKey: key(input)
          });
          return response('saved', `已记下这餐，份量未核对，未计算精确热量。${link(record.id)}`);
        }
        if (workout) {
          const record = service.create(input.ownerId, {
            kind: 'workout',
            occurredOn: dates.occurredOn,
            payload: {
              name: '主对话运动记录',
              minutes: Number(workout[1]),
              feeling: /疼|痛|不适/.test(text) ? 'pain' : /累/.test(text) ? 'tired' : 'unrecorded',
              note: text
            },
            idempotencyKey: key(input)
          });
          return response('saved', `运动记录已保存。${record.payload.feeling === 'pain' ? '已记录不适，请暂停相关运动并核对适用范围。' : ''}${link(record.id)}`);
        }
        return response('clarify', '请说明具体健康记录，例如“记录刚量的血压128/82”或“记录今天晚餐吃了番茄炒蛋”。');
      }
      if (/(?:安排|制定|生成|设计).*(?:运动|饮食|健身|菜谱|健康).*计划|(?:运动|饮食|健康).*周计划/.test(text)) {
        const profile = service.profile(input.ownerId);
        if (!profile) return response('consent', '先在健康档案确认本人目标、时间和必要健康限制，随后即可生成周计划。');
        const today = localDateKey(now, timezone);
        const startDate = /下周/.test(text) ? new Date(Date.parse(today) + ((8 - new Date(today).getUTCDay()) % 7 || 7) * 86400000).toISOString().slice(0, 10) : today;
        const payload = await draftPlan({
          profile: profile.payload,
          profileRevision: profile.revision,
          startDate,
          mode: 'ai',
          request: text,
          aiService,
          invocation: input.invocation,
          records: service.list(input.ownerId)
        });
        if (service.profile(input.ownerId)?.revision !== profile.revision) return response('failed', '档案已变化，请重新生成计划。');
        const record = service.create(input.ownerId, {
          kind: 'plan',
          occurredOn: startDate,
          payload,
          idempotencyKey: key(input)
        });
        return response('proposal', `一周运动与饮食草案已准备，请打开核对后启用。${link(record.id)}`);
      }
      if (/查看|看看|查询|查一下|上次|最近|总结|哪天|哪一天|什么/.test(text)) {
        if (!service.profile(input.ownerId)?.payload.consentStorage) return response('consent', '当前没有可用于主对话查询的健康授权，请在健康档案中查看或恢复授权。');
        let records = service.list(input.ownerId).filter(r => r.kind !== 'profile');
        const match = text.match(/最近(?:一个月|一月|30天|三个月|90天|7天|一周)/);
        if (match) {
          const n = /三个月|90/.test(match[0]) ? 90 : /月|30/.test(match[0]) ? 30 : 7;
          const from = new Date(now.getTime() - (n - 1) * 86400000).toISOString().slice(0, 10);
          records = records.filter(r => r.occurredOn >= from);
        }
        const type = /体重/.test(text) ? 'weight' : /血压/.test(text) ? 'bloodPressure' : /血糖/.test(text) ? 'glucose' : /体温/.test(text) ? 'temperature' : null;
        if (type) records = records.filter(r => r.kind === 'metric' && r.payload.type === type);else if (/报告|体检/.test(text)) records = records.filter(r => r.kind === 'report' && r.payload.status === 'archived');else if (/运动|训练|健身/.test(text)) records = records.filter(r => r.kind === 'workout');else if (/饮食|吃|餐/.test(text)) records = records.filter(r => r.kind === 'meal');
        const on = text.match(/\d{4}-\d{2}-\d{2}/)?.[0];
        if (on) records = records.filter(r => r.occurredOn === on);
        if (!records.length) return response('query', '没有找到符合条件的本人健康记录。');
        const shown = records.slice(0, /上次/.test(text) ? 1 : 8);
        return response('query', shown.map(r => `${r.occurredOn}：${r.kind === 'metric' ? `${r.payload.value}${r.payload.secondaryValue ? '/' + r.payload.secondaryValue : ''} ${r.payload.unit || '单位待补'}${r.payload.status === 'draft' ? '（草稿，未计入趋势）' : ''}` : r.kind === 'report' ? `${r.payload.institution || '体检报告'}；${r.payload.items.map(i => `${i.name} ${i.value} ${i.unit}`).join('；').slice(0, 450)}` : r.payload.name || r.payload.title || '健康计划'}\n${link(r.id)}`).join('\n\n') + '\n以上依据已保存记录；未记录的内容无法推断。');
      }
      return null;
    }
  };
}
export function withHealthAssistant(agent, runtime, {
  getMessages,
  aiService
} = {}) {
  const handler = runtime ? createHealthConversationHandler({
    ...runtime,
    aiService
  }) : null;
  return {
    ...agent,
    async processUserMessage(input) {
      try {
        const result = await handler?.processUserMessage({
          ...input,
          conversationMessages: getMessages?.(input) || []
        });
        if (result?.handled) return result;
      } catch (error) {
        return response('failed', /[\u4e00-\u9fff]/.test(error.message || '') ? error.message : '健康操作未完成，未确认保存成功，请检查资料后重试。');
      }
      return agent.processUserMessage({
        ...input,
        conversationMessages: redactHealthHistory(input.conversationMessages || [])
      });
    }
  };
}
