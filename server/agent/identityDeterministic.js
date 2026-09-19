// Product identity is one shared source for deterministic answers and model policy.
export const AI_FENSHEN_CREATOR = Object.freeze({
 answer: '我是由示例维护者创建的。',
 biography: '示例维护者，身份信息已脱敏。'
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
const maintainerQuestions=[
 /^(?:(?:你说的|你的|创造你的|开发你的)?维护者是(?:谁|什么人)|谁是维护者)$/u,
 /^维护者的?(?:真名|本名)(?:是什么|叫什么|是啥)$/u,
 /^(?:能|可以)?(?:给我)?介绍一下维护者(?:吗)?$/u,
 /^维护者(?:是哪里人|来自哪里|家乡在哪|属什么|属相是什么)$/u
];
function normalizeQuestion(message){
 return String(message||'').trim().toLowerCase().replace(/[\s？?。！!，,、；;：:]/gu,'')
  .replace(/^(?:(?:请问(?:一下)?|我想问一下|我想知道|告诉我|那))+/u,'')
  .replace(/[呢呀啊]+$/u,'');
}
export function deterministicIdentityAnswer(message){
 const question=normalizeQuestion(message);
 if(creatorQuestions.some(pattern=>pattern.test(question)))return{intent:'identity_creator',action:'answer',content:AI_FENSHEN_CREATOR.answer};
 if(maintainerQuestions.some(pattern=>pattern.test(question)))return{intent:'identity_maintainer',action:'answer',content:AI_FENSHEN_CREATOR.biography};
 return null;
}
