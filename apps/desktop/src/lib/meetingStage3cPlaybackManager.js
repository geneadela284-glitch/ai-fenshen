import { assertStage3cPlaybackCapability, playbackMimeForSource } from './meetingStage3cPlaybackCapability.js';
import { buildStage3cPlaybackTimeline, resolveStage3cPlaybackWindow } from './meetingStage3cPlaybackWindowPlanner.js';
import {
  CONTINUOUS_FRAGMENT_STREAM_V1,
  INDEPENDENT_MP4_SEGMENTS_V1
} from './meetingRecordingContainerLayout.js';

function codedError(code, cause = null) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function sameBinding(left, right) {
  const leftLayout = String(left?.containerLayout || CONTINUOUS_FRAGMENT_STREAM_V1);
  const rightLayout = String(right?.containerLayout || CONTINUOUS_FRAGMENT_STREAM_V1);
  return left?.sourceId === right?.sourceId && left?.meetingId === right?.meetingId && Number(left?.revision) === Number(right?.revision) && Number(left?.durationMs) === Number(right?.durationMs) && Number(left?.byteLength) === Number(right?.byteLength) && Number(left?.chunkCount) === Number(right?.chunkCount) && String(left?.checksum || '') === String(right?.checksum || '') && leftLayout === rightLayout;
}

