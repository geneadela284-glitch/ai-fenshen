import { assertOwnerContext } from '../../../../core/meeting/stage3a/transcriptContracts.js';
import {
  assertResultInput,
  deterministicId,
  optionalSpeakerRevisionFields
} from '../../../../core/meeting/stage4/meetingBrainContractUtils.js';
import { createMeetingAnalysisBundle } from '../../../../core/meeting/stage4/meetingAnalysisBundleContracts.js';
import { createMeetingBrainEngine } from '../../../../core/meeting/stage4/meetingBrainEngine.js';
import { resolveMeetingAnalysisSource } from '../components/meeting/meetingAnalysisSource.js';

export const MEETING_ANALYSIS_ENGINE_VERSION = 'stage4-phase2';
export const MEETING_ANALYSIS_STATUS = Object.freeze({
  IDLE: 'idle',
  ANALYZING: 'analyzing',
  READY: 'ready',
  FAILED: 'failed'
});

function codedError(code, details = null) {
  const error = new Error(code);
  error.code = code;
  if (details !== null) error.details = details;
  return error;
}

function required(value, code) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw codedError(code);
  return normalized;
}

function validateDependencies(analysisBundles, engine) {
  if (!analysisBundles || typeof analysisBundles.list !== 'function' || typeof analysisBundles.save !== 'function') {
    throw codedError('MEETING_ANALYSIS_STORE_REQUIRED');
  }
  if (!engine || typeof engine.generate !== 'function') throw codedError('MEETING_BRAIN_ENGINE_REQUIRED');
}

function legacyRequestKey({ ownerContext, source, transcriptRevision, diarizationRevision, speakerCorrectionRevision }) {
  return deterministicId('meeting-analysis-request', {
    engine: MEETING_ANALYSIS_ENGINE_VERSION,
    ownerId: ownerContext.ownerId,
    scope: 'meeting',
    meetingId: source.meetingId,
    sourceId: source.sourceId,
    sourceRevision: Number(source.revision),
    transcriptId: transcriptRevision.transcriptId,
    transcriptRevision: Number(transcriptRevision.transcriptRevision),
    segments: transcriptRevision.segments.map((segment) => ({
      segmentId: segment.segmentId,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text
    })),
    ...optionalSpeakerRevisionFields({ diarizationRevision, speakerCorrectionRevision })
  });
}

function requestKey(input) {
  // Explicit dependency identity keeps an unbound retry distinct from an old
  // request whose saved result depended on a speaker mapping that is not loaded.
  return deterministicId('meeting-analysis-request', {
    dependencyVersion: 2,
    dependencyKey: legacyRequestKey(input)
  });
}

function analysisRevision(values) {
  return values.reduce((highest, value) => Math.max(highest, Number(value.analysisRevision) || 0), 0) + 1;
}

function latestBundle(values) {
  return [...values].sort((left, right) => Number(right.analysisRevision || 0) - Number(left.analysisRevision || 0))[0] || null;
}

function isCurrent(bundle) {
  return bundle?.status === 'CURRENT' && bundle?.groundingStatus === 'GROUNDING_SUPPORTED';
}

