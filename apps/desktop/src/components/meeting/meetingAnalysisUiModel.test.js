import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMeetingAnalysisViewModel,
  formatEvidenceTime,
  unresolvedLabel
} from './meetingAnalysisUiModel.js';

test('analysis view model keeps grounded facts and exposes human-readable evidence actions', () => {
  const model = buildMeetingAnalysisViewModel({
    status: 'CURRENT',
    groundingStatus: 'GROUNDING_SUPPORTED',
    summary: {
      topic: { value: '报价方案', evidenceRefs: [{ evidenceRefId: 'e-1', startMs: 110000, endMs: 112000 }] },
      overview: { value: '讨论报价交付节奏', evidenceRefs: [{ evidenceRefId: 'e-1', startMs: 110000, endMs: 112000 }] },
      keyPoints: [{ content: '先确认交付时间', evidenceRefs: [{ evidenceRefId: 'e-1', startMs: 110000, endMs: 112000 }] }],
      conclusions: [],
      openQuestions: []
    },
    decisions: [{ decisionId: 'd-1', content: '本周确认报价', status: 'confirmed', evidenceRefs: [{ evidenceRefId: 'e-1', startMs: 110000, endMs: 112000 }] }],
    actionItems: [{ actionId: 'a-1', content: '整理报价单', owner: 'unresolved', dueDate: 'unresolved', status: 'unresolved', evidenceRefs: [{ evidenceRefId: 'e-1', startMs: 110000, endMs: 112000 }] }],
    evidenceRefs: [{ evidenceRefId: 'e-1', startMs: 110000, endMs: 112000, status: 'VALID', textSpan: { quote: '本周确认报价' } }]
  });

  assert.equal(model.state, 'current');
  assert.equal(model.summary.topic, '报价方案');
  assert.equal(model.decisions[0].statusLabel, '已确认');
  assert.equal(model.actionItems[0].ownerLabel, unresolvedLabel);
  assert.equal(model.actionItems[0].dueDateLabel, unresolvedLabel);
  assert.equal(model.evidenceById['e-1'].timeLabel, '01:50');
  assert.equal(model.evidenceById['e-1'].actions[0].label, '查看原话');
  assert.equal(model.evidenceById['e-1'].actions[1].label, '回听 01:50');
});

test('unavailable and stale analysis never becomes a supported result', () => {
  for (const status of ['STALE', 'INVALID', 'REVALIDATION_REQUIRED']) {
    const model = buildMeetingAnalysisViewModel({ status, groundingStatus: status });
    assert.equal(model.state, status.toLowerCase());
    assert.equal(model.displayable, false);
  }
  assert.equal(formatEvidenceTime(0), '00:00');
  assert.equal(formatEvidenceTime(3_661_000), '01:01:01');
});
