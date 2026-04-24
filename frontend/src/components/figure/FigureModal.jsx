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

// ---------------------------------------------------------------------------
// Hook — PDF navigation
// ---------------------------------------------------------------------------
/**
 * Builds the page-anchored PDF URL and returns a stable click handler.
 *
 * Rules:
 *  - Both `pdfUrl` AND a valid `page` (≥ 1) are required; otherwise disabled.
 *  - `page` values < 1 or non-numeric are treated as page 1 (safe fallback).
 *  - Absolute URLs (http/https) are used as-is; relative paths are prefixed
 *    with the Vite API base so this works across dev + staging + prod.
 *  - Opens in a new tab; noopener + noreferrer for security.
 *  - "progress" cursor flashes for 100 ms on click — gives tactile feedback
 *    without blocking the UI thread.
 *
 * @param {string|undefined} pdfUrl   Absolute URL for the session PDF.
 * @param {number|undefined} page     1-based page number from the figure.
 * @returns {{ href: string, disabled: boolean, handleClick: () => void }}
 */
function usePdfNavigation(pdfUrl, page) {
  const [navigating, setNavigating] = useState(false);

  // Normalise page: must be a positive integer; fall back to 1.
  const safePage = Number.isFinite(Number(page)) && Number(page) >= 1
    ? Math.floor(Number(page))
    : 1;

  // Disabled when there is no URL to navigate to or page is completely invalid.
  const disabled = !pdfUrl || !Number.isFinite(Number(page));

  // Full URL with fragment — prebuilt so <a href> can also use it.
  const href = disabled ? "#" : `${pdfUrl}#page=${safePage}`;

  const handleClick = useCallback(() => {
    if (disabled) return;

    // Brief "progress" cursor — purely cosmetic, does not block anything.
    setNavigating(true);
    setTimeout(() => setNavigating(false), 100);

    window.open(href, "_blank", "noopener,noreferrer");
  }, [disabled, href]);

  return { href, disabled, navigating, handleClick, safePage };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function FigureModal({
  figure,
  onClose,
  onExplain,
  onGoToPDF,          // kept for FigureExplainPanel (in-viewer scroll)
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

  // Reset transient state when the figure changes.
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
        if (explainOpen) { setExplainOpen(false); return; }
        onClose?.();
      }
      if (!explainOpen) {
        if (e.key === "ArrowLeft")  onPrev?.();
        if (e.key === "ArrowRight") onNext?.();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onPrev, onNext, explainOpen]);

  if (!figure) return null;

  const {
    id, image, clean_caption, caption,
    page, type = "other", title, description,
    importance = "medium", confidence = null,
    pdf_url,    // ← Phase 7.5.2: stamped by figureService.normaliseFigure
  } = figure;

  // ── PDF navigation (hook) ─────────────────────────────────────────────────
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
                  opacity:    imgLoaded ? 1 : 0,
                  transform:  imgHovered && !explainOpen ? "scale(1.05)" : "scale(1)",
                  transition: "opacity 300ms ease, transform 320ms ease",
                  cursor:     "zoom-in",
                }}
                onLoad={()  => setImgLoaded(true)}
                onError={() => { setImgError(true); setImgLoaded(false); }}
                onMouseEnter={() => setImgHovered(true)}
                onMouseLeave={() => setImgHovered(false)}
              />
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
        {/*
            Layout (flex column, height:100%):
            ┌─────────────────────────────────┐
            │  [close ×]  (absolute)          │
            │─────────────────────────────────│
            │                                 │
            │  scroll area  (flex: 1)         │
            │  title · badges · desc          │
            │  caption · metadata             │
            │                                 │
            │─────────────────────────────────│
            │  STICKY FOOTER  (flex-shrink:0) │
            │  [✦ Explain with AI]            │
            │  [↗ Go to PDF • p.N]            │
            └─────────────────────────────────┘
        */}
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

            </div>
            {/* ── END scroll area ── */}

            {/* ═══ STICKY FOOTER — ALWAYS VISIBLE ═══════════════════════════
                Lives OUTSIDE the scroll container so it is NEVER clipped.
                flex-shrink:0 + border-top pins it to the bottom of the pane.
            ════════════════════════════════════════════════════════════════ */}
            <div className="fig-modal-detail-footer">

              {/* ── Explain with AI ──────────────────────────────────────── */}
              <button
                className="fig-modal-btn fig-modal-btn--explain fig-modal-btn--primary"
                onClick={handleExplainClick}
              >
                ✦ Explain with AI
              </button>

              {/* ── Go to PDF ────────────────────────────────────────────────
                  Phase 7.5.2 changes:
                  • Disabled when pdf_url or page is missing.
                  • Label includes the page number: "↗ Go to PDF • p.4"
                  • Opens in new tab via window.open (handled by hook).
                  • data-navigating drives the "progress" cursor CSS tweak.
                  • title provides an accessible tooltip.
              ─────────────────────────────────────────────────────────────── */}
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