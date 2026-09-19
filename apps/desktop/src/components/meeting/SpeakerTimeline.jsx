import './SpeakerManagement.css';

function formatTimelineTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds) / 1000) || 0);
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export function SpeakerTimeline({ segments = [], selectedSegmentIds = [], onSegmentSelect, disabled = false }) {
  const interactive = typeof onSegmentSelect === 'function';
  return (
    <section className="meeting-speaker-timeline" aria-label="说话人时间线">
      <div className="meeting-speaker-timeline-heading">
        <div>
          <p className="meeting-speaker-eyebrow">会议内容</p>
          <h3 className="meeting-speaker-title">说话人时间线</h3>
        </div>
        <p className="meeting-speaker-count">{segments.length} 段内容</p>
      </div>

      <ol className="meeting-speaker-timeline-list">
        {segments.map((segment) => {
          const speakerLabel = segment.speakerLabel || '未识别说话人';
          const timeRange = `${formatTimelineTime(segment.startMs)} – ${formatTimelineTime(segment.endMs)}`;
          const isSelected = selectedSegmentIds.includes(segment.id);
          const content = (
            <>
              <span className={`meeting-speaker-chip${speakerLabel === '未识别说话人' ? ' is-unknown' : ''}`}>{speakerLabel}</span>
              <span className="meeting-speaker-time">{timeRange}</span>
              <span className="meeting-speaker-content">{segment.text}</span>
            </>
          );
          return (
            <li className="meeting-speaker-timeline-item" key={segment.id}>
              {interactive ? (
                <button
                  className="meeting-speaker-timeline-card"
                  type="button"
                  aria-pressed={isSelected}
                  aria-label={`选择 ${speakerLabel} 的内容，${timeRange}`}
                  onClick={() => onSegmentSelect(segment.id)}
                  disabled={disabled}
                >
                  {content}
                </button>
              ) : (
                <article className="meeting-speaker-timeline-card">
                  {content}
                </article>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export default SpeakerTimeline;
