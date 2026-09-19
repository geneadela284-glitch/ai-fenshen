import { useEffect, useState } from 'react';

import { buildMeetingAnalysisViewModel } from './meetingAnalysisUiModel.js';
import './MeetingAnalysisPanel.css';

const analysisErrorLabels = Object.freeze({
  AI_ANALYSIS_UNAVAILABLE: 'AI会议整理暂时不可用，请稍后重试',
  NO_CAPABLE_MODEL: '当前没有可用的 AI 整理服务，请稍后重试',
  TIMEOUT: 'AI会议整理响应超时，请稍后重试',
  RATE_LIMITED: 'AI会议整理请求过多，请稍后重试',
  INVALID_JSON: 'AI会议整理结果暂时无法确认，请稍后重试',
  MEETING_TRANSCRIPT_REVISION_STALE: '转写内容已经更新，请基于最新转写重新整理',
  ANALYSIS_EVIDENCE_INVALID: '会议证据校验未通过，请稍后重新整理',
  EVIDENCE_AUDIO_DURATION_MISMATCH: '录音与转写时间轴不一致，请基于当前录音重新转写后再试'
});

function analysisErrorMessage(code) {
  const normalized = String(code || '').trim();
  return analysisErrorLabels[normalized] || (normalized ? '会议整理未完成，请稍后重试' : '');
}

const refinementPrompts = Object.freeze([
  '请把重点压缩成三点',
  '请突出后续行动和负责人',
  '请整理成适合发给团队的版本'
]);

const refinementErrorLabels = Object.freeze({
  MEETING_ANALYSIS_REFINEMENT_REQUEST_INVALID: '请输入你希望 AI 微调的方向',
  MEETING_ANALYSIS_REFINEMENT_UNAVAILABLE: '当前会议整理还不能进行 AI 微调',
  MEETING_ANALYSIS_REFINEMENT_EMPTY: 'AI 暂时没有生成可用草稿'
});

function refinementErrorMessage(code) {
  const normalized = String(code || '').trim();
  return refinementErrorLabels[normalized] || (normalized ? 'AI 微调暂时不可用，请稍后重试' : '');
}

function EvidenceActions({ evidenceRefs = [], onEvidenceSelect }) {
  return (
    <div className="meeting-analysis__evidence-actions">
      {evidenceRefs.map((evidenceRef) => (
        <span className="meeting-analysis__evidence-group" key={evidenceRef.evidenceRefId}>
          <button type="button" className="meeting-analysis__evidence-button" onClick={() => onEvidenceSelect?.({ evidenceRef, mode: 'transcript' })}>查看原话</button>
          <button type="button" className="meeting-analysis__evidence-button meeting-analysis__evidence-button--secondary" onClick={() => onEvidenceSelect?.({ evidenceRef, mode: 'playback' })}>回听 {evidenceRef.timeLabel}</button>
        </span>
      ))}
    </div>
  );
}

function SummaryFact({ label, value, evidenceRefs, onEvidenceSelect, className = '' }) {
  return (
    <div className={`meeting-analysis__fact ${className}`}>
      <div className="meeting-analysis__fact-label">{label}</div>
      <p className="meeting-analysis__fact-value">{value}</p>
      <EvidenceActions evidenceRefs={evidenceRefs} onEvidenceSelect={onEvidenceSelect} />
    </div>
  );
}

