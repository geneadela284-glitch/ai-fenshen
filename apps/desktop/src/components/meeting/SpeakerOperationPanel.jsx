import { useState } from 'react';
import { SpeakerTimeline } from './SpeakerTimeline.jsx';
import './SpeakerManagement.css';

const OPERATIONS = Object.freeze([
  { id: 'rename', label: '重命名' },
  { id: 'merge', label: '合并' },
  { id: 'split', label: '拆分' },
  { id: 'reassign', label: '重新分配' }
]);

function toggleId(ids, id) {
  return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
}

function uniqueIds(ids) {
  return Array.isArray(ids) && ids.length > 0 && new Set(ids).size === ids.length;
}

export function buildRenameIntent(snapshot, speakerId, displayLabel) {
  const normalizedLabel = String(displayLabel ?? '').trim();
  const speaker = snapshot?.speakers?.find((candidate) => candidate.id === speakerId && candidate.canRename);
  if (!speaker || !normalizedLabel || normalizedLabel.length > 80) return null;
  if (normalizedLabel === String(speaker.label ?? '').trim()) return null;
  return { type: 'rename', speakerId, displayLabel: normalizedLabel };
}

export function buildMergeIntent(snapshot, speakerIds, targetSpeakerId) {
  if (!uniqueIds(speakerIds) || speakerIds.length < 2 || !speakerIds.includes(targetSpeakerId)) return null;
  const availableIds = new Set((snapshot?.speakers || []).filter((speaker) => speaker.canMerge).map((speaker) => speaker.id));
  if (!speakerIds.every((id) => availableIds.has(id))) return null;
  return { type: 'merge', speakerIds: [...speakerIds], targetSpeakerId };
}

export function buildSplitIntent(snapshot, speakerId, segmentIds) {
  const speakerIsCurrent = snapshot?.speakers?.some((speaker) => speaker.id === speakerId && speaker.canSplit);
  if (!speakerIsCurrent || !uniqueIds(segmentIds)) return null;
  const sourceSegments = (snapshot?.segments || []).filter((segment) => segment.speakerId === speakerId);
  if (segmentIds.length >= sourceSegments.length) return null;
  const selectableIds = new Set(sourceSegments.filter((segment) => segment.canSelectForSplit).map((segment) => segment.id));
  if (!segmentIds.every((id) => selectableIds.has(id))) return null;
  return { type: 'split', speakerId, segmentIds: [...segmentIds] };
}

export function buildReassignIntent(snapshot, segmentIds, targetSpeakerId) {
  if (!uniqueIds(segmentIds)) return null;
  const targetIsCurrent = snapshot?.speakers?.some((speaker) => speaker.id === targetSpeakerId && speaker.canReceiveReassignment);
  if (!targetIsCurrent) return null;
  const selectableSegments = (snapshot?.segments || []).filter((segment) => segment.canSelectForReassignment);
  const selectableIds = new Set(selectableSegments.map((segment) => segment.id));
  if (!segmentIds.every((id) => selectableIds.has(id))) return null;
  const selectedSegments = selectableSegments.filter((segment) => segmentIds.includes(segment.id));
  if (selectedSegments.every((segment) => segment.speakerId === targetSpeakerId)) return null;
  return { type: 'reassign', segmentIds: [...segmentIds], targetSpeakerId };
}

function RenameForm({ snapshot, isSubmitting, onSubmit }) {
  const availableSpeakers = snapshot.speakers.filter((speaker) => speaker.canRename);
  const [speakerId, setSpeakerId] = useState(availableSpeakers[0]?.id || '');
  const [displayLabel, setDisplayLabel] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const intent = buildRenameIntent(snapshot, speakerId, displayLabel);
  const invalidLabel = !intent;

  function changeSpeaker(id) {
    setSpeakerId(id);
    setConfirmed(false);
  }

  function changeLabel(value) {
    setDisplayLabel(value);
    setConfirmed(false);
  }

  function submit(event) {
    event.preventDefault();
    const currentIntent = buildRenameIntent(snapshot, speakerId, displayLabel);
    if (!currentIntent || !confirmed || isSubmitting) return;
    onSubmit(currentIntent);
  }

  return (
    <form className="meeting-speaker-operation-form" onSubmit={submit}>
      <label className="meeting-speaker-field">
        <span>选择说话人</span>
        <select className="meeting-speaker-select" value={speakerId} onChange={(event) => changeSpeaker(event.target.value)} disabled={isSubmitting}>
          {availableSpeakers.map((speaker) => <option key={speaker.id} value={speaker.id}>{speaker.label}</option>)}
        </select>
      </label>
      <label className="meeting-speaker-field">
        <span>新的显示名称</span>
        <input
          className="meeting-speaker-input"
          value={displayLabel}
          onChange={(event) => changeLabel(event.target.value)}
          maxLength={80}
          placeholder="输入 1 至 80 个字符"
          disabled={isSubmitting}
        />
      </label>
      {displayLabel && invalidLabel ? <p className="meeting-speaker-validation">请输入 1 至 80 个字符。</p> : null}
      <Confirmation checked={confirmed} onChange={setConfirmed} disabled={isSubmitting} />
      <SubmitButton isSubmitting={isSubmitting} disabled={invalidLabel || !speakerId || !confirmed} />
    </form>
  );
}

