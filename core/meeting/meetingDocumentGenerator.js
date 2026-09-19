function sanitize(text = '') {
  return String(text || '')
    .replace(/Provider/gi, '服务')
    .replace(/API Key/gi, '凭据')
    .replace(/meeting-[A-Za-z0-9-]+/g, '会议记录');
}

function list(items = [], render = (item) => item.content || item) {
  return items.length ? items.map((item) => `- ${sanitize(render(item))}`).join('\n') : '- 未明确';
}

export class MeetingDocumentGenerator {
  generateMarkdown(meeting = {}, { includeTranscript = true } = {}) {
    const summary = meeting.summary || {};
    const content = [
      `# ${sanitize(meeting.title || '未命名会议')}`,
      '',
      '## 基本信息',
      `- 状态：${meeting.status || '未明确'}`,
      `- 开始时间：${meeting.startedAt || '未明确'}`,
      `- 结束时间：${meeting.endedAt || '未明确'}`,
      `- 时长：${Number(meeting.durationSeconds || 0)} 秒`,
      `- 参会人：${(meeting.participants || summary.participants || []).join('、') || '未明确'}`,
      '',
      '## 会议摘要',
      sanitize(summary.summary || '未明确'),
      '',
      '## 讨论主题',
      list(summary.topics || []),
      '',
      '## 最终决策',
      list(meeting.decisions || []),
      '',
      '## 待办事项',
      list(meeting.actionItems || [], (item) => `${item.content}｜负责人：${item.owner || '未明确'}｜截止：${item.dueDate || '未明确'}`),
      '',
      '## 风险',
      list(meeting.risks || []),
      '',
      '## 待确认事项',
      list(summary.unconfirmedItems || []),
      '',
      '## 后续跟进',
      list(meeting.followUps || []),
      includeTranscript ? ['', '## 原文附录', sanitize(meeting.transcript || '未明确')].join('\n') : ''
    ].filter((section) => section !== '').join('\n');

    return {
      filename: `${sanitize(meeting.title || 'meeting')}.md`,
      content
    };
  }
}
