import {LearningRealtimeSessions} from './realtimeSessions.js';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { applyConversationMigrations } from '../conversation/migrations.js';
import { LearningRepository, applyLearningMigrations } from './repository.js';
import { LearningService } from './service.js';
export function hasLearningData(database){return !!database?.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='learning_sessions'").get();}
export function createLearningRuntime({database,encryptionKey,aiService,enabled=false,realtimeEnabled=false}){
  if(!enabled&&!hasLearningData(database))return null;
  if(!database)throw Error('LEARNING_CONVERSATIONS_REQUIRED');
  const repository=new LearningRepository({database,encryptionKey});
  applyLearningMigrations(database);
  const temporary=new DatabaseSync(':memory:');applyConversationMigrations(temporary);applyLearningMigrations(temporary);
  const ephemeralRepository=new LearningRepository({database:temporary,encryptionKey:randomBytes(32)});
  const service=new LearningService({repository,ephemeralRepository,aiService});
  const realtime=realtimeEnabled&&aiService?.router?.speechRuntime?.realtimeAvailable?new LearningRealtimeSessions({service}):null;
  const requests=new Map();let closed=false;
  service.export=owner=>repository.export(owner);
  service.deleteAllForOwner=owner=>{
    realtime?.cancelOwner(owner);
    for(const [controller,account]of requests)if(account===owner)controller.abort();
    for(const repo of [repository,ephemeralRepository]){
      repo.conversations.database.prepare('DELETE FROM conversations WHERE owner_id=? AND id IN (SELECT conversation_id FROM learning_sessions WHERE owner_id=?)').run(owner,owner);
      repo.database.prepare('DELETE FROM learning_preferences WHERE owner_id=?').run(owner);
      repo.database.prepare('DELETE FROM learning_audit WHERE owner_id=?').run(owner);
    }
    for(const[k,v]of service.voiceEvidence)if(v.owner===owner)service.voiceEvidence.delete(k);
  };
  const sweep=setInterval(()=>{
    for(const row of temporary.prepare('SELECT owner_id,id,updated_at,revision FROM learning_sessions').all())if(Date.parse(row.updated_at)<Date.now()-2*3600000)ephemeralRepository.delete(row.owner_id,row.id,row.revision);
  },60000);sweep.unref();
  return {enabled,service,repository,requests,realtime,close(){if(closed)return;closed=true;realtime?.close();clearInterval(sweep);for(const controller of requests.keys())controller.abort();repository.close();ephemeralRepository.close();temporary.close();}};
}
