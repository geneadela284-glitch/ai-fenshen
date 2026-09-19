import { createActionProposal } from './actionProposal.js';
import { ActionAuditRepository } from './actionAuditRepository.js';
import { ActionExecutor } from './actionExecutor.js';
import { ActionRegistry } from './actionRegistry.js';
import { createExpenseAction } from './createExpenseAction.js';
import { createScheduleAction } from './createScheduleAction.js';

export function createSecretaryActionFramework({
  memoryService,
  auditRepository = new ActionAuditRepository(),
  now = () => new Date(),
  idGenerator
} = {}) {
  const registry = new ActionRegistry();
  registry.register(createExpenseAction({ memoryService }));
  registry.register(createScheduleAction({ memoryService }));
  const executor = new ActionExecutor({ registry, auditRepository, now });

  return Object.freeze({
    registry,
    auditRepository,
    propose(fields = {}) {
      return createActionProposal({
        ...fields,
        now: fields.now || now(),
        idGenerator: fields.idGenerator || idGenerator
      });
    },
    execute(proposal, context = {}) {
      return executor.run(proposal, context);
    }
  });
}
