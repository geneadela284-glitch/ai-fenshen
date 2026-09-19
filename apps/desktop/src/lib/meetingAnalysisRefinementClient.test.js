import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMeetingAnalysisRefinementInput,
  createMeetingAnalysisRefinementClient
} from './meetingAnalysisRefinementClient.js';

const analysis = {
  status: 'CURRENT',
  groundingStatus: 'GROUNDING_SUPPORTED',
  summary: {
    topic: { value: '报价方案' },
    overview: { value: '讨论报价交付节奏' },
    keyPoints: [{ content: '先确认交付时间' }],
    conclusions: [{ content: '本周确认报价' }],
    openQuestions: [{ content: '还需确认最终负责人' }]
  },
  decisions: [{ decisionId: 'decision-secret', content: '本周确认报价', status: 'confirmed' }],
  actionItems: [{ actionId: 'action-secret', content: '整理报价单', owner: '未明确', dueDate: '未明确', status: 'unresolved' }]
};

test('refinement input contains only user-visible grounded content and the requested adjustment', () => {
  const input = buildMeetingAnalysisRefinementInput({ analysis, request: '请突出行动项并压缩成三点' });

  assert.match(input, /报价方案/);
  assert.match(input, /请突出行动项并压缩成三点/);
  assert.doesNotMatch(input, /decision-secret|action-secret|CURRENT|GROUNDING_SUPPORTED/);
});

test('refinement client returns an unsaved draft through the existing meeting analysis model contract', async () => {
  let request;
  const client = createMeetingAnalysisRefinementClient({
    idFactory: () => 'refine-1',
    modelClient: async (value) => {
      request = value;
      return { content: '一、突出报价确认\n二、保留交付时间\n三、标记负责人待确认' };
    }
  });

  const result = await client({ analysis, request: '请突出行动项并压缩成三点' });

  assert.deepEqual(result, {
    content: '一、突出报价确认\n二、保留交付时间\n三、标记负责人待确认',
    persisted: false
  });
  assert.equal(request.metadata.clientRequestId, 'meeting-refinement-refine-1');
  assert.equal(request.messages.length, 2);
  assert.match(request.messages[1].content, /请突出行动项并压缩成三点/);
  assert.doesNotMatch(JSON.stringify(request), /decision-secret|action-secret/);
});

test('refinement client rejects an empty prompt or unsupported analysis', async () => {
  const client = createMeetingAnalysisRefinementClient({ modelClient: async () => ({ content: 'draft' }) });

  await assert.rejects(
    () => client({ analysis, request: '   ' }),
    (error) => error.code === 'MEETING_ANALYSIS_REFINEMENT_REQUEST_INVALID'
  );
  await assert.rejects(
    () => client({ analysis: { status: 'STALE', groundingStatus: 'STALE' }, request: '请压缩' }),
    (error) => error.code === 'MEETING_ANALYSIS_REFINEMENT_UNAVAILABLE'
  );
});
