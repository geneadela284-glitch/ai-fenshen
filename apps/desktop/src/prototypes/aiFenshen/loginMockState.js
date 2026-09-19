export const LOGIN_SCREEN_STATES = ['unregistered', 'registered_no_face', 'face_ready'];

export function normalizeLoginScreenState(value) {
  return LOGIN_SCREEN_STATES.includes(value) ? value : 'unregistered';
}

export function getDefaultCredentialMode(loginScreenState) {
  return loginScreenState === 'unregistered' ? 'register' : 'login';
}