export function createStage3cPlaybackManager({
  ownerContext,
  audioStore,
  player,
  playerFactory,
  capabilityDetector,
  sourceBoundaryVerifier = (source) => source?.format !== 'webm-opus' && !String(source?.mimeType || '').startsWith('audio/webm'),
  initBytesProvider = async () => new Uint8Array(),
  webmReassemblyAdapter = null,
  aacStoredFragmentAdapter = null,
  independentMp4SegmentAdapter = null
} = {}) {
  if (!ownerContext || !audioStore) throw codedError('PLAYBACK_DEPENDENCY_UNAVAILABLE');
  const currentPlayer = player || playerFactory?.();
  if (!currentPlayer) throw codedError('PLAYBACK_PLAYER_UNAVAILABLE');
  const detect = capabilityDetector || (() => ({ supported: false, errorCode: 'PLAYBACK_UNSUPPORTED' }));
  let opened = null;
  let disposed = false;
  let mutationQueue = Promise.resolve();
  let pendingSeek = null;
  let seekDrainScheduled = false;

  function enqueueMutation(operation) {
    const next = mutationQueue.catch(() => {}).then(operation);
    mutationQueue = next.catch(() => {});
    return next;
  }

  async function latestSource() {
    if (!opened) throw codedError('PLAYBACK_NOT_OPEN');
    const latest = await audioStore.getAudioSource(ownerContext, opened.meetingId, opened.sourceId);
    if (!sameBinding(opened.source, latest)) throw codedError('PLAYBACK_BINDING_MISMATCH');
    return latest;
  }

  async function open({ meetingId, sourceId, initialTimeMs = 0 } = {}) {
    if (disposed) throw codedError('PLAYBACK_MANAGER_DISPOSED');
    const source = await audioStore.getAudioSource(ownerContext, meetingId, sourceId);
    const meeting = await audioStore.getMeeting(ownerContext, meetingId);
    const boundSource = meeting?.audioSources?.find((item) => item.sourceId === sourceId);
    if (!boundSource || !sameBinding(source, boundSource)) throw codedError('PLAYBACK_BINDING_MISMATCH');
    const timeline = buildStage3cPlaybackTimeline({ source, segments: meeting.segments });
    const mimeType = playbackMimeForSource(source);
    const capability = assertStage3cPlaybackCapability(await detect({ source, mimeType, ownerContext }));
    if (opened) await currentPlayer.dispose?.();
    opened = { meetingId, sourceId, source, timeline, mimeType, capability, window: null };
    try {
      // Opening a session is also the first bounded prepare. This keeps the
      // formal Meeting path identical to every later seek and prevents the
      // first user Play from racing a lazy, unopened player.
      await performSeek(initialTimeMs, { autoplay: false });
      return getSnapshot();
    } catch (error) {
      try { await currentPlayer.dispose?.(); } catch { /* preserve the original open error */ }
      opened = null;
      throw error;
    }
  }

  async function performSeek(targetMs, { autoplay = false } = {}) {
    if (disposed) throw codedError('PLAYBACK_MANAGER_DISPOSED');
    if (!opened) throw codedError('PLAYBACK_NOT_OPEN');
    const source = await latestSource();
    const window = resolveStage3cPlaybackWindow(opened.timeline, targetMs, { maxMediaChunks: 3 });
    const isWebm = String(opened.mimeType || '').startsWith('audio/webm');
    const isAac = String(opened.mimeType || '').startsWith('audio/mp4')
      || ['m4a', 'aac'].includes(String(source?.format || '').toLowerCase());
    const containerLayout = String(source?.containerLayout || CONTINUOUS_FRAGMENT_STREAM_V1);
    let initBytes;
    let mediaChunks;
    if (isWebm) {
      if (!webmReassemblyAdapter?.readWindow) throw codedError('PLAYBACK_SOURCE_BOUNDARY_UNVERIFIED');
      const assembled = await webmReassemblyAdapter.readWindow({
        ownerContext,
        source,
        timeline: opened.timeline,
        targetMs: window.targetMs
      });
      if (assembled?.classification !== 'STORED_WEBM_REQUIRES_BOUNDED_REASSEMBLY_SUPPORTED') {
        throw codedError('PLAYBACK_SOURCE_BOUNDARY_UNVERIFIED');
      }
      initBytes = assembled.initBytes;
      mediaChunks = assembled.mediaChunks;
    } else {
      if (!sourceBoundaryVerifier(source)) throw codedError('PLAYBACK_SOURCE_BOUNDARY_UNVERIFIED');
      if (containerLayout === INDEPENDENT_MP4_SEGMENTS_V1) {
        if (!isAac || !independentMp4SegmentAdapter?.readWindow) {
          throw codedError('PLAYBACK_INDEPENDENT_SOURCE_UNSUPPORTED');
        }
        const assembled = await independentMp4SegmentAdapter.readWindow({
          ownerContext,
          source,
          window
        });
        if (assembled?.classification !== 'STORED_AAC_INDEPENDENT_MP4_SEGMENTS_SUPPORTED') {
          throw codedError('PLAYBACK_INDEPENDENT_SOURCE_UNSUPPORTED');
        }
        initBytes = assembled.initBytes;
        mediaChunks = assembled.mediaChunks;
      } else if (containerLayout !== CONTINUOUS_FRAGMENT_STREAM_V1) {
        throw codedError('PLAYBACK_CONTAINER_LAYOUT_UNSUPPORTED');
      } else if (isAac && aacStoredFragmentAdapter?.readWindow) {
        const assembled = await aacStoredFragmentAdapter.readWindow({
          ownerContext,
          source,
          window
        });
        if (assembled?.classification !== 'STORED_AAC_STORED_FRAGMENTS_SUPPORTED') {
          throw codedError('PLAYBACK_AAC_SOURCE_UNSUPPORTED');
        }
        initBytes = assembled.initBytes;
        mediaChunks = assembled.mediaChunks;
      } else {
        initBytes = await initBytesProvider({ ownerContext, source, window, entries: window.mediaChunks });
        if (!initBytes || typeof initBytes.byteLength !== 'number' || initBytes.byteLength === 0) throw codedError('PLAYBACK_INIT_SEGMENT_UNAVAILABLE');
        mediaChunks = [];
        for (const entry of window.mediaChunks) {
          const bytes = await audioStore.readAudioSegment(ownerContext, opened.meetingId, entry.sourceChunkId);
          mediaChunks.push(Object.freeze({ ...entry, bytes }));
        }
      }
    }
    const afterRead = await latestSource();
    if (!sameBinding(source, afterRead)) throw codedError('PLAYBACK_BINDING_MISMATCH');
    await currentPlayer.loadWindow({
      mimeType: opened.mimeType,
      initBytes,
      mediaChunks,
      targetMs: window.targetMs,
      autoplay
    });
    opened = { ...opened, window };
    return getSnapshot();
  }

  function rejectPendingSeeks(error) {
    const batch = pendingSeek;
    pendingSeek = null;
    if (!batch) return;
    for (const waiter of batch.waiters) waiter.reject(error);
  }

  function scheduleSeekDrain() {
    if (seekDrainScheduled || !pendingSeek) return;
    seekDrainScheduled = true;
    const scheduled = enqueueMutation(async () => {
      const batch = pendingSeek;
      pendingSeek = null;
      if (!batch) return;
      try {
        const result = await performSeek(batch.targetMs, batch.options);
        for (const waiter of batch.waiters) waiter.resolve(result);
      } catch (error) {
        for (const waiter of batch.waiters) waiter.reject(error);
        rejectPendingSeeks(error);
      }
    });
    scheduled.catch(() => {}).finally(() => {
      seekDrainScheduled = false;
      if (pendingSeek) scheduleSeekDrain();
    });
  }

  function seekTo(targetMs, { autoplay = false } = {}) {
    if (disposed) return Promise.reject(codedError('PLAYBACK_MANAGER_DISPOSED'));
    if (!opened) return Promise.reject(codedError('PLAYBACK_NOT_OPEN'));
    return new Promise((resolve, reject) => {
      if (!pendingSeek) pendingSeek = { targetMs, options: { autoplay }, waiters: [] };
      else {
        pendingSeek.targetMs = targetMs;
        pendingSeek.options = { autoplay };
      }
      pendingSeek.waiters.push({ resolve, reject });
      scheduleSeekDrain();
    });
  }

  async function skipBy(deltaMs, options) {
    if (!opened) throw codedError('PLAYBACK_NOT_OPEN');
    const currentMs = Number(currentPlayer.audio?.currentTime || 0) * 1_000;
    return seekTo(Math.max(0, Math.min(opened.timeline.durationMs, currentMs + Number(deltaMs || 0))), options);
  }

  async function play() {
    return currentPlayer.play();
  }

  async function pause() {
    if (pendingSeek) pendingSeek.options = { ...pendingSeek.options, autoplay: false };
    return enqueueMutation(() => currentPlayer.pause());
  }

  async function dispose() {
    disposed = true;
    rejectPendingSeeks(codedError('PLAYBACK_MANAGER_DISPOSED'));
    await mutationQueue.catch(() => {});
    await currentPlayer.dispose?.();
    opened = null;
  }

  function getSnapshot() {
    const resources = currentPlayer.getSnapshot?.() || null;
    return Object.freeze({
      opened: Boolean(opened),
      meetingId: opened?.meetingId || null,
      sourceId: opened?.sourceId || null,
      revision: opened?.source?.revision ?? null,
      durationMs: opened?.timeline?.durationMs ?? 0,
      currentTargetMs: opened?.window?.targetMs ?? null,
      mimeType: opened?.mimeType || null,
      capability: opened?.capability || null,
      windowSequences: Object.freeze(opened?.window?.mediaChunks?.map((entry) => entry.sequence) || []),
      requiresUserGesture: Boolean(resources?.requiresUserGesture),
      resources
    });
  }

  return Object.freeze({ open, seekTo, skipBy, play, pause, dispose, getSnapshot });
}
