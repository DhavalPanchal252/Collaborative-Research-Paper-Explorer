// src/components/figure/FigureModal.jsx
// Phase 7.3 — Full caption, ← → keyboard nav, prev/next buttons, index counter,
//             image loading state, ESC-to-close.

import { useEffect, useState } from "react";

const TYPE_LABEL = {
  graph:      "◈ Graph",
  diagram:    "⬡ Diagram",
  chart:      "◉ Chart",
  comparison: "⇄ Compare",
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
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError,  setImgError]  = useState(false);

  // Reset image state whenever figure changes
  useEffect(() => {
    setImgLoaded(false);
    setImgError(false);
  }, [figure?.id]);

  // ESC to close — already handled in FigureExplorer for ← → nav,
  // but we still need ESC here for close.
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose?.();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!figure) return null;

  const { id, image, caption, page, type } = figure;
  const badgeLabel = TYPE_LABEL[type] ?? "◈ Figure";
  const showCounter = typeof currentIndex === "number" && typeof totalCount === "number";

  return (
    <div
      className="fig-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={caption}
    >
      <div
        className="fig-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header bar ── */}
        <div className="fig-modal-header">
          <div className="fig-modal-header-left">
            <span className={`fig-type-badge fig-type-badge--${type ?? "graph"}`}>
              {badgeLabel}
            </span>
            <span className="fig-modal-id">{id}</span>
          </div>

          <div className="fig-modal-header-right">
            {showCounter && (
              <span className="fig-modal-counter">
                {currentIndex + 1} / {totalCount}
              </span>
            )}
            <button
              className="fig-modal-close"
              onClick={onClose}
              aria-label="Close modal"
            >
              ×
            </button>
          </div>
        </div>

        {/* ── Image ── */}
        <div className="fig-modal-img-wrap">
          {/* Skeleton while image loads */}
          {!imgLoaded && !imgError && (
            <div className="fig-modal-img-skeleton" aria-hidden="true" />
          )}

          {imgError && (
            <div className="fig-modal-img-error">
              <span style={{ fontSize: 32, opacity: 0.4 }}>◫</span>
              <span style={{ fontSize: 12, color: "var(--text-3)", marginTop: 8 }}>
                Image could not be loaded
              </span>
            </div>
          )}

          {!imgError && (
            <img
              src={image}
              alt={caption}
              className="fig-modal-img"
              style={{ opacity: imgLoaded ? 1 : 0, transition: "opacity 300ms ease" }}
              onLoad={() => setImgLoaded(true)}
              onError={() => { setImgError(true); setImgLoaded(false); }}
            />
          )}

          {/* Prev / Next nav arrows overlaid on image */}
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

        {/* ── Body ── */}
        <div className="fig-modal-body">
          <p className="fig-modal-caption">{caption || "No caption available."}</p>
          <p className="fig-modal-page">Page {page}</p>

          <div className="fig-modal-actions">
            <button
              className="fig-modal-btn fig-modal-btn--explain"
              onClick={() => onExplain?.(id)}
            >
              ✦ Explain
            </button>
            <button
              className="fig-modal-btn fig-modal-btn--goto"
              onClick={() => onGoToPDF?.(page)}
            >
              ↗ Go to PDF
            </button>
            <button
              className="fig-modal-btn fig-modal-btn--close"
              onClick={onClose}
            >
              Close
            </button>
          </div>

          {/* Keyboard hint */}
          {totalCount > 1 && (
            <p className="fig-modal-kb-hint">
              ← → to navigate · ESC to close
            </p>
          )}
        </div>
      </div>
    </div>
  );
}