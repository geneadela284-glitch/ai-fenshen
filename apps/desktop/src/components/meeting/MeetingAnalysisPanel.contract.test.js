import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const source = await readFile(fileURLToPath(new URL('./MeetingAnalysisPanel.jsx', import.meta.url)), 'utf8');
const styles = await readFile(fileURLToPath(new URL('./MeetingAnalysisPanel.css', import.meta.url)), 'utf8');

test('analysis panel presents grounded meeting outcomes without exposing technical payloads', () => {
  assert.match(source, /MeetingAnalysisPanel/);
  assert.match(source, /AI会议整理/);
  assert.match(source, /会议摘要/);
  assert.match(source, /meeting-analysis__assistant-message/);
  assert.match(source, /会议决定/);
  assert.match(source, /后续行动/);
  assert.match(source, /查看原话/);
  assert.match(source, /回听/);
  assert.match(source, /未明确/);
  assert.match(source, /onAnalyze/);
  assert.match(source, /一键整理/);
  assert.match(source, /正在整理会议/);
  assert.match(source, /重新整理/);
  assert.match(source, /onEvidenceSelect/);
  assert.match(source, /analysis-unavailable/);
  assert.doesNotMatch(source, /analysisId/);
  assert.doesNotMatch(source, /provider/);
  assert.doesNotMatch(source, /JSON\.stringify/);
});

test('analysis panel exposes refinement and both real document and PPTX export actions', () => {
  const panelProps = source.match(/export function MeetingAnalysisPanel\(\{([\s\S]*?)\}\) \{/i)?.[1] || '';
  assert.match(source, /meeting-analysis__refinement/);
  assert.match(source, /AI微调/);
  assert.match(source, /未写回会议结果/);
  assert.match(panelProps, /onRefine/);
  assert.match(panelProps, /refinementStatus/);
  assert.match(panelProps, /refinementError/);
  assert.match(panelProps, /refinementRequest/);
  assert.match(panelProps, /refinementResult/);
  assert.match(source, /导出文档/);
  assert.match(panelProps, /onExportDocument/);
  assert.match(source, /导出 PPT/);
  assert.match(panelProps, /onExportPptx/);
  assert.match(styles, /@media \(max-width: 560px\)[\s\S]*?\.meeting-analysis__header \{[^}]*flex-direction: column;/);
  assert.doesNotMatch(source, /保存到记忆|写入任务|写入日历/);
});
