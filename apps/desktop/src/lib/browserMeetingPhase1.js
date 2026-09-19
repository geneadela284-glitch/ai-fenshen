import {createMeetingRecordingPlaybackGate,coordinateMeetingRecordingPlayback} from './meetingRecordingPlaybackGate.js';
import { createBrowserProductionKeyProvider } from './browserProductionKeyProvider.js';
import { createIndexedDbKeyStorage } from './browserKeyStore.js';
import { createIndexedDbMeetingBackend, createMeetingPhase1Store } from './browserMeetingStore.js';
import { createMeetingTranscriptStore } from './meetingTranscriptStore.js';
import { createMeetingDiarizationStore } from './meetingDiarizationStore.js';
import { createMeetingPhase1Manager } from './meetingPhase1Manager.js';
import { createMeetingSpeechGateway } from '../../../../core/meeting/stage3a/meetingSpeechGateway.js';
import { createMeetingTranscriptionManager } from './meetingTranscriptionManager.js';
import { createMeetingDiarizationManager } from './meetingDiarizationManager.js';
import { createMeetingSpeechGatewayClient } from './meetingSpeechGatewayClient.js';
import { createIndexedDbMeetingSpeakerCorrectionBackend } from './meetingSpeakerCorrectionBackend.js';
import { createMeetingSpeakerCorrectionStore } from './meetingSpeakerCorrectionStore.js';
import { createMeetingSpeakerCorrectionManager } from './meetingSpeakerCorrectionManager.js';
import { createMeetingAnalysisBundleStore } from './meetingAnalysisBundleStore.js';
import { createMeetingAnalysisManager } from './meetingAnalysisManager.js';
import { createMeetingAnalysisModelClient } from './meetingAnalysisModelClient.js';
import { createStage3cBrowserPlaybackSession } from './meetingStage3cBrowserPlayback.js';
import { createStage3cRefreshSafeRecorderFactory } from './meetingStage3cRefreshSafeRecorderAdapter.js';
import { resolveMeetingRecordingMediaProfile } from './meetingRecordingMediaProfile.js';
import { configureMeetingRecordingRuntime } from './meetingRecordingRuntimeProfile.js';

function codedError(code, cause = null) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

async function probeBaseBrowserCapabilities({ cryptoImpl, keyStorage }) {
  if (globalThis.isSecureContext !== true) throw codedError('INSECURE_CONTEXT');
  if (!cryptoImpl?.subtle || typeof cryptoImpl.getRandomValues !== 'function') throw codedError('WEB_CRYPTO_UNAVAILABLE');
  if (!keyStorage?.available || typeof keyStorage.probeCryptoKeyPersistence !== 'function') throw codedError('INDEXEDDB_UNAVAILABLE');
  let key;
  try {
    key = await cryptoImpl.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = cryptoImpl.getRandomValues(new Uint8Array(12));
    const ciphertext = await cryptoImpl.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('meeting-phase1-capability'));
    await cryptoImpl.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    try {
      await cryptoImpl.subtle.exportKey('raw', key);
      throw codedError('NON_EXPORTABLE_KEY_UNAVAILABLE');
    } catch (error) {
      if (error?.code === 'NON_EXPORTABLE_KEY_UNAVAILABLE') throw error;
    }
  } catch (error) {
    throw error?.code ? error : codedError('WEB_CRYPTO_PROBE_FAILED', error);
  }
  const persistence = await keyStorage.probeCryptoKeyPersistence(key);
  if (persistence?.reopened !== true) throw codedError(persistence?.errorCode || 'CRYPTO_KEY_PERSISTENCE_FAILED');
  return Object.freeze({
    environment: 'browser',
    productionReady: false,
    capabilities: Object.freeze({
      webCryptoAesGcm: true,
      nonExportableKeyHandle: true,
      indexedDb: true,
      persistentCryptoKey: true
    }),
    errorCodes: Object.freeze({})
  });
}

