import assert from 'node:assert/strict';
import test from 'node:test';

async function loadPptxExporter() {
  try {
    return await import('./meetingAnalysisPptxExport.js');
  } catch (error) {
    assert.fail(`PPTX exporter is not implemented yet: ${error.message}`);
  }
}

const analysis = {
  status: 'CURRENT',
  groundingStatus: 'GROUNDING_SUPPORTED',
  summary: {
    topic: { value: '客户沟通 <报价>' },
    overview: { value: '讨论交付节奏与报价确认' },
    keyPoints: [
      { content: '先确认交付时间' },
      { content: '补充服务范围' }
    ],
    conclusions: [{ content: '本周确认报价' }],
    openQuestions: [{ content: '最终付款节点尚未明确' }]
  },
  decisions: [{ decisionId: 'decision-secret', content: '本周确认报价', status: 'confirmed' }],
  actionItems: [{ actionId: 'action-secret', content: '整理报价单', owner: '项目负责人', dueDate: '周五', status: 'confirmed' }]
};

test('PPTX export maps grounded meeting outcomes into complete presentation sections', async () => {
  const { buildMeetingAnalysisPptxSlides } = await loadPptxExporter();
  const slides = buildMeetingAnalysisPptxSlides('客户沟通会', analysis);
  const text = slides.flatMap((slide) => [slide.title, slide.subtitle, ...(slide.entries || [])]).join('\n');

  assert.deepEqual(slides.slice(0, 6).map((slide) => slide.title), [
    '客户沟通会',
    '会议摘要',
    '讨论重点',
    '结论与会议决定',
    '未决问题',
    '后续行动'
  ]);
  assert.match(text, /客户沟通 <报价>/);
  assert.match(text, /先确认交付时间/);
  assert.match(text, /本周确认报价/);
  assert.match(text, /最终付款节点尚未明确/);
  assert.match(text, /负责人：项目负责人/);
  assert.match(text, /截止日期：周五/);
  assert.doesNotMatch(text, /decision-secret|action-secret|GROUNDING_SUPPORTED/);
});

test('PPTX export emits a real Open XML package without leaking internal analysis fields', async () => {
  const { createMeetingAnalysisPptxBlob } = await loadPptxExporter();
  const blob = createMeetingAnalysisPptxBlob('客户沟通会', analysis);
  const packageText = new TextDecoder().decode(await blob.arrayBuffer());

  assert.equal(blob.type, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  assert.ok(packageText.startsWith('PK\u0003\u0004'));
  assert.match(packageText, /\[Content_Types\]\.xml/);
  assert.match(packageText, /ppt\/presentation\.xml/);
  assert.match(packageText, /ppt\/slideMasters\/slideMaster1\.xml/);
  assert.match(packageText, /ppt\/slideLayouts\/slideLayout1\.xml/);
  assert.match(packageText, /ppt\/slides\/slide1\.xml/);
  assert.match(packageText, /application\/vnd\.openxmlformats-officedocument\.presentationml\.presentation\.main\+xml/);
  assert.match(packageText, /PingFang SC/);
  assert.match(packageText, /Heiti SC/);
  assert.match(packageText, /客户沟通 &lt;报价&gt;/);
  assert.doesNotMatch(packageText, /decision-secret|action-secret|GROUNDING_SUPPORTED|analysisRevision/);
});

test('PPTX export creates continuation slides instead of dropping long meeting lists', async () => {
  const { buildMeetingAnalysisPptxSlides } = await loadPptxExporter();
  const longAnalysis = {
    ...analysis,
    summary: {
      ...analysis.summary,
      keyPoints: Array.from({ length: 13 }, (_, index) => ({ content: `讨论重点 ${index + 1}` }))
    }
  };
  const slides = buildMeetingAnalysisPptxSlides('客户沟通会', longAnalysis);
  const discussionSlides = slides.filter((slide) => slide.title.startsWith('讨论重点'));
  const discussionText = discussionSlides.flatMap((slide) => slide.entries || []).join('\n');

  assert.equal(discussionSlides.length, 3);
  assert.match(discussionSlides[1].title, /续/);
  assert.match(discussionText, /讨论重点 1/);
  assert.match(discussionText, /讨论重点 13/);
});

test('PPTX export fails closed for stale and empty analysis bundles', async () => {
  const { buildMeetingAnalysisPptxSlides } = await loadPptxExporter();

  assert.throws(
    () => buildMeetingAnalysisPptxSlides('客户沟通会', { ...analysis, status: 'STALE', groundingStatus: 'STALE' }),
    (error) => error.code === 'MEETING_ANALYSIS_EXPORT_UNAVAILABLE'
  );
  assert.throws(
    () => buildMeetingAnalysisPptxSlides('客户沟通会', { status: 'CURRENT', groundingStatus: 'GROUNDING_SUPPORTED' }),
    (error) => error.code === 'MEETING_ANALYSIS_EXPORT_UNAVAILABLE'
  );
});

test('PPTX export delegates local download with a pptx filename', async () => {
  const { exportMeetingAnalysisToPptx } = await loadPptxExporter();
  let call;
  const result = exportMeetingAnalysisToPptx('客户沟通会', analysis, {
    download: (...args) => {
      call = args;
    },
    date: new Date('2026-08-31T00:00:00+08:00')
  });

  assert.equal(result, 'AI-Work-Center-客户沟通会-2026-08-31.pptx');
  assert.equal(call[1], result);
  assert.equal(call[0].type, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
});
