import { createMeetingRecordingAttemptEvidenceClient } from './meetingRecordingAttemptEvidence.js';
import { createMeetingRecordingCheckpointTraceClient } from './meetingRecordingCheckpointTrace.js';
import {
  IOS_AAC_CAPTURE_UNIT_MS,
  IOS_AAC_NATIVE_TIMESLICE_MS,
  PASSIVE_NATIVE_TIMESLICE_MODE,
  ROTATING_INDEPENDENT_MP4_MODE
} from './meetingRecordingDurabilityMode.js';
import { isVerifiedIosAacRecordingDevice } from './meetingRecordingMediaProfile.js';

const VITE_ENV = import.meta.env || {};

export function resolveDefaultSegmentRotationWritesEnabled(env = VITE_ENV) {
  if (env?.VITE_MEETING_STAGE4_UI_RC === '1') return false;
  return env?.VITE_MEETING_IOS_AAC_SEGMENT_ROTATION === '1';
}

const DEFAULT_SEGMENT_ROTATION_WRITES_ENABLED = resolveDefaultSegmentRotationWritesEnabled();

export function configureMeetingRecordingRuntime({
  mediaProfile,
  recorderOptions = {},
  indexedDBImpl = globalThis.indexedDB,
  recordingAttemptEvidenceClient = null,
  checkpointTraceClient = null,
  segmentRotationWritesEnabled = DEFAULT_SEGMENT_ROTATION_WRITES_ENABLED,
  createAttemptEvidenceClient = createMeetingRecordingAttemptEvidenceClient,
  createCheckpointTraceClient = createMeetingRecordingCheckpointTraceClient
} = {}) {
  if (isVerifiedIosAacRecordingDevice(mediaProfile)) {
    const attemptEvidenceClient = recordingAttemptEvidenceClient
      || createAttemptEvidenceClient();
    const durableCheckpointTraceClient = checkpointTraceClient
      || createCheckpointTraceClient({ indexedDBImpl });
    const rotatingIndependentMp4 = segmentRotationWritesEnabled === true
      && mediaProfile?.profile?.id === 'aac-mp4'
      && mediaProfile?.recordingCodecExperiment === 'aac-mp4';
    return Object.freeze({
      attemptEvidenceClient,
      durableCheckpointTraceClient,
      recorderOptions: Object.freeze({
        ...recorderOptions,
        checkpointMode: rotatingIndependentMp4
          ? ROTATING_INDEPENDENT_MP4_MODE
          : PASSIVE_NATIVE_TIMESLICE_MODE,
        ...(rotatingIndependentMp4
          ? { captureUnitMs: IOS_AAC_CAPTURE_UNIT_MS }
          : { nativeTimesliceMs: IOS_AAC_NATIVE_TIMESLICE_MS }),
        preferredMimeType: mediaProfile.preferredMimeType,
        recordingCodecExperiment: mediaProfile.recordingCodecExperiment,
        mediaProfile,
        requireAacPrimaryGate: true,
        recordingAttemptEvidence: attemptEvidenceClient?.submit
      })
    });
  }

  if (mediaProfile?.device === 'ios-unsupported' || mediaProfile?.blocked === true) {
    return Object.freeze({
      attemptEvidenceClient: null,
      durableCheckpointTraceClient: null,
      recorderOptions: Object.freeze({
        ...recorderOptions,
        mediaProfile,
        preRecordErrorCode: mediaProfile?.errorCode || 'IOS_BROWSER_UNSUPPORTED'
      })
    });
  }

  return Object.freeze({
    attemptEvidenceClient: recordingAttemptEvidenceClient || null,
    durableCheckpointTraceClient: checkpointTraceClient || null,
    recorderOptions
  });
}

export { DEFAULT_SEGMENT_ROTATION_WRITES_ENABLED };
