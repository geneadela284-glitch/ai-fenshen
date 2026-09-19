import Icon from './Icon.jsx';

export default function FeaturePlaceholderView({ feature, onBack }) {
  if (!feature) return null;
  return (
    <main className="af-feature-view" data-testid={`feature-${feature.key}`}>
      <section className="af-feature-glass" aria-labelledby={`feature-title-${feature.key}`}>
        <span className="af-feature-icon" aria-hidden="true"><Icon name={feature.icon} size={30} /></span>
        <h1 id={`feature-title-${feature.key}`}>{feature.label}</h1>
        <p>该功能正在完善，将在后续版本开放。</p>
        <button type="button" className="af-feature-action af-placeholder-back" onClick={onBack}>返回首页</button>
      </section>
    </main>
  );
}
