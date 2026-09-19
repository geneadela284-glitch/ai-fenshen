import { useEffect, useRef, useState } from 'react';
import ChatMessage from './ChatMessage.jsx';
import Icon from './Icon.jsx';
import { isNearBottom } from './prototypeState.js';

export default function ChatMessageList({ messages, onRetry, onDeleteAttachment }) {
  const listRef = useRef(null);
  const frameRef = useRef(0);
  const [followLatest, setFollowLatest] = useState(true);
  const latestContentLength = messages.at(-1)?.content?.length || 0;

  useEffect(() => {
    if (!followLatest || !listRef.current) return;
    window.cancelAnimationFrame(frameRef.current);
    frameRef.current = window.requestAnimationFrame(() => {
      const list = listRef.current;
      if (list) list.scrollTo({ top: list.scrollHeight, behavior: 'auto' });
    });
    return () => window.cancelAnimationFrame(frameRef.current);
  }, [followLatest, messages.length, latestContentLength]);

  const scrollToBottom = () => {
    if (!listRef.current) return;
    setFollowLatest(true);
    window.cancelAnimationFrame(frameRef.current);
    frameRef.current = window.requestAnimationFrame(() => {
      const list = listRef.current;
      if (list) list.scrollTo({ top: list.scrollHeight, behavior: 'auto' });
    });
  };

  return (
    <div className="af-message-list-wrap">
      <div
        ref={listRef}
        className="af-message-list"
        data-testid="chat-message-list"
        onScroll={(event) => setFollowLatest(isNearBottom(event.currentTarget))}
      >
        <div className="af-message-list-inner">
          {messages.map((message) => (
            <ChatMessage
              key={message.id}
              message={message}
              onRetry={onRetry}
              onDeleteAttachment={onDeleteAttachment}
            />
          ))}
        </div>
      </div>
      {!followLatest ? <button type="button" className="af-back-to-bottom" onClick={scrollToBottom}><Icon name="arrow-down" size={18} />回到底部</button> : null}
    </div>
  );
}
