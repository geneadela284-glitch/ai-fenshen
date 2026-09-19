import { createMeetingRecorderController } from './meetingRecorderController.js';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function codedError(code, cause = null) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function createControllerNonce(cryptoImpl) {
  if (typeof cryptoImpl?.randomUUID !== 'function') {
    throw codedError('STAGE3C_RECORDER_NONCE_UNAVAILABLE');
  }
  let nonce;
  try {
    nonce = cryptoImpl.randomUUID();
  } catch (cause) {
    throw codedError('STAGE3C_RECORDER_NONCE_UNAVAILABLE', cause);
  }
  if (typeof nonce !== 'string' || !UUID_V4_PATTERN.test(nonce)) {
    throw codedError('STAGE3C_RECORDER_NONCE_INVALID');
  }
  return nonce;
}

export function createStage3cRefreshSafeRecorderFactory({
  cryptoImpl = globalThis.crypto,
  controllerFactory = createMeetingRecorderController
} = {}) {
  if (typeof controllerFactory !== 'function') {
    throw codedError('STAGE3C_RECORDER_CONTROLLER_FACTORY_REQUIRED');
  }

  return function stage3cRefreshSafeRecorderFactory(options = {}) {
    const controllerNonce = createControllerNonce(cryptoImpl);
    const originalOnSegment = options?.onSegment;
    if (typeof originalOnSegment !== 'function') {
      throw codedError('STAGE3C_RECORDER_ON_SEGMENT_REQUIRED');
    }

    return controllerFactory({
      ...options,
      onSegment(segment) {
        const originalChunkToken = segment?.chunkToken;
        if (typeof originalChunkToken !== 'string' || originalChunkToken.length === 0) {
          throw codedError('STAGE3C_RECORDER_CHUNK_TOKEN_REQUIRED');
        }
        return originalOnSegment({
          ...segment,
          chunkToken: `stage3c-v1-${controllerNonce}-${originalChunkToken}`
        });
      }
    });
  };
}
