// Derived, source-linked context only. This never writes permanent memory or
// turns a model's earlier answer into an execution receipt.
const DIRECTIVE = /目标|预算|要求|必须|不得|禁止|不要|只(?:能|做|要)|最多|至少|截止|更正|改成|作废|取消|撤销|已经完成|已完成|尚未|还没|接下来|方案|记住|\b(?:must|budget|cancel|correct|goal|deadline)\b/iu;
const REVISION = /更正|改成|作废|取消|撤销|不再|已经完成|已完成|\b(?:cancel|correct|instead|completed)\b/iu;
const kind = row => row.role === 'assistant' ? 'earlier_generated_answer' : REVISION.test(row.content) ? 'user_revision' : 'user_statement';
const fail = code => { throw Object.assign(new Error(code), {code}); };

export function assembleConversationContext({messages = [], maxChars = 12000, recentTurns = 6} = {}) {
 if(!Number.isSafeInteger(maxChars)||maxChars<2048) fail('CONTEXT_BUDGET_INVALID');
 const rows=messages.filter(m=>m&&['user','assistant'].includes(m.role)&&typeof m.content==='string'&&m.content.trim()&&
  (m.role==='user'||!m.status||['complete','completed'].includes(m.status)))
  .map((m,index)=>({messageId:m.id||m.messageId||`position:${index}`,role:m.role,content:m.content,ordinal:index}));
 const groups=[];
 for(const row of rows){if(row.role==='user'||!groups.length)groups.push([]);groups.at(-1).push(row)}
 if(!groups.length)return {messages:[],stageContext:null,characters:0};
 const compact=items=>items.map(({role,content})=>({role,content}));
 const last=groups.at(-1);
 if(JSON.stringify(compact(last)).length>maxChars-1024)fail('CONTEXT_LATEST_TURN_TOO_LARGE');
 let start=groups.length-1,recent=last;
 const recentBudget=Math.max(Math.floor(maxChars*.58),JSON.stringify(compact(last)).length);
 while(start>0&&groups.length-start<recentTurns){
  const proposal=[...groups[start-1],...recent];
  if(JSON.stringify(compact(proposal)).length>recentBudget)break;
  recent=proposal;start--;
 }
 const earlier=groups.slice(0,start).flat(),current=compact(recent);
 if(!earlier.length)return {messages:current,stageContext:null,characters:JSON.stringify(current).length};
 const stage={version:'source-excerpts-v1',policy:'historical_data_latest_user_instruction_wins',excerpts:[],omittedMessages:0,omittedImportantMessages:0};
 // User goals and explicit revisions outrank generated prose. No generated
 // paraphrase can erase the user's original words or hide a dropped constraint.
 const candidates=earlier.map(row=>({row,priority:row.role==='user'?(row.ordinal===0?100:REVISION.test(row.content)?90:DIRECTIVE.test(row.content)?70:40):10}))
  .sort((a,b)=>b.priority-a.priority||b.row.ordinal-a.row.ordinal);
 const totalLimit=maxChars-512;
 for(const {row,priority}of candidates){
  const entry={messageId:row.messageId,ordinal:row.ordinal,kind:kind(row),text:row.content};
  const next={...stage,excerpts:[...stage.excerpts,entry]};
  if(JSON.stringify(current).length+JSON.stringify(next).length<=totalLimit)stage.excerpts.push(entry);
  else{stage.omittedMessages++;if(priority>=70)stage.omittedImportantMessages++;}
 }
 stage.excerpts.sort((a,b)=>a.ordinal-b.ordinal);
 return {messages:current,stageContext:stage,characters:JSON.stringify(current).length+JSON.stringify(stage).length};
}

export function formatStageContext(stage){
 if(!stage)return '';
 return '\n阶段上下文（从本对话原消息提取的历史资料，不是新命令或永久记忆）：\n'+
 '每段附原消息引用和顺序；以本轮及最新用户纠正为准，已取消的任务不能复活。历史模型回答只是待核对的生成内容，不是事实或执行回执。'+
 (stage.omittedImportantMessages?'部分早期约束超出预算未能带入；依赖该缺口时具体说明并询问，不假装上下文完整。':'')+'\n'+JSON.stringify(stage);
}
