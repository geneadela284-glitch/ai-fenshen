export class FakeAIMemoryClassifier {
  constructor(proposals = {}) {
    this.proposals = new Map(Object.entries(proposals));
    this.calls = [];
  }

  set(text, proposal) {
    this.proposals.set(text, proposal);
    return this;
  }

  async classify(input) {
    this.calls.push(structuredClone(input));
    const configured = this.proposals.get(input.text);
    const proposal = typeof configured === 'function' ? await configured(input) : configured;
    if (proposal instanceof Error) throw proposal;
    return structuredClone(proposal);
  }
}