export async function createBrowserMeetingPhase1Manager({
  ownerContext,
  cryptoImpl = globalThis.crypto,
  indexedDBImpl = globalThis.indexedDB,
  navigatorImpl = globalThis.navigator,
  keyStorage = null,
  keyProvider = null,
  backend = null,
  speakerCorrectionBackend = null,
  capabilities = null,
  deviceBindingId = '',
  initializeSyntheticOwnerKey = false,
  initializeAuthenticatedOwnerKey = false,
  recorderOptions = {},
  speechGateway = null,
  MediaRecorderImpl = globalThis.MediaRecorder,
  recordingMediaProfile = null,
  recordingAttemptEvidenceClient = null,
  checkpointTraceClient = null,
  exposeTestHandles = false
} = {}) {
  const storage = keyStorage || createIndexedDbKeyStorage({ indexedDBImpl, navigatorImpl });
  const checkedCapabilities = capabilities || await probeBaseBrowserCapabilities({ cryptoImpl, keyStorage: storage });
  const bindingId = String(deviceBindingId || await storage.getOrCreateDeviceBindingId()).trim();
  if (!bindingId) throw codedError('DEVICE_BINDING_UNAVAILABLE');
  const provider = keyProvider || createBrowserProductionKeyProvider({
    cryptoImpl,
    storage,
    capabilities: checkedCapabilities,
    deviceBindingId: bindingId,
    validationOnly: true
  });
  if (provider.describe?.().available !== true) throw codedError('KEY_PROVIDER_PLATFORM_BLOCKED');
  // Authenticated product users receive a device-local owner key on their first
  // visit.  The owner context is constructed by the authenticated app boundary;
  // untrusted callers still fail closed inside the provider.  Keep the synthetic
  // flag as a separate compatibility path for existing isolated fixtures.
  if (initializeAuthenticatedOwnerKey === true || initializeSyntheticOwnerKey === true) {
    await provider.enrollOwner(ownerContext);
  }
  const meetingBackend = backend || createIndexedDbMeetingBackend({ indexedDBImpl });
  const store = createMeetingPhase1Store({ cryptoImpl, keyProvider: provider, backend: meetingBackend });
  const analysisBundles = createMeetingAnalysisBundleStore({ cryptoImpl, keyProvider: provider, backend: meetingBackend });
  const analysis = createMeetingAnalysisManager({
    ownerContext,
    analysisBundles,
    modelRunner: createMeetingAnalysisModelClient()
  });
  const profileRecorderImpl = MediaRecorderImpl || recorderOptions.MediaRecorderImpl;
  const mediaProfile = recordingMediaProfile || resolveMeetingRecordingMediaProfile({ navigatorImpl, MediaRecorderImpl: profileRecorderImpl });
  const recordingRuntime = configureMeetingRecordingRuntime({
    mediaProfile,
    recorderOptions,
    indexedDBImpl,
    recordingAttemptEvidenceClient,
    checkpointTraceClient
  });
  const {
    attemptEvidenceClient,
    durableCheckpointTraceClient,
    recorderOptions: profileRecorderOptions
  } = recordingRuntime;
  // A recorder controller's local sequence restarts after a page refresh.  Keep
  // the persisted chunk-token namespace stable per controller so a resumed
  // recording cannot collide with an earlier page's committed segment.
  const refreshSafeRecorderFactory = createStage3cRefreshSafeRecorderFactory({ cryptoImpl });
  let phase1Manager = null;
  let boundRecordingAttempt = null;
  const pendingAttemptBindings = new Map();
  async function bindRecordingAttemptToSource() {
    const snapshot = phase1Manager.getSnapshot();
    const recordingAttemptId = String(
      snapshot.active?.meeting?.recordingAttemptId
      || snapshot.recorderInfo?.recordingAttemptId
      || ''
    ).trim();
    const meetingId = String(snapshot.active?.meeting?.meetingId || '').trim();
    const sourceId = meetingId ? `recorded-${meetingId}` : '';
    if (!recordingAttemptId || !meetingId || !sourceId || typeof attemptEvidenceClient?.bind !== 'function') return null;
    if (boundRecordingAttempt?.recordingAttemptId === recordingAttemptId) return boundRecordingAttempt;
    const bindingKey = `${recordingAttemptId}:${meetingId}:${sourceId}`;
    if (pendingAttemptBindings.has(bindingKey)) return pendingAttemptBindings.get(bindingKey);
    const pending = (async () => {
      const bound = await attemptEvidenceClient.bind({
        recordingAttemptId,
        meetingId,
        sourceId,
        ownerId: ownerContext.ownerId,
        scope: ownerContext.spaceId
      });
      if (bound === false) throw codedError('RECORDING_ATTEMPT_BIND_FAILED');
      boundRecordingAttempt = Object.freeze({ recordingAttemptId, meetingId, sourceId });
      // Checkpoint traces emitted before the first committed segment cannot be
      // scope-verified until this server-side binding exists. Retry them now;
      // the trace client keeps uploads idempotent and leaves failures pending.
      await durableCheckpointTraceClient?.flushPending?.();
      return boundRecordingAttempt;
    })();
    pendingAttemptBindings.set(bindingKey, pending);
    try { return await pending; } finally { pendingAttemptBindings.delete(bindingKey); }
  }
  function scheduleRecordingAttemptBinding() {
    // Recording is already persisted locally. Auxiliary evidence uploads must
    // not keep capture controls busy or turn a saved segment into a failure.
    // A later committed segment retries a failed binding; concurrent calls share it.
    void bindRecordingAttemptToSource().catch(() => {});
  }
  const recordingPlaybackGate = createMeetingRecordingPlaybackGate();
  phase1Manager = createMeetingPhase1Manager({
    ownerContext,
    store,
    cryptoImpl,
    recorderFactory: refreshSafeRecorderFactory,
    recorderOptions: profileRecorderOptions,
    onSegmentCommitted: scheduleRecordingAttemptBinding,
    onCheckpointTrace: durableCheckpointTraceClient?.record
  });
  phase1Manager = coordinateMeetingRecordingPlayback(phase1Manager,recordingPlaybackGate);
  void durableCheckpointTraceClient?.flushPending?.();
  const transcriptStore = createMeetingTranscriptStore({ cryptoImpl, keyProvider: provider, backend: meetingBackend });
  const meetingSpeechGateway = speechGateway || createMeetingSpeechGateway({ provider: createMeetingSpeechGatewayClient() });
  const transcriptionManager = createMeetingTranscriptionManager({
    ownerContext,
    audioStore: store,
    transcriptStore,
    speechGateway: meetingSpeechGateway,
    cryptoImpl
  });
  const diarizationStore = createMeetingDiarizationStore({ cryptoImpl, keyProvider: provider, backend: meetingBackend });
  const diarizationManager = createMeetingDiarizationManager({
    ownerContext,
    audioStore: store,
    transcriptStore,
    diarizationStore,
    speechGateway: meetingSpeechGateway,
    cryptoImpl
  });
  const correctionBackend = speakerCorrectionBackend || createIndexedDbMeetingSpeakerCorrectionBackend({ indexedDBImpl });
  const speakerCorrectionStore = createMeetingSpeakerCorrectionStore({
    cryptoImpl,
    keyProvider: provider,
    backend: correctionBackend
  });
  const speakerCorrectionManager = createMeetingSpeakerCorrectionManager({
    ownerContext,
    transcriptStore,
    diarizationStore,
    speakerCorrectionStore,
    cryptoImpl
  });
  const testOnly = exposeTestHandles === true
    ? Object.freeze({
      ownerContext,
      backend: meetingBackend,
      keyProvider: provider,
      meetingStore: store,
      audioStore: store,
      transcriptStore,
      diarizationStore,
      speakerCorrectionStore
    })
    : null;
  // Stage3C additive seam: playback uses the same owner-scoped encrypted store;
  // the existing recording, transcript, diarization, and correction contracts
  // remain unchanged.
  const playback = Object.freeze({
    createSession: () => recordingPlaybackGate.createSession(() => createStage3cBrowserPlaybackSession({ ownerContext, audioStore: store }))
  });
  let disposePromise = null;
  function dispose() {
    if (!disposePromise) {
      disposePromise = (async () => {
        try {
          await phase1Manager.dispose();
        } finally {
          analysis.dispose();
          correctionBackend.close?.();
        }
      })();
    }
    return disposePromise;
  }
  return Object.freeze({
    ...phase1Manager,
    async startRecording(...args) {
      const result = await phase1Manager.startRecording(...args);
      scheduleRecordingAttemptBinding();
      return result;
    },
    async resumeRecording(...args) {
      const result = await phase1Manager.resumeRecording(...args);
      scheduleRecordingAttemptBinding();
      return result;
    },
    async stopRecording(...args) {
      const result = await phase1Manager.stopRecording(...args);
      scheduleRecordingAttemptBinding();
      return result;
    },
    transcription: transcriptionManager,
    diarization: diarizationManager,
    speakerCorrection: speakerCorrectionManager,
    analysisBundles,
    analysis,
    ...(testOnly ? { testOnly } : {}),
    playback,
    dispose
  });
}

export { probeBaseBrowserCapabilities };