export function createMeetingAnalysisManager({
  ownerContext: inputOwnerContext,
  analysisBundles,
  engine = null,
  modelRunner = null,
  now = () => new Date().toISOString()
} = {}) {
  const ownerContext = assertOwnerContext(inputOwnerContext);
  const resolvedEngine = engine || createMeetingBrainEngine({ modelRunner });
  validateDependencies(analysisBundles, resolvedEngine);

  let state = Object.freeze({
    status: MEETING_ANALYSIS_STATUS.IDLE,
    bundle: null,
    errorCode: '',
    diagnostics: null
  });
  const listeners = new Set();
  const inflight = new Map();

  function notify() {
    for (const listener of listeners) {
      try {
        listener(getSnapshot());
      } catch {
        // UI observers must never interrupt analysis or persistence.
      }
    }
  }

  function setState(next) {
    state = Object.freeze({
      ...state,
      ...next,
      bundle: next.bundle === undefined ? state.bundle : next.bundle
    });
    notify();
  }

  function getSnapshot() {
    return Object.freeze({
      status: state.status,
      bundle: state.bundle,
      errorCode: state.errorCode,
      diagnostics: state.diagnostics
    });
  }

  async function loadBundles(source, transcriptRevision, diarizationRevision, speakerCorrectionRevision) {
    return analysisBundles.list(ownerContext, {
      meetingId: required(source.meetingId, 'MEETING_ID_REQUIRED'),
      currentContext: {
        source,
        currentTranscriptRevision: transcriptRevision,
        currentDiarizationRevision: diarizationRevision,
        currentSpeakerCorrectionRevision: speakerCorrectionRevision
      }
    });
  }

  async function getCurrent({ source, transcriptRevision, diarizationRevision, speakerCorrectionRevision } = {}) {
    const trusted = assertResultInput({ ownerContext,
      source: resolveMeetingAnalysisSource(source, transcriptRevision), transcriptRevision });
    const values = await loadBundles(trusted.source, trusted.transcriptRevision, diarizationRevision, speakerCorrectionRevision);
    return values.find(isCurrent) || null;
  }

  async function analyze(input = {}) {
    const trusted = assertResultInput({
      ownerContext,
      source: resolveMeetingAnalysisSource(input.source, input.transcriptRevision),
      transcriptRevision: input.transcriptRevision
    });
    const dependencies = {
      ...trusted,
      diarizationRevision: input.diarizationRevision,
      speakerCorrectionRevision: input.speakerCorrectionRevision
    };
    const key = requestKey(dependencies);
    const reusableKeys = new Set([
      key,
      requestKey(trusted),
      legacyRequestKey(dependencies),
      legacyRequestKey(trusted)
    ]);
    // Reuse only results whose saved evidence is current in this exact context.
    const findReusable = (values) => values.find((value) => isCurrent(value)
      && reusableKeys.has(value.idempotencyKey));
    const activeRequest = inflight.get(key);
    if (activeRequest) return activeRequest;

    const operation = (async () => {
      let preservedBundle = state.bundle;
      try {
        const values = await loadBundles(
          trusted.source,
          trusted.transcriptRevision,
          input.diarizationRevision,
          input.speakerCorrectionRevision
        );
        preservedBundle = values.find(isCurrent) || preservedBundle;
        const existing = findReusable(values);
        if (existing && isCurrent(existing)) {
          setState({ status: MEETING_ANALYSIS_STATUS.READY, bundle: existing, errorCode: '', diagnostics: null });
          return Object.freeze({ idempotent: true, bundle: existing });
        }

        setState({ status: MEETING_ANALYSIS_STATUS.ANALYZING, bundle: preservedBundle, errorCode: '', diagnostics: null });
        const result = await resolvedEngine.generate({
          ownerContext,
          source: trusted.source,
          transcriptRevision: trusted.transcriptRevision,
          currentTranscriptRevision: input.currentTranscriptRevision || trusted.transcriptRevision,
          diarizationRevision: input.diarizationRevision,
          speakerCorrectionRevision: input.speakerCorrectionRevision,
          meetingMetadata: input.meetingMetadata
        });
        if (!result?.ok || !result.data || !['ready', 'partial'].includes(result.status)) {
          throw codedError(result?.code || 'AI_ANALYSIS_UNAVAILABLE', result?.diagnostics || null);
        }

        const parent = latestBundle(values);
        const timestamp = String(now());
        const bundle = createMeetingAnalysisBundle({
          ownerContext,
          source: trusted.source,
          transcriptRevision: trusted.transcriptRevision,
          diarizationRevision: input.diarizationRevision,
          speakerCorrectionRevision: input.speakerCorrectionRevision,
          analysisId: deterministicId('meeting-analysis', { requestKey: key }),
          analysisRevision: analysisRevision(values),
          parentAnalysisId: parent?.analysisId || null,
          idempotencyKey: key,
          groundingPolicyVersion: 'meeting-grounding-v1',
          analysisEngineVersion: MEETING_ANALYSIS_ENGINE_VERSION,
          provenance: { capability: 'MEETING_SUMMARY' },
          result,
          createdAt: timestamp,
          updatedAt: timestamp
        });
        let saved;
        try {
          saved = await analysisBundles.save(ownerContext, { bundle });
        } catch (error) {
          if (error?.code !== 'ANALYSIS_IDEMPOTENCY_CONFLICT') throw error;
          // Another manager can finish while this one is generating. Read and
          // validate the winner; never overwrite it or relax the store contract.
          const concurrent = findReusable(await loadBundles(
            trusted.source,
            trusted.transcriptRevision,
            input.diarizationRevision,
            input.speakerCorrectionRevision
          ));
          if (!concurrent) throw error;
          saved = { idempotent: true, bundle: concurrent };
        }
        const savedBundle = saved?.bundle || bundle;
        setState({
          status: MEETING_ANALYSIS_STATUS.READY,
          bundle: savedBundle,
          errorCode: '',
          diagnostics: result.diagnostics || null
        });
        return Object.freeze({ idempotent: saved?.idempotent === true, bundle: savedBundle });
      } catch (error) {
        const failure = error?.code ? error : codedError('AI_ANALYSIS_UNAVAILABLE', { cause: error?.message || '' });
        setState({
          status: MEETING_ANALYSIS_STATUS.FAILED,
          bundle: preservedBundle,
          errorCode: failure.code,
          diagnostics: failure.details || null
        });
        throw failure;
      }
    })();

    inflight.set(key, operation);
    try {
      return await operation;
    } finally {
      if (inflight.get(key) === operation) inflight.delete(key);
    }
  }

  return Object.freeze({
    analyze,
    getCurrent,
    getSnapshot,
    subscribe(listener) {
      if (typeof listener !== 'function') throw codedError('MEETING_ANALYSIS_LISTENER_REQUIRED');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      listeners.clear();
    }
  });
}
