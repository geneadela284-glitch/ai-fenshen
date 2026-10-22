import {createHmac,timingSafeEqual} from 'node:crypto';
import {normalizeChineseMoney} from './chineseMoneyNormalizer.js';
import {isAllowedCategory} from './constants.js';
import {planDeterministicFinanceCreate,extractAmountMinorEvidence,classifyFinanceType,classifyCategory,parseFinanceRelation} from './service.js';
import {evaluateFinanceToolPlan} from './financeToolContract.js';
import {localDateKey} from './time.js';
import {resolveDateRange} from '../../core/trust/dateRangeResolver.js';
import {renderMonthlyFinanceExcel} from './monthlyReportExcel.js';
import {renderMonthlyFinancePdf} from './monthlyReportPdf.js';

const SUBTYPES={loan_out:'expense',loan_in:'income',repayment_in:'income',repayment_out:'expense'};
function invalid(code='FINANCE_INPUT_INVALID'){throw Object.assign(new Error(code),{code});}
function sign(runtime,ownerId,kind,data){const raw=Buffer.from(JSON.stringify({ownerId,kind,data,expires:runtime.clock().getTime()+86400000})).toString('base64url');return `${raw}.${createHmac('sha256',runtime.repository.cursorSecret).update(raw).digest('base64url')}`;}
function verify(runtime,ownerId,kind,token){
 try{const [raw,signature,...extra]=String(token||'').split('.');if(extra.length)invalid();const expected=createHmac('sha256',runtime.repository.cursorSecret).update(raw).digest(),actual=Buffer.from(signature,'base64url');if(actual.length!==expected.length||!timingSafeEqual(actual,expected))invalid();const p=JSON.parse(Buffer.from(raw,'base64url'));if(p.ownerId!==ownerId||p.kind!==kind||p.expires<runtime.clock().getTime())invalid();return p.data;}catch{invalid('FINANCE_DRAFT_EXPIRED');}
}
function preview(runtime,ownerId,input){
 const timezone=runtime.timezone||'Asia/Shanghai',now=runtime.clock();
 let draft;
 if(input.text!==undefined){
  const text=String(input.text||'').trim();if(!text||text.length>2000)invalid();
  const previous=input.previousToken?verify(runtime,ownerId,'context',input.previousToken):null;
  if(/(?:美元|美金|欧元|港币|日元|人民币以外)/u.test(text))return {state:'clarify',question:'当前账本仅支持人民币，请核对币种。'};
  if(/转账|转到|转出|转给(?!我)/u.test(text)&&!/[借还]/u.test(text))return {state:'clarify',question:'这笔涉及转账。当前没有账户间转账功能，请回到主对话核对用途，不会按消费保存。'};
  if(/分析|总结|统计|查询|导出|多少|几笔|哪些|修改|改成|改为|删除|撤销|不要记|不记|别记/u.test(text))return {state:'clarify',question:'这里用于新增一笔账。查账或修改请使用账单页面或已有主对话入口。'};
  const relation=parseFinanceRelation(text);
  const amountSource=(relation?.counterparty?text.replace(relation.counterparty,''):text).replace(/(?:\d{4}年)?\d{1,2}月\d{1,2}日/gu,'');
  const evidence=extractAmountMinorEvidence(amountSource,{allowUnitless:true});
  const direction=classifyFinanceType(text)||previous?.direction;
  const category=classifyCategory(text,direction);
  const dateRange=resolveDateRange(text,{timezone,now});
  const sourceText=previous?.sourceText?`${previous.sourceText}；${text}`:text;
  if(sourceText.length>6000)invalid();
  const slots={...previous,sourceText,
   amountMinor:evidence.status==='resolved'?evidence.amountMinor:previous?.amountMinor,
   amountText:evidence.status==='resolved'?evidence.amountText:previous?.amountText,
   direction,category:!['其他','其他收入'].includes(category)?category:(isAllowedCategory(direction,previous?.category)?previous.category:category),
   subtype:relation?.status==='clear'?relation.subtype:previous?.subtype,
   counterparty:relation?.counterparty||previous?.counterparty,
   relationAmbiguous:relation?.status==='ambiguous'||(previous?.relationAmbiguous&&relation?.status!=='clear'),
   occurredExpression:dateRange.dateStatus!=='ABSENT'?text:previous?.occurredExpression,
   datePending:dateRange.dateStatus==='ABSENT'?previous?.datePending:dateRange.dateStatus!=='RESOLVED'||Date.parse(dateRange.endAt)-Date.parse(dateRange.startAt)!==86400000};
  const ask=question=>({state:'clarify',question,slots,contextToken:sign(runtime,ownerId,'context',slots)});
  if(evidence.status==='ambiguous'||evidence.status==='invalid')return ask('请确认这一笔大于0、最多两位小数的准确金额。');
  if(slots.relationAmbiguous)return ask(`请确认是${slots.counterparty||'对方'}借给你，还是你借给${slots.counterparty||'对方'}？`);
  if(slots.datePending)return ask('这笔账发生在哪一天？请补充具体日期。');
  if(!slots.amountMinor)return ask('金额是多少？');
  if(!slots.direction)return ask('这是收入还是支出？');
  let plan=(evidence.status==='resolved'||relation)?planDeterministicFinanceCreate(text,{timezone,now,previousSlots:slots}):null;
  if(!plan)plan=planDeterministicFinanceCreate(`${slots.direction==='income'?'收入':'支出'}${(slots.amountMinor/100).toFixed(2)}元`,{timezone,now,previousSlots:slots});
  plan.category=slots.category;
  plan.transaction_candidate.occurred_expression=slots.occurredExpression||null;
  // Bind current evidence to the user's exact reply; earlier fields come only
  // from the owner-bound, signed clarification context.
  plan.source_spans=[{text,start:0,end:text.length}];
  const contract=evaluateFinanceToolPlan(plan,{message:text,timezone,now,ownerId});
  if(contract.decision!=='ACCEPT')return ask(contract.question||'请核对这笔账的金额与类型。');
  const accepted=contract.plan;
  draft={type:accepted.type,amountMinor:accepted.amount_minor,category:accepted.category,occurredAt:accepted.occurred_at,timezone,currency:'CNY',counterparty:accepted.counterparty||null,subtype:accepted.changes?.subtype||null,note:slots.sourceText};
 }else{
  const amount=normalizeChineseMoney(input.amount);if(amount.status!=='resolved'||amount.amountMinor<=0)invalid();
  const type=String(input.type||''),category=String(input.category||'');if(!isAllowedCategory(type,category))invalid();
  const date=String(input.date||localDateKey(now,timezone));if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)invalid();
  const range=resolveDateRange(`${Number(date.slice(0,4))}年${Number(date.slice(5,7))}月${Number(date.slice(8,10))}日`,{timezone,now});if(range.requiresConfirmation||!range.startAt)invalid();
  const subtype=input.subtype||null;if(subtype&&SUBTYPES[subtype]!==type)invalid();
  const counterparty=String(input.counterparty||'').trim()||null;if(subtype&&!counterparty)invalid();
  if(String(input.note||'').length>2000||String(counterparty||'').length>100)invalid();
  draft={type,amountMinor:amount.amountMinor,category,occurredAt:range.startAt,timezone,currency:'CNY',subtype,counterparty,note:String(input.note||'').trim()||null};
 }
 if(!isAllowedCategory(draft.type,draft.category))invalid();
 return{state:'review',draft,token:sign(runtime,ownerId,'draft',draft)};
}
export async function handleFinanceExperienceApi({req,res,url,user,runtime,readJson,sendJson,historyQuery,privacyLifecycle}){
 const route=url.pathname;if(!['/api/finance/experience','/api/finance/preview','/api/finance/confirm','/api/finance/reports/range'].includes(route))return false;
 if(!runtime.repository.f201Enabled){sendJson(res,409,{ok:false,code:'FINANCE_EXPERIENCE_UNAVAILABLE',message:'当前账本版本尚未启用此页面，请使用原财务入口。'});return true;}
 try{
  if(route==='/api/finance/experience'&&req.method==='GET'){const {snapshot,...result}=runtime.repository.readExperienceSnapshot({ownerId:user.id,...historyQuery});sendJson(res,200,{ok:true,...result});return true;}
  if(route==='/api/finance/preview'&&req.method==='POST'){sendJson(res,200,{ok:true,...preview(runtime,user.id,await readJson(req))});return true;}
  if(route==='/api/finance/confirm'&&req.method==='POST'){
   const body=await readJson(req);if(body.confirmed!==true)invalid('FINANCE_CONFIRMATION_REQUIRED');const draft=verify(runtime,user.id,'draft',body.token),key=String(req.headers['idempotency-key']||'').trim();if(!key||key.length>150)invalid();
   const entry=runtime.repository.create({...draft,ownerId:user.id,mutationRequestId:key,clientRequestId:key,sourceMessageId:`finance-reviewed:${key}`});
   if(!entry?.id||entry.clientRequestId!==key)throw Error('FINANCE_PERSISTENCE_UNCONFIRMED');sendJson(res,200,{ok:true,state:'saved',entry});return true;
  }
  if(route==='/api/finance/reports/range'&&req.method==='GET'){
   const format=url.searchParams.get('format');if(!['pdf','xlsx'].includes(format))invalid();const {snapshot}=runtime.repository.readExperienceSnapshot({ownerId:user.id,...historyQuery},{report:true});
   const buffer=await(format==='pdf'?renderMonthlyFinancePdf(snapshot):renderMonthlyFinanceExcel(snapshot));const filename=`${snapshot.title}.${format}`;
   privacyLifecycle?.recordGeneratedReport?.({ownerId:user.id,reportType:snapshot.reportType,format,periodStart:snapshot.period.startAt,periodEnd:snapshot.period.endAt});
   res.writeHead(200,{'Content-Type':format==='pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Length':String(buffer.length),'Content-Disposition':`attachment; filename="finance-report.${format}"; filename*=UTF-8''${encodeURIComponent(filename)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Finance-Count':String(snapshot.entryCount),'X-Finance-Income-Minor':String(snapshot.totals.incomeMinor),'X-Finance-Expense-Minor':String(snapshot.totals.expenseMinor)});res.end(buffer);return true;
  }
  sendJson(res,405,{ok:false,message:'操作方式无效。'});return true;
 }catch(error){
  const code=String(error.code||'');const status=code==='FINANCE_IDEMPOTENCY_CONFLICT'?409:/^FINANCE_(INPUT|DRAFT|CONFIRMATION|HISTORY)/.test(code)?400:503;
  sendJson(res,status,{ok:false,code:status===503?'FINANCE_UNAVAILABLE':code,message:code==='FINANCE_DRAFT_EXPIRED'?'草稿已失效，请重新核对后保存。':status===400?'请核对金额、日期和筛选条件。':'财务操作未完成，请稍后重试。'});return true;
 }
}
