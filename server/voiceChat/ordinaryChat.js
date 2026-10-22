export const VOICE_RESPONSE_STYLE='先回应用户具体的情绪或处境，避免套话和一味附和。建议要有专业判断：先给结论，再说必要理由与可执行的下一步。结合当前对话理解省略和口语；只有缺少信息会实质改变结果或执行才问一个具体问题，不用泛泛的听不懂话术。区分已知事实与推测，不编造记忆、资料或已执行的动作。医疗、法律、财务等高风险建议说明适用条件与依据，不装作已经核实。';
const route=(kind,capability,available,reason)=>({kind,capability,available,reason});
const textOf=input=>String(input?.message||'').trim();
const queryWords=/(?:查(?:询|看|找)?|查看|看看|找(?:出|到)?|搜索|搜(?:索)?|检索|打开|多少|哪(?:天|个|些)|什么时候|何时|有没有|是否)/u;
const actionCommand=/(?:^(?:请|帮我|替我|给我)?\s*(?:保存|删除|删掉|清空|修改|更正|更新|撤销|取消|确认|执行|发送|发给|转给|上传|下载|导出|提醒|安排|添加|创建|记录|记住|记下|忘记)|(?:帮我|替我|请).{0,20}(?:保存|删除|删掉|清空|修改|更正|更新|撤销|取消|确认|执行|发送|发给|转给|上传|下载|导出|提醒|安排|添加|创建|记录|记住|记下|忘记))/u;
const englishActionCommand=/^\s*(?:(?:please\s+)?|(?:(?:can|could|would|will)\s+you\s+)|(?:i\s+(?:want|need|would\s+like)\s+to\s+))?(?:save|remember|forget|delete|remove|update|edit|send|email|upload|download|export|remind|schedule|cancel|confirm|execute)\b/i;
const operationReference=/(?:它|那个|这(?:个|条|件)|刚才(?:的)?(?:操作|内容|那个)?|上次(?:的)?(?:操作|那个)?|\b(?:it|that|this|previous)\b)/iu;
const memoryFact=/(?:我(?:的)?(?:妈|妈妈|母亲|女儿|妻子|老婆|爱人|太太|家人)|我的(?:偏好|生日)|我叫什么).*(?:生日|偏好|喜欢|名字|记忆)|(?:生日|偏好|喜欢|名字).*(?:哪(?:天|个)|多少|什么|什么时候|何时)/u;
const privateFactQuestion=/(?:告诉(?:我)?|请问|问一下|我想知道|哪(?:天|个)|多少|什么|什么时候|何时|喜欢什么|[？?])/u;
const englishPrivateFact=/\bmy\s+(?:(?:mom|mother|dad|father|daughter|son|wife|husband|partner|spouse|family)\b.{0,48}\b(?:birthday|birth\s?date|preferences?|likes?|name|memor(?:y|ies))\b|(?:birthday|birth\s?date|preferences?|likes?|name|memor(?:y|ies))\b)/i;
const englishPrivateFactQuestion=/(?:\?|^\s*(?:what|when|who|which|how\s+much|tell\s+me|do\s+you\s+know|can\s+you\s+tell))/i;
const genericBirthdayWriting=/(?:生日|节日).*(?:祝福|文案|贺词|怎么写|送什么|礼物)|(?:祝福|文案|贺词|怎么写|送什么|礼物).*?(?:生日|节日)/u;
const meetingRecord=/(?:上次|刚才|那次|这次|我的)?.{0,12}会议.{0,16}(?:记录|纪要|决定|结论|待办|内容|说了什么)|(?:查(?:询|看|找)?|查看|找(?:出|到)?|搜索|搜(?:索)?|检索).{0,20}会议/u;
const financeRecord=/(?:上(?:个)?月|本月|这个月|今天|昨天).{0,12}(?:花了|收入|支出|收支|余额|支付|转账).*(?:多少|几|统计)|(?:花了|收入|支出|收支|余额|支付|转账).{0,12}(?:多少|几|统计)/u;
const diaryRecord=/(?:日记|记录).{0,12}(?:多少|哪(?:天|个)|什么时候|何时|有没有)|(?:查(?:询|看|找)?|查看|看看|找(?:出|到)?).{0,12}(?:日记|记录)/u;
const healthRecord=/(?:我的|我).{0,8}(?:血压|血糖|体重|病历|健康记录).*(?:多少|哪(?:天|个)|什么时候|何时|有没有|怎么样)|(?:查(?:询|看|找)?|查看|看看|找(?:出|到)?).{0,12}(?:血压|血糖|体重|病历|健康记录)/u;

