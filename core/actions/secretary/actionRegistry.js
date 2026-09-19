import { validateActionContract } from './actionContract.js';

export class ActionRegistry {
  constructor() {
    this.actions = new Map();
  }

  register(action) {
    validateActionContract(action);
    if (this.actions.has(action.name)) {
      throw new Error(`Action 已注册: ${action.name}`);
    }
    this.actions.set(action.name, action);
    return action;
  }

  get(actionName) {
    return this.actions.get(actionName) || null;
  }

  has(actionName) {
    return this.actions.has(actionName);
  }

  list() {
    return [...this.actions.values()];
  }
}
