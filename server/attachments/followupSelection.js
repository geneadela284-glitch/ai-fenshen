// Resolve only explicit image references or a short, adjacent visual follow-up.
// History selects an ID; the processing service still verifies live ownership and bytes.
export function selectImageFollowup(question, groups, { adjacent = false } = {}) {
  const text=String(question||'').trim();
  const explicit=/(?:这|那|刚才|之前|上面|前面|上一|第[一二三123]).{0,8}(?:图|照片|图片|票据|截图)|图里|图中|照片里|图片上|刚才的票据/.test(text);
  const shortFollowup=adjacent&&/^(?:它|这个|那个|第二个|第一个|第三个|左边|右边|上面|下面|多少钱|什么颜色|是什么牌子)/.test(text)&&text.length<100&&!/方案|计划|任务|记住|记账|删除|日程/.test(text);
  if(!explicit&&!shortFollowup)return null;
  if(!groups.length)return { clarification:'这条对话中没有可定位的图片，请重新选择需要查看的图片。' };
  let group=groups.at(-1);
  if(/第一(?:张|幅|个图)/.test(text))group=groups[0];
  const ids=group.attachmentIds;
  const ordinal=text.match(/第([一二三123])(?:张|幅)(?:图|照片|图片)?/);
  if(ordinal){const n={'一':0,'二':1,'三':2,'1':0,'2':1,'3':2}[ordinal[1]];const all=groups.flatMap(g=>g.attachmentIds);return all[n]?{attachmentIds:[all[n]]}:{clarification:'这条对话中找不到所说的那张图片，请说明要看哪一张或重新选择图片。'};}
  if(ids.length>1&&!/这些|几张|每张|分别|比较|对比|区别|不同/.test(text))return {clarification:'刚才有多张图片，请说明第几张；如果是一起比较，也可以直接告诉我。'};
  return {attachmentIds:ids};
}
