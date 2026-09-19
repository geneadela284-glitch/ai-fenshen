import { createMeetingPhase1Store } from './browserMeetingStore.js';
import { createMeetingTranscriptStore } from './meetingTranscriptStore.js';
import { createMeetingAnalysisBundleStore } from './meetingAnalysisBundleStore.js';
import { classifyMeetingQuery, meetingLocalDay, MEETING_QUERY_SCHEMA, MEETING_QUERY_LIMIT, MEETING_QUERY_TEXT_LIMIT } from '../../../../core/meetingQuery/queryContract.js';
import { openMeetingQueryReader, checkMeetingQuerySignal } from './meetingQueryReadOnlyStorage.js';

function summaryText(bundle) {
  const value = item => typeof item === 'string' ? item : String(item?.value || item?.content || '');
  const strings = [value(bundle.summary?.overview), ...(bundle.summary?.keyPoints || []).map(value), ...(bundle.summary?.conclusions || []).map(value), ...(bundle.decisions || []).map(item => `决定：${value(item)}`), ...(bundle.actionItems || []).map(item => `待办：${value(item)}`)];
  return [...new Set(strings.filter(s => s.trim()))].join('\n');
}
const elapsed = ms => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
export async function collectMeetingEvidence({ user, question, timezone = 'Asia/Shanghai', now = new Date(), signal } = {}, dependencies = {}) {
  checkMeetingQuerySignal(signal);
  const normalizedQuestion = String(question || '').trim();
  const plan = classifyMeetingQuery(normalizedQuestion, { timezone, now });
  if (!plan) return null;
  if (!user?.id) throw Object.assign(new Error('AUTH_REQUIRED'), { code: 'AUTH_REQUIRED' });
  const context = Object.freeze({ trusted: true, ownerId: String(user.id), sessionId: String(user.sessionId || user.session?.id || `auth-session-${user.id}`), spaceId: 'meeting-space' });
  const envelope = { schema: MEETING_QUERY_SCHEMA, ownerId: context.ownerId, question: normalizedQuestion, timezone, date: plan.date, queriedAt: new Date(now).toISOString(), state: plan.state, total: 0, meetings: [] };
  if (plan.state === 'needs_date') return envelope;
  let reader;
  try {
    reader = dependencies.backend ? dependencies : await (dependencies.openReader || openMeetingQueryReader)({ ...dependencies, signal });
    checkMeetingQuerySignal(signal);
    if (reader.empty) return envelope;
    const { backend, keyProvider, cryptoImpl = globalThis.crypto } = reader;
    const store = createMeetingPhase1Store({ backend, keyProvider, cryptoImpl });
    const transcripts = createMeetingTranscriptStore({ backend, keyProvider, cryptoImpl });
    const bundles = createMeetingAnalysisBundleStore({ backend, keyProvider, cryptoImpl });
    const meetings = (await store.listMeetings(context))
      .filter(m => m.ownerId === context.ownerId && m.scope === 'meeting' && meetingLocalDay(m.createdAt, timezone) === plan.date)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.meetingId.localeCompare(b.meetingId));
    envelope.total = meetings.length;
    const hashBytes = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(`meeting-owner:${context.ownerId}`));
    const ownerHash = [...new Uint8Array(hashBytes)].map(n => n.toString(16).padStart(2, '0')).join('');
    const documents = meetings.length ? (await backend.list('transcriptDocuments')).filter(row => row.ownerHash === ownerHash) : [];
    for (const meeting of meetings.slice(0, MEETING_QUERY_LIMIT)) {
      checkMeetingQuerySignal(signal);
      const projected = { meetingId: meeting.meetingId, title: String(meeting.title || '未命名会议').slice(0, 120), createdAt: meeting.createdAt, kind: 'no_text', text: '', sourceUpdatedAt: '', truncated: false };
      try {
        const rows = documents.filter(row => row.meetingId === meeting.meetingId);
        const values = [];
        for (const row of rows) {
          checkMeetingQuerySignal(signal);
          const loaded = await transcripts.getTranscript(context, { meetingId: meeting.meetingId, transcriptId: row.transcriptId });
          if (loaded.document.status === 'ready') values.push(loaded);
        }
        values.sort((a, b) => Date.parse(b.document.updatedAt) - Date.parse(a.document.updatedAt));
        const sources = new Set();
        const current = values.filter(item => { if (sources.has(item.document.sourceId)) return false; sources.add(item.document.sourceId); return true; });
        // Reading saved bundles without a source returns REVALIDATION_REQUIRED.
        // We quote a saved, revision-matched result; never relabel it CURRENT.
        const saved = current.length ? await bundles.list(context, { meetingId: meeting.meetingId }) : [];
        const texts = [];
        const kinds = [];
        for (const loaded of current.slice(0, 3)) {
          const doc = loaded.document;
          const matching = saved.filter(b => b.transcriptId === doc.transcriptId && b.transcriptRevision === loaded.currentRevision.transcriptRevision && b.sourceId === doc.sourceId && b.sourceRevision === doc.sourceRevision)
            .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.analysisRevision - a.analysisRevision)[0];
          const summary = matching ? summaryText(matching) : '';
          const text = summary || loaded.currentRevision.segments.map(s => `[${elapsed(s.startMs)}] ${s.text}`).join('\n');
          if (!text.trim()) continue;
          const kind = summary ? 'saved_summary' : 'transcript';
          kinds.push(kind);
          const sourceLabel = summary ? `已保存纪要；生成日期：${meetingLocalDay(matching.updatedAt, timezone)}` : '转文字节选';
          texts.push(`${current.length > 1 ? `文字记录 ${texts.length + 1}（${sourceLabel}）：\n` : ''}${text}`);
          if (!projected.sourceUpdatedAt) projected.sourceUpdatedAt = summary ? matching.updatedAt : doc.updatedAt;
        }
        const text = texts.join('\n\n');
        if (text) {
          projected.kind = new Set(kinds).size === 1 ? kinds[0] : 'mixed';
          projected.text = text.slice(0, MEETING_QUERY_TEXT_LIMIT);
          projected.truncated = text.length > MEETING_QUERY_TEXT_LIMIT || current.length > 3;
          if (texts.length > 1) projected.sourceUpdatedAt = '';
        }
      } catch (err) {
        checkMeetingQuerySignal(signal);
        projected.kind = 'unavailable'; projected.text = ''; projected.sourceUpdatedAt = '';
      }
      envelope.meetings.push(projected);
    }
    return envelope;
  } catch (err) {
    checkMeetingQuerySignal(signal);
    return { ...envelope, state: 'unavailable', total: 0, meetings: [] };
  } finally { reader?.close?.(); }
}
