function codedError(code, cause = null) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

export function reloadMeetingRecorderSession({
  locationImpl = globalThis.location,
  now = () => Date.now()
} = {}) {
  if (typeof locationImpl?.replace !== 'function') return false;
  const href = String(locationImpl?.href || '');
  if (!href) return false;
  try {
    const nextUrl = new URL(href);
    const value = Number(now());
    nextUrl.searchParams.set(
      '__meeting_recorder_session',
      String(Number.isFinite(value) ? value : Date.now())
    );
    locationImpl.replace(nextUrl.toString());
    return true;
  } catch {
    return false;
  }
}

function committedDuration(raw) {
  const value = Number(raw?.active?.meeting?.committedDurationMs);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function trueRecording(raw) {
  return raw?.active?.meeting?.recordingState === 'recording'
    && raw?.recorderStatus === 'recording'
    && raw?.recorderInfo?.actualStarted === true;
}

function durationText(durationMs) {
  const totalSeconds = Math.floor(Math.max(0, durationMs) / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const pair = (value) => String(value).padStart(2, '0');
  return hours > 0
    ? `${pair(hours)}:${pair(minutes)}:${pair(seconds)}`
    : `${pair(totalMinutes)}:${pair(seconds)}`;
}

function presentation(raw, isRecording, mutationKind) {
  const state = raw?.active?.meeting?.recordingState;
  const reason = raw?.active?.meeting?.interruptionReason;
  if (mutationKind === 'pause') return { status: '正在暂停', message: '正在安全暂停录音，请稍候。' };
  if (mutationKind === 'end') return { status: '正在结束', message: '正在安全结束并保存录音，请稍候。' };
  if (raw?.active?.meeting?.persistenceStalled === true) {
    return { status: '保存需要检查', message: '录音仍在继续，但最近一次持久化检查未完成，请保持页面打开。' };
  }
  if (isRecording) return { status: '正在录音', message: '录音正在进行，请保持麦克风畅通。' };
  if (state === 'interrupted' && reason === 'user_pause') {
    return { status: '已暂停', message: '录音已暂停，可以继续录音或结束会议。' };
  }
  if (state === 'interrupted') {
    return { status: '已中断', message: '录音已中断，需要您明确选择继续录音。' };
  }
  if (state === 'finalization_pending') {
    return {
      status: '已安全保存，待完成封存',
      message: `已安全保存至 ${durationText(committedDuration(raw))}，最后尾段待封存；可再次点击结束并保存完成封存。`
    };
  }
  if (state === 'stopped') return { status: '已结束', message: '录音已结束。' };
  if (state === 'failed_retryable' || state === 'failed') {
    return { status: '录音未完成', message: '录音没有正常开始或保存，请检查后重试。' };
  }
  if (state === 'recording' || raw?.recorderStatus === 'starting') {
    return { status: '正在准备', message: '正在请求麦克风并准备录音，请稍候。' };
  }
  return { status: '准备录音', message: '准备就绪后即可开始录音。' };
}

function safeMicrophoneSnapshot(microphoneMeter) {
  const measured = microphoneMeter?.getSnapshot?.();
  const available = measured?.available === true;
  const level = available && Number.isFinite(Number(measured?.level))
    ? Math.min(1, Math.max(0, Number(measured.level)))
    : 0;
  const bars = available && Array.isArray(measured?.bars)
    ? measured.bars.map((value) => Math.min(1, Math.max(0, Number(value) || 0)))
    : [];
  return Object.freeze({ available, level, bars: Object.freeze(bars) });
}

export function createMeetingStage3cRecordingExperience({
  manager,
  microphoneMeter = null,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  setIntervalImpl = globalThis.setInterval,
  clearIntervalImpl = globalThis.clearInterval,
  tickIntervalMs = 250,
  reloadRecorderSession = reloadMeetingRecorderSession
} = {}) {
  for (const method of ['getSnapshot', 'subscribe', 'startRecording', 'interruptRecording', 'stopRecording']) {
    if (typeof manager?.[method] !== 'function') throw new TypeError(`manager.${method} is required`);
  }
  if (typeof now !== 'function') throw new TypeError('monotonic time source is required');

  let raw = manager.getSnapshot();
  let meetingIdentity = raw?.active?.meeting?.meetingId ?? null;
  let durationBaseMs = committedDuration(raw);
  let durationAnchor = trueRecording(raw) ? now() : null;
  let lastDurationMs = durationBaseMs;
  let activeMutation = null;
  let activeMutationKind = null;
  let disposed = false;
  let timerTick = null;
  const listeners = new Set();

  function currentDuration(at = now()) {
    const elapsed = durationAnchor === null ? 0 : Math.max(0, at - durationAnchor);
    const projected = Math.floor(durationBaseMs + elapsed);
    lastDurationMs = Math.max(lastDurationMs, projected);
    return lastDurationMs;
  }

  function rebase(nextRaw) {
    const at = now();
    const nextIdentity = nextRaw?.active?.meeting?.meetingId ?? null;
    const nextCommitted = committedDuration(nextRaw);
    const wasRecording = trueRecording(raw);
    const isRecording = trueRecording(nextRaw);
    if (nextIdentity !== meetingIdentity) {
      meetingIdentity = nextIdentity;
      durationBaseMs = nextCommitted;
      lastDurationMs = nextCommitted;
    } else if (!isRecording && ['interrupted', 'stopped', 'finalization_pending'].includes(nextRaw?.active?.meeting?.recordingState)) {
      // Live time is only a projection. At a durable boundary the saved media,
      // not elapsed wall time, is authoritative for playback and transcription.
      durationBaseMs = nextCommitted;
      lastDurationMs = nextCommitted;
    } else {
      const beforeUpdate = currentDuration(at);
      durationBaseMs = Math.max(beforeUpdate, nextCommitted);
      lastDurationMs = durationBaseMs;
    }
    durationAnchor = isRecording ? at : null;
    raw = nextRaw;

    if (microphoneMeter?.stop && !isRecording && wasRecording) {
      void microphoneMeter.stop();
    }
  }

  function buildSnapshot() {
    const recording = trueRecording(raw) && !['pause', 'end'].includes(activeMutationKind);
    const state = raw?.active?.meeting?.recordingState;
    const reason = raw?.active?.meeting?.interruptionReason;
    const durationMs = currentDuration();
    const copy = presentation(raw, recording, activeMutationKind);
    return Object.freeze({
      status: copy.status,
      message: copy.message,
      isRecording: recording,
      isPaused: state === 'interrupted' && reason === 'user_pause',
      isInterrupted: state === 'interrupted' && reason !== 'user_pause',
      isFinalizationPending: state === 'finalization_pending',
      isStopped: state === 'stopped',
      isBusy: activeMutationKind !== null,
      canStart: !activeMutationKind && ['draft', 'ready', 'failed_retryable'].includes(state),
      canPause: !activeMutationKind && recording,
      canResume: !activeMutationKind && state === 'interrupted',
      canEnd: !activeMutationKind && Boolean(raw?.active?.meeting) && state !== 'stopped',
      durationMs,
      durationText: durationText(durationMs),
      persistenceStalled: raw?.active?.meeting?.persistenceStalled === true,
      lastSuccessfulPersistAt: raw?.active?.meeting?.lastSuccessfulPersistAt || '',
      lastPersistedSequence: Number.isSafeInteger(raw?.active?.meeting?.lastPersistedSequence)
        ? raw.active.meeting.lastPersistedSequence
        : -1,
      microphone: safeMicrophoneSnapshot(microphoneMeter)
    });
  }

  function notify() {
    const snapshot = buildSnapshot();
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // A UI observer cannot interrupt a recording mutation.
      }
    }
  }

  function syncTimer() {
    const shouldTick = !disposed && trueRecording(raw) && !['pause', 'end'].includes(activeMutationKind);
    if (shouldTick && timerTick === null) {
      timerTick = setIntervalImpl(notify, Math.max(100, Number(tickIntervalMs) || 250));
    } else if (!shouldTick && timerTick !== null) {
      clearIntervalImpl(timerTick);
      timerTick = null;
    }
  }

  const unsubscribeManager = manager.subscribe((nextRaw) => {
    if (disposed) return;
    rebase(nextRaw || manager.getSnapshot());
    syncTimer();
    notify();
  });
  const unsubscribeMeter = typeof microphoneMeter?.subscribe === 'function'
    ? microphoneMeter.subscribe(() => {
      if (!disposed) notify();
    })
    : () => {};
  syncTimer();

  function mutate(operation, { kind, cleanupOnFailure = false, cleanupAfter = false } = {}) {
    if (activeMutation) return activeMutation;
    activeMutationKind = kind;
    const timingBeforeMutation = kind === 'pause' || kind === 'end'
      ? { durationBaseMs, durationAnchor, lastDurationMs }
      : null;
    if (kind === 'pause' || kind === 'end') {
      durationBaseMs = currentDuration();
      durationAnchor = null;
    }
    syncTimer();
    let resolveMutation;
    let rejectMutation;
    const pending = new Promise((resolve, reject) => {
      resolveMutation = resolve;
      rejectMutation = reject;
    });
    activeMutation = pending;
    notify();
    const runner = (async () => {
      let succeeded = false;
      try {
        const result = await operation();
        succeeded = true;
        return result;
      } catch (error) {
        if (cleanupOnFailure) await microphoneMeter?.stop?.();
        throw error;
      } finally {
        if (cleanupAfter && succeeded) await microphoneMeter?.stop?.();
        activeMutation = null;
        activeMutationKind = null;
        const nextRaw = manager.getSnapshot();
        if (!succeeded && timingBeforeMutation && trueRecording(nextRaw)) {
          durationBaseMs = timingBeforeMutation.durationBaseMs;
          durationAnchor = timingBeforeMutation.durationAnchor;
          lastDurationMs = timingBeforeMutation.lastDurationMs;
        }
        rebase(nextRaw);
        syncTimer();
        notify();
      }
    })();
    void runner.then(resolveMutation, rejectMutation);
    return pending;
  }

  return Object.freeze({
    getSnapshot: buildSnapshot,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('experience listener is required');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      return mutate(() => manager.startRecording(), { kind: 'start', cleanupOnFailure: true });
    },
    pause() {
      const operation = typeof manager.pauseRecording === 'function'
        ? () => manager.pauseRecording()
        : () => manager.interruptRecording('user_pause');
      return mutate(async () => {
        const result = await operation();
        if (result?.recorderSessionBoundary === true) reloadRecorderSession();
        return result;
      }, { kind: 'pause', cleanupAfter: true });
    },
    resume() {
      const operation = typeof manager.resumeRecording === 'function'
        ? () => manager.resumeRecording()
        : () => manager.startRecording();
      return mutate(operation, { kind: 'resume', cleanupOnFailure: true });
    },
    end() {
      return mutate(() => manager.stopRecording(), { kind: 'end', cleanupAfter: true });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeManager?.();
      unsubscribeMeter?.();
      syncTimer();
      listeners.clear();
      await microphoneMeter?.dispose?.();
    }
  });
}
