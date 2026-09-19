export function findPendingMemoryConfirmation(tasks = []) {
  const candidates = tasks
    .map((task) => ({ task, confirmation: task?.workspaceMetadata?.memoryIntegration }))
    .filter(({ confirmation }) => confirmation?.status === 'confirmation_required' && confirmation?.confirmationId)
    .sort((left, right) => new Date(right.task.updatedAt || 0) - new Date(left.task.updatedAt || 0));
  if (!candidates.length) return null;
  return { ...candidates[0].confirmation, taskId: candidates[0].task.taskId };
}

export function shouldKeepMemoryConfirmation(result = {}) {
  return ['confirmation_required', 'failed'].includes(result.status);
}
