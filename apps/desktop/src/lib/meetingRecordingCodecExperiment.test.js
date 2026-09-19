import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AAC_MP4_EXPERIMENT,
  MEETING_RECORDING_CODEC_EXPERIMENT_KEY,
  describeRecordingMimeType,
  getMeetingRecordingCodecExperiment,
  setMeetingRecordingCodecExperiment
} from './meetingRecordingCodecExperiment.js';

function storageHarness() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

test('candidate AAC mode survives the entry to home to meeting view sequence through sessionStorage', () => {
  const entryStorage = storageHarness();
  assert.equal(setMeetingRecordingCodecExperiment({ storage: entryStorage }, AAC_MP4_EXPERIMENT), true);
  assert.equal(entryStorage.getItem(MEETING_RECORDING_CODEC_EXPERIMENT_KEY), AAC_MP4_EXPERIMENT);

  const homeStorage = entryStorage;
  const meetingStorage = homeStorage;
  assert.equal(getMeetingRecordingCodecExperiment({ storage: meetingStorage }), AAC_MP4_EXPERIMENT);
});

test('invalid or unavailable candidate mode remains disabled', () => {
  const storage = storageHarness();
  storage.setItem(MEETING_RECORDING_CODEC_EXPERIMENT_KEY, 'webm');
  assert.equal(getMeetingRecordingCodecExperiment({ storage }), '');
  assert.equal(getMeetingRecordingCodecExperiment({ storage: null }), '');
});

test('recording MIME metadata identifies AAC MP4 and WebM Opus without audio content', () => {
  assert.deepEqual(describeRecordingMimeType('audio/mp4;codecs=mp4a.40.2'), {
    mimeType: 'audio/mp4;codecs=mp4a.40.2',
    container: 'MP4',
    codec: 'AAC'
  });
  assert.deepEqual(describeRecordingMimeType('audio/webm;codecs=opus'), {
    mimeType: 'audio/webm;codecs=opus',
    container: 'WebM',
    codec: 'Opus'
  });
});
