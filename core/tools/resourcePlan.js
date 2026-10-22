// Pure, read-only verification. Quantities come from quoted user text, never
// model-supplied totals. Rendering is deliberately after the calculation gate.
const object = properties => ({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const string = {type:'string'};
const measure = {quantity:string,source:string};
export const RESOURCE_PLAN_SCHEMA = {anyOf:[{type:'null'},object({
  limit:object(measure),
  items:{type:'array',items:object({id:string,label:string,...measure,after:{type:'array',items:string}})},
  alternatives:{type:'array',items:object({omit:{type:'array',items:string}})}
})]};
const invalid=()=>{throw Object.assign(new Error('VOICE_RESOURCE_PLAN_INVALID'),{code:'VOICE_RESOURCE_PLAN_INVALID'});};
const norm=s=>String(s||'').replace(/\s+/g,'');
const units={秒:['分钟',1/60],分钟:['分钟',1],分:['分钟',1],小时:['分钟',60],元:['元',1],万元:['元',10000],克:['克',1],千克:['克',1000],公斤:['克',1000],毫升:['毫升',1],升:['毫升',1000],个:['个',1],件:['件',1],瓶:['瓶',1],台:['台',1],人:['人',1]};
function number(text){
  if(/^\d+(?:\.\d+)?$/.test(text))return Number(text);
  if(text==='半')return .5;
  if(text!=='零'&&!/^(?:[一二两三四五六七八九]千)?(?:零?[一二两三四五六七八九]百)?(?:零?[一二两三四五六七八九]?十)?(?:零?[一二两三四五六七八九])?$/.test(text))invalid();
  const digits={'零':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
  let total=0,pending=0;
  for(const c of text){if(c in digits)pending=digits[c];else if(c==='十'||c==='百'||c==='千'){total+=(pending||1)*({'十':10,'百':100,'千':1000}[c]);pending=0;}else invalid();}
  return total+pending;
}
const rounded=n=>Number(n.toFixed(8));
function exact(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))invalid();}
export function requiresResourcePlan(messages){
  const text=messages.filter(m=>m.role==='user').at(-1)?.content||'';
  const quantities=text.match(/(?:\d+(?:\.\d+)?|[零一二两三四五六七八九十百千]+|半)(?:万元|小时|分钟|千克|公斤|毫升|秒|元|克|升|个|件|瓶|台|人)/g)||[];
  const dimensions=new Set(quantities.map(q=>Object.keys(units).sort((a,b)=>b.length-a.length).find(u=>q.endsWith(u))).map(u=>units[u]?.[0]));
  return quantities.length>=3 && dimensions.size===1 && /上限|预算|限[\d零一二两三四五六七八九十]|只有|内.*(?:完成|做完)|够|来得及|依次完成|能.*完成/.test(text);
}
export function verifyResourcePlan(plan,messages,{checkCoverage=true}={}){
  exact(plan,['mode','limit','items','alternatives']);
  const originals=messages.filter(m=>m.role==='user'&&typeof m.content==='string').map(m=>norm(m.content));
  const anchored=s=>typeof s==='string'&&s.length>0&&s.length<=200&&originals.some(m=>m.includes(norm(s)));
  if(!['sum','schedule'].includes(plan.mode)||!Array.isArray(plan.items)||plan.items.length<1||plan.items.length>12||!Array.isArray(plan.alternatives)||plan.alternatives.length>3)invalid();
  function read(m){
    if(!anchored(m.source)||typeof m.quantity!=='string'||!norm(m.source).includes(norm(m.quantity)))invalid();
    const match=norm(m.quantity).match(/^(\d+(?:\.\d+)?|[零一二两三四五六七八九十百千]+|半)(万元|小时|分钟|千克|公斤|毫升|秒|分|元|克|升|个|件|瓶|台|人)$/);
    if(!match)invalid();
    const [unit,scale]=units[match[2]],value=rounded(number(match[1])*scale);
    if(!Number.isFinite(value)||value<0||value>1e9)invalid();
    return {value,unit};
  }
  exact(plan.limit,['quantity','source']);const limit=read(plan.limit);
  const tasks=new Map();
  for(const item of plan.items){
    exact(item,['id','label','quantity','source','after']);
    if(typeof item.id!=='string'||!/^[a-zA-Z0-9_-]{1,24}$/.test(item.id)||tasks.has(item.id)||typeof item.label!=='string'||item.label.length>24||!anchored(item.label)||!Array.isArray(item.after)||item.after.length>12||new Set(item.after).size!==item.after.length)invalid();
    const amount=read(item);if(amount.unit!==limit.unit)invalid();
    tasks.set(item.id,{...item,value:amount.value});
  }
  // Catch omitted explicit amounts in the latest self-contained statement.
  // A later numeric correction supersedes this completeness check rather than
  // forcing stale values back into the plan. Semantic interpretation is not proof.
  const statement=[...originals].reverse().find(text=>/(?:\d|[零一二两三四五六七八九十百千半])(?:万元|小时|分钟|千克|公斤|毫升|秒|元|克|升|个|件|瓶|台|人)/.test(text))||'';
  const mentioned=statement.match(/(?:\d+(?:\.\d+)?|[零一二两三四五六七八九十百千]+|半)(?:万元|小时|分钟|千克|公斤|毫升|秒|元|克|升|个|件|瓶|台|人)/g)||[];
  const represented=new Set([norm(plan.limit.quantity),...plan.items.map(i=>norm(i.quantity))]);
  if(checkCoverage&&mentioned.length>=3&&mentioned.some(q=>!represented.has(q)))throw Object.assign(new Error('VOICE_RESOURCE_PLAN_INCOMPLETE'),{code:'VOICE_RESOURCE_PLAN_INCOMPLETE'});
  if(plan.mode==='schedule'&&limit.unit!=='分钟')invalid();
  for(const item of tasks.values())if(item.after.some(id=>!tasks.has(id)||id===item.id))invalid();
  if(plan.mode==='sum'&&[...tasks.values()].some(i=>i.after.length))invalid();
  function total(omit){
    const memo=new Map(),visiting=new Set();
    function finish(id){
      if(omit.has(id))return 0;
      if(visiting.has(id))invalid();if(memo.has(id))return memo.get(id);
      visiting.add(id);const item=tasks.get(id);
      const end=item.value+Math.max(0,...item.after.map(finish));
      visiting.delete(id);memo.set(id,end);return end;
    }
    return rounded(plan.mode==='sum'?[...tasks.values()].filter(t=>!omit.has(t.id)).reduce((n,t)=>n+t.value,0):Math.max(0,...[...tasks.keys()].map(finish)));
  }
  const required=total(new Set()),difference=rounded(required-limit.value);
  const alternatives=plan.alternatives.map(option=>{
    exact(option,['omit']);if(!Array.isArray(option.omit)||option.omit.length<1||option.omit.length>=tasks.size||new Set(option.omit).size!==option.omit.length||option.omit.some(id=>!tasks.has(id)))invalid();
    const omit=new Set(option.omit),labels=option.omit.map(id=>tasks.get(id).label);
    const broken=[...tasks.values()].some(t=>!omit.has(t.id)&&t.after.some(id=>omit.has(id)));
    return {labels,broken,total:broken?null:total(omit)};
  });
  const u=limit.unit,verb=u==='分钟'?'用时':'用量';
  let content=`按你提供的条件，全部完成的${verb}为${required}${u}，上限${limit.value}${u}，`+(difference>0?`超出${difference}${u}，原条件下无法全部完成。`:`可以满足，余量${rounded(-difference)}${u}。`);
  for(const option of alternatives){
    const label=option.labels.join('、');
    if(option.broken){content+=`不做${label}会破坏其余任务的前置条件，不能作为可行方案。`;continue;}
    const gap=rounded(option.total-limit.value);
    content+=gap>0?`即使不做${label}，仍需${option.total}${u}，仍超出${gap}${u}。`:`若允许不完成${label}，其余任务需${option.total}${u}，在上限内；这是调整后的目标，并未完成全部任务。`;
  }
  if(difference>0&&!alternatives.some(a=>!a.broken&&a.total<=limit.value))content+=`需要增加至少${difference}${u}的可用额度，或调整任务后重新核算。`;
  return {content,required,limit:limit.value,unit:u,difference,alternatives};
}
export const resourcePlanRegistry=Object.freeze({verify_resource_plan:Object.freeze({execute:verifyResourcePlan})});

// This state belongs only to the active voice session. It is not permanent memory.
export const RESOURCE_UPDATE_SCHEMA={anyOf:[{type:'null'},object({operation:{type:'string',enum:['reuse','omit','quantity','limit']},taskIds:{type:'array',items:string},quantity:string,source:string})]};
export function saveResourceState(plan){
  return {plan:structuredClone(plan),sources:[plan.limit.source,...plan.items.flatMap(i=>[i.source,i.label])]};
}
export function updateResourceState(state,update,messages){
  exact(update,['operation','taskIds','quantity','source']);
  const latest=messages.filter(m=>m.role==='user').at(-1)?.content||'';
  if(!state?.plan||!Array.isArray(state.sources)||typeof update.source!=='string'||!update.source.trim()||!norm(latest).includes(norm(update.source))||!Array.isArray(update.taskIds)||new Set(update.taskIds).size!==update.taskIds.length||typeof update.quantity!=='string')invalid();
  const plan=structuredClone(state.plan),ids=new Set(plan.items.map(i=>i.id));
  if(update.taskIds.some(id=>!ids.has(id)))invalid();
  if(update.operation==='reuse'){
    if(update.taskIds.length||update.quantity)invalid();
  }else if(update.operation==='omit'){
    if(!update.taskIds.length||update.quantity||update.taskIds.some(id=>!norm(update.source).includes(norm(plan.items.find(i=>i.id===id).label))))invalid();
    plan.alternatives=[{omit:[...update.taskIds]}];
  }else if(update.operation==='quantity'||update.operation==='limit'){
    if(!update.quantity||!norm(update.source).includes(norm(update.quantity)))invalid();
    if(update.operation==='limit'){
      if(update.taskIds.length)invalid();plan.limit={quantity:update.quantity,source:update.source};
    }else{
      if(update.taskIds.length!==1)invalid();const item=plan.items.find(i=>i.id===update.taskIds[0]);
      if(!norm(update.source).includes(norm(item.label))){const explicit=exactQuantityChange(plan,latest);if(!explicit||explicit.id!==item.id||norm(explicit.quantity)!==norm(update.quantity))invalid();}
      item.quantity=update.quantity;item.source=update.source;
    }
  }else invalid();
  const provenance=[{role:'user',content:state.sources.join('；')},{role:'user',content:latest}];
  // Update operations preserve the full verified task set. Old quoted wording
  // remains provenance, not an instruction to restore superseded quantities.
  const checked=verifyResourcePlan(plan,provenance,{checkCoverage:false});
  return {...checked,state:saveResourceState(plan)};
}

// The model describes quantities and task dependencies, never the arithmetic
// operator. Derive the operator from the supplied unit, then validate every
// quantity, source, dependency and bound using the canonical contract.
export function compileResourcePlan(raw,messages){
  exact(raw,['limit','items','alternatives']);
  const duration=/(?:小时|分钟|秒|分)$/.test(norm(raw.limit?.quantity));
  const plan={...structuredClone(raw),mode:duration?'schedule':'sum'};
  const checked=verifyResourcePlan(plan,messages);
  return {...checked,state:saveResourceState(plan)};
}

// Only ids cross the model boundary. Quoted values and display labels are
// extracted locally, so a paraphrase cannot alter or invalidate numeric facts.
export function extractResourceCandidates(messages){
  const text=messages.filter(m=>m.role==='user'&&typeof m.content==='string').at(-1)?.content||'';
  const pattern=/(?:\d+(?:\.\d+)?|[零一二两三四五六七八九十百千]+|半)(?:万元|小时|分钟|千克|公斤|毫升|秒|元|克|升|个|件|瓶|台|人)/g;
  let end=0;const candidates=[];
  for(const match of text.matchAll(pattern)){
    if(candidates.length>=16)break;
    const prefix=text.slice(end,match.index).split(/[，。；、！？!?;\n]/).at(-1).trim().slice(-80);
    const quantity=match[0],source=prefix+quantity;
    const label=prefix.replace(/(?:需要|耗时|用时|花费|共需|需|用|为|是)$/,'').trim().slice(-24)||source;
    candidates.push({id:`q${candidates.length+1}`,quantity,source,label});end=match.index+quantity.length;
  }
  return candidates;
}
export function resourceSelectionSchema(candidates,{allowAlternatives=true}={}){
  if(candidates.length<2)return {type:'null'};
  const id={type:'string',enum:candidates.map(c=>c.id)};
  const duration=candidates.every(c=>/(?:小时|分钟|秒|分)$/.test(norm(c.quantity)));
  // Precedence is meaningful only for time. Other resource types cannot
  // express an edge in the model contract; validation remains fail-closed.
  const after={type:'array',items:id,...(duration?{}:{maxItems:0})};
  return object({limitId:id,dependencies:object(Object.fromEntries(candidates.map(c=>[c.id,after]))),alternatives:{type:'array',maxItems:allowAlternatives?3:0,items:object({omit:{type:'array',minItems:1,items:id}})}});
}
export function resourceChangeSchema(state,candidates){
  if(!state)return {type:'null'};
  const tasks={type:'array',items:{type:'string',enum:state.items.map(i=>i.id)}};
  const variant=(operation,taskIds,quantityId)=>object({operation:{type:'string',enum:[operation]},taskIds,quantityId:{type:'string',enum:quantityId}});
  const choices=[{type:'null'},variant('reuse',{...tasks,maxItems:0},[''])];
  if(state.items.length>1)choices.push(variant('omit',{...tasks,minItems:1,maxItems:state.items.length-1},['']));
  if(candidates.length){
    const quantities=candidates.map(c=>c.id);
    choices.push(variant('quantity',{...tasks,minItems:1,maxItems:1},quantities));
    choices.push(variant('limit',{...tasks,maxItems:0},quantities));
  }
  return {anyOf:choices};
}
export function resolveResourceSelection(selection,candidates,messages){
  if(selection&&Object.hasOwn(selection,'dependencies')){
    exact(selection,['limitId','dependencies','alternatives']);
    exact(selection.dependencies,candidates.map(c=>c.id));
    if(!candidates.some(c=>c.id===selection.limitId)||!Array.isArray(selection.dependencies[selection.limitId])||selection.dependencies[selection.limitId].length)invalid();
    selection={limitId:selection.limitId,items:candidates.filter(c=>c.id!==selection.limitId).map(c=>({id:c.id,after:selection.dependencies[c.id]})),alternatives:selection.alternatives};
  }
  exact(selection,['limitId','items','alternatives']);
  const byId=new Map(candidates.map(c=>[c.id,c])),limit=byId.get(selection.limitId);
  if(!limit||!Array.isArray(selection.items)||selection.items.some(i=>i.id===limit.id)||new Set(selection.items.map(i=>i.id)).size!==selection.items.length)invalid();
  const items=selection.items.map(i=>{exact(i,['id','after']);const c=byId.get(i.id);if(!c)invalid();return {...c,after:i.after};});
  return compileResourcePlan({limit:{quantity:limit.quantity,source:limit.source},items,alternatives:selection.alternatives},messages);
}
export function resolveResourceChange(state,change,candidates,messages){
  exact(change,['operation','taskIds','quantityId']);
  const measure=candidates.find(c=>c.id===change.quantityId);
  if(['quantity','limit'].includes(change.operation)?!measure:change.quantityId!=='')invalid();
  return updateResourceState(state,{operation:change.operation,taskIds:change.taskIds,quantity:measure?.quantity||'',source:messages.filter(m=>m.role==='user').at(-1)?.content||''},messages);
}

// Only a complete, explicit one-field command can bypass model interpretation.
// Anything conditional, ambiguous or compound remains on the normal path.
function exactQuantityChange(plan,latest){
  if(latest.length>200)return null;
  const quantity='((?:\\d+(?:\\.\\d+)?|[零一二两三四五六七八九十百千]+|半)(?:万元|小时|分钟|千克|公斤|毫升|秒|元|克|升|个|件|瓶|台|人))';
  const match=(item,name)=>{
    const label=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const pattern=new RegExp('^(?:请)?(?:把)?'+label+'\\s*(?:改成|改为|调整为)\\s*'+quantity+'(?:[，,。]?(?:其他|其它)(?:条件)?不变)?[。！!]?$', 'u');
    const found=pattern.exec(latest);return found?{id:item.id,quantity:found[1]}:null;
  };
  const direct=plan.items.map(item=>match(item,item.label)).filter(Boolean);
  if(direct.length)return direct.length===1?direct[0]:null;
  // Only the explicit command may use an unambiguous suffix after a temporal
  // connector. Preserve the stored label and original source verbatim.
  const aliases=plan.items.map(item=>{const alias=item.label.replace(/^.{1,40}(?:完后|完成后|结束后|才能)/u,'').replace(/^(?:(?:请)?先|然后|之后|再|和|与|以及|同时)+/u,'');return alias!==item.label&&alias.length>=2?match(item,alias):null;}).filter(Boolean);
  return aliases.length===1?aliases[0]:null;
}
export function tryExactResourceUpdate(state,messages){
  if(!state?.plan?.items)return null;
  const latest=messages.filter(m=>m.role==='user'&&typeof m.content==='string').at(-1)?.content.trim()||'';
  const change=exactQuantityChange(state.plan,latest);if(!change)return null;
  try{return updateResourceState(state,{operation:'quantity',taskIds:[change.id],quantity:change.quantity,source:latest},messages);}
  catch(error){if(error.code==='VOICE_RESOURCE_PLAN_INVALID')return null;throw error;}
}
