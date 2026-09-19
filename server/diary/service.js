import { randomUUID } from 'node:crypto';
import { diaryError } from './repository.js';
import { assertTimezone, localDateKey, addCalendarDays } from '../tasks/time.js';

function ownerId(value) {if(typeof value!=='string'||!value.trim())throw diaryError('AUTH_REQUIRED',401);return value.trim();}
function dateKey(value) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw diaryError('DIARY_DATE_INVALID');
  return value;
}
function zone(value) {try{return assertTimezone(value);}catch{throw diaryError('DIARY_TIMEZONE_INVALID');}}
function instant(value) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))throw diaryError('DIARY_SCHEDULE_INVALID');
  dateKey(value.slice(0,10));
  const [hour,minute,second='0']=value.slice(11).split(/[TZ+\-:]/);
  if(Number(hour)>23||Number(minute)>59||Number(second)>59)throw diaryError('DIARY_SCHEDULE_INVALID');
  if(!Number.isFinite(Date.parse(value)))throw diaryError('DIARY_SCHEDULE_INVALID');return new Date(value).toISOString();
}
function text(value,max,code,empty=false){if(typeof value!=='string'||(!empty&&!value.trim())||value.length>max)throw diaryError(code);return value;}
function source(value){
  if(value===undefined)return {kind:'manual'};
  if(!value||!['manual','conversation'].includes(value.kind))throw diaryError('DIARY_SOURCE_INVALID');
  const result={kind:value.kind};
  for(const key of ['conversationId','messageId'])if(value[key]!==undefined)result[key]=text(value[key],200,'DIARY_SOURCE_INVALID');
  return result;
}
function reminderInput(value){
  if(value===null||value===undefined)return null;
  if(typeof value!=='object'||Array.isArray(value))throw diaryError('DIARY_REMINDER_INVALID');
  const repeat=value.repeat??'none';if(!['none','yearly'].includes(repeat))throw diaryError('DIARY_REPEAT_INVALID');
  return {scheduledAt:instant(value.scheduledAt),timezone:zone(value.timezone),repeat};
}
function localParts(value,timezone) {
  return {...Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value)).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)])),millisecond:new Date(value).getUTCMilliseconds()};
}
function localInstant(parts,timezone) {
  const desired=Date.UTC(parts.year,parts.month-1,parts.day,parts.hour,parts.minute,parts.second,parts.millisecond||0);
  let result=desired;
  for(let i=0;i<5;i++) {const p=localParts(result,timezone);const observed=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second,p.millisecond);const diff=desired-observed;if(!diff)return new Date(result).toISOString();result+=diff;}
  throw diaryError('DIARY_TIME_AMBIGUOUS');
}
function publicEntry(entry){return {...entry,reminder:entry.reminder ? Object.fromEntries(Object.entries(entry.reminder).filter(([key])=>key!=='anchor')):null};}
function checkRevision(entry,value){if(!Number.isSafeInteger(value)||value<1)throw diaryError('DIARY_REVISION_REQUIRED');if(entry.revision!==value)throw diaryError('DIARY_REVISION_CONFLICT',409);}

