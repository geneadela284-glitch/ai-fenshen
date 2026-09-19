import { runAiAction } from '../actions/runAiAction.js';

export class WorkflowEngine {
  constructor({ workflows = [] } = {}) {
    this.workflows = new Map();
    workflows.forEach((workflow) => this.registerWorkflow(workflow));
  }

  registerWorkflow(workflow) {
    if (!workflow?.id) {
      throw new Error('Workflow must include id.');
    }
    this.workflows.set(workflow.id, workflow);
    return workflow;
  }

  getWorkflow(workflowId) {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }
    return workflow;
  }

  listWorkflows() {
    return Array.from(this.workflows.values()).map(({ id, name, provider, steps = [] }) => ({
      id,
      name,
      provider,
      stepCount: steps.length
    }));
  }

  async run(workflowId, context = {}) {
    return runWorkflow(this.getWorkflow(workflowId), context);
  }
}

export async function runWorkflow(workflow, context = {}) {
  const steps = workflow.steps || [];
  const results = [];

  for (const step of steps) {
    const result = await runAiAction({
      ...step,
      input: step.input ?? context.input,
      provider: step.provider ?? workflow.provider
    });
    results.push({ stepId: step.id, result });
  }

  return {
    workflowId: workflow.id,
    results,
    mocked: results.every((item) => item.result?.mocked)
  };
}

export const workflowEngine = new WorkflowEngine();