function RefinementComposer({
  onRefine,
  refinementStatus = 'idle',
  refinementError = '',
  refinementRequest = '',
  refinementResult = ''
}) {
  const [draft, setDraft] = useState('');
  const isSubmitting = refinementStatus === 'submitting';
  const normalizedDraft = draft.trim();
  const canSubmit = typeof onRefine === 'function' && Boolean(normalizedDraft) && !isSubmitting;

  const submit = (event) => {
    event.preventDefault();
    if (!canSubmit) return;
    setDraft('');
    onRefine(normalizedDraft);
  };

  return (
    <section className="meeting-analysis__refinement" data-testid="meeting-analysis-refinement" aria-label="AI微调">
      <div className="meeting-analysis__refinement-header">
        <div>
          <div className="meeting-analysis__section-kicker">继续对话</div>
          <h4 className="meeting-analysis__refinement-title">AI微调</h4>
        </div>
        <span className="meeting-analysis__draft-badge">未写回会议结果</span>
      </div>
      <p className="meeting-analysis__refinement-copy">告诉 AI 你想怎么重排、压缩或突出重点，当前已确认的会议事实不会被覆盖。</p>

      {refinementRequest ? (
        <div className="meeting-analysis__chat-message meeting-analysis__chat-message--user">
          <span className="meeting-analysis__chat-avatar meeting-analysis__chat-avatar--user" aria-hidden="true">你</span>
          <div>
            <div className="meeting-analysis__chat-label">你的要求</div>
            <p>{refinementRequest}</p>
          </div>
        </div>
      ) : null}
      {isSubmitting ? <div className="meeting-analysis__refinement-status" role="status">AI分身正在整理这份草稿…</div> : null}
      {refinementStatus === 'ready' && refinementResult ? (
        <div className="meeting-analysis__chat-message meeting-analysis__chat-message--assistant">
          <span className="meeting-analysis__chat-avatar" aria-hidden="true">AI</span>
          <div>
            <div className="meeting-analysis__chat-label">AI分身 · 临时草稿</div>
            <p className="meeting-analysis__draft-result">{refinementResult}</p>
          </div>
        </div>
      ) : null}
      {refinementStatus === 'failed' && refinementError ? <p className="meeting-analysis__refinement-error" role="status">{refinementErrorMessage(refinementError)}。</p> : null}

      <form className="meeting-analysis__refinement-form" onSubmit={submit}>
        <div className="meeting-analysis__prompt-row" aria-label="快速微调建议">
          <span className="meeting-analysis__prompt-label">可以这样说</span>
          {refinementPrompts.map((prompt) => <button type="button" className="meeting-analysis__prompt-chip" key={prompt} onClick={() => setDraft(prompt)} disabled={isSubmitting}>{prompt}</button>)}
        </div>
        <textarea
          className="meeting-analysis__refinement-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="例如：把结论放在最前面，行动项按紧急程度排序"
          aria-label="输入 AI 微调要求"
          maxLength={2000}
          disabled={isSubmitting}
        />
        <div className="meeting-analysis__refinement-footer">
          <span>仅生成临时草稿，不修改已保存结果</span>
          <button type="submit" className="meeting-analysis__refinement-submit" disabled={!canSubmit} aria-busy={isSubmitting}>
            {isSubmitting ? '正在整理…' : '让 AI 微调'}
          </button>
        </div>
      </form>
    </section>
  );
}

function AnalysisProgress({ status }) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const running = status === 'analyzing';
  const complete = status === 'ready';

  useEffect(() => {
    setElapsedSeconds(0);
    if (!running) return undefined;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => clearInterval(timer);
  }, [running]);

  if (!running && !complete) return null;
  const elapsed = `${Math.floor(elapsedSeconds / 60).toString().padStart(2, '0')}:${(elapsedSeconds % 60).toString().padStart(2, '0')}`;
  return (
    <div className={`meeting-analysis__progress${running ? ' meeting-analysis__progress--running' : ''}`} aria-busy={running}>
      <div className="meeting-analysis__progress-heading">
        <span role="status">{complete ? '会议整理已完成' : 'AI正在整理会议…'}</span>
        <strong>{complete ? '100%' : `已等待 ${elapsed}`}</strong>
      </div>
      <div className="meeting-analysis__progress-track" role="progressbar" aria-label="AI会议整理进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={complete ? 100 : undefined} aria-valuetext={complete ? '已完成' : '正在处理，等待结果'}>
        <span />
      </div>
      {running ? <p className="meeting-analysis__progress-hint">{elapsedSeconds >= 30 ? '长会议需要更多时间，完成后会自动显示结果。' : '正在整理会议要点和行动项，请稍候。'}</p> : null}
    </div>
  );
}

