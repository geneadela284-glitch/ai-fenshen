export const VOICE_RESPONSE_STYLE='先回应用户具体的情绪或处境，避免套话和一味附和。建议要有专业判断：先给结论，再说必要理由与可执行的下一步。结合当前对话理解省略和口语；只有缺少信息会实质改变结果或执行才问一个具体问题，不用泛泛的听不懂话术。区分已知事实与推测，不编造记忆、资料或已执行的动作。医疗、法律、财务等高风险建议说明适用条件与依据，不装作已经核实。';
export const VOICE_RESPONSE_MAX_TOKENS=256;
export const VOICE_CONTEXT_MAX_MESSAGES=8;
export function boundVoiceConversationMessages(messages=[],maxMessages=VOICE_CONTEXT_MAX_MESSAGES){
 const list=Array.isArray(messages)?messages.filter(message=>message&&typeof message==='object'):[];
 const system=list.filter(message=>message.role==='system');
 const turns=list.filter(message=>message.role!=='system');
 if(turns.length<=maxMessages)return list;
 return [...system,...turns.slice(-maxMessages)];
}
// This is a conservative read-only fast-path exclusion, not an intent executor.
// A missed intent can only receive advice; all writes still require VoiceWriteGate.
export function isVoiceBusinessCandidate(input,{financeRuntime,protectedMemoryRuntime}={}){
 const message=String(input.message||'');
 if(financeRuntime?.service?.isFinanceCandidate?.(message)||protectedMemoryRuntime?.isMemoryCandidate?.(message,{ownerId:input.ownerId,conversationId:input.conversationId}))return true;
 return /记住|记一下|记下|记得|记忆|忘记|记录|保存|删除|清空|修改|更正|更新|撤销|取消|确认|执行|发送|发给|转给|上传|下载|导出|提醒|日程|待办|闹钟|日记|账|收入|支出|花了|支付|转账|余额|统计|生日|农历|公历|健康|血压|血糖|体重|病历|合同|会议|文件|资料|知识库|附件|我的偏好|我叫什么|我是谁|打开|查询|查一下|查找|检索|帮我查|我(?:昨天|今天|明天|上周|以前).*?(?:说|做|安排)|(?:\d|[一二三四五六七八九十])[点时号月日元块]/u.test(message)
  ||/\b(save|remember|forget|delete|remove|update|edit|send|email|upload|download|export|remind|schedule|calendar|task|diary|payment|expense|income|balance|health|record|cancel|confirm|execute|my name|my preference)\b/i.test(message);
}
