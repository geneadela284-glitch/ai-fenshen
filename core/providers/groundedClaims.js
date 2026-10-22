// Provenance and coverage checks, not a semantic entailment proof.
// The model still must judge whether the source supports the claim and its date.
const fail=()=>{throw Object.assign(new Error('VOICE_ANSWER_EVIDENCE_MISMATCH'),{code:'VOICE_ANSWER_EVIDENCE_MISMATCH'});};
const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
export function groundedClaimsSchema(passages,{current=false}={}){
 const schema={type:'object',additionalProperties:false,required:['verdict','claims','missing'],properties:{
  verdict:{type:'string',enum:['accept','revise','insufficient']},
  claims:{type:'array',maxItems:3,items:{type:'object',additionalProperties:false,required:['text','passageId','timePassageId'],properties:{
   text:{type:'string',description:'一个直接回答问题的原子事实；不要把多个对象或独立结论混在同一条。'},
   passageId:{type:'string',enum:passages.length?passages.map(p=>p.id):['unused']},
   timePassageId:{type:'null'}
  }}},missing:{anyOf:[{type:'string'},{type:'null'}],description:'仅证据不足时说明缺什么依据，不写未证实事实；其他情况填null。'}
 }};
 schema.properties.claims.items.properties.timePassageId=current
  ?{type:'string',enum:passages.length?passages.map(p=>p.id):['unused'],description:'同一事实中支持所问时间和实际状态的片段编号；页面更新时间或预告不能证明当前状态。'}
  :{type:'null'};
 const success={...schema,properties:{...schema.properties,verdict:{type:'string',enum:['accept','revise']},missing:{type:'null'},claims:{...schema.properties.claims,minItems:1}}};
 const insufficient={...schema,properties:{...schema.properties,verdict:{type:'string',enum:['insufficient']},claims:{...schema.properties.claims,maxItems:0},missing:{type:'string',description:'只说明缺少的依据，不提供未经证实的事实。'}}};
 return {type:'object',additionalProperties:false,required:['decision'],properties:{decision:{anyOf:[success,insufficient]}}};
}
export function normalizeGroundedClaims(value,passages,{current=false}={}){
 if(!exactKeys(value,['verdict','claims','missing'])||!['accept','revise','insufficient'].includes(value.verdict)||!Array.isArray(value.claims)||value.claims.length>3)fail();
 if(value.verdict==='insufficient'){
  if(value.claims.length||typeof value.missing!=='string'||!value.missing.trim()||value.missing.length>400)fail();
  return {verdict:value.verdict,answer:value.missing.trim(),citations:[],resourcePlan:null,resourceUpdate:null};
 }
 if(!value.claims.length||value.missing!==null)fail();
 const byId=new Map(passages.map(p=>[p.id,p])),citations=[],answers=[];
 for(const claim of value.claims){
  if(!exactKeys(claim,['text','passageId','timePassageId']))fail();
  const p=byId.get(claim.passageId);
  if(!p||typeof claim.text!=='string'||!claim.text.trim()||claim.text.length>500)fail();
  if(current&&claim.timePassageId!==claim.passageId)fail();
  if(!current&&claim.timePassageId!==null)fail();
  answers.push(claim.text.trim());citations.push({url:p.url,quote:p.text});
 }
 return {verdict:value.verdict,answer:answers.join('\n'),citations,resourcePlan:null,resourceUpdate:null};
}
