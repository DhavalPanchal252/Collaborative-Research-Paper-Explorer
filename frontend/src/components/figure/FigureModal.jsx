// src/components/figure/FigureModal.jsx
// UPDATED — Phase 7.3.B: left/right split layout, detail panel, collapsible caption,
//           confidence bar, new field support. All existing props kept.

import { useEffect, useState } from "react";

// UPDATED — includes image type
const TYPE_LABEL = {
  graph:      "◈ Graph",
  diagram:    "⬡ Diagram",
  chart:      "◉ Chart",
  comparison: "⇄ Compare",
  image:      "◫ Image",
};

// NEW — importance display config
const IMPORTANCE_CONFIG = {
  high:   { label: "High Priority",   cls: "fig-importance-badge--high"   },
  medium: { label: "Medium",          cls: "fig-importance-badge--medium" },
  low:    { label: "Low",             cls: "fig-importance-badge--low"    },
};

export default function FigureModal({
  figure,
  onClose,
  onExplain,
  onGoToPDF,
  onPrev,
  onNext,
  currentIndex,
  totalCount,
}) {
  const [imgLoaded,      setImgLoaded]      = useState(false);
  const [imgError,       setImgError]       = useState(false);
  // NEW — collapsible caption section
  const [captionOpen,    setCaptionOpen]    = useState(false);

  // Reset states on figure change
  useEffect(() => {
    setImgLoaded(false);
    setImgError(false);
    setCaptionOpen(false);
  }, [figure?.id]);

  // ESC to close
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose?.();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!figure) return null;

  // UPDATED — support both old + new field shapes
  const {
    id,
    image         = figure.image_url,
    caption,
    clean_caption,              // NEW — cleaner version of caption if available
    page,
    type,
    title         = id,         // NEW
    description   = caption,    // NEW
    importance    = "medium",   // NEW
    confidence,                 // NEW
  } = figure;

  const badgeLabel    = TYPE_LABEL[type] ?? "◈ Figure";
  const importanceCfg = IMPORTANCE_CONFIG[importance] ?? IMPORTANCE_CONFIG.medium;
  const showCounter   = typeof currentIndex === "number" && typeof totalCount === "number";

  // NEW — normalise confidence 0-1 or 0-100 → integer percent
  const confPct =
    confidence == null
      ? null
      : confidence <= 1
        ? Math.round(confidence * 100)
        : Math.round(confidence);

  // Use clean_caption if available, fall back to caption
  const displayCaption = clean_caption || caption;

  return (
    <div
      className="fig-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title || caption}
    >
      {/* NEW — wider two-column container */}
      <div
        className="fig-modal fig-modal--split"
        onClick={(e) => e.stopPropagation()}
      >

        {/* ══════════════════════════════════════════
            LEFT — Image (60%)
            ══════════════════════════════════════════ */}
        <div className="fig-modal-left">

          {/* Counter badge top-left */}
          {showCounter && (
            <span className="fig-modal-left-counter">
              {currentIndex + 1} / {totalCount}
            </span>
          )}

          {/* Image area */}
          <div className="fig-modal-img-wrap">

            {!imgLoaded && !imgError && (
              <div className="fig-modal-img-skeleton" aria-hidden="true" />
            )}

            {imgError && (
              <div className="fig-modal-img-error">
                <span style={{ fontSize: 36, opacity: 0.3 }}>◫</span>
                <span style={{ fontSize: 12, color: "var(--text-3)", marginTop: 8 }}>
                  Image unavailable
                </span>
              </div>
            )}

            {!imgError && (
              <img
                src={image}
                alt={title || caption}
                className="fig-modal-img"
                style={{ opacity: imgLoaded ? 1 : 0, transition: "opacity 300ms ease" }}
                onLoad={() => setImgLoaded(true)}
                onError={() => { setImgError(true); setImgLoaded(false); }}
              />
            )}

            {/* Prev / Next arrows */}
            {onPrev && (
              <button
                className="fig-modal-nav fig-modal-nav--prev"
                onClick={(e) => { e.stopPropagation(); onPrev(); }}
                aria-label="Previous figure"
                title="Previous (←)"
              >
                ‹
              </button>
            )}
            {onNext && (
              <button
                className="fig-modal-nav fig-modal-nav--next"
                onClick={(e) => { e.stopPropagation(); onNext(); }}
                aria-label="Next figure"
                title="Next (→)"
              >
                ›
              </button>
            )}
          </div>

          {/* KB hint at bottom of left panel */}
          {totalCount > 1 && (
            <p className="fig-modal-kb-hint">← → navigate · ESC close</p>
          )}
        </div>

        {/* ══════════════════════════════════════════
            RIGHT — Detail panel (40%)
            ══════════════════════════════════════════ */}
        <div className="fig-modal-right">

          {/* Close button */}
          <button
            className="fig-modal-close"
            onClick={onClose}
            aria-label="Close modal"
          >
            ×
          </button>

          {/* Scrollable content area */}
          <div className="fig-modal-right-scroll">

            {/* ── Section 1: Title ── */}
            <div className="fig-modal-section">
              <p className="fig-modal-title">{title || id}</p>
            </div>

            {/* ── Section 2: Badges row ── */}
            <div className="fig-modal-section fig-modal-badges-row">
              <span className={`fig-type-badge fig-type-badge--${type ?? "graph"} fig-type-badge--inline`}>
                {badgeLabel}
              </span>
              <span className={`fig-importance-badge ${importanceCfg.cls} fig-importance-badge--inline`}>
                {importanceCfg.label}
              </span>
            </div>

            {/* ── Section 3: Description ── */}
            {description && (
              <div className="fig-modal-section">
                <p className="fig-modal-section-label">Description</p>
                <p className="fig-modal-description">{description}</p>
              </div>
            )}

            {/* ── Section 4: Caption (collapsible) ── */}
            {displayCaption && (
              <div className="fig-modal-section">
                <button
                  className="fig-modal-collapse-toggle"
                  onClick={() => setCaptionOpen((v) => !v)}
                  aria-expanded={captionOpen}
                >
                  <span className="fig-modal-section-label">Caption</span>
                  <span
                    className="fig-modal-collapse-icon"
                    style={{
                      transform: captionOpen ? "rotate(180deg)" : "rotate(0deg)",
                      transition: "transform 200ms ease",
                    }}
                  >
                    ▾
                  </span>
                </button>

                {/* NEW — collapsible body */}
                <div
                  className="fig-modal-collapse-body"
                  style={{ display: captionOpen ? "block" : "none" }}
                >
                  <p className="fig-modal-caption">{displayCaption}</p>
                </div>
              </div>
            )}

            {/* ── Section 5: Metadata row ── */}
            <div className="fig-modal-section fig-modal-meta-row">
              <div className="fig-modal-meta-chip">
                <span className="fig-modal-meta-label">Page</span>
                <span className="fig-modal-meta-value">{page}</span>
              </div>

              {confPct != null && (
                <div className="fig-modal-meta-chip fig-modal-meta-chip--conf">
                  <span className="fig-modal-meta-label">Confidence</span>
                  <div className="fig-modal-conf-wrap">
                    <div
                      className="fig-card-conf-bar"                  /* reuse card bar class */
                      style={{ "--conf-pct": `${confPct}%` }}
                      aria-label={`Confidence: ${confPct}%`}
                    />
                    <span className="fig-card-conf-label">{confPct}%</span>
                  </div>
                </div>
              )}
            </div>

            {/* ── Section 6: Actions ── */}
            <div className="fig-modal-section fig-modal-actions">
              <button
                className="fig-modal-btn fig-modal-btn--explain"
                onClick={() => onExplain?.(id)}
              >
                ✦ Explain with AI
              </button>
              <button
                className="fig-modal-btn fig-modal-btn--goto"
                onClick={() => onGoToPDF?.(page)}
              >
                ↗ Go to PDF
              </button>
            </div>

          </div>{/* end scroll */}
        </div>{/* end right */}
      </div>{/* end fig-modal--split */}
    </div>
  );
}