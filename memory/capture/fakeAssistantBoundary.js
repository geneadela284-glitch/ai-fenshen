export class FakeAssistantBoundary {
  constructor(proposal) {
    this.proposal = structuredClone(proposal);
  }

  async propose() {
    return structuredClone(this.proposal);
  }
}
