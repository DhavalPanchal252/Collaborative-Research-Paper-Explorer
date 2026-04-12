// src/components/figure/FigureCard.jsx
// Phase 7.4 — Maps normalised figure shape from figureService.
// All fallbacks are resolved upstream in normaliseFigure(); card just renders.

import { useState } from "react";

// ── Badge configs ────────────────────────────────────────────────────────────

const TYPE_LABEL = {
  graph:      "◈ Graph",
  diagram:    "⬡ Diagram",
  chart:      "◉ Chart",
  comparison: "⇄ Compare",
  image:      "◫ Image",
  other:      "◈ Figure",
};

const IMPORTANCE_CONFIG = {
  high:   { label: "High",   cls: "fig-importance-badge--high"   },
  medium: { label: "Medium", cls: "fig-importance-badge--medium" },
  low:    { label: "Low",    cls: "fig-importance-badge--low"    },
};

// Truncate to ~90 chars for the 2-line preview
function truncate(str, max = 90) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) + "…" : str;
}

export default function FigureCard({ figure, onClick, onExplain, animationIndex = 0 }) {
  // All fields are pre-normalised by figureService.normaliseFigure():
  //   image       → resolved absolute URL
  //   type        → lowercase, fallback "graph"
  //   importance  → lowercase, fallback "medium"
  //   confidence  → 0-100 integer or null
  //   title       → raw.title || raw.id
  //   description → raw.description || raw.clean_caption || raw.caption || ""
  const {
    id,
    image,
    page,
    type        = "other",
    title,
    description,
    importance  = "medium",
    confidence  = null,
  } = figure;

  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError,  setImgError]  = useState(false);

  function handleExplain(e) {
    e.stopPropagation();
    onExplain?.(id);
  }

  const badgeLabel    = TYPE_LABEL[type]       ?? "◈ Figure";
  const importanceCfg = IMPORTANCE_CONFIG[importance] ?? IMPORTANCE_CONFIG.medium;
  const shortDesc     = truncate(description);

  return (
    <div
      className="fig-card"
      onClick={() => onClick?.(figure)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onClick?.(figure)}
      aria-label={title}
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
            alt={title}
            className="fig-card-img"
            loading="lazy"
            decoding="async"
            style={{ opacity: imgLoaded ? 1 : 0, transition: "opacity 280ms ease" }}
            onLoad={()  => setImgLoaded(true)}
            onError={() => { setImgError(true); setImgLoaded(false); }}
          />
        )}

        {/* Type badge — top-left */}
        <span className={`fig-type-badge fig-type-badge--${type}`}>
          {badgeLabel}
        </span>

        {/* Importance badge — top-right */}
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

      {/* ── Card body ───────────────────────────────────────────────────── */}
      <div className="fig-card-body">

        {/* Title — bold, 1 line */}
        <p className="fig-card-title">{title}</p>

        {/* Short description — 2 lines max */}
        {shortDesc && (
          <p className="fig-card-desc">
              {shortDesc || "No description available"}
          </p>
        )}

        {/* Meta row: id + page */}
        <div className="fig-card-meta">
          <span className="fig-card-id">{id}</span>
          <span className="fig-card-page">p.{page}</span>
        </div>

        {/* Confidence bar — only when confidence > 0 */}
        {confidence != null && confidence > 0 && (
          <div className="fig-card-conf">
            <div
              className="fig-card-conf-bar"
              style={{ "--conf-pct": `${confidence}%` }}
              aria-label={`Confidence: ${confidence}%`}
            />
            <span className="fig-card-conf-label">{confidence}%</span>
          </div>
        )}
      </div>
    </div>
  );
}