import { randomUUID } from 'node:crypto';
import { DiaryRepository, applyDiaryMigrations, diaryError } from './repository.js';
import { DiaryService } from './service.js';

export function createDiaryRuntime({database,tasksService,encryptionKey,clock=()=>new Date(),applyMigrations=false}={}) {
  if(!database || !tasksService || tasksService.repository?.database !== database) throw new Error('DIARY_SHARED_DATABASE_REQUIRED');
  const repository=new DiaryRepository({database,encryptionKey,clock});
  if(applyMigrations) applyDiaryMigrations(database);
  const service=new DiaryService({repository,tasksService,clock});
  return {database,repository,service,clock,close(){repository.key.fill(0);}};
}

// Feature visibility never removes the account owner's export/deletion rights.
// This factory performs no migrations and exposes no capture API when no key is available.
export function createDiaryLifecycleRuntime({database,tasksService,encryptionKey,clock=()=>new Date()}={}) {
  if(!database || !tasksService || tasksService.repository?.database!==database)throw new Error('DIARY_SHARED_DATABASE_REQUIRED');
  if(!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='diary_entries'").get())return null;
  if(Buffer.isBuffer(encryptionKey)&&encryptionKey.length===32)return createDiaryRuntime({database,tasksService,encryptionKey,clock,applyMigrations:false});
  const ownerId=value=>{
    if(typeof value!=='string'||!value.trim())throw diaryError('AUTH_REQUIRED',401);
    return value.trim();
  };
  const service={
    diaryIdForTask(owner,taskId){
      owner=ownerId(owner);
      return database.prepare('SELECT entry_id FROM diary_task_links WHERE user_id=? AND task_id=?').get(owner,taskId)?.entry_id||null;
    },
    list(owner){
      owner=ownerId(owner);
      if(database.prepare('SELECT 1 FROM diary_entries WHERE user_id=? LIMIT 1').get(owner))throw diaryError('DIARY_KEY_REQUIRED',503);
      return [];
    },
    deleteAllForOwner(owner){
      owner=ownerId(owner);
      const savepoint=`diary_lifecycle_${randomUUID().replaceAll('-','')}`;
      database.exec(`SAVEPOINT ${savepoint}`);
      try {
        const links=database.prepare('SELECT task_id FROM diary_task_links WHERE user_id=?').all(owner);
        for(const link of links)tasksService.update(owner,link.task_id,{status:'cancelled'});
        const removed=Number(database.prepare('DELETE FROM diary_entries WHERE user_id=?').run(owner).changes);
        for(const table of ['diary_requests','diary_audit','diary_task_links'])database.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(owner);
        database.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return removed;
      }catch(error){database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);database.exec(`RELEASE SAVEPOINT ${savepoint}`);throw error;}
    }
  };
  return {database,service,clock,lifecycleOnly:true,close(){}};
}