export class DiaryService {
  constructor({repository,tasksService,clock=()=>new Date()}){this.repository=repository;this.tasksService=tasksService;this.clock=clock;}
  current(owner,id) {
    const entry=this.repository.getForOwner(owner,id);if(!entry)throw diaryError('DIARY_NOT_FOUND',404);
    if(entry.reminder){const task=this.tasksService.repository.getForOwner(owner,entry.reminder.taskId);if(task)entry.reminder={...entry.reminder,status:task.status,scheduledAt:task.scheduledAt,timezone:task.timezone};else entry.reminder.status='cancelled';}
    return entry;
  }
  get(owner,id){return publicEntry(this.current(ownerId(owner),id));}
  list(owner,{date,q}={}){
    owner=ownerId(owner);if(date)dateKey(date);if(q!==undefined&&q!==null)text(q,1000,'DIARY_QUERY_INVALID',true);
    const query=(q||'').toLocaleLowerCase();return this.repository.listForOwner(owner,date||null).map(e=>this.current(owner,e.id)).filter(e=>!query||`${e.title}\n${e.body}`.toLocaleLowerCase().includes(query)).map(publicEntry);
  }
  makeReminder(owner,id,input,old=null){
    if(!input){if(old)this.requireTask(this.tasksService.update(owner,old.taskId,{status:'cancelled'}));return null;}
    const taskInput={title:'日记约定提醒',description:null,scheduledAt:input.scheduledAt,timezone:input.timezone,status:'pending'};
    const task=old ? this.requireTask(this.tasksService.update(owner,old.taskId,taskInput)):this.tasksService.create(owner,taskInput);
    this.repository.linkTask(owner,id,task.id);
    const sameAnchor=old&&old.repeat===input.repeat&&old.scheduledAt===input.scheduledAt&&old.timezone===input.timezone;
    return {...input,taskId:task.id,status:task.status,anchor:sameAnchor?old.anchor:localParts(input.scheduledAt,input.timezone)};
  }
  requireTask(task){if(!task)throw diaryError('DIARY_REMINDER_TASK_MISSING',409);return task;}
  create(owner,input={}) {
    owner=ownerId(owner);const key=text(input.idempotencyKey,200,'DIARY_IDEMPOTENCY_REQUIRED');
    const normalized={title:text(input.title??'',200,'DIARY_TITLE_INVALID',true),body:text(input.body,30000,'DIARY_BODY_INVALID'),occurredOn:dateKey(input.occurredOn),source:source(input.source),reminder:reminderInput(input.reminder)};
    const hash=this.repository.contentHash(normalized);
    return this.repository.transaction(()=>{
      const request=this.repository.request(owner,key);
      if(request){if(request.content_hash!==hash)throw diaryError('DIARY_IDEMPOTENCY_CONFLICT',409);if(!this.repository.getForOwner(owner,request.entry_id))throw diaryError('DIARY_IDEMPOTENCY_DELETED',409);return this.get(owner,request.entry_id);}
      const now=this.clock().toISOString();const id=`diary_${randomUUID()}`;
      const entry={...normalized,id,revision:1,createdAt:now,updatedAt:now,reminder:this.makeReminder(owner,id,normalized.reminder)};
      this.repository.insert(owner,entry);this.repository.saveRequest(owner,key,hash,id);return publicEntry(entry);
    });
  }
  update(owner,id,input={}) {
    owner=ownerId(owner);
    return this.repository.transaction(()=>{
      const old=this.current(owner,id);checkRevision(old,input.revision);
      const entry={...old,title:input.title===undefined?old.title:text(input.title,200,'DIARY_TITLE_INVALID',true),body:input.body===undefined?old.body:text(input.body,30000,'DIARY_BODY_INVALID'),occurredOn:input.occurredOn===undefined?old.occurredOn:dateKey(input.occurredOn),revision:old.revision+1,updatedAt:this.clock().toISOString()};
      if(input.reminder!==undefined){const normalized=reminderInput(input.reminder);const unchanged=normalized&&old.reminder&&normalized.scheduledAt===old.reminder.scheduledAt&&normalized.timezone===old.reminder.timezone&&normalized.repeat===old.reminder.repeat;entry.reminder=unchanged?old.reminder:this.makeReminder(owner,id,normalized,old.reminder);}
      this.repository.update(owner,entry,old.revision);return publicEntry(entry);
    });
  }
  delete(owner,id,input={}) {
    owner=ownerId(owner);if(input.confirmed!==true)throw diaryError('DIARY_DELETE_CONFIRMATION_REQUIRED');
    return this.repository.transaction(()=>{const entry=this.current(owner,id);checkRevision(entry,input.revision);if(entry.reminder)this.requireTask(this.tasksService.update(owner,entry.reminder.taskId,{status:'cancelled'}));return this.repository.delete(owner,entry);});
  }
  reminderAction(owner,id,input={}) {
    owner=ownerId(owner);
    return this.repository.transaction(()=>{
      const old=this.current(owner,id);checkRevision(old,input.revision);if(!old.reminder||old.reminder.status!=='pending')throw diaryError('DIARY_REMINDER_NOT_PENDING',409);
      let reminder={...old.reminder};
      if(input.action==='snooze') {reminder.scheduledAt=instant(input.scheduledAt);if(Date.parse(reminder.scheduledAt)<=this.clock().getTime())throw diaryError('DIARY_SNOOZE_NOT_FUTURE');this.requireTask(this.tasksService.update(owner,reminder.taskId,{scheduledAt:reminder.scheduledAt,status:'pending'}));}
      else if(input.action==='complete') {
        this.requireTask(this.tasksService.complete(owner,reminder.taskId));
        if(reminder.repeat==='yearly') {
          const anchor=reminder.anchor||localParts(reminder.scheduledAt,reminder.timezone);
          let year=localParts(reminder.scheduledAt,reminder.timezone).year+1;let next;
          do{const day=Math.min(anchor.day,new Date(Date.UTC(year,anchor.month,0)).getUTCDate());next=localInstant({...anchor,year,day},reminder.timezone);year++;}while(Date.parse(next)<=this.clock().getTime());
          const task=this.tasksService.create(owner,{title:'日记约定提醒',description:null,scheduledAt:next,timezone:reminder.timezone},{idempotencyKey:`diary:${id}:yearly:revision:${old.revision}`});
          this.repository.linkTask(owner,id,task.id);
          reminder={...reminder,taskId:task.id,scheduledAt:next,status:'pending',anchor};
        } else reminder.status='completed';
      }else throw diaryError('DIARY_REMINDER_ACTION_INVALID');
      const entry={...old,reminder,revision:old.revision+1,updatedAt:this.clock().toISOString()};this.repository.update(owner,entry,old.revision);return publicEntry(entry);
    });
  }
  reminders(owner,{timezone='Asia/Shanghai'}={}) {
    owner=ownerId(owner);timezone=zone(timezone);const tomorrow=addCalendarDays(localDateKey(this.clock(),timezone),1);
    return this.list(owner).filter(e=>e.reminder?.status==='pending'&&localDateKey(e.reminder.scheduledAt,timezone)<=tomorrow).map(e=>({...this.tasksService.repository.getForOwner(owner,e.reminder.taskId),title:e.title.trim()||e.body.slice(0,40),diaryId:e.id,diaryRevision:e.revision,source:'diary'})).sort((a,b)=>a.scheduledAt.localeCompare(b.scheduledAt));
  }
  diaryIdForTask(owner,taskId){return this.repository.diaryIdForTask(ownerId(owner),taskId);}
  export(owner){return {version:'diary-v1',exportedAt:this.clock().toISOString(),entries:this.list(owner)};}
  deleteAllForOwner(owner) {
    owner=ownerId(owner);
    return this.repository.transaction(()=>{
      const entries=this.repository.listForOwner(owner);
      for(const entry of entries)if(entry.reminder)this.tasksService.update(owner,entry.reminder.taskId,{status:'cancelled'});
      const removed=Number(this.repository.database.prepare('DELETE FROM diary_entries WHERE user_id=?').run(owner).changes);
      this.repository.database.prepare('DELETE FROM diary_requests WHERE user_id=?').run(owner);
      this.repository.database.prepare('DELETE FROM diary_audit WHERE user_id=?').run(owner);
      this.repository.database.prepare('DELETE FROM diary_task_links WHERE user_id=?').run(owner);
      return removed;
    });
  }
}
