// src/components/figure/FigureCard.jsx
// UPDATED — Phase 7.3.A: Importance badge, title, description, confidence bar.
// Removed: raw caption clutter, large text blocks.

import { useState } from "react";

// ── Badge configs ──────────────────────────────────────────────────────────

const TYPE_LABEL = {
  graph:      "◈ Graph",
  diagram:    "⬡ Diagram",
  chart:      "◉ Chart",
  comparison: "⇄ Compare",
  image:      "◫ Image",
};

// NEW — importance badge config
const IMPORTANCE_CONFIG = {
  high:   { label: "High",   cls: "fig-importance-badge--high"   },
  medium: { label: "Medium", cls: "fig-importance-badge--medium" },
  low:    { label: "Low",    cls: "fig-importance-badge--low"    },
};

export default function FigureCard({ figure, onClick, onExplain, animationIndex = 0 }) {
  // Support both old shape (id, image, caption, page) and new shape
  // (title, description, image_url, importance, confidence) — graceful fallback
  const {
    id,
    image      = figure.image_url,   // NEW field alias
    caption,
    page,
    type,
    title      = id,                 // NEW — bold title line
    description = caption,           // NEW — short description
    importance  = "medium",          // NEW — high | medium | low
    confidence,                      // NEW — 0–1 or 0–100
  } = figure;

  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError,  setImgError]  = useState(false);

  function handleExplain(e) {
    e.stopPropagation();
    onExplain?.(id);
  }

  const badgeLabel = TYPE_LABEL[type] ?? "◈ Figure";

  // NEW — normalise confidence to 0-100
  const confPct =
    confidence == null
      ? null
      : confidence <= 1
        ? Math.round(confidence * 100)
        : Math.round(confidence);

  // NEW — truncate description to 2 lines worth (~90 chars)
  const shortDesc =
    (description ?? "").length > 90
      ? description.slice(0, 90) + "…"
      : description || "";

  const importanceCfg = IMPORTANCE_CONFIG[importance] ?? IMPORTANCE_CONFIG.medium;

  return (
    <div
      className="fig-card"
      onClick={() => onClick?.(figure)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onClick?.(figure)}
      aria-label={title || caption}
      style={{ "--card-index": animationIndex }}
    >
      {/* ── Image area ──────────────────────────────────────────────────── */}
      <div className="fig-card-img-wrap">

        {!imgLoaded && !imgError && (
          <div className="fig-card-img-placeholder" aria-hidden="true" />
        )}

        {imgError && (
          <div className="fig-card-img-error" aria-label="Image unavailable">
            <span className="fig-card-img-error-icon">◫</span>
            <span className="fig-card-img-error-label">No preview</span>
          </div>
        )}

        {!imgError && (
          <img
            src={image}
            alt={title || caption}
            className="fig-card-img"
            loading="lazy"
            decoding="async"
            style={{ opacity: imgLoaded ? 1 : 0, transition: "opacity 280ms ease" }}
            onLoad={() => setImgLoaded(true)}
            onError={() => { setImgError(true); setImgLoaded(false); }}
          />
        )}

        {/* Type badge — top-left */}
        <span className={`fig-type-badge fig-type-badge--${type ?? "graph"}`}>
          {badgeLabel}
        </span>

        {/* NEW — Importance badge — top-right */}
        <span className={`fig-importance-badge ${importanceCfg.cls}`}>
          {importanceCfg.label}
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

      {/* ── Card body ──────────────────────────────────────────────────── */}
      <div className="fig-card-body">

        {/* NEW — Title (bold, 1 line) */}
        <p className="fig-card-title">
          {(title ?? id ?? "Untitled Figure")}
        </p>

        {/* NEW — Short description (2 lines max, replacing raw caption dump) */}
        {shortDesc && (
          <p className="fig-card-desc">{shortDesc}</p>
        )}

        {/* Meta row: id + page */}
        <div className="fig-card-meta">
          <span className="fig-card-id">{id}</span>
          <span className="fig-card-page">p.{page}</span>
        </div>

        {/* NEW — Confidence bar (only rendered if confidence provided) */}
        {confPct != null && (
          <div className="fig-card-conf">
            <div
              className="fig-card-conf-bar"
              style={{ "--conf-pct": `${confPct}%` }}
              aria-label={`Confidence: ${confPct}%`}
            />
            <span className="fig-card-conf-label">{confPct}%</span>
          </div>
        )}
      </div>
    </div>
  );
}