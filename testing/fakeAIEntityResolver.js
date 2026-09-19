export class FakeAIEntityResolver {
  constructor(proposals = {}) {
    this.proposals = new Map(Object.entries(proposals));
    this.calls = [];
  }

  set(text, proposal) {
    this.proposals.set(text, proposal);
    return this;
  }

  async resolve(input) {
    this.calls.push(structuredClone(input));
    const configured = this.proposals.get(input.text);
    const proposal = typeof configured === 'function' ? await configured(input) : configured;
    return structuredClone(proposal ?? {
      kind: 'none',
      mention: '',
      needsClarification: false
    });
  }
}
