import './SpeakerManagement.css';

function formatHistoryDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '日期未记录';
  return date.toLocaleString('zh-CN', {
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function SpeakerRevisionHistory({ history = [] }) {
  return (
    <section className="meeting-speaker-history" aria-label="修改记录">
      <div className="meeting-speaker-history-heading">
        <div>
          <p className="meeting-speaker-eyebrow">安心回顾</p>
          <h3 className="meeting-speaker-title">修改记录</h3>
        </div>
        <p className="meeting-speaker-readonly">仅供查看</p>
      </div>

      {history.length ? (
        <ol className="meeting-speaker-history-list">
          {history.map((entry, index) => (
            <li className="meeting-speaker-history-item" key={`${entry.occurredAt}-${index}`}>
              <article className="meeting-speaker-history-card">
                <time className="meeting-speaker-history-time" dateTime={entry.occurredAt}>{formatHistoryDate(entry.occurredAt)}</time>
                <p className="meeting-speaker-history-summary">{entry.summary}</p>
              </article>
            </li>
          ))}
        </ol>
      ) : (
        <p className="meeting-speaker-empty">还没有说话人调整记录。</p>
      )}
    </section>
  );
}

export default SpeakerRevisionHistory;