function AnalysisUnavailable({
  model,
  sourceReady = false,
  transcriptReady = false,
  analysisStatus = 'idle',
  analysisError = '',
  onAnalyze,
  canAnalyze = false,
  onRefine,
  refinementStatus = 'idle',
  refinementError = '',
  refinementRequest = '',
  refinementResult = '',
  onExportDocument
}) {
  const isAnalyzing = analysisStatus === 'analyzing';
  const errorCopy = analysisErrorMessage(analysisError);
  const statusCopy = isAnalyzing
    ? '正在整理会议'
    : errorCopy
      ? errorCopy
      : model.state === 'stale' || model.state === 'revalidation_required'
    ? model.statusLabel
    : transcriptReady
      ? '当前还没有已保存的会议分析'
      : sourceReady
        ? '先完成转写，再整理会议摘要'
        : '完成录音或导入音频后，可整理会议摘要';
  const canStart = canAnalyze && typeof onAnalyze === 'function';
  return (
    <section className="meeting-analysis meeting-analysis--unavailable analysis-unavailable" data-testid="meeting-analysis-panel" data-analysis-state={isAnalyzing ? 'analyzing' : analysisError ? 'failed' : model.state} aria-label="会议分析">
      <div className="meeting-analysis__eyebrow">MEETING BRAIN</div>
      <div className="meeting-analysis__unavailable-icon" aria-hidden="true">◌</div>
      <h3 className="meeting-analysis__title">AI会议整理</h3>
      <p className="meeting-analysis__unavailable-copy" data-testid="meeting-analysis-status">{statusCopy}。</p>
      <AnalysisProgress status={analysisStatus} />
      {!isAnalyzing && (model.state === 'stale' || model.state === 'revalidation_required') ? <p className="meeting-analysis__unavailable-hint">原始会议与转写仍然保留，可以回到 Transcript 查看原文。</p> : null}
      {!isAnalyzing && !errorCopy && model.state === 'unavailable' && transcriptReady ? <p className="meeting-analysis__unavailable-hint">分析结果只会在完成 grounded 校验并保存后显示，不会用猜测填充页面。</p> : null}
      {canStart ? <button type="button" className="meeting-analysis__primary-action" onClick={onAnalyze} disabled={isAnalyzing} aria-busy={isAnalyzing}>{isAnalyzing ? '正在整理…' : analysisError ? '重新整理' : '一键整理会议'}</button> : null}
    </section>
  );
}

