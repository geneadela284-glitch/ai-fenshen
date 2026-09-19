import { normalizeTaskInput, taskDetectionOrder, taskTypes } from './taskDefinitions.js';
import { routerService } from './RouterService.js';

function includesKeyword(input, keywords = []) {
  const normalized = input.toLowerCase();
  return keywords.some((keyword) => normalized.includes(String(keyword).toLowerCase()));
}

export class TaskRouter {
  constructor({ router = routerService } = {}) {
    this.router = router;
  }

  detectTaskType(request = {}) {
    const input = normalizeTaskInput(request);
    const matchedType = taskDetectionOrder.find((taskType) => includesKeyword(input, taskTypes[taskType]?.keywords));
    return matchedType || 'general';
  }

  route(request = {}, providerConfig = {}) {
    const taskType = this.detectTaskType(request);
    const routed = this.router.selectProvider({ taskType, providerConfig });

    return {
      taskType,
      input: normalizeTaskInput(request),
      preferredProvider: routed.selectedProvider,
      selectedModel: routed.selectedModel,
      fallbackProviders: routed.fallbackProviders,
      requiredCapabilities: routed.requiredCapabilities,
      capabilityMatch: routed.capabilityMatch,
      costStrategy: routed.costStrategy,
      candidates: routed.candidates,
      policy: routed
    };
  }
}

export const taskRouter = new TaskRouter();

export default taskRouter;
