const IDENTITY_KEYS=new Set(['userId','user_id','owner','ownerId','owner_id','accountId','account_id']);
function forged(value){return value&&typeof value==='object'&&Object.entries(value).some(([key,child])=>IDENTITY_KEYS.has(key)||forged(child));}
const MESSAGES={DIARY_REVISION_CONFLICT:'日记已被修改，请刷新后重新编辑。',DIARY_IDEMPOTENCY_CONFLICT:'这次保存与之前的请求内容不同，请重新保存。',DIARY_NOT_FOUND:'日记不存在。',DIARY_DELETE_CONFIRMATION_REQUIRED:'请先确认删除日记及关联提醒。',DIARY_IDEMPOTENCY_DELETED:'这篇日记已删除，不能通过重试恢复。',DIARY_SNOOZE_NOT_FUTURE:'延期时间需要晚于当前时间。'};
export async function handleDiaryApi({req,res,url,user,runtime,readJson,sendJson}) {
  if(url.pathname!=='/api/diary'&&!url.pathname.startsWith('/api/diary/'))return false;
  if(!user?.id){sendJson(res,401,{ok:false,code:'AUTH_REQUIRED',message:'请先登录。'});return true;}
  if(!runtime?.service){sendJson(res,503,{ok:false,code:'DIARY_UNAVAILABLE',message:'日记暂时无法使用，请稍后重试。'});return true;}
  try {
    let input={};
    if(['POST','PATCH','DELETE'].includes(req.method)){input=await readJson(req);if(!input||typeof input!=='object'||Array.isArray(input))throw Object.assign(new Error(),{code:'DIARY_INPUT_INVALID',status:400});}
    if(forged(input)||[...url.searchParams.keys()].some(key=>IDENTITY_KEYS.has(key))){sendJson(res,403,{ok:false,code:'DIARY_FORGED_IDENTITY',message:'不能指定其他账号。'});return true;}
    const service=runtime.service; const owner=user.id; const pathname=url.pathname;
    if(pathname==='/api/diary'&&req.method==='GET')sendJson(res,200,{ok:true,entries:service.list(owner,{date:url.searchParams.get('date'),q:url.searchParams.get('q')})});
    else if(pathname==='/api/diary'&&req.method==='POST')sendJson(res,201,{ok:true,entry:service.create(owner,input)});
    else if(pathname==='/api/diary/export'&&req.method==='GET')sendJson(res,200,{ok:true,...service.export(owner)});
    else if(pathname==='/api/diary/reminders'&&req.method==='GET')sendJson(res,200,{ok:true,tasks:service.reminders(owner,{timezone:url.searchParams.get('timezone')||'Asia/Shanghai'})});
    else {
      const match=pathname.match(/^\/api\/diary\/([^/]+)(\/reminder)?$/);
      if(!match){sendJson(res,404,{ok:false,code:'DIARY_NOT_FOUND',message:'日记不存在。'});return true;}
      const id=decodeURIComponent(match[1]);
      if(match[2]&&req.method==='POST')sendJson(res,200,{ok:true,entry:service.reminderAction(owner,id,input)});
      else if(!match[2]&&req.method==='GET')sendJson(res,200,{ok:true,entry:service.get(owner,id)});
      else if(!match[2]&&req.method==='PATCH')sendJson(res,200,{ok:true,entry:service.update(owner,id,input)});
      else if(!match[2]&&req.method==='DELETE'){service.delete(owner,id,input);sendJson(res,200,{ok:true});}
      else sendJson(res,405,{ok:false,code:'METHOD_NOT_ALLOWED',message:'不支持此操作。'});
    }
  }catch(error){const status=[400,401,403,404,409].includes(error?.status)?error.status:503;sendJson(res,status,{ok:false,code:status===503?'DIARY_UNAVAILABLE':error.code,message:MESSAGES[error.code]||(status===503?'日记操作未完成，请重试。':'日记数据无效，请检查日期、时间和内容。')});}
  return true;
}
