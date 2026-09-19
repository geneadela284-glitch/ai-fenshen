import { createStage3cManagedMediaSourcePlayer } from './meetingStage3cManagedMediaSourcePlayer.js';
import { detectStage3cPlaybackCapability } from './meetingStage3cPlaybackCapability.js';
import { createStage3cPlaybackManager } from './meetingStage3cPlaybackManager.js';
import { createStage3cWebmBoundedReassemblyAdapter } from './meetingStage3cWebmBoundedReassembly.js';
import { createStage3cAacStoredFragmentAdapter } from './meetingStage3cAacStoredFragmentAdapter.js';
import { createStage3cIndependentMp4SegmentAdapter } from './meetingStage3cIndependentMp4SegmentAdapter.js';

function codedError(code, cause = null) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function createLazyPlayer({ globalObject, audioElementFactory } = {}) {
  let activePlayer = null;
  let sharedAudio = null;
  const detect = (mimeType) => detectStage3cPlaybackCapability({ globalObject, mimeType });
  const getSharedAudio = () => {
    if (!sharedAudio) {
      sharedAudio = (audioElementFactory || (() => globalObject.document?.createElement?.('audio')))();
    }
    return sharedAudio;
  };
  const wrapper = {
    get audio() {
      return sharedAudio || activePlayer?.audio || null;
    },
    async loadWindow(input) {
      const capability = detect(input?.mimeType);
      if (!capability.supported) throw codedError(capability.errorCode || 'PLAYBACK_UNSUPPORTED');
      await activePlayer?.dispose?.();
      activePlayer = createStage3cManagedMediaSourcePlayer({
        globalObject,
        audioElementFactory: getSharedAudio,
        capability
      });
      try {
        return await activePlayer.loadWindow(input);
      } catch (error) {
        await activePlayer.dispose?.();
        throw error;
      }
    },
    async play() {
      if (!activePlayer) throw codedError('PLAYBACK_NOT_OPEN');
      return activePlayer.play();
    },
    async pause() {
      return activePlayer?.pause?.();
    },
    async dispose() {
      await activePlayer?.dispose?.();
      activePlayer = null;
    },
    getSnapshot() {
      return activePlayer?.getSnapshot?.() || { activeResources: 0, activeUrls: 0, mediaChunkCount: 0, requiresUserGesture: false, finalActiveResources: 0 };
    }
  };
  return { wrapper, detect, getAudio: () => sharedAudio || activePlayer?.audio || null };
}

export function createStage3cBrowserPlaybackSession({
  ownerContext,
  audioStore,
  globalObject = globalThis,
  audioElementFactory
} = {}) {
  if (!ownerContext || !audioStore) throw codedError('PLAYBACK_DEPENDENCY_UNAVAILABLE');
  const lazy = createLazyPlayer({ globalObject, audioElementFactory });
  const webmReassemblyAdapter = createStage3cWebmBoundedReassemblyAdapter({ ownerContext, audioStore });
  const aacStoredFragmentAdapter = createStage3cAacStoredFragmentAdapter({ ownerContext, audioStore });
  const independentMp4SegmentAdapter = createStage3cIndependentMp4SegmentAdapter({ ownerContext, audioStore });
  const manager = createStage3cPlaybackManager({
    ownerContext,
    audioStore,
    player: lazy.wrapper,
    capabilityDetector: ({ mimeType }) => lazy.detect(mimeType),
    sourceBoundaryVerifier: (source) => source?.format !== 'webm-opus' && !String(source?.mimeType || '').startsWith('audio/webm'),
    webmReassemblyAdapter,
    aacStoredFragmentAdapter,
    independentMp4SegmentAdapter,
    initBytesProvider: async ({ source }) => {
      const initSegmentId = String(source?.playbackInitSegmentId || source?.initSegmentId || '').trim();
      if (!initSegmentId) throw codedError('PLAYBACK_INIT_SEGMENT_UNAVAILABLE');
      return audioStore.readAudioSegment(ownerContext, source.meetingId, initSegmentId);
    }
  });
  return Object.freeze({
    ...manager,
    getAudioElement: () => lazy.getAudio()
  });
}
