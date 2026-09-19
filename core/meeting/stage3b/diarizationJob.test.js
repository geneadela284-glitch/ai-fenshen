import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DIARIZATION_JOB_STATUSES,
  createDiarizationJob,
  transitionDiarizationJob
} from './diarizationJob.js';

test('creates a diarization job scoped to the raw transcript revision', () => {
  const job = createDiarizationJob({
    jobId: 'diarization-job-1',
    ownerId: 'owner-a',
    meetingId: 'meeting-1',
    sourceId: 'source-1',
    transcriptId: 'transcript-1',
    transcriptRevision: 7,
    speakerCount: 3,
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z'
  });

  assert.equal(job.status, 'queued');
  assert.equal(job.mode, 'diarization');
  assert.equal(job.speakerCount, 3);
  assert.deepEqual(DIARIZATION_JOB_STATUSES, [
    'queued', 'preparing', 'diarizing', 'stitching', 'ready', 'failed', 'blocked', 'cancelled'
  ]);
});

test('allows only explicit diarization state transitions and preserves revision scope', () => {
  const initial = createDiarizationJob({
    jobId: 'diarization-job-1',
    ownerId: 'owner-a',
    meetingId: 'meeting-1',
    sourceId: 'source-1',
    transcriptId: 'transcript-1',
    transcriptRevision: 7,
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z'
  });
  const preparing = transitionDiarizationJob(initial, 'preparing', { at: '2026-08-08T00:01:00.000Z' });
  const diarizing = transitionDiarizationJob(preparing, 'diarizing', { at: '2026-08-08T00:02:00.000Z' });
  const stitching = transitionDiarizationJob(diarizing, 'stitching', { at: '2026-08-08T00:03:00.000Z' });
  const ready = transitionDiarizationJob(stitching, 'ready', { at: '2026-08-08T00:04:00.000Z' });

  assert.equal(ready.status, 'ready');
  assert.equal(ready.transcriptRevision, 7);
  assert.equal(ready.revision, 5);
  assert.throws(
    () => transitionDiarizationJob(initial, 'ready'),
    (error) => error.code === 'DIARIZATION_JOB_TRANSITION_INVALID'
  );
  assert.throws(
    () => transitionDiarizationJob(ready, 'diarizing'),
    (error) => error.code === 'DIARIZATION_JOB_TRANSITION_INVALID'
  );
});
