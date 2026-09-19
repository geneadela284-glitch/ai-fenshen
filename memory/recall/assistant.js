import { deepFreezeRecall } from './contracts.js';

export class FakeMemoryRecallAssistant {
  constructor(proposal = {}) {
    this.intent = proposal.intent || null;
  }

  async suggestIntent() {
    return deepFreezeRecall({ intent: this.intent });
  }
}
