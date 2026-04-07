// src/components/figure/FigureModal.jsx
// Phase 7.1 — Expanded figure modal with full caption, actions, ESC-to-close.

import { useEffect } from "react";

export default function FigureModal({ figure, onClose, onExplain, onGoToPDF }) {
  // ESC to close
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose?.();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!figure) return null;

  const { id, image, caption, page, type } = figure;

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
        {/* Close button */}
        <button
          className="fig-modal-close"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>

        {/* Image */}
        <div className="fig-modal-img-wrap">
          <img src={image} alt={caption} className="fig-modal-img" />
          <span className={`fig-type-badge fig-type-badge--${type}`}>
            {type === "graph" ? "◈ Graph" : "⬡ Diagram"}
          </span>
        </div>

        {/* Meta */}
        <div className="fig-modal-body">
          <p className="fig-modal-caption">{caption}</p>
          <p className="fig-modal-page">Page {page}</p>

          {/* Actions */}
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
        </div>
      </div>
    </div>
  );
}