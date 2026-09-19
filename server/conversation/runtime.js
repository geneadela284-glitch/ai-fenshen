import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ActiveRequestRegistry } from './activeRequestRegistry.js';
import { ConversationService } from './conversationService.js';
import { applyConversationMigrations } from './migrations.js';
import { ConversationRepository, MessageRepository } from './repositories.js';
import { createAssistantAgentOrchestrator } from '../agent/assistantAgentOrchestrator.js';

export function createConversationRuntime({ databasePath, database: databaseOverride, aiService, applyMigrations = false,
  memoryPolicy = 'disabled', memoryIntegration = null, financeIntegration = null, assistantAgent: assistantAgentOverride = null } = {}) {
  if (!databaseOverride && !databasePath) throw new Error('Conversation databasePath is required.');
  if (!aiService?.stream) throw new Error('Streaming AI service is required.');
  if (memoryPolicy === 'protected_acceptance' && !memoryIntegration && !assistantAgentOverride) {
    throw new Error('MEMORY_INTEGRATION_REQUIRED');
  }
  const database = databaseOverride || new DatabaseSync(path.resolve(databasePath));
  database.exec('PRAGMA foreign_keys = ON');
  if (applyMigrations) applyConversationMigrations(database);
  const conversations = new ConversationRepository({ database });
  const messages = new MessageRepository({ database });
  const registry = new ActiveRequestRegistry();
  const assistantAgent = assistantAgentOverride || createAssistantAgentOrchestrator({
    financeService: financeIntegration,
    memoryIntegration
  });
  const service = new ConversationService({ conversations, messages, aiService, registry, memoryPolicy, assistantAgent });
  let closed = false;
  return {
    database, conversations, messages, registry, service, memoryPolicy, assistantAgent,
    close() {
      if (closed) return;
      closed = true;
      registry.close();
      if (!databaseOverride) database.close();
    }
  };
}
