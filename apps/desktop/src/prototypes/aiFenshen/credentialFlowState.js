export const CREDENTIAL_FLOW_STEPS = Object.freeze({
  choice: 'choice',
  identifier: 'identifier',
  code: 'code',
  password: 'password',
  success: 'success',
  enrollment: 'enrollment'
});

export function createCredentialFlowState(loginScreenState = 'unregistered') {
  return {
    loginScreenState,
    step: CREDENTIAL_FLOW_STEPS.choice,
    method: null,
    mode: loginScreenState === 'unregistered' ? 'register' : 'login'
  };
}

export function credentialFlowReducer(state, action) {
  switch (action.type) {
    case 'CHOOSE_METHOD':
      return { ...state, method: action.method, step: CREDENTIAL_FLOW_STEPS.identifier };
    case 'CHOOSE_LOGIN':
      return { ...state, mode: 'login', method: null, step: CREDENTIAL_FLOW_STEPS.identifier };
    case 'CONTINUE':
      if (state.step === CREDENTIAL_FLOW_STEPS.identifier) return { ...state, step: CREDENTIAL_FLOW_STEPS.code };
      if (state.step === CREDENTIAL_FLOW_STEPS.code) {
        if (state.mode === 'register') return { ...state, step: CREDENTIAL_FLOW_STEPS.password };
        return { ...state, step: state.loginScreenState === 'registered_no_face' ? CREDENTIAL_FLOW_STEPS.enrollment : CREDENTIAL_FLOW_STEPS.success };
      }
      if (state.step === CREDENTIAL_FLOW_STEPS.password) return { ...state, step: CREDENTIAL_FLOW_STEPS.success };
      return state;
    case 'BACK': {
      const previous = {
        [CREDENTIAL_FLOW_STEPS.identifier]: CREDENTIAL_FLOW_STEPS.choice,
        [CREDENTIAL_FLOW_STEPS.code]: CREDENTIAL_FLOW_STEPS.identifier,
        [CREDENTIAL_FLOW_STEPS.password]: CREDENTIAL_FLOW_STEPS.code,
        [CREDENTIAL_FLOW_STEPS.success]: CREDENTIAL_FLOW_STEPS.password,
        [CREDENTIAL_FLOW_STEPS.enrollment]: CREDENTIAL_FLOW_STEPS.code
      }[state.step] || CREDENTIAL_FLOW_STEPS.choice;
      return { ...state, step: previous };
    }
    case 'RESET':
      return createCredentialFlowState(state.loginScreenState);
    default:
      return state;
  }
}
