// Product identity is one shared source for deterministic answers and model policy.
export const AI_FENSHEN_CREATOR = Object.freeze({
 name: '华哥',
 legalName: '梁钊华',
 hometown: '广东省南雄市',
 zodiac: '羊',
 answer: '我是我亲爱的华哥创造出来的。',
 biography: '华哥，本名梁钊华，广东省南雄市人，属羊。'
});

const subject='(?:你|你们|ai分身|这个ai分身|这款ai分身)';
const who='(?:谁|哪(?:个|位)(?:人|开发者|程序员)|哪(?:家|个)(?:公司|团队))';
const creation='(?:创造|开发|研发|设计|制作|做)';
const creatorRole='(?:创造者|开发者|研发者|设计者|创始人|开发团队)';
const creatorQuestions=[
 `${subject}(?:到底|究竟)?(?:是)?(?:由|被)?${who}${creation}(?:出来)?(?:的)?`,
 `(?:是)?${who}${creation}(?:了|的)?${subject}(?:的)?`,
 `(?:是)?${who}(?:把|将)${subject}${creation}(?:出来)?(?:的)?`,
 `${subject}的${creatorRole}(?:是)?${who}`,
 `${who}是${subject}的${creatorRole}`,
 `${creatorRole}是${who}`
].map(pattern=>new RegExp(`^(?:${pattern})$`,'u'));
const huageQuestions=[
 /^(?:(?:你说的|你的|创造你的|开发你的)?华哥是(?:谁|什么人)|谁是华哥)$/u,
 /^华哥的?(?:真名|本名)(?:是什么|叫什么|是啥)$/u,
 /^(?:能|可以)?(?:给我)?介绍一下华哥(?:吗)?$/u,
 /^华哥(?:是哪里人|来自哪里|家乡在哪|属什么|属相是什么)$/u
];
function normalizeQuestion(message){
 return String(message||'').trim().toLowerCase().replace(/[\s？?。！!，,、；;：:]/gu,'')
  .replace(/^(?:(?:请问(?:一下)?|我想问一下|我想知道|告诉我|那))+/u,'')
  .replace(/[呢呀啊]+$/u,'');
}
function creatorFollowupIntent(question){
 if(/^(?:哪个华哥|你说的是谁|你说的谁|他是谁)$/u.test(question))return'biography';
 if(/^(?:(?:他|华哥)(?:叫(?:什么名字|什么)|(?:的)?(?:真名|本名|名字)(?:是什么|叫什么|是啥))|(?:真名|本名|名字)(?:是什么|叫什么|是啥))$/u.test(question))return'name';
 if(/^(?:(?:他|华哥)(?:是)?|)?(?:哪里人|来自哪里|家乡在哪)$/u.test(question))return'hometown';
 if(/^(?:(?:他|华哥)(?:属)?|)?(?:属什么|属相是什么|生肖是什么)$/u.test(question))return'zodiac';
 return null;
}
function creatorFollowupContent(intent){
 if(intent==='name')return`${AI_FENSHEN_CREATOR.name}本名${AI_FENSHEN_CREATOR.legalName}。`;
 if(intent==='hometown')return`${AI_FENSHEN_CREATOR.name}是${AI_FENSHEN_CREATOR.hometown}人。`;
 if(intent==='zodiac')return`${AI_FENSHEN_CREATOR.name}属${AI_FENSHEN_CREATOR.zodiac}。`;
 return AI_FENSHEN_CREATOR.biography;
}
const creatorAnswerContents=new Set([
 AI_FENSHEN_CREATOR.answer,
 AI_FENSHEN_CREATOR.biography,
 creatorFollowupContent('name'),
 creatorFollowupContent('hometown'),
 creatorFollowupContent('zodiac')
]);
function creatorContextIsContiguous(conversationMessages){
 const history=Array.isArray(conversationMessages)?conversationMessages:[];
 for(let assistantIndex=history.length-1;assistantIndex>=1;assistantIndex-=2){
  const answer=history[assistantIndex],questionMessage=history[assistantIndex-1];
  if(answer?.role!=='assistant'||questionMessage?.role!=='user'||typeof answer.content!=='string'||typeof questionMessage.content!=='string')return false;
  if(!creatorAnswerContents.has(answer.content.trim()))return false;
  const question=normalizeQuestion(questionMessage.content);
  if(creatorQuestions.some(pattern=>pattern.test(question))||huageQuestions.some(pattern=>pattern.test(question)))return true;
  if(!creatorFollowupIntent(question))return false;
 }
 return false;
}
export function deterministicIdentityAnswer(message,{conversationMessages=null,allowCreatorFollowup=false}={}){
 const question=normalizeQuestion(message);
 if(creatorQuestions.some(pattern=>pattern.test(question)))return{intent:'identity_creator',action:'answer',content:AI_FENSHEN_CREATOR.answer};
 if(huageQuestions.some(pattern=>pattern.test(question)))return{intent:'identity_huage',action:'answer',content:AI_FENSHEN_CREATOR.biography};
 if(allowCreatorFollowup&&creatorContextIsContiguous(conversationMessages)){
  const intent=creatorFollowupIntent(question);if(intent)return{intent:`identity_huage_${intent}`,action:'answer',content:creatorFollowupContent(intent)};
 }
 return null;
}
