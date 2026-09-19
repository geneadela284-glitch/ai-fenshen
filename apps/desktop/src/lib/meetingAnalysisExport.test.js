import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMeetingAnalysisMarkdown,
  exportMeetingAnalysisToWord
} from './meetingAnalysisExport.js';

const analysis = {
  status: 'CURRENT',
  groundingStatus: 'GROUNDING_SUPPORTED',
  summary: {
    topic: { value: '报价方案' },
    overview: { value: '讨论报价交付节奏' },
    keyPoints: [{ content: '先确认交付时间' }],
    conclusions: [{ content: '本周确认报价' }],
    openQuestions: []
  },
  decisions: [{ decisionId: 'decision-secret', content: '本周确认报价', status: 'confirmed' }],
  actionItems: [{ actionId: 'action-secret', content: '整理报价单', owner: '未明确', dueDate: '未明确', status: 'unresolved' }]
};

test('meeting analysis export converts the grounded bundle into a readable document without internal fields', () => {
  const markdown = buildMeetingAnalysisMarkdown(analysis, { title: '客户沟通会' });

  assert.match(markdown, /^# 客户沟通会/m);
  assert.match(markdown, /## 会议摘要/);
  assert.match(markdown, /## 主要讨论/);
  assert.match(markdown, /## 会议决定/);
  assert.match(markdown, /## 后续行动/);
  assert.doesNotMatch(markdown, /decision-secret|action-secret|CURRENT|GROUNDING_SUPPORTED/);
});

test('meeting analysis export delegates the document download to the existing Word exporter', () => {
  let call;
  const result = exportMeetingAnalysisToWord('客户沟通会', analysis, {
    exportWord: (...args) => {
      call = args;
      return 'AI-Work-Center-客户沟通会.docx';
    }
  });

  assert.equal(result, 'AI-Work-Center-客户沟通会.docx');
  assert.equal(call[0], '客户沟通会');
  assert.match(call[1], /## 会议摘要/);
});

test('meeting analysis export fails closed for stale or unavailable analysis', () => {
  assert.throws(
    () => buildMeetingAnalysisMarkdown({ status: 'STALE', groundingStatus: 'STALE' }),
    (error) => error.code === 'MEETING_ANALYSIS_EXPORT_UNAVAILABLE'
  );
});
