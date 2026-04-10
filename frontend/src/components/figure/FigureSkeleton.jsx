// src/components/figure/FigureSkeleton.jsx
// Phase 7.3 — Shimmer skeleton card with staggered animation delay.

export default function FigureSkeleton({ index = 0 }) {
  return (
    <div
      className="fig-card fig-card--skeleton"
      aria-hidden="true"
      style={{ animationDelay: `${index * 80}ms` }}
    >
      <div className="fig-card-img-wrap fig-skeleton-img" />
      <div className="fig-card-body">
        <div className="fig-skeleton-line fig-skeleton-line--wide" />
        <div className="fig-skeleton-line fig-skeleton-line--short" />
        <div className="fig-skeleton-badge" />
      </div>
    </div>
  );
}