function MergeForm({ snapshot, isSubmitting, onSubmit }) {
  const availableSpeakers = snapshot.speakers.filter((speaker) => speaker.canMerge);
  const [speakerIds, setSpeakerIds] = useState([]);
  const [targetSpeakerId, setTargetSpeakerId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const invalidSelection = !buildMergeIntent(snapshot, speakerIds, targetSpeakerId);

  function toggleSpeaker(id) {
    const next = toggleId(speakerIds, id);
    setSpeakerIds(next);
    if (!next.includes(targetSpeakerId)) setTargetSpeakerId(next[0] || '');
    setConfirmed(false);
  }

  function changeTarget(id) {
    setTargetSpeakerId(id);
    setConfirmed(false);
  }

  function submit(event) {
    event.preventDefault();
    const currentIntent = buildMergeIntent(snapshot, speakerIds, targetSpeakerId);
    if (!currentIntent || !confirmed || isSubmitting) return;
    onSubmit(currentIntent);
  }

  return (
    <form className="meeting-speaker-operation-form" onSubmit={submit}>
      <fieldset className="meeting-speaker-fieldset">
        <legend className="meeting-speaker-legend">选择至少两位说话人</legend>
        {availableSpeakers.map((speaker) => (
          <label className="meeting-speaker-check-row" key={speaker.id}>
            <input className="meeting-speaker-checkbox" type="checkbox" checked={speakerIds.includes(speaker.id)} onChange={() => toggleSpeaker(speaker.id)} disabled={isSubmitting} />
            <span>{speaker.label}</span>
          </label>
        ))}
      </fieldset>
      <label className="meeting-speaker-field">
        <span>保留哪位说话人</span>
        <select className="meeting-speaker-select" value={targetSpeakerId} onChange={(event) => changeTarget(event.target.value)} disabled={isSubmitting || speakerIds.length < 2}>
          <option value="">请选择</option>
          {availableSpeakers.filter((speaker) => speakerIds.includes(speaker.id)).map((speaker) => (
            <option key={speaker.id} value={speaker.id}>{speaker.label}</option>
          ))}
        </select>
      </label>
      {speakerIds.length > 0 && invalidSelection ? <p className="meeting-speaker-validation">请选择至少两位说话人，并从中确定保留对象。</p> : null}
      <Confirmation checked={confirmed} onChange={setConfirmed} disabled={isSubmitting} />
      <SubmitButton isSubmitting={isSubmitting} disabled={invalidSelection || !confirmed} />
    </form>
  );
}

function SplitForm({ snapshot, isSubmitting, onSubmit }) {
  const availableSpeakers = snapshot.speakers.filter((speaker) => speaker.canSplit);
  const [speakerId, setSpeakerId] = useState(availableSpeakers[0]?.id || '');
  const [segmentIds, setSegmentIds] = useState([]);
  const [confirmed, setConfirmed] = useState(false);
  const sourceSegments = snapshot.segments.filter((segment) => segment.speakerId === speakerId);
  const invalidSelection = !buildSplitIntent(snapshot, speakerId, segmentIds);

  function changeSpeaker(id) {
    setSpeakerId(id);
    setSegmentIds([]);
    setConfirmed(false);
  }

  function toggleSegment(id) {
    if (isSubmitting) return;
    setSegmentIds((current) => toggleId(current, id));
    setConfirmed(false);
  }

  function submit(event) {
    event.preventDefault();
    const currentIntent = buildSplitIntent(snapshot, speakerId, segmentIds);
    if (!currentIntent || !confirmed || isSubmitting) return;
    onSubmit(currentIntent);
  }

  return (
    <form className="meeting-speaker-operation-form" onSubmit={submit}>
      <label className="meeting-speaker-field">
        <span>选择来源说话人</span>
        <select className="meeting-speaker-select" value={speakerId} onChange={(event) => changeSpeaker(event.target.value)} disabled={isSubmitting}>
          {availableSpeakers.map((speaker) => <option key={speaker.id} value={speaker.id}>{speaker.label}</option>)}
        </select>
      </label>
      <p className="meeting-speaker-help">选择要拆出的完整内容段，至少保留一段在原说话人下。</p>
      <SpeakerTimeline segments={sourceSegments} selectedSegmentIds={segmentIds} onSegmentSelect={toggleSegment} disabled={isSubmitting} />
      {segmentIds.length > 0 && invalidSelection ? <p className="meeting-speaker-validation">不能选择全部内容段，请为原说话人至少保留一段。</p> : null}
      <Confirmation checked={confirmed} onChange={setConfirmed} disabled={isSubmitting} />
      <SubmitButton isSubmitting={isSubmitting} disabled={invalidSelection || !confirmed} />
    </form>
  );
}

function ReassignForm({ snapshot, isSubmitting, onSubmit }) {
  const availableTargets = snapshot.speakers.filter((speaker) => speaker.canReceiveReassignment);
  const selectableSegments = snapshot.segments.filter((segment) => segment.canSelectForReassignment);
  const [segmentIds, setSegmentIds] = useState([]);
  const [targetSpeakerId, setTargetSpeakerId] = useState(availableTargets[0]?.id || '');
  const [confirmed, setConfirmed] = useState(false);
  const invalidSelection = !buildReassignIntent(snapshot, segmentIds, targetSpeakerId);

  function toggleSegment(id) {
    if (isSubmitting) return;
    setSegmentIds((current) => toggleId(current, id));
    setConfirmed(false);
  }

  function changeTarget(id) {
    setTargetSpeakerId(id);
    setConfirmed(false);
  }

  function submit(event) {
    event.preventDefault();
    const currentIntent = buildReassignIntent(snapshot, segmentIds, targetSpeakerId);
    if (!currentIntent || !confirmed || isSubmitting) return;
    onSubmit(currentIntent);
  }

  return (
    <form className="meeting-speaker-operation-form" onSubmit={submit}>
      <p className="meeting-speaker-help">选择一段或多段完整内容，再指定新的说话人。</p>
      <SpeakerTimeline segments={selectableSegments} selectedSegmentIds={segmentIds} onSegmentSelect={toggleSegment} disabled={isSubmitting} />
      <label className="meeting-speaker-field">
        <span>分配给</span>
        <select className="meeting-speaker-select" value={targetSpeakerId} onChange={(event) => changeTarget(event.target.value)} disabled={isSubmitting}>
          {availableTargets.map((speaker) => <option key={speaker.id} value={speaker.id}>{speaker.label}</option>)}
        </select>
      </label>
      <Confirmation checked={confirmed} onChange={setConfirmed} disabled={isSubmitting} />
      <SubmitButton isSubmitting={isSubmitting} disabled={invalidSelection || !confirmed} />
    </form>
  );
}

function Confirmation({ checked, onChange, disabled }) {
  return (
    <label className="meeting-speaker-confirmation">
      <input className="meeting-speaker-checkbox" type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} disabled={disabled} />
      <span>我已确认本次修改内容</span>
    </label>
  );
}

