// src/components/figure/FigureModal.jsx
// UPDATED — Phase 7.3.C
// Tasks: T6 dark centered img bg · T7 hover zoom · T8 badge spacing ·
//        T9 description readability · T10 caption UX · T11 button hierarchy ·
//        T12 enhanced nav arrows

import { useEffect, useState } from "react";

const TYPE_LABEL = {
  graph:      "◈ Graph",
  diagram:    "⬡ Diagram",
  chart:      "◉ Chart",
  comparison: "⇄ Compare",
  image:      "◫ Image",
};

const IMPORTANCE_CONFIG = {
  high:   { label: "High Priority", cls: "fig-importance-badge--high"   },
  medium: { label: "Medium",        cls: "fig-importance-badge--medium" },
  low:    { label: "Low",           cls: "fig-importance-badge--low"    },
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
  const [imgLoaded,   setImgLoaded]   = useState(false);
  const [imgError,    setImgError]    = useState(false);
  const [captionOpen, setCaptionOpen] = useState(false);
  // NEW T7 — track hover on image for zoom
  const [imgHovered,  setImgHovered]  = useState(false);

  useEffect(() => {
    setImgLoaded(false);
    setImgError(false);
    setCaptionOpen(false);
    setImgHovered(false);
  }, [figure?.id]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!figure) return null;

  const {
    id,
    image         = figure.image_url,
    caption,
    clean_caption,
    page,
    type,
    title         = id,
    description   = caption,
    importance    = "medium",
    confidence,
  } = figure;

  const badgeLabel    = TYPE_LABEL[type] ?? "◈ Figure";
  const importanceCfg = IMPORTANCE_CONFIG[importance] ?? IMPORTANCE_CONFIG.medium;
  const showCounter   = typeof currentIndex === "number" && typeof totalCount === "number";
  const displayCaption = clean_caption || caption;

  const confPct =
    confidence == null ? null
    : confidence <= 1  ? Math.round(confidence * 100)
    :                    Math.round(confidence);

  return (
    <div
      className="fig-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title || caption}
    >
      <div className="fig-modal fig-modal--split" onClick={(e) => e.stopPropagation()}>

        {/* ════════════════════════════════════════════
            LEFT — Image panel (60%)
            ════════════════════════════════════════════ */}
        {/* UPDATED T6 — dark #0f0f0f bg, flex-centered */}
        <div className="fig-modal-left">

          {showCounter && (
            <span className="fig-modal-left-counter">
              {currentIndex + 1} / {totalCount}
            </span>
          )}

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

            {/* UPDATED T7 — zoom on hover via inline transform */}
            {!imgError && (
              <img
                src={image}
                alt={title || caption}
                className="fig-modal-img"
                style={{
                  opacity:   imgLoaded ? 1 : 0,
                  transform: imgHovered ? "scale(1.03)" : "scale(1)",
                  transition: "opacity 300ms ease, transform 320ms ease",
                  cursor: "zoom-in",
                }}
                onLoad={()  => setImgLoaded(true)}
                onError={() => { setImgError(true); setImgLoaded(false); }}
                onMouseEnter={() => setImgHovered(true)}
                onMouseLeave={() => setImgHovered(false)}
              />
            )}

            {/* UPDATED T12 — enhanced nav arrows: larger, always visible on hover */}
            {onPrev && (
              <button
                className="fig-modal-nav fig-modal-nav--prev fig-modal-nav--enhanced"
                onClick={(e) => { e.stopPropagation(); onPrev(); }}
                aria-label="Previous figure"
                title="Previous (←)"
              >
                ‹
              </button>
            )}
            {onNext && (
              <button
                className="fig-modal-nav fig-modal-nav--next fig-modal-nav--enhanced"
                onClick={(e) => { e.stopPropagation(); onNext(); }}
                aria-label="Next figure"
                title="Next (→)"
              >
                ›
              </button>
            )}
          </div>

          {totalCount > 1 && (
            <p className="fig-modal-kb-hint">← → navigate · ESC close</p>
          )}
        </div>

        {/* ════════════════════════════════════════════
            RIGHT — Detail panel (40%)
            ════════════════════════════════════════════ */}
        <div className="fig-modal-right">

          <button className="fig-modal-close" onClick={onClose} aria-label="Close modal">
            ×
          </button>

          <div className="fig-modal-right-scroll">

            {/* Section 1 — Title */}
            <div className="fig-modal-section">
              <p className="fig-modal-title">{title || id}</p>
            </div>

            {/* Section 2 — Badges  UPDATED T8: padding-top added via CSS */}
            <div className="fig-modal-section fig-modal-badges-row">
              <span className={`fig-type-badge fig-type-badge--${type ?? "graph"} fig-type-badge--inline`}>
                {badgeLabel}
              </span>
              <span className={`fig-importance-badge ${importanceCfg.cls} fig-importance-badge--inline`}>
                {importanceCfg.label}
              </span>
            </div>

            {/* Section 3 — Description  UPDATED T9 */}
            {description && (
              <div className="fig-modal-section">
                <p className="fig-modal-section-label">Description</p>
                <p className="fig-modal-description">{description}</p>
              </div>
            )}

            {/* Section 4 — Caption (collapsible)  UPDATED T10 */}
            {displayCaption && (
              <div className="fig-modal-section">
                <button
                  className="fig-modal-collapse-toggle"
                  onClick={() => setCaptionOpen((v) => !v)}
                  aria-expanded={captionOpen}
                >
                  {/* UPDATED T10 — label includes indicator icon + hover underline */}
                  <span className="fig-modal-section-label fig-modal-caption-label">
                    <span
                      className="fig-modal-collapse-chevron"
                      style={{
                        display: "inline-block",
                        transition: "transform 200ms ease",
                        transform: captionOpen ? "rotate(180deg)" : "rotate(0deg)",
                        marginRight: 5,
                      }}
                    >
                      ▾
                    </span>
                    Caption
                  </span>
                  {/* UPDATED T10 — peek text when collapsed */}
                  {!captionOpen && (
                    <span className="fig-modal-caption-peek">
                      {displayCaption.slice(0, 38)}{displayCaption.length > 38 ? "…" : ""}
                    </span>
                  )}
                </button>

                {/* UPDATED T10 — animated expand using max-height */}
                <div className={`fig-modal-collapse-body${captionOpen ? " fig-modal-collapse-body--open" : ""}`}>
                  <p className="fig-modal-caption">{displayCaption}</p>
                </div>
              </div>
            )}

            {/* Section 5 — Metadata */}
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
                      className="fig-card-conf-bar"
                      style={{ "--conf-pct": `${confPct}%` }}
                      aria-label={`Confidence: ${confPct}%`}
                    />
                    <span className="fig-card-conf-label">{confPct}%</span>
                  </div>
                </div>
              )}
            </div>

            {/* Section 6 — Actions  UPDATED T11: primary/secondary hierarchy */}
            <div className="fig-modal-section fig-modal-actions">
              {/* T11 PRIMARY — filled amber, glowing */}
              <button
                className="fig-modal-btn fig-modal-btn--explain fig-modal-btn--primary"
                onClick={() => onExplain?.(id)}
              >
                ✦ Explain with AI
              </button>
              {/* T11 SECONDARY — outline/ghost */}
              <button
                className="fig-modal-btn fig-modal-btn--goto fig-modal-btn--secondary"
                onClick={() => onGoToPDF?.(page)}
              >
                ↗ Go to PDF
              </button>
            </div>

          </div>
        </div>

      </div>
    </div>
  );
}