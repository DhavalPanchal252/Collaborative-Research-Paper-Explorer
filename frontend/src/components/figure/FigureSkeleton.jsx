// src/components/figure/FigureSkeleton.jsx
// Phase 7.1 — Shimmer skeleton card shown while figures load.

export default function FigureSkeleton() {
  return (
    <div className="fig-card fig-card--skeleton" aria-hidden="true">
      <div className="fig-card-img-wrap fig-skeleton-img" />
      <div className="fig-card-body">
        <div className="fig-skeleton-line fig-skeleton-line--wide" />
        <div className="fig-skeleton-line fig-skeleton-line--short" />
        <div className="fig-skeleton-badge" />
      </div>
    </div>
  );
}