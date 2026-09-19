/** Calendar-only diary dates. Never uses the host's implicit timezone. */
const pad = n => String(n).padStart(2, '0');
export function assertDiaryTimezone(timezone) {
  if (!timezone || typeof timezone !== 'string') throw new Error('请提供有效时区。');
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  return timezone;
}
export function zonedDate(now, timezone) {
  assertDiaryTimezone(timezone);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year:'numeric',month:'2-digit',day:'2-digit' }).formatToParts(new Date(now));
  const p = Object.fromEntries(parts.map(v => [v.type,v.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
export function validDiaryDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value;
}
export function addCalendarMonths(date, count) {
  if (!validDiaryDate(date) || !Number.isInteger(count)) throw new Error('无效日历日期');
  const [y,m,d] = date.split('-').map(Number);
  const target = new Date(Date.UTC(y,m-1+count,1));
  const last = new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth()+1,0)).getUTCDate();
  return `${target.getUTCFullYear()}-${pad(target.getUTCMonth()+1)}-${pad(Math.min(d,last))}`;
}
export const addCalendarYears = (date, years) => addCalendarMonths(date, years*12);
function addDays(date,n) { const d=new Date(`${date}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10); }
function wallParts(value, timezone) {
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value)).map(v=>[v.type,v.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
export function dateTimeInZone(date,time,timezone) {
  assertDiaryTimezone(timezone);
  if(!validDiaryDate(date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))throw new Error('日期或时间无效');
  const wall=`${date}T${time}:00`, naive=Date.parse(`${wall}Z`);
  // Check all timezone offsets represented near this wall time. Reject DST gaps and folds.
  const candidates = new Set();
  for(const hours of [-36,-12,0,12,36]) {
    const sample=naive+hours*3600000;
    const offset=Date.parse(`${wallParts(sample,timezone)}Z`)-sample;
    const candidate=naive-offset;
    if(wallParts(candidate,timezone)===wall)candidates.add(candidate);
  }
  if(candidates.size!==1)throw new Error('该时区的时间不存在或有重复，请换一个明确时间');
  return new Date([...candidates][0]).toISOString();
}
function chineseNumber(value) {
  if(/^\d+$/.test(value))return Number(value);
  const digit={'零':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
  if(value==='十')return 10;
  if(value.includes('十')) {const [a,b]=value.split('十');return (a?digit[a]:1)*10+(b?digit[b]:0);}
  return digit[value];
}
const tokenPattern=/明年的今天|\d{4}年\d{1,2}月\d{1,2}[日号]|\d{4}-\d{2}-\d{2}|(?:\d+|[一二两三四五六七八九十]+)个?月后|\d{1,2}月\d{1,2}[日号]|今天|昨天|明天/g;
export function resolveDiaryDates(text,{now,timezone}={}) {
  try {
    const today=zonedDate(now,timezone);
    if(/明年(?!的今天)|后年|来年|(?:[一二三四五六七八九十两\d]+)(?:周|星期|年|天|小时|分钟)后|[一二三四五六七八九十]+月[一二三四五六七八九十]+[日号]|\d{1,4}\/\d{1,2}|次日|第二天|周末|今晚|下周|下星期|周[一二三四五六日天]|星期[一二三四五六日天]|[上下这]个?月(?!后)|年底|年初|月底|月初|改天|以后|过几天|最近|后天|大后天|前天|农历|阴历|春节|[一二三四五六七八九十\d]+天后|[一二三四五六七八九十\d]+年后/.test(text))return {error:'这段话里的日期还不能可靠确定，请补充公历年月日和时间。'};
    const tokens=[...text.matchAll(tokenPattern)];
    let occurredOn=today;
    const dates=[];
    const resolve = token => {
      if(token==='今天')return today;
      if(token==='昨天')return addDays(today,-1);
      if(token==='明天')return addDays(today,1);
      if(token==='明年的今天')return addCalendarYears(today,1);
      if(token.endsWith('月后')){const n=chineseNumber(token.replace(/个?月后$/,''));if(!n||n>120)throw Error('请补充明确日期');return addCalendarMonths(dates[0]?.date||today,n);}
      let result=token;
      if(token.includes('年')) {const [y,m,d]=token.match(/\d+/g);result=`${y}-${pad(m)}-${pad(d)}`;}
      else if(token.includes('月')) {const [m,d]=token.match(/\d+/g);result=`${today.slice(0,4)}-${pad(m)}-${pad(d)}`;}
      if(!validDiaryDate(result))throw Error('日期无效，请补充有效的公历年月日。');return result;
    };
    for(const t of tokens)dates.push({token:t[0],date:resolve(t[0]),index:t.index});
    if(dates[0]&&!dates[0].token.endsWith('月后')&&dates[0].token!=='明年的今天')occurredOn=dates[0].date;
    const completedEvent=/(?:已经|已|刚刚)(?:全部|提前|按时)?(?:还钱|还款|归还|还清|完成)|(?:还钱|还款|归还|还清)[^，。；]{0,20}了(?:[。！!]|$)/.test(text);
    if(completedEvent) {
      if(/提醒|明天|明年的今天|月后|每年/.test(text))return {error:'这段话同时包含已完成事项和未来安排，请单独说明本次需要提醒的事项及日期。'};
      return {occurredOn,reminder:null,reminderNote:'这是已完成的事项，未设置提醒。'};
    }
    const wantsReminder=/约定|约好|答应|承诺|归还|还钱|还款|提醒|每年|个月后|月后|明年的今天/.test(text)||/明天.*(?:见|吃饭|还|去)/.test(text);
    if(!wantsReminder)return {occurredOn,reminder:null};
    const candidate=dates.at(-1);
    const commitment = text.search(/约定|约好|答应|承诺/);
    if(!candidate || (dates.length===1 && commitment>=candidate.index+candidate.token.length))return {error:'请补充约定或提醒的具体公历日期，例如“2026年12月9日9点”。'};
    if(dates.length>2)return {error:'这段话包含多个日期，请明确事件日期和本次提醒日期。'};
    let reminderDate=candidate.date;
    if(/每年/.test(text)&&reminderDate<today)reminderDate=addCalendarYears(reminderDate,1);
    if(/(?:一|三|\d+)刻|晚上\s*(?:12|十二)(?:点|时|:|：)/.test(text))return {error:'请用明确的公历日期和24小时制时间，例如09:15；晚上12点请明确是哪一天的00:00。'};
    let time='09:00';
    const times=[...text.matchAll(/(?:(上午|下午|晚上|中午|凌晨|早上)\s*)?(\d{1,2}|[一二两三四五六七八九十]+)(?::|：|点|时)(?:(\d{1,2}|[一二三四五六七八九十]+)分?|半)?/g)];
    if(times.length>1)return {error:'请明确本次提醒使用哪个时间。'};
    if(times.length) {const t=times[0];let hour=chineseNumber(t[2]);const minute=t[0].endsWith('半')?30:(t[3]?chineseNumber(t[3]):0);if(['下午','晚上','中午'].includes(t[1])&&hour<12)hour+=12;if(t[1]==='凌晨'&&hour===12)hour=0;time=`${pad(hour)}:${pad(minute)}`;}
    else if(/上午|下午|晚上|中午|凌晨|早上|傍晚|今晚/.test(text))return {error:'请补充具体几点几分；只有上午、下午或晚上还不足以确定提醒时间。'};
    const scheduledAt=dateTimeInZone(reminderDate,time,timezone);
    return {occurredOn,reminder:{scheduledAt,timezone,repeat:/每年/.test(text)?'yearly':'none'},reminderDate,reminderTime:time};
  }catch(error){return {error:error.message.includes('time zone')?'请提供有效的时区，再记录相对日期。':error.message};}
}