function SubmitButton({ isSubmitting, disabled }) {
  return (
    <button className="meeting-speaker-button meeting-speaker-submit" type="submit" disabled={disabled || isSubmitting}>
      {isSubmitting ? '正在保存…' : '确认并保存'}
    </button>
  );
}

export function SpeakerOperationPanel({ snapshot, isSubmitting = false, onSubmit }) {
  const [activeOperation, setActiveOperation] = useState(null);

  function selectOperation(operation) {
    if (isSubmitting) return;
    setActiveOperation((current) => current === operation ? null : operation);
  }

  return (
    <section className="meeting-speaker-operations" aria-label="修改说话人">
      <div className="meeting-speaker-operation-triggers">
        {OPERATIONS.map((operation) => (
          <button
            className="meeting-speaker-operation-trigger"
            type="button"
            key={operation.id}
            aria-pressed={activeOperation === operation.id}
            onClick={() => selectOperation(operation.id)}
            disabled={isSubmitting}
          >
            {operation.label}
          </button>
        ))}
      </div>

      {activeOperation ? (
        <div className="meeting-speaker-operation-panel">
          <div className="meeting-speaker-operation-heading">
            <h3 className="meeting-speaker-operation-title">{OPERATIONS.find((operation) => operation.id === activeOperation)?.label}</h3>
            <button className="meeting-speaker-button" type="button" onClick={() => setActiveOperation(null)} disabled={isSubmitting}>取消</button>
          </div>
          {activeOperation === 'rename' ? <RenameForm snapshot={snapshot} isSubmitting={isSubmitting} onSubmit={onSubmit} /> : null}
          {activeOperation === 'merge' ? <MergeForm snapshot={snapshot} isSubmitting={isSubmitting} onSubmit={onSubmit} /> : null}
          {activeOperation === 'split' ? <SplitForm snapshot={snapshot} isSubmitting={isSubmitting} onSubmit={onSubmit} /> : null}
          {activeOperation === 'reassign' ? <ReassignForm snapshot={snapshot} isSubmitting={isSubmitting} onSubmit={onSubmit} /> : null}
        </div>
      ) : (
        <p className="meeting-speaker-help">请选择一种修改方式。每次只处理一项，保存前需要再次确认。</p>
      )}
    </section>
  );
}

export default SpeakerOperationPanel;