// This classifies only whether a request needs trusted data or a guarded action.
// Topic words alone remain ordinary conversation; actual domain handlers still own facts and writes.
export function classifyVoiceRoute(input,{financeRuntime,protectedMemoryRuntime,diaryRuntime,healthRuntime,meetingRuntime}={}){
 const message=textOf(input);
 const memoryAvailable=Boolean(protectedMemoryRuntime?.isMemoryQuery);
 const financeAvailable=Boolean(financeRuntime?.service?.isFinanceCandidate);
 const diaryAvailable=Boolean(diaryRuntime?.service);
 const healthAvailable=Boolean(healthRuntime?.service);
 const meetingAvailable=Boolean(meetingRuntime?.service||meetingRuntime?.query);
 const memoryQuery=Boolean(protectedMemoryRuntime?.isMemoryQuery?.(message,{ownerId:input?.ownerId,conversationId:input?.conversationId}));
 const timedAction=/^(?:今天|明天|后天|下周|下个星期|周[一二三四五六日天]|星期[一二三四五六日天]|\d{1,2}月\d{1,2}[日号]).{0,20}(?:提醒我|安排|添加|创建)/u.test(message);
 if(actionCommand.test(message)||englishActionCommand.test(message)||timedAction||/^把.{1,40}(?:发给|删除|删掉|保存|安排|导出)/u.test(message)){
  if(operationReference.test(message))return route('needs_context','operation',true,'operation_reference');
  if(/(?:帮我|替我|请).{0,20}(?:保存|记录|记住|记下)/u.test(message)&&!/(?:保存|记录|记住|记下).{1,}/u.test(message.replace(/(?:帮我|替我|请)/gu,'')))return route('needs_context','operation',true,'operation_target');
  return route('action','operation',true,'explicit_operation');
 }
 if(memoryQuery)return route('read','memory',memoryAvailable,'memory_query');
 if(meetingRecord.test(message)&&queryWords.test(message))return route('read','meeting',meetingAvailable,'meeting_record_query');
 if((memoryFact.test(message)&&privateFactQuestion.test(message)&&!genericBirthdayWriting.test(message))||(englishPrivateFact.test(message)&&englishPrivateFactQuestion.test(message)))return route('read','memory',memoryAvailable,'private_fact_query');
 if(financeRecord.test(message)||Boolean(financeAvailable&&financeRuntime.service.isFinanceCandidate(message)&&queryWords.test(message)))return route('read','finance',financeAvailable,'finance_record_query');
 if(diaryRecord.test(message))return route('read','diary',diaryAvailable,'diary_record_query');
 if(healthRecord.test(message))return route('read','health',healthAvailable,'health_record_query');
 if(financeAvailable&&financeRuntime.service.isFinanceCandidate(message)&&/(?:花了|收了|收入|支出|支付|转账).*(?:\d|[一二三四五六七八九十])/u.test(message))return route('action','finance',true,'finance_operation');
 return route('ordinary',null,true,'ordinary_expression');
}

const legacyBusiness=/记住|记一下|记下|记得|记忆|忘记|记录|保存|删除|清空|修改|更正|更新|撤销|取消|确认|执行|发送|发给|转给|上传|下载|导出|提醒|日程|待办|闹钟|日记|账|收入|支出|花了|支付|转账|余额|统计|生日|农历|公历|健康|血压|血糖|体重|病历|合同|会议|文件|资料|知识库|附件|我的偏好|我叫什么|我是谁|打开|查询|查一下|查找|检索|帮我查|我(?:昨天|今天|明天|上周|以前).*?(?:说|做|安排)|(?:\d|[一二三四五六七八九十])[点时号月日元块]/u;
const legacyStrongBusiness=/记住|记一下|记下|记得|记忆|忘记|记录|保存|删除|清空|修改|更正|更新|撤销|取消|确认|执行|发送|发给|转给|上传|下载|导出|提醒|日程|待办|闹钟|日记|账|收入|支出|花了|支付|转账|余额|统计|生日|农历|公历|健康|血压|血糖|体重|病历|合同|会议|文件|资料|知识库|附件|我的偏好|我叫什么|我是谁|打开|查询|查一下|查找|检索|帮我查|查我的|我的.*?(?:记录|资料|记忆|偏好)|我(?:昨天|上周|以前).*?(?:说|做|安排)|我今天.*?(?:说过|说了|做过|做了|安排过|安排了)|(?:安排|联系|购买|预订|创建|添加)|(?:\d|[一二三四五六七八九十])[点时号月日元块]/u;
const legacyEnglish=/\b(save|remember|forget|delete|remove|update|edit|send|email|upload|download|export|remind|schedule|calendar|task|diary|payment|expense|income|balance|health|record|cancel|confirm|execute|my name|my preference)\b/i;
// Preserve the previous exported boolean contract for callers outside this voice route.
export function isVoiceBusinessCandidate(input,{financeRuntime,protectedMemoryRuntime}={}){
 const message=textOf(input);
 return Boolean(financeRuntime?.service?.isFinanceCandidate?.(message)||protectedMemoryRuntime?.isMemoryCandidate?.(message,{ownerId:input?.ownerId,conversationId:input?.conversationId})||legacyBusiness.test(message)||legacyEnglish.test(message));
}
export function hasVoiceStrongBusinessSignal(input,{financeRuntime,protectedMemoryRuntime}={}){
 const message=textOf(input);
 return Boolean(financeRuntime?.service?.isFinanceCandidate?.(message)||protectedMemoryRuntime?.isMemoryCandidate?.(message,{ownerId:input?.ownerId,conversationId:input?.conversationId})||legacyStrongBusiness.test(message)||legacyEnglish.test(message));
}
export function isVoiceAdviceOnlyCandidate(input,dependencies={}){
 const message=textOf(input);
 const asksForAdvice=/(?:给|提供)(?:我|我们)?[\u4E00-\u9FFF]{0,8}(?:建议|方法|办法)|你建议我.{0,16}|(?:怎么|如何|怎样).{0,12}(?:准备|应对|处理|做)|(?:准备|应对|处理).{0,12}(?:建议|方法)/u.test(message);
 return asksForAdvice&&!hasVoiceStrongBusinessSignal(input,dependencies);
}
