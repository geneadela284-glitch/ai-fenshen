export const meetingStatuses = Object.freeze({
  DRAFT: 'draft',
  RECORDING: 'recording',
  PAUSED: 'paused',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ARCHIVED: 'archived'
});

export const meetingTranscriptSources = Object.freeze({
  PASTE: 'paste',
  IMPORT: 'import',
  MANUAL: 'manual'
});

export const meetingActionStatuses = Object.freeze({
  CANDIDATE: 'candidate',
  CONFIRMED: 'confirmed',
  CREATED: 'created',
  DISMISSED: 'dismissed'
});

export const meetingPriorities = Object.freeze({
  LOW: 'low',
  NORMAL: 'normal',
  HIGH: 'high'
});

export const MEETING_STORAGE_KEY = 'aiworkcenter.meetings.v1';
