import { createHash } from 'node:crypto';
import { resolveDiaryDates, zonedDate, addCalendarMonths, validDiaryDate } from '../../core/diary/time.js';
const MARKER = /<!-- diary-proposal-v1:([A-Za-z0-9_-]+) -->$/;
const explicit = /^(?:(?:请)?(?:帮我|替我)?(?:记录(?:一下)?|记一下|记下来|记下|记住|记日记|写(?:一篇)?日记)|(?:今天|昨天|明天)的日记[：:])[：:\s]*/;
const declinedCapture = /不要(?:帮我)?(?:记录|记下|记住|保存|写日记)|别(?:帮我)?(?:记录|记下|记住|保存)|不(?:用|必)(?:记录|记下|记住|保存)|不记录/;
function captureIntent(text) {
  if(!explicit.test(text))return false;
  const remainder=text.replace(explicit,'').trim();
  return !/^(?:是(?:什么|啥)|指什么|(?:功能)?怎么|(?:功能)?如何|(?:有)?什么(?:意思|用)|的意思|功能|能否|可以吗)/.test(remainder);
}
function occurrenceOnly(text,now,timezone) {
  const beginning=text.replace(explicit,'').match(/^(今天|昨天|明天|\d{4}年\d{1,2}月\d{1,2}[日号]|\d{4}-\d{2}-\d{2})/);
  const datePrefix=text.match(/^(今天|昨天|明天)的日记[：:]/)?.[1];
  return resolveDiaryDates(`记录${beginning?.[0]||datePrefix||'今天'}`,{now,timezone});
}
const unsafe = /不要|别(?:记|保存)|不(?:用|要|必)(?:记|保存)|不记录|没有约定|没(?:有)?借|不是|并未|未曾|没说|可能|打算|准备|想借|取消约定|假如|假设|如果|假想|举个?例|例如|示例|演示|他说|她说|引用|[“”「」『』"]/;
const passive = text => !unsafe.test(text) && /约定|约好|答应|承诺|借(?:给|了|我)|借款/.test(text) && /明年的今天|月后|明天|每年|\d{1,2}月\d{1,2}[日号]|下周|年底|周后|天后|还钱|还款|归还|后还/.test(text);
const reply=(action,content)=>({domain:'diary',handled:true,action,content});
const digest=value=>createHash('sha256').update(value).digest('hex');
function makeProposal(input, dates, now, timezone) {
  return {version:1,ownerId:input.ownerId,conversationId:input.conversationId,messageId:input.sourceMessageId,body:input.message,now,timezone,dates};
}
function proposalContent(p) {
  if(p.kind==='clarify') return `${p.dates.error}本次尚未保存。请直接回复约定的公历年月日和时间。\n<!-- diary-proposal-v1:${Buffer.from(JSON.stringify(p)).toString('base64url')} -->`;
  const schedule=p.dates.reminder ? `提醒时间：${p.dates.reminderDate} ${p.dates.reminderTime}（${p.timezone}）${p.dates.reminder.repeat==='yearly'?'，每年重复':''}。` : '暂不设置提醒。';
  return `要把这段约定记入日记吗？\n\n${p.body}\n\n${schedule}\n回复“确认记录”保存，回复“取消”放弃。\n<!-- diary-proposal-v1:${Buffer.from(JSON.stringify(p)).toString('base64url')} -->`;
}
function findProposal(input) {
  // Only the last conversational exchange can authorize a pending proposal.
  const messages=(input.conversationMessages||[]).filter(m=>m.id!==input.sourceMessageId && ['user','assistant'].includes(m.role) && typeof m.content==='string' && m.content.trim());
  const assistant=messages.at(-1), user=messages.at(-2);
  if(assistant?.role!=='assistant'||user?.role!=='user')return null;
  const match=assistant.content.match(MARKER);if(!match)return null;
  try {
    const p=JSON.parse(Buffer.from(match[1],'base64url').toString('utf8'));
    if(p.version!==1||p.ownerId!==input.ownerId||p.conversationId!==input.conversationId||(p.supplement?.messageId||p.messageId)!==user.id||(p.supplement?.text||p.body)!==user.content||(!passive(p.body)&&!captureIntent(p.body)))return null;
    if(user.ownerId&&user.ownerId!==input.ownerId)return null;
    if(user.conversationId&&user.conversationId!==input.conversationId)return null;
    if(p.supplement && !(input.conversationMessages||[]).some(m=>m.role==='user'&&m.id===p.messageId&&m.content===p.body))return null;
    const dates=p.supplement?resolveSupplement(p):resolveDiaryDates(p.body,{now:p.now,timezone:p.timezone});
    if((p.kind!=='clarify'&&dates.error)||JSON.stringify(dates)!==JSON.stringify(p.dates)||proposalContent(p)!==assistant.content)return null;
    return p;
  }catch{return null;}
}

function resolveSupplement(p) {
  const dates=resolveDiaryDates(`记录约定${p.supplement.text}`,{now:p.now,timezone:p.timezone});
  if(dates.error)return dates;
  const beginning=p.body.replace(explicit,'').match(/^(今天|昨天|\d{4}年\d{1,2}月\d{1,2}[日号]|\d{4}-\d{2}-\d{2})/);
  const event=resolveDiaryDates(`记录${beginning?.[0]||'今天'}`,{now:p.now,timezone:p.timezone});
  return {...dates,occurredOn:event.occurredOn};
}
// Small, explicit Chinese phrase matching. Each remaining person/topic and activity
// must occur in the owner's evidence; no guessed names, dates or rewritten facts.
function phraseQuery(phrase) {
  const value=phrase.trim().replace(/^(?:我(?:和|与|跟)|和|与|跟)/,'').replace(/(?:的事(?:情)?|的)$/,'');
  const terms=value.split(/(吃饭|吃晚饭|吃午饭|用餐|喝茶|见面|借钱|借款|归还|还钱|还款)/).map(term=>term.trim().replace(/^一起|一起$/g,'')).filter(Boolean);
  return terms.length?{filters:{},terms}:{error:'请提供日记里的人名或事项关键词。'};
}
function matchesPhrase(entry,terms) {
  const evidence=`${entry.title||''}\n${entry.body||''}`.toLocaleLowerCase();
  return terms.every(term=>{
    if(['借钱','借款'].includes(term))return /借/.test(evidence);
    if(['吃饭','吃晚饭','吃午饭','用餐'].includes(term))return /吃(?:早|午|晚)?饭|用餐/.test(evidence);
    return evidence.includes(term.toLocaleLowerCase());
  });
}
function querySpec(text,now,timezone) {
  if(/上个月.*(?:未处理|未完成).*约定/.test(text)) {
    const last=addCalendarMonths(zonedDate(now,timezone),-1);return {filters:{},month:last.slice(0,7),pending:true};
  }
  const date=text.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号].*(?:记了什么|日记|记录)/);
  if(date) {const value=`${date[1]||zonedDate(now,timezone).slice(0,4)}-${date[2].padStart(2,'0')}-${date[3].padStart(2,'0')}`;return validDiaryDate(value)?{filters:{date:value}}:{error:'这个日期无效，请提供有效的公历年月日。'};}
  const relative=text.match(/^(今天|昨天|明天)(?:的)?(?:日记|记了什么|记录了什么)[？?]?$/);
  if(relative) {const dates=resolveDiaryDates(`记录${relative[1]}`,{now,timezone});return dates.error?dates:{filters:{date:dates.occurredOn}};}
  const recordedWhen=text.match(/^(?:我(?:是)?)?(?:哪一天|什么时候|何时)(?:记录|记下)(?:了)?(.+?)(?:的事(?:情)?)?[？?。]?$/);
  if(recordedWhen)return phraseQuery(recordedWhen[1]);
  const person=text.match(/^(?:请)?(?:帮我)?(?:找|查找|查询|搜)(?:一下)?(.+?)(?:的)?(?:约定|日记|记录)[？?]?$/)||text.match(/^(.+?)(?:什么时候|何时|哪一天)(?:说)?(?:要)?还钱[？?]?$/);
  if(person)return phraseQuery(person[1]);
  if(/^(?:查看|打开|查一下|看看)(?:我的)?日记[？?]?$/.test(text))return {filters:{}};
  return null;
}
export function createDiaryConversationHandler({service,clock=()=>new Date(),timezone}={}) {
  if(!service)throw new Error('Diary service is required');
  async function save(input,body,dates,sourceId) {
    if(!input.ownerId||!input.conversationId||!sourceId)return reply('failed','尚未取得可靠的会话来源，日记未保存。请重新发送记录内容。');
    try {
      const entry=await service.create(input.ownerId,{title:body.replace(explicit,'').trim().slice(0,80)||'日记',body,occurredOn:dates.occurredOn,source:{kind:'conversation',conversationId:input.conversationId,messageId:sourceId},reminder:dates.reminder,idempotencyKey:`diary-conversation-${digest(`${input.conversationId}:${sourceId}`)}`});
      if(!entry?.id)throw new Error('No persisted entry');
      const reminder=dates.reminder?`提醒：${dates.reminderDate} ${dates.reminderTime}（${dates.reminder.timezone}）${dates.reminder.repeat==='yearly'?'，每年重复':''}。`:(dates.reminderNote||'未设置提醒。');
      return reply('saved',`已保存日记（事件日期：${dates.occurredOn}）。${reminder}\n[查看日记原文](/#diary=${encodeURIComponent(entry.id)})`);
    }catch{return reply('failed','日记保存失败，尚未确认日记和提醒已保存。请稍后重试。');}
  }
  async function processUserMessage(input={}) {
    const text=String(input.message||'').trim();if(!text)return null;
    const now=new Date(clock()).toISOString(), zone=input.taskTimezone||timezone;
    if(/^(?:确认记录|确认保存|确认|好的|好|保存|记下来|取消|不记了|不用了|不要记录)[。！!]?$/u.test(text)) {
      const p=findProposal(input);if(!p)return null;
      if(p.kind==='clarify'&&!/^(取消|不记了|不用了|不要记录)/.test(text))return reply('clarify','请先补充约定的具体日期和时间，本次尚未保存。');
      if(/^(取消|不记了|不用了|不要记录)/.test(text))return reply('cancelled','已放弃本次记录，未保存日记或设置提醒。');
      return save(input,p.supplement?`${p.body}\n\n补充：${p.supplement.text}`:p.body,p.dates,p.messageId);
    }
    const pending=findProposal(input);
    if(pending?.kind==='clarify'&&/^(?:补充[：:]?\s*)?(?:\d{4}年\d{1,2}月\d{1,2}[日号]|\d{4}-\d{2}-\d{2}|今天|明天|明年的今天)/.test(text)) {
      const p={...pending,kind:'proposal',supplement:{messageId:input.sourceMessageId,text:input.message}};
      p.dates=resolveSupplement(p);
      if(p.dates.error)return reply('clarify',proposalContent({...p,kind:'clarify'}));
      if(captureIntent(p.body))return save(input,`${p.body}\n\n补充：${p.supplement.text}`,p.dates,p.messageId);
      return reply('proposal',proposalContent(p));
    }
    let query;
    try{query=querySpec(text,now,zone);}catch{return reply('clarify','请补充有效时区，以便确定查询日期。');}
    if(query) {
      if(query.error)return reply('clarify',query.error);
      try {
        let entries=await service.list(input.ownerId,query.filters);
        if(!Array.isArray(entries))throw Error('Invalid result');
        if(query.terms)entries=entries.filter(entry=>matchesPhrase(entry,query.terms));
        if(query.month)entries=entries.filter(e=>e.occurredOn?.startsWith(query.month));
        if(query.pending)entries=entries.filter(e=>e.reminder?.status==='pending');
        if(!entries.length)return reply('query','没有找到符合条件的日记。');
        const content=entries.slice(0,10).map(e=>{
          const recorded=zonedDate(e.createdAt,zone);
          const characters=Array.from(e.body);
          const excerpt=characters.slice(0,240).join('');
          const continuation=characters.length>240?'\n原文较长，打开日记查看全文。':'';
          const reminder=e.reminder?`\n提醒时间：${new Intl.DateTimeFormat('zh-CN',{timeZone:e.reminder.timezone,dateStyle:'medium',timeStyle:'short',hour12:false}).format(new Date(e.reminder.scheduledAt))}（${e.reminder.timezone}）；状态：${({pending:'未完成',completed:'已完成',cancelled:'已取消'})[e.reminder.status]||'未确认'}。`:'';
          return `事件日期：${e.occurredOn}；记录日期：${recorded}\n原文：${excerpt}${continuation}${reminder}\n[查看日记原文](/#diary=${encodeURIComponent(e.id)})`;
        }).join('\n\n');
        return reply('query',content+(entries.length>10?`\n\n另有 ${entries.length-10} 篇，请缩小日期或关键词范围。`:''));
      }catch{return reply('failed','日记查询失败，请稍后重试。');}
    }
    const isExplicit=captureIntent(text);
    if(explicit.test(text)&&!isExplicit)return null;
    if(declinedCapture.test(text))return isExplicit?reply('cancelled','已按你的要求不保存本次内容，也未设置提醒。'):null;
    if(unsafe.test(text)) {
      if(!isExplicit)return null;
      const dates=occurrenceOnly(text,now,zone);
      if(dates.error)return reply('clarify',`${dates.error}本次尚未保存。`);
      dates.reminder=null;dates.reminderNote='原文包含引用、假设或未确认内容，未设置提醒。';
      return save(input,input.message,dates,input.sourceMessageId);
    }
    if(!isExplicit&&!passive(text))return null;
    if(isExplicit&&!text.replace(explicit,'').trim())return reply('clarify','请提供要保存的日记原文。');
    const dates=resolveDiaryDates(text,{now,timezone:zone});
    if(dates.error)return reply('clarify',proposalContent({...makeProposal(input,dates,now,zone),kind:'clarify'}));
    if(isExplicit)return save(input,input.message,dates,input.sourceMessageId);
    if(!input.ownerId||!input.conversationId||!input.sourceMessageId)return reply('failed','尚未取得可靠的会话来源，请重新发送这段约定。');
    return reply('proposal',proposalContent(makeProposal({...input,message:input.message},dates,now,zone)));
  }
  return {processUserMessage};
}
