// src/components/figure/FigureCard.jsx
// Phase 7.3 — Lazy image loading, blur placeholder, staggered fade-in, press animation.

import { useState } from "react";

// Map type → badge label
const TYPE_LABEL = {
  graph:      "◈ Graph",
  diagram:    "⬡ Diagram",
  chart:      "◉ Chart",
  comparison: "⇄ Compare",
};

export default function FigureCard({ figure, onClick, onExplain, animationIndex = 0 }) {
  const { id, image, caption, page, type } = figure;

  // Image load / error state for blur placeholder effect
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError]   = useState(false);

  function handleExplain(e) {
    e.stopPropagation();
    onExplain?.(id);
  }

  const badgeLabel = TYPE_LABEL[type] ?? "◈ Figure";

  return (
    <div
      className="fig-card"
      onClick={() => onClick?.(figure)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onClick?.(figure)}
      aria-label={caption}
      // Staggered entrance animation via CSS custom property
      style={{ "--card-index": animationIndex }}
    >
      {/* ── Image area ── */}
      <div className="fig-card-img-wrap">

        {/* Blur placeholder shown until image loads */}
        {!imgLoaded && !imgError && (
          <div className="fig-card-img-placeholder" aria-hidden="true" />
        )}

        {/* Error fallback */}
        {imgError && (
          <div className="fig-card-img-error" aria-label="Image unavailable">
            <span className="fig-card-img-error-icon">◫</span>
            <span className="fig-card-img-error-label">No preview</span>
          </div>
        )}

        {!imgError && (
          <img
            src={image}
            alt={caption}
            className="fig-card-img"
            loading="lazy"
            decoding="async"
            style={{ opacity: imgLoaded ? 1 : 0, transition: "opacity 280ms ease" }}
            onLoad={() => setImgLoaded(true)}
            onError={() => { setImgError(true); setImgLoaded(false); }}
          />
        )}

        {/* Type badge */}
        <span className={`fig-type-badge fig-type-badge--${type ?? "graph"}`}>
          {badgeLabel}
        </span>

        {/* Hover overlay */}
        <div className="fig-card-overlay">
          <button
            className="fig-overlay-btn fig-overlay-btn--view"
            onClick={(e) => { e.stopPropagation(); onClick?.(figure); }}
          >
            🔍 View
          </button>
          <button
            className="fig-overlay-btn fig-overlay-btn--explain"
            onClick={handleExplain}
          >
            ✦ Explain
          </button>
        </div>
      </div>

      {/* ── Card body ── */}
      <div className="fig-card-body">
        <p className="fig-card-caption">
          {(caption ?? "").length > 80
            ? caption.slice(0, 80) + "…"
            : (caption || "No caption available")}
        </p>
        <div className="fig-card-meta">
          <span className="fig-card-id">{id}</span>
          <span className="fig-card-page">p.{page}</span>
        </div>
      </div>
    </div>
  );
}