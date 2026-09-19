import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const source = await readFile(fileURLToPath(new URL('./MeetingCenter.jsx', import.meta.url)), 'utf8');
const analysisPanelSource = await readFile(fileURLToPath(new URL('./meeting/MeetingAnalysisPanel.jsx', import.meta.url)), 'utf8');
const styles = await readFile(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');
const browserHarness = await readFile(fileURLToPath(new URL('./MeetingCenter.browser-harness.html', import.meta.url)), 'utf8');

test('MeetingCenter keeps mobile content scrollable and switches to the active detail view', () => {
  assert.match(source, /data-testid="meeting-scroll-container"/);
  assert.match(source, /h-full[^"']*overflow-x-hidden[^"']*overflow-y-auto/);
  assert.match(source, /max-\[768px\]:hidden/);
  assert.match(source, /setMobilePanel\('detail'\)/);
  assert.match(source, /返回会议列表/);
});

test('MeetingCenter uses one top-level back action, a functional overflow menu, and no dead bottom navigation', () => {
  assert.equal((source.match(/返回会议列表/g) || []).length, 1);
  assert.match(source, /meeting-v1-overflow-menu/);
  assert.match(source, /新建会议/);
  assert.match(source, /导入会议/);
  assert.match(source, /aria-expanded=\{overflowMenuOpen\}/);
  assert.doesNotMatch(source, /meeting-v1-bottom-nav/);
});

test('MeetingCenter makes the unified AI Secretary context visible without adding a new data path', () => {
  assert.match(source, /meeting-v1-context-strip/);
  assert.match(source, /data-testid="meeting-secretary-context"/);
  assert.match(source, /meeting-v1-top-action__label/);
  assert.match(source, /回到 AI分身/);
  assert.match(source, /meeting-v1-detail-empty/);
});

test('MeetingCenter wires refinement and both exports through UI adapters', () => {
  assert.match(source, /createMeetingAnalysisRefinementClient/);
  assert.match(source, /runMeetingAnalysisRefinement/);
  assert.match(source, /exportMeetingAnalysisToWord/);
  assert.match(source, /exportMeetingAnalysisToPptx/);
  assert.match(source, /refinementStatus=\{analysisRefinement\.status\}/);
  assert.match(source, /onRefine=\{runMeetingAnalysisRefinement\}/);
  assert.match(source, /onExportDocument=\{exportMeetingDocument\}/);
  assert.match(source, /onExportPptx=\{exportMeetingPresentation\}/);
  assert.match(source, /setAnalysisRefinement\(\{ status: 'idle'[\s\S]*?\}, \[active\?\.meeting\?\.meetingId, analysis\?\.analysisId, analysis\?\.analysisRevision\]\)/);
  assert.doesNotMatch(source, /manager\.analysis\.refine/);
  assert.doesNotMatch(source, /analysisBundles\.save/);
});

test('Meeting RC test handles use a UI-only flag and do not couple to the recorder profile gate', () => {
  assert.match(source, /const MEETING_UI_RC_ENABLED/);
  assert.match(source, /VITE_MEETING_UI_RC/);
  assert.match(source, /exposeTestHandles: MEETING_UI_RC_ENABLED/);
});

test('MeetingCenter closes the overflow menu from outside clicks, Escape, and scroll', () => {
  assert.match(source, /const overflowMenuRef = useRef\(null\)/);
  assert.match(source, /shouldDismissMeetingOverflowMenu/);
  assert.match(source, /document\.addEventListener\('pointerdown'/);
  assert.match(source, /event\.key === 'Escape'/);
  assert.match(source, /document\.addEventListener\('scroll'/);
  assert.match(source, /ref=\{overflowMenuRef\}/);
});

test('MeetingCenter keeps import work on a dedicated page and moves the new-meeting CTA out of the list tail', () => {
  assert.match(source, /meeting-v1-import-page/);
  assert.match(source, /导入会议/);
  assert.match(source, /manager\.importAudio/);
  assert.match(source, /handleAudioFile/);
  assert.doesNotMatch(source, /meeting-v1-primary-cta/);
  const audioSectionStart = source.indexOf('title="音频来源"');
  const playbackStart = source.indexOf('<MeetingPlaybackPanel');
  assert.ok(audioSectionStart >= 0 && playbackStart > audioSectionStart);
  assert.doesNotMatch(source.slice(audioSectionStart, playbackStart), /meeting-v1-import-button/);
});

test('MeetingCenter collapses long local segment lists to three rows with an explicit disclosure control', () => {
  assert.match(source, /segmentsExpanded/);
  assert.match(source, /active\.segments\.slice\(0, 3\)/);
  assert.match(source, /aria-expanded=\{segmentsExpanded\}/);
  assert.match(source, /展开全部分段|收起分段/);
});

test('Meeting analysis is placed after audio/playback and before raw transcript on the reading path', () => {
  const playbackIndex = source.indexOf('<MeetingPlaybackPanel');
  const analysisIndex = source.indexOf('<MeetingAnalysisPanel');
  const transcriptIndex = source.indexOf('<Section title="原始转写">');
  assert.ok(playbackIndex >= 0 && analysisIndex > playbackIndex && transcriptIndex > analysisIndex);
  assert.match(source, /sourceReady=\{Boolean\(analysisSource \|\| playbackPanelSource\)\}/);
  assert.match(source, /transcriptReady=\{Boolean\(analysisTranscriptRevision\)\}/);
});

test('Meeting analysis gives immediate pending feedback before the asynchronous manager call', () => {
  const analysisHandler = source.match(/const runMeetingAnalysis = \(\) => \{([\s\S]*?)\n  \};/)?.[1] || '';
  assert.match(analysisHandler, /setAnalysisOperation\(\(current\) => \(\{[\s\S]*?status: 'analyzing'/);
  assert.match(analysisHandler, /manager\.analysis\.analyze\(/);
  assert.match(analysisPanelSource, /data-testid="meeting-analysis-status"/);
  assert.match(analysisPanelSource, /role="status"/);
});

test('Meeting list reflects the active meeting snapshot after recording finalization', () => {
  assert.match(source, /const isActive = active\?\.meeting\?\.meetingId === meeting\.meetingId;/);
  assert.match(source, /const meetingView = isActive \? active\.meeting : meeting;/);
  assert.match(source, /meetingView\.committedDurationMs/);
  assert.match(source, /meetingView\.committedSegmentCount/);
});

test('MeetingCenter keeps Stage 3A controls below the existing Phase 1 audio controls', () => {
  assert.match(source, /选择音频文件/);
  assert.match(source, /type="file"/);
  assert.match(source, /audio\/m4a/);
  assert.match(source, /取消导入/);
  assert.match(source, /重新选择同一文件/);
  assert.match(source, /删除音频/);
  assert.match(source, /开始转写/);
  assert.match(source, /原始转写/);
  assert.match(source, /识别匿名说话人/);
  assert.match(source, /ensureMeetingDiarization/);
  assert.match(source, /autoDiarizationRuns/);
  assert.match(source, /stage3b-a-review-generation-224/);
  assert.match(source, /diarization_backfill/);
  assert.match(source, /backfillCondition/);
  assert.match(source, /status !== 'ready' \|\| !providerReady/);
  assert.match(source, /说话人管理/);
  assert.doesNotMatch(source, /生成纪要|EvidenceRef|Memory|Tasks|Calendar/);
});

test('MeetingCenter mounts the live recording experience instead of static recording controls', () => {
  assert.match(source, /createMeetingStage3cRecordingExperience/);
  assert.match(source, /MeetingRecordingExperience/);
  assert.match(source, /<MeetingRecordingExperience\s+experience=\{recordingExperience\}/);
  assert.doesNotMatch(source, /onClick=\{\(\) => run\(\(\) => manager\.stopRecording\(\)/);
});

test('mounted MeetingCenter harness implements the live recording manager contract', () => {
  assert.match(browserHarness, /async startRecording\(\)/);
  assert.match(browserHarness, /async interruptRecording\(\)/);
  assert.match(browserHarness, /async stopRecording\(\)/);
});

test('ready diarized transcripts remount the isolated speaker panel with only safe bindings', () => {
  assert.match(source, /import \{ SpeakerManagementPanel \} from '\.\/meeting\/SpeakerManagementPanel\.jsx';/);
  assert.match(source, /<Section title="说话人管理">/);
  const panelMount = source.match(/<SpeakerManagementPanel[\s\S]*?\/>/)?.[0] || '';
  assert.deepEqual(
    [...panelMount.matchAll(/\b([a-z][A-Za-z0-9]*)=\{/g)].map((match) => match[1]),
    ['speakerCorrectionManager', 'meetingId', 'transcriptId']
  );
  assert.match(panelMount, /speakerCorrectionManager=\{manager\.speakerCorrection\}/);
  assert.match(panelMount, /meetingId=\{transcript\.document\.meetingId\}/);
  assert.match(panelMount, /transcriptId=\{transcript\.document\.transcriptId\}/);
  assert.match(source, /key=\{`\$\{transcript\.document\.meetingId\}:\$\{transcript\.document\.transcriptId\}:\$\{transcript\.document\.transcriptRevision\}:\$\{diarization\.revision\.diarizationRevisionId\}`\}/);
  assert.match(source, /\{source\.originalFileName \|\| '本地音频'\}/);
  assert.doesNotMatch(source, /说话人时间轴（匿名）|diarization revision|labelBySpeakerId/);
  assert.doesNotMatch(source, /diarization\.revision\.segments\.map/);
});

test('MeetingCenter exposes candidate AAC mode and actual recorder metadata without changing production defaults', () => {
  assert.match(source, /meetingRecordingCodecExperiment/);
  assert.match(source, /实验AAC模式：已启用/);
  assert.match(source, /AAC_EXPERIMENT_NOT_ACTIVE/);
  assert.match(source, /实际MediaRecorder\.mimeType/);
  assert.match(source, /container/);
  assert.match(source, /codec/);
  assert.match(source, /recordingCodecExperiment/);
  assert.match(source, /audioSourceFormat/);
});

test('audio deletion is explicit, accessible, and theme-safe on mobile', () => {
  assert.match(source, /window\.confirm\('确定删除这个音频吗？'\)/);
  assert.match(source, /aria-label="删除音频"/);
  assert.match(source, /min-h-11[^"']*border-\[color:var\(--danger-color\)\][^"']*bg-\[color:var\(--surface-background\)\][^"']*text-\[color:var\(--danger-color\)\]/);
  assert.match(source, /style=\{\{ color: 'var\(--danger-color\)' \}\}/);
  assert.match(source, /音频已删除/);
});

test('continue-transcription button has an explicit Safari-safe readable theme style', () => {
  assert.match(source, /meeting-transcription-resume-button/);
  assert.match(source, /aria-busy=\{busy \|\| importBusy\}/);
  assert.match(source, /disabled=\{busy \|\| importBusy \|\| !transcriptionSourceReady\}/);
  assert.match(source, /aria-disabled=\{!transcriptionSourceReady\}/);
  assert.match(source, /busy \|\| importBusy \? '正在恢复…' : '继续转写'/);
  assert.match(source, /disabled:opacity-50/);
  assert.match(styles, /meeting-transcription-resume-button[\s\S]*-webkit-text-fill-color:\s*var\(--accent-color\)/);
  assert.match(styles, /meeting-transcription-resume-button:disabled[\s\S]*opacity:\s*0\.9/);
});

test('start-transcription button stays readable and does not invite a guaranteed provider failure', () => {
  assert.match(source, /meeting-transcription-start-button/);
  assert.match(source, /transcriptionSnapshot\.provider\?\.sourceAvailable === true/);
  assert.match(source, /转写服务暂时不可用/);
  assert.match(styles, /meeting-transcription-start-button[\s\S]*-webkit-text-fill-color:\s*var\(--accent-color\)/);
});

test('ready transcripts remain visible in transcript-only mode after the source disappears', () => {
  assert.match(source, /getTranscriptView/);
  assert.match(source, /transcript_only/);
  assert.match(source, /transcriptOnlyJobIds/);
  assert.match(source, /selectCurrentTranscriptionJobs\(/);
  assert.match(source, /activeTranscripts\.map\(\(\{ source, transcript, mode \}\)/);
  assert.match(source, /原始音频已不可用，已保存的转写内容仍可继续查看和编辑。/);
});

test('current revision selection prevents historical transcript and diarization jobs from overwriting the active UI', () => {
  assert.match(source, /selectCurrentTranscriptionJobs/);
  assert.match(source, /selectCurrentDiarizationJobs/);
  assert.match(source, /activeSources: active\?\.audioSources/);
  assert.match(source, /currentTranscripts: transcripts/);
  assert.match(source, /diarizationSnapshot\.jobs, transcripts/);
});

test('save and revision notices use an explicit Safari-readable theme style', () => {
  assert.match(source, /meeting-success-notice/);
  assert.match(styles, /meeting-success-notice[\s\S]*-webkit-text-fill-color/);
  assert.match(source, /meeting-transcript-save-button/);
  assert.match(source, />保存修改<\/button>/);
  assert.doesNotMatch(source, />保存修订<\/button>/);
  assert.match(styles, /meeting-transcript-save-button[\s\S]*-webkit-text-fill-color/);
});

test('ready transcripts expose a destructive original-audio action without deleting the meeting', () => {
  assert.match(source, /删除原录音/);
  assert.match(source, /删除原录音后仍可查看和编辑转写内容，是否继续？/);
  assert.match(source, /原录音已删除，转写内容已保留/);
  assert.match(source, /transcripts\[source\.sourceId\]\?\.transcript\?\.document\?\.status === 'ready'/);
  assert.match(source, /manager\.deleteAudioSource\(sourceId\)/);
  assert.match(source, /meeting-transcript-delete-original-button/);
});
