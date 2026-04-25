// src/components/figure/FigureModal.jsx
// Phase 7.5.2 — "Go to PDF" opens the source paper at the exact figure page
//               using the browser-native PDF fragment "#page=N".
//
// What changed from Phase 7.5.1
// --------------------------------
// • Added `usePdfNavigation` hook — encapsulates all URL-building + edge-case
//   logic in one place, tested independently.
// • "↗ Go to PDF" button now:
//     – Disabled when pdf_url or page is missing/invalid.
//     – Shows "Go to PDF • p.{N}" as the label.
//     – Opens a new tab at `pdf_url#page=N`.
//     – Briefly flashes a "progress" cursor on click (100 ms) without
//       blocking the UI thread.
//     – Has tooltip "Open paper at this figure".
// • onGoToPDF prop is preserved for the in-viewer sibling navigation
//   (FigureExplainPanel still calls it to scroll the embedded PDF viewer).
//   The new button does NOT call onGoToPDF — it opens a new browser tab.
// Phase 7.5.3 — Added ⚡ UX behavior hint table in detail pane.

import { useEffect, useState, useCallback } from "react";
import FigureExplainPanel from "./FigureExplainPanel";

const TYPE_LABEL = {
  graph:      "◈ Graph",
  diagram:    "⬡ Diagram",
  chart:      "◉ Chart",
  comparison: "⇄ Compare",
  image:      "◫ Image",
  other:      "◈ Figure",
};

const IMPORTANCE_CONFIG = {
  high:   { label: "High Priority", cls: "fig-importance-badge--high"   },
  medium: { label: "Medium",        cls: "fig-importance-badge--medium" },
  low:    { label: "Low",           cls: "fig-importance-badge--low"    },
};

const UX_BEHAVIORS = [
  { action: "Click image",  result: "Enter zoom mode" },
  { action: "Scroll",       result: "Zoom"            },
  { action: "Drag",         result: "Move image"      },
  { action: "Double click", result: "Reset"           },
  { action: "ESC",          result: "Exit"            },
];

