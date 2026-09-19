import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCredentialFlowState,
  credentialFlowReducer,
  CREDENTIAL_FLOW_STEPS
} from './credentialFlowState.js';

test('unregistered flow begins with lightweight choices and advances one action at a time', () => {
  let state = createCredentialFlowState('unregistered');
  assert.equal(state.step, CREDENTIAL_FLOW_STEPS.choice);

  state = credentialFlowReducer(state, { type: 'CHOOSE_METHOD', method: 'phone' });
  assert.deepEqual({ step: state.step, method: state.method }, { step: CREDENTIAL_FLOW_STEPS.identifier, method: 'phone' });
  state = credentialFlowReducer(state, { type: 'CONTINUE' });
  assert.equal(state.step, CREDENTIAL_FLOW_STEPS.code);
  state = credentialFlowReducer(state, { type: 'CONTINUE' });
  assert.equal(state.step, CREDENTIAL_FLOW_STEPS.password);
  state = credentialFlowReducer(state, { type: 'CONTINUE' });
  assert.equal(state.step, CREDENTIAL_FLOW_STEPS.success);
});

test('registered without face proceeds to enrollment after mock login', () => {
  let state = createCredentialFlowState('registered_no_face');
  state = credentialFlowReducer(state, { type: 'CHOOSE_METHOD', method: 'email' });
  state = credentialFlowReducer(state, { type: 'CONTINUE' });
  state = credentialFlowReducer(state, { type: 'CONTINUE' });
  assert.equal(state.step, CREDENTIAL_FLOW_STEPS.enrollment);
});

test('back and reset stay inside the mock credential flow', () => {
  let state = createCredentialFlowState('unregistered');
  state = credentialFlowReducer(state, { type: 'BACK' });
  assert.equal(state.step, CREDENTIAL_FLOW_STEPS.choice);
  state = credentialFlowReducer(state, { type: 'CHOOSE_METHOD', method: 'phone' });
  state = credentialFlowReducer(state, { type: 'RESET' });
  assert.equal(state.step, CREDENTIAL_FLOW_STEPS.choice);
});
