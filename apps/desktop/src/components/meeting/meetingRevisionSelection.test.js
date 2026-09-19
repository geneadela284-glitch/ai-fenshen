import assert from 'node:assert/strict';
import test from 'node:test';

import {
  selectCurrentDiarizationJobs,
  selectCurrentTranscriptionJobs
} from './meetingRevisionSelection.js';

test('current transcription selection excludes historical source revisions and keeps latest deleted-source history', () => {
  const selected = selectCurrentTranscriptionJobs({
    meetingId: 'meeting-a',
    activeSources: [{ sourceId: 'source-a', revision: 4 }],
    jobs: [
      { jobId: 'source-a-r3', meetingId: 'meeting-a', sourceId: 'source-a', sourceRevision: 3, status: 'ready', updatedAt: '2026-08-16T00:01:00.000Z' },
      { jobId: 'source-a-r4', meetingId: 'meeting-a', sourceId: 'source-a', sourceRevision: 4, status: 'ready', updatedAt: '2026-08-16T00:02:00.000Z' },
      { jobId: 'deleted-source-r2', meetingId: 'meeting-a', sourceId: 'deleted-source', sourceRevision: 2, status: 'ready', updatedAt: '2026-08-16T00:01:00.000Z' },
      { jobId: 'deleted-source-r3', meetingId: 'meeting-a', sourceId: 'deleted-source', sourceRevision: 3, status: 'ready', updatedAt: '2026-08-16T00:03:00.000Z' },
      { jobId: 'other-meeting', meetingId: 'meeting-b', sourceId: 'source-a', sourceRevision: 4, status: 'ready' }
    ]
  });

  assert.deepEqual(selected.map((job) => job.jobId).sort(), ['deleted-source-r3', 'source-a-r4']);
});

test('current diarization selection follows the current transcript identity instead of a historical transcript', () => {
  const selected = selectCurrentDiarizationJobs({
    meetingId: 'meeting-a',
    currentTranscripts: {
      'source-a': { transcript: { document: { transcriptId: 'transcript-source-a-r4' } } }
    },
    jobs: [
      { jobId: 'diarization-r3', meetingId: 'meeting-a', sourceId: 'source-a', transcriptId: 'transcript-source-a-r3', transcriptRevision: 1, status: 'ready', updatedAt: '2026-08-16T00:03:00.000Z' },
      { jobId: 'diarization-r4', meetingId: 'meeting-a', sourceId: 'source-a', transcriptId: 'transcript-source-a-r4', transcriptRevision: 1, status: 'ready', updatedAt: '2026-08-16T00:02:00.000Z' },
      { jobId: 'other-meeting', meetingId: 'meeting-b', sourceId: 'source-a', transcriptId: 'transcript-source-a-r4', transcriptRevision: 1, status: 'ready' }
    ]
  });

  assert.deepEqual(selected.map((job) => job.jobId), ['diarization-r4']);
});