// ---------------------------------------------------------------------------
// Hook — PDF navigation
// ---------------------------------------------------------------------------
function usePdfNavigation(pdfUrl, page) {
  const [navigating, setNavigating] = useState(false);

  const safePage = Number.isFinite(Number(page)) && Number(page) >= 1
    ? Math.floor(Number(page))
    : 1;

  const disabled = !pdfUrl || !Number.isFinite(Number(page));

  const href = disabled ? "#" : `${pdfUrl}#page=${safePage}`;

  const handleClick = useCallback(() => {
    if (disabled) return;

    setNavigating(true);
    setTimeout(() => setNavigating(false), 100);

    window.open(href, "_blank", "noopener,noreferrer");
    }, [disabled, href]);

    const handleZoom = (e) => {
    if (!zoomed) return;

    e.preventDefault();
    const delta = e.deltaY * -0.001;

    setScale((prev) => Math.min(Math.max(1, prev + delta), 4));
  };

  const handleMouseDown = (e) => {
    if (!zoomed) return;
    setDragging(true);
    setStart({
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    });
  };

  const handleMouseMove = (e) => {
    if (!dragging) return;

    setPosition({
      x: e.clientX - start.x,
      y: e.clientY - start.y,
    });
  };

  const resetZoom = () => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  };

  return { href, disabled, navigating, handleClick, safePage };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
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
  const [imgHovered,  setImgHovered]  = useState(false);
  const [explainOpen, setExplainOpen] = useState(false);
  const [start, setStart] = useState({ x: 0, y: 0 });
  const [zoomed, setZoomed] = useState(false);
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    setImgLoaded(false);
    setImgError(false);
    setCaptionOpen(false);
    setImgHovered(false);
    setExplainOpen(false);
  }, [figure?.id]);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") {
        if (zoomed) {
          setZoomed(false);
          setScale(1);
          setPosition({ x: 0, y: 0 });
          return;
        }
        if (explainOpen) {
          setExplainOpen(false);
          return;
        }
        onClose?.();
      }
      if (!explainOpen) {
        if (e.key === "ArrowLeft")  onPrev?.();
        if (e.key === "ArrowRight") onNext?.();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onPrev, onNext, explainOpen, zoomed]);

  if (!figure) return null;

  const {
    id, image, clean_caption, caption,
    page, type = "other", title, description,
    importance = "medium", confidence = null,
    pdf_url,
  } = figure;

  const {
    disabled:   pdfDisabled,
    navigating: pdfNavigating,
    handleClick: handleGoToPDF,
    safePage,
  } = usePdfNavigation(pdf_url, page);

  const badgeLabel    = TYPE_LABEL[type]              ?? "◈ Figure";
  const importanceCfg = IMPORTANCE_CONFIG[importance] ?? IMPORTANCE_CONFIG.medium;
  const showCounter   = typeof currentIndex === "number" && typeof totalCount === "number";
  const displayCaption = clean_caption || caption || "";

  const handleExplainClick = useCallback(() => {
    setExplainOpen(true);
    onExplain?.(id);
  }, [id, onExplain]);

  const handleZoom = (e) => {
    if (!zoomed) return;
    e.preventDefault();
    const delta = e.deltaY * -0.001;
    setScale((prev) => Math.min(Math.max(1, prev + delta), 4));
  };

  const handleMouseDown = (e) => {
    if (!zoomed) return;
    setDragging(true);
    setStart({ x: e.clientX - position.x, y: e.clientY - position.y });
  };

  const handleMouseMove = (e) => {
    if (!dragging) return;
    setPosition({ x: e.clientX - start.x, y: e.clientY - start.y });
  };

  const resetZoom = () => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  };

  return (
    <div
      className="fig-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="fig-modal fig-modal--split" onClick={(e) => e.stopPropagation()}>

        {/* ═══════════════════════ LEFT — image panel ═══════════════════════ */}
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
            {!imgError && (
              <img
                  key={id}
                  src={image}
                  alt={title}
                  className="fig-modal-img"
                  style={{
                    opacity: imgLoaded ? 1 : 0,
                    transform: zoomed
                      ? `translate(${position.x}px, ${position.y}px) scale(${scale})`
                      : (imgHovered && !explainOpen ? "scale(1.05)" : "scale(1)"),
                    transition: zoomed
                      ? "none"
                      : "opacity 300ms ease, transform 320ms ease",
                    cursor: zoomed
                      ? (dragging ? "grabbing" : "grab")
                      : "zoom-in",
                  }}
                  onClick={() => { if (!zoomed) setZoomed(true); }}
                  onWheel={handleZoom}
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={() => setDragging(false)}
                  onMouseLeave={() => { setDragging(false); setImgHovered(false); }}
                  onDoubleClick={resetZoom}
                  onLoad={() => setImgLoaded(true)}
                  onError={() => { setImgError(true); setImgLoaded(false); }}
                  onMouseEnter={() => setImgHovered(true)}
              />
            )}
            {zoomed && (
              <div className="zoom-hint">
                Scroll to zoom • Drag to move • Double click to reset • ESC to exit
              </div>
            )}
            {onPrev && (
              <button
                className="fig-modal-nav fig-modal-nav--prev fig-modal-nav--enhanced"
                onClick={(e) => { e.stopPropagation(); onPrev(); }}
                aria-label="Previous figure"
                title="Previous (←)"
              >‹</button>
            )}
            {onNext && (
              <button
                className="fig-modal-nav fig-modal-nav--next fig-modal-nav--enhanced"
                onClick={(e) => { e.stopPropagation(); onNext(); }}
                aria-label="Next figure"
                title="Next (→)"
              >›</button>
            )}
          </div>

          {totalCount > 1 && (
            <p className="fig-modal-kb-hint">
              {explainOpen ? "ESC closes explanation" : "← → navigate · ESC close"}
            </p>
          )}
        </div>

        {/* ══════════════════════ RIGHT — detail / explain ══════════════════ */}
        <div className="fig-modal-right fig-modal-right--swappable">

          {/* ── DETAIL pane ─────────────────────────────────────────────── */}
          <div
            className={[
              "fig-modal-right-pane",
              "fig-modal-detail-pane",
              explainOpen ? "fig-modal-right-pane--hidden" : "fig-modal-right-pane--visible",
            ].join(" ")}
            aria-hidden={explainOpen}
          >
            {/* Absolute close button */}
            <button className="fig-modal-close" onClick={onClose} aria-label="Close modal">
              ×
            </button>

            {/* ── Scrollable content ── */}
            <div className="fig-modal-right-scroll">

              <div className="fig-modal-section fig-modal-section--title">
                <p className="fig-modal-title">{title}</p>
              </div>

              <div className="fig-modal-section fig-modal-badges-row">
                <span className={`fig-type-badge fig-type-badge--${type} fig-type-badge--inline`}>
                  {badgeLabel}
                </span>
                <span className={`fig-importance-badge ${importanceCfg.cls} fig-importance-badge--inline`}>
                  {importanceCfg.label}
                </span>
              </div>

              {description && (
                <div className="fig-modal-section">
                  <p className="fig-modal-section-label">Description</p>
                  <p className="fig-modal-description">{description}</p>
                </div>
              )}

              {displayCaption && (
                <div className="fig-modal-section">
                  <button
                    className="fig-modal-collapse-toggle"
                    onClick={() => setCaptionOpen((v) => !v)}
                    aria-expanded={captionOpen}
                  >
                    <span className="fig-modal-section-label fig-modal-caption-label">
                      <span
                        className="fig-modal-collapse-chevron"
                        style={{
                          display: "inline-block",
                          transition: "transform 200ms ease",
                          transform: captionOpen ? "rotate(180deg)" : "rotate(0deg)",
                          marginRight: 5,
                        }}
                      >▾</span>
                      Caption
                    </span>
                    {!captionOpen && (
                      <span className="fig-modal-caption-peek">
                        {displayCaption.slice(0, 38)}{displayCaption.length > 38 ? "…" : ""}
                      </span>
                    )}
                  </button>
                  <div className={`fig-modal-collapse-body${captionOpen ? " fig-modal-collapse-body--open" : ""}`}>
                    <p className="fig-modal-caption">{displayCaption}</p>
                  </div>
                </div>
              )}

              <div className="fig-modal-section fig-modal-meta-row">
                <div className="fig-modal-meta-chip">
                  <span className="fig-modal-meta-label">Page</span>
                  <span className="fig-modal-meta-value">{page}</span>
                </div>
                {confidence != null && (
                  <div className="fig-modal-meta-chip fig-modal-meta-chip--conf">
                    <span className="fig-modal-meta-label">Confidence</span>
                    <div className="fig-modal-conf-wrap">
                      <div
                        className="fig-card-conf-bar"
                        style={{ "--conf-pct": `${confidence}%` }}
                        aria-label={`Confidence: ${confidence}%`}
                      />
                      <span className="fig-card-conf-label">{confidence}%</span>
                    </div>
                  </div>
                )}
              </div>

              {/* ══════════════════════════════════════════════════════════
                  ⚡ UX BEHAVIOR HINT TABLE
                  Educates users about zoom/pan gestures on the image.
                  Phase 7.5.3
              ══════════════════════════════════════════════════════════ */}
              <div className="fig-modal-section fig-modal-ux-section">
                <div className="fig-modal-ux-header">
                  <span className="fig-modal-ux-icon">⚡</span>
                  <span className="fig-modal-ux-title">UX behavior</span>
                  <span className="fig-modal-ux-subtitle">clean &amp; intuitive</span>
                </div>
                <table className="fig-modal-ux-table" aria-label="Image interaction gestures">
                  <thead>
                    <tr>
                      <th>Action</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {UX_BEHAVIORS.map(({ action, result }) => (
                      <tr key={action}>
                        <td>{action}</td>
                        <td>{result}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

            </div>
            {/* ── END scroll area ── */}

            {/* ═══ STICKY FOOTER ═══════════════════════════════════════════ */}
            <div className="fig-modal-detail-footer">
              <button
                className="fig-modal-btn fig-modal-btn--explain fig-modal-btn--primary"
                onClick={handleExplainClick}
              >
                ✦ Explain with AI
              </button>

              <button
                className="fig-modal-btn fig-modal-btn--goto fig-modal-btn--secondary"
                onClick={handleGoToPDF}
                disabled={pdfDisabled}
                data-navigating={pdfNavigating || undefined}
                title={
                  pdfDisabled
                    ? "PDF location unavailable for this figure"
                    : "Open paper at this figure"
                }
                aria-label={
                  pdfDisabled
                    ? "Go to PDF (unavailable)"
                    : `Open paper at page ${safePage}`
                }
                style={pdfNavigating ? { cursor: "progress" } : undefined}
              >
                {pdfDisabled
                  ? "↗ Go to PDF"
                  : `↗ Go to PDF • p.${safePage}`}
              </button>
            </div>

          </div>
          {/* ── END DETAIL pane ── */}

          {/* ── EXPLAIN pane ────────────────────────────────────────────── */}
          <div
            className={[
              "fig-modal-right-pane",
              "fig-modal-explain-pane",
              explainOpen ? "fig-modal-right-pane--visible" : "fig-modal-right-pane--hidden",
            ].join(" ")}
            aria-hidden={!explainOpen}
          >
            {explainOpen && (
              <FigureExplainPanel
                figure={figure}
                onBack={() => setExplainOpen(false)}
                onGoToPDF={onGoToPDF}
              />
            )}
          </div>

        </div>
      </div>
    </div>
  );
}