export function MeetingAnalysisPanel({
  analysis = null,
  onEvidenceSelect,
  sourceReady = false,
  transcriptReady = false,
  analysisStatus = 'idle',
  analysisError = '',
  onAnalyze,
  canAnalyze = false,
  onRefine,
  refinementStatus = 'idle',
  refinementError = '',
  refinementRequest = '',
  refinementResult = '',
  onExportDocument,
  onExportPptx
}) {
  const model = buildMeetingAnalysisViewModel(analysis);
  if (!model.displayable) {
    return (
      <AnalysisUnavailable
        model={model}
        sourceReady={sourceReady}
        transcriptReady={transcriptReady}
        analysisStatus={analysisStatus}
        analysisError={analysisError}
        onAnalyze={onAnalyze}
        canAnalyze={canAnalyze}
      />
    );
  }
  return (
    <section className="meeting-analysis meeting-analysis--conversation" data-testid="meeting-analysis-panel" data-analysis-state={model.state} aria-label="会议分析">
      <div className="meeting-analysis__header">
        <div>
          <div className="meeting-analysis__eyebrow">AI MEETING BRIEF</div>
          <h3 className="meeting-analysis__title">AI会议整理</h3>
          <p className="meeting-analysis__subtitle">先看结论，再回到原话</p>
        </div>
          <div className="meeting-analysis__header-actions">
            <span className="meeting-analysis__status">{model.statusLabel}</span>
            {typeof onExportDocument === 'function' ? <button type="button" className="meeting-analysis__export-action" onClick={onExportDocument} aria-label="导出会议整理文档">导出文档</button> : null}
            {typeof onExportPptx === 'function' ? <button type="button" className="meeting-analysis__export-action" onClick={onExportPptx} aria-label="导出会议整理 PPT">导出 PPT</button> : null}
            {canAnalyze ? <button type="button" className="meeting-analysis__secondary-action" onClick={onAnalyze} disabled={analysisStatus === 'analyzing'} aria-busy={analysisStatus === 'analyzing'}>{analysisStatus === 'analyzing' ? '正在整理…' : '重新整理'}</button> : null}
        </div>
      </div>
      <AnalysisProgress status={analysisStatus} />
      {analysisStatus === 'failed' && analysisError ? <p className="meeting-analysis__error-copy" role="status">{analysisErrorMessage(analysisError)}。</p> : null}

      <div className="meeting-analysis__assistant-message" data-testid="meeting-analysis-assistant-message">
        <span className="meeting-analysis__chat-avatar" aria-hidden="true">AI</span>
        <div>
          <div className="meeting-analysis__chat-label">AI分身 · 已根据当前原文整理</div>
          <p>我已经把这场会议整理成一份可直接行动的结果。下面优先显示会议摘要、决定和后续行动，原始转写仍保留在页面下方。</p>
        </div>
      </div>

      <div className="meeting-analysis__summary-grid" data-testid="meeting-analysis-summary">
        <SummaryFact label="会议主题" value={model.summary.topic} evidenceRefs={model.summary.topicEvidenceRefs} onEvidenceSelect={onEvidenceSelect} className="meeting-analysis__fact--topic" />
        <SummaryFact label="会议摘要" value={model.summary.overview} evidenceRefs={model.summary.overviewEvidenceRefs} onEvidenceSelect={onEvidenceSelect} />
      </div>

      <div className="meeting-analysis__section">
        <div className="meeting-analysis__section-heading">讨论重点</div>
        {model.summary.keyPoints.length ? (
          <div className="meeting-analysis__list">
            {model.summary.keyPoints.map((item) => <div className="meeting-analysis__list-item" key={item.keyPointId || item.content}><span className="meeting-analysis__bullet" aria-hidden="true" /> <div><p>{item.content}</p><EvidenceActions evidenceRefs={item.evidenceRefs} onEvidenceSelect={onEvidenceSelect} /></div></div>)}
          </div>
        ) : <p className="meeting-analysis__empty-copy">会议中没有形成可确认的讨论重点。</p>}
      </div>

      <div className="meeting-analysis__section">
        <div className="meeting-analysis__section-heading">最终结论</div>
        {model.summary.conclusions.length ? (
          <div className="meeting-analysis__list">
            {model.summary.conclusions.map((item) => <div className="meeting-analysis__list-item" key={item.conclusionId || item.content}><span className="meeting-analysis__bullet meeting-analysis__bullet--violet" aria-hidden="true" /> <div><p>{item.content}</p><EvidenceActions evidenceRefs={item.evidenceRefs} onEvidenceSelect={onEvidenceSelect} /></div></div>)}
          </div>
        ) : <p className="meeting-analysis__empty-copy">会议中没有形成明确结论。</p>}
      </div>

      <div className="meeting-analysis__section">
        <div className="meeting-analysis__section-heading">未决问题</div>
        {model.summary.openQuestions.length ? (
          <div className="meeting-analysis__list">
            {model.summary.openQuestions.map((item) => <div className="meeting-analysis__list-item" key={item.openQuestionId || item.content}><span className="meeting-analysis__bullet meeting-analysis__bullet--amber" aria-hidden="true" /> <div><p>{item.content}</p><EvidenceActions evidenceRefs={item.evidenceRefs} onEvidenceSelect={onEvidenceSelect} /></div></div>)}
          </div>
        ) : <p className="meeting-analysis__empty-copy">没有记录到未决问题。</p>}
      </div>

      <div className="meeting-analysis__section" data-testid="meeting-decisions-section">
        <div className="meeting-analysis__section-heading">会议决定</div>
        {model.decisions.length ? <div className="meeting-analysis__cards">{model.decisions.map((decision) => <article className={`meeting-analysis__card ${decision.status === 'unresolved' ? 'meeting-analysis__card--unresolved' : ''}`} key={decision.decisionId || decision.content}><div className="meeting-analysis__card-topline"><span className="meeting-analysis__card-label">{decision.status === 'unresolved' ? '会议中尚未明确' : '已确认'}</span><span className="meeting-analysis__card-mark" aria-hidden="true">{decision.status === 'unresolved' ? '!' : '✓'}</span></div><p>{decision.content}</p><EvidenceActions evidenceRefs={decision.evidenceRefs} onEvidenceSelect={onEvidenceSelect} /></article>)}</div> : <p className="meeting-analysis__empty-copy">没有形成明确决定。</p>}
      </div>

      <div className="meeting-analysis__section" data-testid="meeting-action-items-section">
        <div className="meeting-analysis__section-heading">后续行动</div>
        {model.actionItems.length ? <div className="meeting-analysis__cards">{model.actionItems.map((item) => <article className="meeting-analysis__card" key={item.actionId || item.content}><div className="meeting-analysis__card-topline"><span className="meeting-analysis__card-label">{item.statusLabel}</span><span className="meeting-analysis__card-mark meeting-analysis__card-mark--cyan" aria-hidden="true">→</span></div><p>{item.content}</p><dl className="meeting-analysis__meta"><div><dt>负责人</dt><dd>{item.ownerLabel}</dd></div><div><dt>截止日期</dt><dd>{item.dueDateLabel}</dd></div></dl><EvidenceActions evidenceRefs={item.evidenceRefs} onEvidenceSelect={onEvidenceSelect} /></article>)}</div> : <p className="meeting-analysis__empty-copy">没有记录到后续行动。</p>}
      </div>

      <RefinementComposer
        onRefine={onRefine}
        refinementStatus={refinementStatus}
        refinementError={refinementError}
        refinementRequest={refinementRequest}
        refinementResult={refinementResult}
      />
    </section>
  );
}

export default MeetingAnalysisPanel;
