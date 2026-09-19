const fail=code=>Object.assign(new Error(code),{code});
export class VoiceRepository {
 constructor(database,{clock=()=>new Date()}={}){this.database=database;this.clock=clock;}
 migrate(){this.database.exec(`
 CREATE TABLE IF NOT EXISTS voice_chat_usage_v1(owner_id TEXT NOT NULL,day TEXT NOT NULL,input_ms INTEGER NOT NULL DEFAULT 0,output_ms INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner_id,day));
 CREATE TABLE IF NOT EXISTS voice_chat_delivery_v1(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,owner_id TEXT NOT NULL,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,turn_id TEXT NOT NULL,status TEXT NOT NULL,completed_segments INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);
 `);}
 consume(ownerId,inputMs=0,outputMs=0,limitMs=null){
  if(!ownerId||![inputMs,outputMs].every(n=>Number.isSafeInteger(n)&&n>=0)||(limitMs!==null&&(!Number.isSafeInteger(limitMs)||limitMs<0)))throw fail('VOICE_USAGE_INVALID');
  const day=this.clock().toISOString().slice(0,10);
  this.database.prepare('INSERT OR IGNORE INTO voice_chat_usage_v1(owner_id,day) VALUES(?,?)').run(ownerId,day);
  const result=this.database.prepare(`UPDATE voice_chat_usage_v1 SET input_ms=input_ms+?,output_ms=output_ms+? WHERE owner_id=? AND day=? AND (? IS NULL OR input_ms+output_ms+?+?<=?)`).run(inputMs,outputMs,ownerId,day,limitMs,inputMs,outputMs,limitMs);
  if(!result.changes)throw fail('VOICE_DAILY_LIMIT');
  return this.database.prepare('SELECT input_ms,output_ms FROM voice_chat_usage_v1 WHERE owner_id=? AND day=?').get(ownerId,day);
 }
 createDelivery({ownerId,conversationId,messageId,turnId}){
  if(!this.database.prepare(`SELECT m.id FROM messages m JOIN conversations c ON m.conversation_id=c.id WHERE m.id=? AND c.id=? AND c.owner_id=? AND m.role='assistant'`).get(messageId,conversationId,ownerId))throw fail('VOICE_MESSAGE_NOT_FOUND');
  this.database.prepare('INSERT INTO voice_chat_delivery_v1(message_id,owner_id,conversation_id,turn_id,status,updated_at) VALUES(?,?,?,?,?,?)').run(messageId,ownerId,conversationId,turnId,'unknown',this.clock().toISOString());
 }
 receipt({ownerId,conversationId,messageId,turnId,status,completedSegments=0}){
  if(!['playing','completed','interrupted','error','unknown'].includes(status)||!Number.isSafeInteger(completedSegments)||completedSegments<0||completedSegments>10000)throw fail('VOICE_RECEIPT_INVALID');
  const row=this.database.prepare('SELECT * FROM voice_chat_delivery_v1 WHERE message_id=? AND owner_id=? AND conversation_id=? AND turn_id=?').get(messageId,ownerId,conversationId,turnId);
  if(!row)throw fail('VOICE_MESSAGE_NOT_FOUND');
  if(['completed','interrupted','error'].includes(row.status))return this.get(messageId,ownerId);
  this.database.prepare('UPDATE voice_chat_delivery_v1 SET status=?,completed_segments=?,updated_at=? WHERE message_id=?').run(status,Math.max(row.completed_segments,completedSegments),this.clock().toISOString(),messageId);
  return this.get(messageId,ownerId);
 }
 markReplacementUnspoken({messageId,ownerId,conversationId,turnId}){
  const result=this.database.prepare("UPDATE voice_chat_delivery_v1 SET status='unknown',completed_segments=0,updated_at=? WHERE message_id=? AND owner_id=? AND conversation_id=? AND turn_id=?").run(this.clock().toISOString(),messageId,ownerId,conversationId,turnId);
  if(!result.changes)throw fail('VOICE_MESSAGE_NOT_FOUND');
 }
 get(messageId,ownerId){const r=this.database.prepare('SELECT status,completed_segments,updated_at FROM voice_chat_delivery_v1 WHERE message_id=? AND owner_id=?').get(messageId,ownerId);return r?{status:r.status,completedSegments:r.completed_segments,updatedAt:r.updated_at}:null;}
 deleteOwner(ownerId){this.database.prepare('DELETE FROM voice_chat_usage_v1 WHERE owner_id=?').run(ownerId);this.database.prepare('DELETE FROM voice_chat_delivery_v1 WHERE owner_id=?').run(ownerId);}
}
