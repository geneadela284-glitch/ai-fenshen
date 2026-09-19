import Icon from './Icon.jsx';

export default function MemoryFeatureView({ onBack, onStartChat }) {
  return (
    <main className="af-feature-view" data-testid="feature-memory">
      <section className="af-feature-glass" aria-labelledby="feature-title-memory">
        <span className="af-feature-icon" aria-hidden="true"><Icon name="brain" size={30} /></span>
        <h1 id="feature-title-memory">记忆</h1>
        <p>长期记忆已启用。你可以在对话中告诉AI分身重要信息，并在之后的新对话中再次询问。</p>
        <button type="button" className="af-feature-action" onClick={onStartChat}>开始对话</button>
        <button type="button" className="af-feature-back" onClick={onBack}>返回首页</button>
      </section>
    </main>
  );
}
