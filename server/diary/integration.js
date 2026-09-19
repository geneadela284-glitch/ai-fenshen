import { createDiaryConversationHandler } from './conversation.js';
import { localDateKey } from '../tasks/time.js';

// Preserve the existing agent for every request outside the diary's explicit scope.
export function withDiaryAssistant(agent, runtime, {getMessages} = {}) {
  if (!runtime) return agent;
  const diary = createDiaryConversationHandler({service: runtime.service, clock: runtime.clock, timezone:'Asia/Shanghai'});
  return {
    ...agent,
    async processUserMessage(input) {
      let result;
      try { result = await diary.processUserMessage({...input,...(getMessages ? {conversationMessages:getMessages(input)} : {})}); }
      catch { return {domain:'diary',handled:true,action:'error',content:'日记操作未完成，请稍后重试。'}; }
      if (result?.handled) return result;
      return agent.processUserMessage(input);
    }
  };
}

export function diaryHomeTasks(base, reminders) {
  const ids = new Set(reminders.map(item => item.id));
  const today = base.today.filter(item => !ids.has(item.id));
  const tomorrow = base.tomorrow.filter(item => !ids.has(item.id));
  for (const item of reminders) {
    const date = localDateKey(item.scheduledAt, base.range.timezone);
    if (date <= base.range.today) today.push({...item, overdue: date < base.range.today});
    else if (date === base.range.tomorrow) tomorrow.push(item);
  }
  today.sort((a,b)=>a.scheduledAt.localeCompare(b.scheduledAt));
  tomorrow.sort((a,b)=>a.scheduledAt.localeCompare(b.scheduledAt));
  return {...base,today,tomorrow,state:today.length||tomorrow.length?'ready':'empty'};
}
