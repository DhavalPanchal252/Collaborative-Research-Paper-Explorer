// src/components/PDFViewer.jsx
// Phase 5 — Viewer Controls + Navigation + Annotate Mode
// Bug fix: highlights now correctly placed at any zoom level (stale closure fix via zoomRef)

import { useState, useRef, useCallback, useEffect } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import PDFToolbar from "./PDFToolbar";
import AnnotationLayer from "./AnnotationLayer";
import { downloadAnnotatedPDF } from "../utils/downloadAnnotatedPDF";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

// ─────────────────────────────────────────────────────────────────────────────
// UID
// ─────────────────────────────────────────────────────────────────────────────
let _uid = 0;
function uid() { return ++_uid; }

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers — no React, no side-effects
// ─────────────────────────────────────────────────────────────────────────────

/**
 * toScrollAreaCoords — viewport DOMRect → zoom-normalised scroll-area coords.
 *
 * NORMALIZATION RULE (must mirror the render formula exactly):
 *
 *   Render:  renderX = cx + (storedX − cx) × renderZoom
 *   ∴ Store: storedX = cx + (rawX   − cx) / captureZoom
 *
 *   Render:  renderY = py + (storedY − py) × renderZoom
 *   ∴ Store: storedY = py + (rawY   − py) / captureZoom
 *
 * WHY anchors instead of dividing from 0:
 *   cx — the page is flex-centered horizontally.  The centering gap
 *        (scrollAreaWidth − pageWidth)/2 is NOT proportional to zoom,
 *        so we must scale relative to the center, not origin 0.
 *   py — `.pdf-scroll-area` has a fixed `padding: 24px`.  That padding
 *        does not scale with zoom, so we normalise only the content
 *        offset above it.
 *
 * WHY dividing from 0 breaks at non-100% zoom:
 *   rawX/captureZoom produces a value that, when multiplied by renderZoom
 *   in HighlightLayer, gives `cx*(renderZoom/captureZoom − 1)` of extra
 *   drift — invisible at captureZoom=1, growing at any other zoom.
 *
 * Width / height ARE divided from 0 — they are page-relative sizes with
 * no centering offset, so plain division is correct for them.
 */

/**
 * getPageCenterX — reads the horizontal center of the first rendered .pdf-page
 * element within the scroll area, measured in scroll-area coordinates.
 *
 * WHY this instead of scrollAreaEl.clientWidth / 2:
 *   `.pdf-scroll-area` uses `align-items: center` so pages are flex-centered.
 *   When a vertical scrollbar is present (content overflows at high zoom),
 *   `clientWidth` shrinks by the scrollbar width (~6 px on most systems).
 *   The page, however, is still visually centered against the *full* inner
 *   width (scrollbar included on some browsers, excluded on others — it depends
 *   on the OS/browser scrollbar overlay mode).  Using clientWidth/2 as `cx`
 *   therefore introduces a systematic drift that scales with zoom.
 *
 *   Reading the page element's own bounding rect gives us the ground-truth
 *   center regardless of scrollbar state, container resizes, or zoom level.
 *   Both capture and render use the same measurement → zero drift.
 */
function getPageCenterX(scrollAreaEl) {
  const pageEl = scrollAreaEl.querySelector(".pdf-page");
  if (!pageEl) return scrollAreaEl.clientWidth / 2; // fallback before pages render

  const areaRect = scrollAreaEl.getBoundingClientRect();
  const pageRect = pageEl.getBoundingClientRect();

  // Page center in scroll-area coordinates (account for current scroll position)
  return pageRect.left - areaRect.left + scrollAreaEl.scrollLeft + pageRect.width / 2;
}

function toScrollAreaCoords(domRect, scrollAreaEl, zoom = 1) {
  const area = scrollAreaEl.getBoundingClientRect();
  const z    = zoom || 1;

  const rawX = domRect.left  - area.left + scrollAreaEl.scrollLeft;
  const rawY = domRect.top   - area.top  + scrollAreaEl.scrollTop;

  // cx: use the real page center, not clientWidth/2 — immune to scrollbar drift
  const cx = getPageCenterX(scrollAreaEl);
  const py = 24; // top padding (`.pdf-scroll-area { padding: 24px }`)

  return {
    x:      Math.round(cx + (rawX - cx) / z),
    y:      Math.round(py + (rawY - py) / z),
    width:  Math.round(domRect.width  / z),
    height: Math.round(domRect.height / z),
  };
}

/**
 * mergeRects — consolidates the flood of per-span rects into one rect per line.
 */
const LINE_TOL = 4;   // px — y-centre tolerance for "same line"
const V_PAD    = 1;   // px — vertical expansion per edge

function mergeRects(rects) {
  if (!rects.length) return [];

  const sorted = [...rects].sort((a, b) =>
    a.y === b.y ? a.x - b.x : a.y - b.y
  );

  const lines = [];
  let currentLine = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = currentLine[currentLine.length - 1];
    const curr = sorted[i];

    const prevCenter = prev.y + prev.height / 2;
    const currCenter = curr.y + curr.height / 2;

    if (Math.abs(prevCenter - currCenter) <= LINE_TOL) {
      currentLine.push(curr);
    } else {
      lines.push(currentLine);
      currentLine = [curr];
    }
  }

  lines.push(currentLine);

  return lines.map(line => {
    const x = Math.min(...line.map(r => r.x));
    const y = Math.min(...line.map(r => r.y));
    const right  = Math.max(...line.map(r => r.x + r.width));
    const bottom = Math.max(...line.map(r => r.y + r.height));

    return {
      x:      Math.round(x),
      y:      Math.round(y - V_PAD),
      width:  Math.round(right - x),
      height: Math.round(bottom - y + V_PAD * 2),
    };
  });
}

/**
 * overlapsExisting — prevent genuinely stacked/duplicate highlights.
 */
const OVERLAP_MIN = 4; // px — intersection in both axes required to block

function overlapsExisting(newRects, newText, existing) {
  for (const h of existing) {
    if (h.text === newText) return h;

    for (const nr of newRects) {
      for (const hr of h.rects) {
        const xIntersect = Math.min(nr.x + nr.width,  hr.x + hr.width)
                         - Math.max(nr.x,              hr.x);
        const yIntersect = Math.min(nr.y + nr.height, hr.y + hr.height)
                         - Math.max(nr.y,              hr.y);
        if (xIntersect > OVERLAP_MIN && yIntersect > OVERLAP_MIN) return h;
      }
    }
  }
  return null;
}

/**
 * computePopupPosition — fixed-position {x,y} for the annotation popup
 * anchored to a highlight rect. Converts scroll-area coords → viewport coords.
 */
function computePopupPosition(highlight, scrollAreaEl, zoom = 1) {
  if (!scrollAreaEl || !highlight?.rects?.[0]) return { x: 120, y: 160 };

  const r    = highlight.rects[0];
  const area = scrollAreaEl.getBoundingClientRect();
  const z    = zoom || 1;

  const cx = getPageCenterX(scrollAreaEl);
  const py = 24;
  const vx = (cx + (r.x - cx) * z) + area.left - scrollAreaEl.scrollLeft;
  const vy = (py + (r.y - py) * z) + area.top  - scrollAreaEl.scrollTop;

  const PW  = 316;
  const PH  = 460;
  const PAD = 12;
  const GAP = 8;

  let x = vx;
  let y = vy + r.height * z + GAP;

  if (x + PW > window.innerWidth  - PAD) x = window.innerWidth  - PW - PAD;
  x = Math.max(PAD, x);

  if (y + PH > window.innerHeight - PAD) y = vy - PH - GAP;
  y = Math.max(PAD, y);

  return { x, y };
}

// ─────────────────────────────────────────────────────────────────────────────
// [Phase 5] computeAnnotationPopupPosition
// Converts stored annotation point → fixed viewport {x, y} for the popup.
// Mirrors the AnnotationLayer render formula exactly.
// ─────────────────────────────────────────────────────────────────────────────
function computeAnnotationPopupPosition(storedX, storedY, scrollAreaEl, zoom = 1) {
  if (!scrollAreaEl) return { x: 120, y: 160 };

  const area = scrollAreaEl.getBoundingClientRect();
  const z    = zoom || 1;
  const cx   = getPageCenterX(scrollAreaEl);
  const py   = 24;

  // Inverse of the AnnotationLayer render formula
  const vx = (cx + (storedX - cx) * z) + area.left - scrollAreaEl.scrollLeft;
  const vy = (py + (storedY - py) * z) + area.top  - scrollAreaEl.scrollTop;

  const PW  = 280;
  const PH  = 200;
  const PAD = 12;
  const GAP = 12;

  let x = vx - PW / 2; // horizontally centered on marker
  let y = vy + GAP;    // below marker tip

  if (x + PW > window.innerWidth  - PAD) x = window.innerWidth  - PW - PAD;
  x = Math.max(PAD, x);
  if (y + PH > window.innerHeight - PAD) y = vy - PH - GAP;
  y = Math.max(PAD, y);

  return { x, y };
}

function isHighlightVisible(highlight, scrollAreaEl, zoom = 1, margin = 80) {
  if (!scrollAreaEl || !highlight?.rects?.[0]) return false;
  const rect   = highlight.rects[0];
  const areaH  = scrollAreaEl.clientHeight;
  const z      = zoom || 1;
  const relTop = rect.y * z - scrollAreaEl.scrollTop;
  return relTop >= margin && relTop + rect.height * z <= areaH - margin;
}

const MODE_CURSOR = { select: "text", highlight: "text", annotate: "crosshair", clear: "cell" };

// ─────────────────────────────────────────────────────────────────────────────
// rectIntersects — true when two axis-aligned rects have meaningful overlap.
// Used by drag-to-erase to detect which highlights fall inside the erase box.
//
// a, b: { x, y, width, height }  (scroll-area coords at zoom=1 for stored rects;
//                                  raw pixel coords for the live drag-box)
// ─────────────────────────────────────────────────────────────────────────────
function rectIntersects(a, b) {
  return (
    a.x < b.x + b.width  &&
    a.x + a.width  > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AnnotationPopup
// ─────────────────────────────────────────────────────────────────────────────
function AnnotationPopup({
  highlight,
  onSave,
  onDelete,
  onClose,
  onReExplain,
  explainLoading,
}) {
  const [note, setNote] = useState(highlight.note ?? "");
  const popupRef        = useRef(null);

  useEffect(() => { setNote(highlight.note ?? ""); }, [highlight.note]);

  useEffect(() => {
    function onDown(e) {
      if (highlight.aiLoading) return;
      if (popupRef.current?.contains(e.target)) return;
      onClose();
    }
    const t = setTimeout(() => document.addEventListener("mousedown", onDown), 20);
    return () => { clearTimeout(t); document.removeEventListener("mousedown", onDown); };
  }, [onClose, highlight.aiLoading]);

  const { x: px, y: py } = highlight.position;
  const isLoading = !!highlight.aiLoading;
  const hasError  = !!highlight.aiError && !isLoading;
  const hasAI     = !!highlight.aiExplanation && !isLoading && !hasError;

  function handleSave() {
    if (!note.trim()) return;
    onSave(highlight.id, note);
    onClose();
  }

  return (
    <div
      ref={popupRef}
      className="annotation-popup annotation-popup--v2"
      style={{ left: px, top: py }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="annotation-popup-header">
        <span className="annotation-popup-label">✦ Annotation</span>
        <button
          className="annotation-popup-close"
          onClick={onClose}
          disabled={isLoading}
          aria-label="Close"
        >✕</button>
      </div>

      <p className="annotation-popup-quote">
        "{highlight.text.length > 90
          ? highlight.text.slice(0, 90) + "…"
          : highlight.text}"
      </p>

      <div className={[
        "annotation-ai-block",
        isLoading ? "annotation-ai-block--loading" : "",
        hasError  ? "annotation-ai-block--error"   : "",
      ].filter(Boolean).join(" ")}>

        <div className="annotation-ai-header">
          <span className="annotation-ai-label">
            {isLoading ? "✦ Generating…" : hasError ? "✦ Failed" : "✦ AI Explanation"}
          </span>
          <button
            className="annotation-btn annotation-btn--reexplain"
            onClick={() => onReExplain(highlight)}
            disabled={isLoading || explainLoading}
            title={hasError ? "Retry explanation" : "Re-generate explanation"}
          >
            {isLoading
              ? <><span className="spinner spinner--xs" />&nbsp;Working</>
              : hasError ? "↺ Retry" : "↺ Re-explain"}
          </button>
        </div>

        {isLoading ? (
          <div className="annotation-ai-skeleton">
            <div className="annotation-ai-shimmer" />
            <div className="annotation-ai-shimmer annotation-ai-shimmer--md" />
            <div className="annotation-ai-shimmer annotation-ai-shimmer--sm" />
          </div>
        ) : hasError ? (
          <p className="annotation-ai-error-text">{highlight.aiError}</p>
        ) : hasAI ? (
          <p className="annotation-ai-text">{highlight.aiExplanation}</p>
        ) : (
          <p className="annotation-ai-empty">
            No explanation yet.{" "}
            <button
              className="annotation-ai-trigger-link"
              onClick={() => onReExplain(highlight)}
              disabled={explainLoading}
            >Generate one →</button>
          </p>
        )}
      </div>

      <textarea
        className="annotation-popup-textarea"
        placeholder="Add a personal note…"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
      />

      <div className="annotation-popup-actions">
        <button
          className="annotation-btn annotation-btn--delete"
          onClick={() => onDelete(highlight.id)}
        >Delete</button>
        <button
          className="annotation-btn annotation-btn--save"
          onClick={handleSave}
          disabled={!note.trim()}
        >Save note</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// [Phase 5] AnnotationNotePopup — lightweight popup for point-based annotations
// Reuses all annotation-popup CSS classes for visual consistency.
// ─────────────────────────────────────────────────────────────────────────────
function AnnotationNotePopup({ annotation, onSave, onDelete, onClose }) {
  const [note, setNote] = useState(annotation.note ?? "");
  const popupRef        = useRef(null);
  const { x: px, y: py } = annotation.position;

  useEffect(() => { setNote(annotation.note ?? ""); }, [annotation.id]);

  useEffect(() => {
    function onDown(e) {
      if (popupRef.current?.contains(e.target)) return;
      if (e.target.closest(".pdf-annotation-marker")) return; // marker click handled separately
      onClose();
    }
    const t = setTimeout(() => document.addEventListener("mousedown", onDown), 20);
    return () => { clearTimeout(t); document.removeEventListener("mousedown", onDown); };
  }, [onClose]);

  return (
    <div
      ref={popupRef}
      className="annotation-popup annotation-popup--v2"
      style={{ left: px, top: py, width: 280 }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="annotation-popup-header">
        <span className="annotation-popup-label">✎ Point Note</span>
        <button className="annotation-popup-close" onClick={onClose} aria-label="Close">✕</button>
      </div>

      <textarea
        className="annotation-popup-textarea"
        placeholder="Add a note to this location…"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={4}
        autoFocus
      />

      <div className="annotation-popup-actions">
        <button
          className="annotation-btn annotation-btn--delete"
          onClick={() => { onDelete(annotation.id); onClose(); }}
        >Delete</button>
        <button
          className="annotation-btn annotation-btn--save"
          onClick={() => { onSave(annotation.id, note); onClose(); }}
        >Save note</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HighlightLayer — default | noted | ai-ready | loading | error | flash | clear
// ─────────────────────────────────────────────────────────────────────────────
function HighlightLayer({
  highlights,
  onHighlightClick,
  mode,
  flashingId,
  zoom,
  scrollAreaRef,
  // Erase mode props:
  erasingIds,        // Set<id> — highlights targeted by current drag
  onEraseHover,      // (id) => void — mouse enter in clear mode
  onEraseLeave,      // (id) => void — mouse leave in clear mode
}) {
  // hoveredId — tracks which highlight the cursor is currently over.
  // Used to apply the --hovered class to ALL rects of that highlight
  // simultaneously, so multi-line highlights light up as a group.
  const [hoveredId, setHoveredId] = useState(null);

  if (!highlights.length) return null;
  const interactive = mode === "select";
  const isClearMode = mode === "clear";
  const z = zoom || 1;

  const scrollAreaEl = scrollAreaRef?.current;
  const cx = scrollAreaEl ? getPageCenterX(scrollAreaEl) : 0;
  const py = 24;

  return (
    <div className="pdf-highlight-layer" aria-hidden="true">
      {highlights.map((h) =>
        h.rects.map((rect, ri) => {
          const isDragTarget = isClearMode && erasingIds?.has(h.id);

          const cls = [
            "pdf-highlight",
            h.note          ? "pdf-highlight--noted"   : "",
            h.aiExplanation ? "pdf-highlight--ai"      : "",
            h.aiLoading     ? "pdf-highlight--loading" : "",
            h.aiError       ? "pdf-highlight--error"   : "",
            flashingId === h.id ? "pdf-highlight--flash" : "",
            // Clear mode state classes
            isDragTarget    ? "pdf-highlight--erase-target" : "",
            // Group hover — applied to ALL rects when any rect in this highlight is hovered
            hoveredId === h.id ? "pdf-highlight--hovered" : "",
          ].filter(Boolean).join(" ");

          // Every rect in a multi-line highlight is interactive in select mode —
          // the user should be able to hover or click any line to open the popup.
          // In clear mode every rect also needs hover + click so erasing works on
          // all lines, not just the first.
          // Click fires on any rect but always identifies the highlight by id, so
          // there is no double-firing — handleHighlightClick is idempotent (toggle).
          const isSelectInteractive = interactive;   // all rects active in select mode
          const isClickTarget = isSelectInteractive || (isClearMode && ri === 0);
          const isHoverTarget = isSelectInteractive || isClearMode;

          return (
            <div
              key={`${h.id}-${ri}`}
              data-highlight-id={h.id}
              className={cls}
              style={{
                left:   Math.round(cx + (rect.x - cx) * z),
                top:    Math.round(py + (rect.y - py) * z),
                width:  Math.round(rect.width  * z),
                height: Math.round(rect.height * z),
                pointerEvents: (isClickTarget || isHoverTarget) ? "auto" : "none",
                cursor: (isClickTarget || isHoverTarget) ? "pointer" : "default",
              }}
              onClick={isClickTarget
                ? (e) => { e.stopPropagation(); onHighlightClick(e, h); }
                : undefined}
              onMouseEnter={isHoverTarget ? () => {
                setHoveredId(h.id);
                if (isClearMode) onEraseHover?.(h.id);
              } : undefined}
              onMouseLeave={isHoverTarget ? () => {
                setHoveredId(null);
                if (isClearMode) onEraseLeave?.(h.id);
              } : undefined}
            />
          );
        })
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EraseSelectionBox — the red drag-selection rectangle shown in clear mode.
// Positioned in scroll-area space so it tracks perfectly alongside highlights.
// ─────────────────────────────────────────────────────────────────────────────
function EraseSelectionBox({ box }) {
  if (!box) return null;
  const { x, y, width, height } = box;
  if (width < 2 && height < 2) return null; // don't flash on plain click

  return (
    <div
      className="erase-selection-box"
      style={{ left: x, top: y, width, height }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SelectionTooltip
// ─────────────────────────────────────────────────────────────────────────────
function SelectionTooltip({ position, onExplain, onDismiss, loading }) {
  if (!position) return null;
  return (
    <div
      className="selection-tooltip"
      style={{
        position: "fixed",
        left: position.x,
        top:  position.y,
        transform: "translateX(-50%) translateY(-110%)",
        zIndex: 1000,
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button className="tooltip-explain-btn" onClick={onExplain} disabled={loading}>
        {loading
          ? <><span className="spinner spinner--xs" />Explaining…</>
          : <><span className="tooltip-icon">✦</span>Explain</>}
      </button>
      <button className="tooltip-dismiss-btn" onClick={onDismiss} aria-label="Dismiss">✕</button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PDFViewer — default export
// ─────────────────────────────────────────────────────────────────────────────
export default function PDFViewer({
  file,
  onExplainRequest,
  explainLoading,
  explainResult,
  onExplainResultConsumed,
  focusedHighlightId,
  onFocusedHighlightConsumed,
}) {
  const [numPages, setNumPages]               = useState(null);
  const [loadError, setLoadError]             = useState(null);
  const [tooltipPos, setTooltipPos]           = useState(null);
  const [selectedText, setSelectedText]       = useState("");
  const [mode, setMode]                       = useState("select");
  const [zoom, setZoom]                       = useState(1);
  const [highlights, setHighlights]           = useState([]);
  const [activeHighlight, setActiveHighlight] = useState(null);
  const [flashingId, setFlashingId]           = useState(null);
  const [downloadPhase, setDownloadPhase]     = useState(null); // null | "loading" | "drawing" | "saving"

  // ── [Phase 5] New state ──────────────────────────────────────────────────
  const [annotations, setAnnotations]         = useState([]);
  const [activeAnnotation, setActiveAnnotation] = useState(null);
  const [currentPage, setCurrentPage]         = useState(1);

  // ── [Phase 6] Erase mode state ───────────────────────────────────────────
  const [undoStack, setUndoStack]             = useState([]);   // [{highlights removed}]
  const [erasingIds, setErasingIds]           = useState(null); // Set<id> during drag
  const [eraseBox, setEraseBox]               = useState(null); // {x,y,width,height} scroll-space
  // Erase drag state lives entirely in refs — zero setState during mousemove
  const eraseStartRef  = useRef(null);   // {x, y} in scroll-area space at dragstart
  const isDraggingRef  = useRef(false);  // true from mousedown until mouseup

  const containerRef        = useRef(null);
  const scrollAreaRef       = useRef(null);
  const pendingExplainIdRef = useRef(null);
  const lastRangeRef        = useRef(null);
  const explainTimeoutRef   = useRef(null);
  const highlightsRef       = useRef(highlights);
  const activeHighlightRef  = useRef(activeHighlight);
  const annotationsRef      = useRef(annotations);
  const modeRef             = useRef(mode);      // always-live mode for drag handler
  const erasingIdsRef       = useRef(erasingIds); // always-live for drag cleanup

  // ── [Phase 5] baseWidthRef — must be declared before any early return ────
  // (moved from below the early return to fix React hooks ordering violation)
  const baseWidthRef        = useRef(null);

  // ── [Phase 5 / Bug fix] zoomRef — always holds the live zoom value ───────
  //
  // WHY THIS FIXES THE HIGHLIGHT BUG:
  //   handleMouseUp is a useCallback that only re-creates when `mode` changes.
  //   Its closure captures `zoom` at the time mode was set (e.g. 1.0).
  //   When zoom later changes to 1.5, `createHighlightFromRange` is called from
  //   inside the stale handleMouseUp — it still sees zoom=1.0, so toScrollAreaCoords
  //   normalises with the wrong divisor, placing the highlight rect at the wrong
  //   position for every non-100% zoom level.
  //
  //   Fixing the useCallback deps would recreate the listener on every zoom
  //   change. Instead, we mirror zoom into a ref and read zoomRef.current
  //   inside createHighlightFromRange — always fresh, zero closure drift.
  const zoomRef = useRef(zoom);

  useEffect(() => { highlightsRef.current  = highlights;      }, [highlights]);
  useEffect(() => { activeHighlightRef.current = activeHighlight; }, [activeHighlight]);
  useEffect(() => { annotationsRef.current = annotations;     }, [annotations]);
  useEffect(() => { zoomRef.current        = zoom;            }, [zoom]);
  useEffect(() => { modeRef.current        = mode;            }, [mode]);
  useEffect(() => { erasingIdsRef.current  = erasingIds;      }, [erasingIds]);
  useEffect(() => () => clearTimeout(explainTimeoutRef.current), []);

  // ── Initialise baseWidth once the container is in the DOM ────────────────
  // (lazy: set on first access, not in useEffect, to keep pageWidth in sync)
  if (!baseWidthRef.current && containerRef.current) {
    baseWidthRef.current = Math.min(containerRef.current.clientWidth - 48, 900);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  function scrollToHighlightSmooth(id) {
    const el = scrollAreaRef.current;
    if (!el) return;
    const h = highlightsRef.current.find((h) => h.id === id);
    if (!h || isHighlightVisible(h, el, zoom)) return;
    const rect = h.rects[0];
    const z    = zoom || 1;
    el.scrollTo({
      top: Math.round(rect.y * z - el.clientHeight / 2 + rect.height * z / 2),
      behavior: "smooth",
    });
  }

  function flashHighlight(id) {
    setFlashingId(id);
    setTimeout(() => setFlashingId(null), 1400);
  }

  function startExplainTimeout(id) {
    clearTimeout(explainTimeoutRef.current);
    explainTimeoutRef.current = setTimeout(() => {
      if (pendingExplainIdRef.current !== id) return;
      setHighlights((prev) =>
        prev.map((h) =>
          h.id === id
            ? { ...h, aiLoading: false, aiError: "Request timed out. Please retry." }
            : h
        )
      );
      pendingExplainIdRef.current = null;
    }, 15_000);
  }

  // ── [Phase 5] Page tracking — detect which page is most visible ──────────
  //
  // Called from the scroll handler (throttled via rAF) and after zoom/page changes.
  // Finds the page whose vertical centre is closest to the viewport midpoint.
  // Uses a ref to avoid queueing duplicate setState calls when page hasn't changed.
  const currentPageRef = useRef(1);

  function updateCurrentPage() {
    const el = scrollAreaRef.current;
    if (!el) return;
    const pageEls = Array.from(el.querySelectorAll(".pdf-page"));
    if (!pageEls.length) return;

    const midpoint = el.scrollTop + el.clientHeight / 2;
    let closestPage = 1, closestDist = Infinity;

    pageEls.forEach((pageEl, i) => {
      const dist = Math.abs((pageEl.offsetTop + pageEl.offsetHeight / 2) - midpoint);
      if (dist < closestDist) { closestDist = dist; closestPage = i + 1; }
    });

    if (currentPageRef.current !== closestPage) {
      currentPageRef.current = closestPage;
      setCurrentPage(closestPage);
    }
  }

  // Re-detect page after zoom change (page heights change → offsets change)
  useEffect(() => {
    const id = setTimeout(updateCurrentPage, 200); // wait for DOM to settle
    return () => clearTimeout(id);
  }, [zoom, numPages]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mode ──────────────────────────────────────────────────────────────────

  function handleModeChange(next) {
    setMode(next);
    setTooltipPos(null);
    setSelectedText("");
    setActiveHighlight(null);
    setActiveAnnotation(null);
    // Clear any in-progress erase drag
    setErasingIds(null);
    setEraseBox(null);
    isDraggingRef.current  = false;
    eraseStartRef.current  = null;
    window.getSelection()?.removeAllRanges();
  }

  // ── Highlight click → anchor popup ───────────────────────────────────────

  function handleHighlightClick(e, highlight) {
    // ── Clear mode: click = single-highlight delete (with undo) ────────────
    if (mode === "clear") {
      e.stopPropagation();
      setUndoStack((prev) => [...prev, [highlight]]);
      setHighlights((prev) => prev.filter((h) => h.id !== highlight.id));
      return;
    }
    if (activeHighlight?.id === highlight.id) { setActiveHighlight(null); return; }
    setActiveHighlight({
      ...highlight,
      position: computePopupPosition(highlight, scrollAreaRef.current, zoom),
    });
  }

  // Erase mode: hover visual feedback (single highlight)
  function handleEraseHover(id) {
    if (isDraggingRef.current) return; // drag handles its own targeting
    setErasingIds(new Set([id]));
  }
  function handleEraseLeave(id) {
    if (isDraggingRef.current) return;
    setErasingIds((prev) => {
      if (!prev || !prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next.size ? next : null;
    });
  }

  // Recompute popup position on resize
  useEffect(() => {
    function onResize() {
      setActiveHighlight((prev) =>
        prev ? { ...prev, position: computePopupPosition(prev, scrollAreaRef.current, zoom) } : null
      );
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setActiveHighlight((prev) =>
      prev ? { ...prev, position: computePopupPosition(prev, scrollAreaRef.current, zoom) } : null
    );
  }, [zoom]);

  // Scroll: keep popup alive (reanchored) while AI is loading; close otherwise
  useEffect(() => {
    const el = scrollAreaRef.current;
    if (!el) return;

    let ticking = false;

    function onScroll() {
      if (!ticking) {
        requestAnimationFrame(() => {
          // ── Page tracking ──────────────────────────────────────────────
          updateCurrentPage();

          // ── Highlight popup reanchoring ────────────────────────────────
          const cur = activeHighlightRef.current;
          if (cur) {
            if (cur.aiLoading) {
              const fresh = highlightsRef.current.find((h) => h.id === cur.id);
              if (!fresh) { setActiveHighlight(null); }
              else {
                setActiveHighlight((prev) =>
                  prev ? { ...prev, ...fresh, position: computePopupPosition(fresh, el, zoom) } : null
                );
              }
            } else {
              setActiveHighlight((prev) => {
                if (!prev) return null;
                const fresh = highlightsRef.current.find((h) => h.id === prev.id);
                if (!fresh) return null;
                return { ...prev, ...fresh, position: computePopupPosition(fresh, el, zoom) };
              });
            }
          }

          // ── Annotation popup reanchoring ───────────────────────────────
          setActiveAnnotation((prev) => {
            if (!prev) return null;
            const fresh = annotationsRef.current.find((a) => a.id === prev.id);
            if (!fresh) return null;
            return {
              ...prev,
              note: fresh.note,
              position: computeAnnotationPopupPosition(fresh.x, fresh.y, el, zoomRef.current),
            };
          });

          ticking = false;
        });
        ticking = true;
      }
    }

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live-sync highlight popup when highlight data changes
  useEffect(() => {
    setActiveHighlight((prev) => {
      if (!prev) return null;
      const fresh = highlights.find((h) => h.id === prev.id);
      return fresh ? { ...fresh, position: prev.position } : null;
    });
  }, [highlights]);

  // ── CRUD — Highlights ─────────────────────────────────────────────────────

  function handleSaveNote(id, note) {
    setHighlights((prev) => prev.map((h) => (h.id === id ? { ...h, note } : h)));
  }

  function handleDeleteHighlight(id) {
    setHighlights((prev) => prev.filter((h) => h.id !== id));
    setActiveHighlight(null);
  }

  // ── [Phase 6] Undo — restore last batch of erased highlights ────────────
  function handleUndo() {
    if (!undoStack.length) return;
    const last = undoStack[undoStack.length - 1];
    setHighlights((prev) => [...prev, ...last]);
    setUndoStack((prev) => prev.slice(0, -1));
  }

  useEffect(() => {
    function onKeyDown(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && mode === "clear") {
        e.preventDefault();
        handleUndo();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode, undoStack]); // eslint-disable-line react-hooks/exhaustive-deps

  function createHighlightFromRange(range, text) {
    if (!scrollAreaRef.current) return null;

    // ── HIGHLIGHT BUG FIX ──────────────────────────────────────────────────
    // Use zoomRef.current (always live) instead of the `zoom` variable from
    // the closure — which may be stale when called from the memoized handleMouseUp.
    const currentZoom = zoomRef.current;

    const raw = Array.from(range.getClientRects());
    const normalizedRects = raw
      .filter((r) => r.width > 1 && r.height > 1)
      .map((r) => toScrollAreaCoords(r, scrollAreaRef.current, currentZoom));

    if (!normalizedRects.length) return null;

    const rects = mergeRects(normalizedRects);
    if (!rects.length) return null;

    const dupe = overlapsExisting(rects, text, highlightsRef.current);
    if (dupe) return dupe.id;

    const newId = uid();
    setHighlights((prev) => [
      ...prev,
      { id: newId, text, rects, note: "", aiExplanation: null, aiLoading: false, aiError: null, createdAt: new Date() },
    ]);
    window.getSelection()?.removeAllRanges();
    return newId;
  }

  // ── CRUD — Annotations ────────────────────────────────────────────────────

  function handleSaveAnnotationNote(id, note) {
    setAnnotations((prev) => prev.map((a) => (a.id === id ? { ...a, note } : a)));
    // Sync to activeAnnotation so the marker dot updates
    setActiveAnnotation((prev) => (prev?.id === id ? { ...prev, note } : prev));
  }

  function handleDeleteAnnotation(id) {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
    setActiveAnnotation(null);
  }

  // ── [Phase 5] Marker click from AnnotationLayer ───────────────────────────
  function handleMarkerClick(e, annotation) {
    if (activeAnnotation?.id === annotation.id) { setActiveAnnotation(null); return; }
    const fresh = annotationsRef.current.find((a) => a.id === annotation.id) ?? annotation;
    setActiveAnnotation({
      ...fresh,
      position: computeAnnotationPopupPosition(fresh.x, fresh.y, scrollAreaRef.current, zoomRef.current),
    });
  }

  // ── Re-explain ─────────────────────────────────────────────────────────────

  function handleReExplain(highlight) {
    if (explainLoading) return;
    pendingExplainIdRef.current = highlight.id;
    setHighlights((prev) =>
      prev.map((h) => h.id === highlight.id ? { ...h, aiLoading: true, aiError: null } : h)
    );
    startExplainTimeout(highlight.id);
    onExplainRequest(highlight.text, highlight.id);
  }

  // ── Consume explainResult ──────────────────────────────────────────────────

  useEffect(() => {
    if (!explainResult) return;
    clearTimeout(explainTimeoutRef.current);

    const { answer } = explainResult;
    const targetId   = pendingExplainIdRef.current;
    const isError    = !answer || typeof answer !== "string"
      || answer.startsWith("⚠") || answer.trim().length < 5;

    setHighlights((prev) =>
      prev.map((h) => {
        if (!targetId || h.id !== targetId) return h;
        return isError
          ? { ...h, aiLoading: false, aiError: answer || "No response. Please retry." }
          : { ...h, aiExplanation: answer, aiLoading: false, aiError: null };
      })
    );

    if (targetId && !isError) {
      scrollToHighlightSmooth(targetId);
      setTimeout(() => flashHighlight(targetId), 200);
    }

    pendingExplainIdRef.current = null;
    onExplainResultConsumed?.();
  }, [explainResult]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Bidirectional: focus from chat ────────────────────────────────────────

  useEffect(() => {
    if (!focusedHighlightId) return;
    const h = highlightsRef.current.find((h) => h.id === focusedHighlightId);
    onFocusedHighlightConsumed?.();
    if (!h) return;

    scrollToHighlightSmooth(focusedHighlightId);
    flashHighlight(focusedHighlightId);

    setTimeout(() => {
      setActiveHighlight({
        ...h,
        position: computePopupPosition(h, scrollAreaRef.current, zoom),
      });
    }, 320);
  }, [focusedHighlightId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mouse / event handlers ─────────────────────────────────────────────────

  const handleMouseUp = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0).cloneRange();
    const text  = selection.toString().trim();

    setTimeout(() => {
      if (mode === "annotate" || mode === "clear") return; // clear mode owns its own mouse logic
      if (!text || text.length < 5) { setTooltipPos(null); setSelectedText(""); return; }
      if (!containerRef.current?.contains(range.commonAncestorContainer)) return;

      if (mode === "select") {
        const rect = range.getBoundingClientRect();
        setSelectedText(text);
        setTooltipPos({ x: rect.left + rect.width / 2, y: rect.top });
        lastRangeRef.current = range;
      } else if (mode === "highlight") {
        createHighlightFromRange(range, text);
      }
    }, 10);
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── [Phase 5] handleClick — annotate mode creates point annotations ───────
  const handleClick = useCallback((e) => {
    if (mode !== "annotate") return; // clear mode uses mousedown/up, not click
    if (e.target.closest(".selection-tooltip"))  return;
    if (e.target.closest(".annotation-popup"))   return;
    if (e.target.closest(".pdf-annotation-marker")) return;

    const scrollEl = scrollAreaRef.current;
    if (!scrollEl) return;

    const area = scrollEl.getBoundingClientRect();
    const z    = zoomRef.current;
    const cx   = getPageCenterX(scrollEl);
    const py   = 24;

    // Raw click position in scroll-area space
    const rawX = e.clientX - area.left + scrollEl.scrollLeft;
    const rawY = e.clientY - area.top  + scrollEl.scrollTop;

    // Normalise — same formula as toScrollAreaCoords
    const storedX = Math.round(cx + (rawX - cx) / z);
    const storedY = Math.round(py + (rawY - py) / z);

    // Detect which page was clicked
    const pageEls = Array.from(scrollEl.querySelectorAll(".pdf-page"));
    let page = 1;
    for (let i = 0; i < pageEls.length; i++) {
      const top    = pageEls[i].offsetTop;
      const bottom = top + pageEls[i].offsetHeight;
      if (rawY >= top && rawY <= bottom) { page = i + 1; break; }
    }

    const newAnnotation = { id: uid(), x: storedX, y: storedY, page, note: "" };
    setAnnotations((prev) => [...prev, newAnnotation]);

    // Immediately open the note popup for the new annotation
    setActiveAnnotation({
      ...newAnnotation,
      position: computeAnnotationPopupPosition(storedX, storedY, scrollEl, z),
    });
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleMouseDown = useCallback((e) => {
    if (!e.target.closest(".selection-tooltip")) { setTooltipPos(null); setSelectedText(""); }

    // ── Drag-to-erase: start drag in clear mode ────────────────────────────
    // We attach to the document handler rather than a React handler so we can
    // reliably attach move/up listeners and read refs without stale closures.
    if (modeRef.current !== "clear") return;
    if (e.target.closest(".annotation-popup") || e.target.closest(".selection-tooltip")) return;

    const scrollEl = scrollAreaRef.current;
    if (!scrollEl || !scrollEl.contains(e.target)) return;

    const area = scrollEl.getBoundingClientRect();
    const startX = e.clientX - area.left + scrollEl.scrollLeft;
    const startY = e.clientY - area.top  + scrollEl.scrollTop;

    // Stop the browser starting a native text selection from this mousedown.
    // The PDF text layer is underneath; without this every drag selects text.
    e.preventDefault();
    // Belt-and-suspenders: lock the whole document for the drag lifetime.
    // Safari ignores preventDefault for selection in some text-layer contexts.
    document.body.style.userSelect       = "none";
    document.body.style.webkitUserSelect = "none";

    eraseStartRef.current = { x: startX, y: startY };
    isDraggingRef.current = true;

    function onMove(me) {
      if (!isDraggingRef.current || !eraseStartRef.current) return;
      const el2   = scrollAreaRef.current;
      if (!el2) return;
      const ar2   = el2.getBoundingClientRect();
      const curX  = me.clientX - ar2.left + el2.scrollLeft;
      const curY  = me.clientY - ar2.top  + el2.scrollTop;
      const { x: sx, y: sy } = eraseStartRef.current;

      const box = {
        x:      Math.min(sx, curX),
        y:      Math.min(sy, curY),
        width:  Math.abs(curX - sx),
        height: Math.abs(curY - sy),
      };
      setEraseBox(box);

      // Live intersection — compare box (scroll-area px) vs stored rects (zoom=1)
      // Convert box to zoom=1 space using the same anchor formula as rendering.
      const z  = zoomRef.current || 1;
      const cx = getPageCenterX(el2);
      const py = 24;

      const boxNorm = {
        x:      cx + (box.x      - cx) / z,
        y:      py + (box.y      - py) / z,
        width:  box.width  / z,
        height: box.height / z,
      };

      const targeted = new Set();
      for (const h of highlightsRef.current) {
        for (const r of h.rects) {
          if (rectIntersects(boxNorm, r)) { targeted.add(h.id); break; }
        }
      }
      setErasingIds(targeted.size ? targeted : null);
    }

    function onUp() {
      isDraggingRef.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup",   onUp);

      // Restore normal text selection and clear any stray selection from the drag.
      document.body.style.userSelect       = "";
      document.body.style.webkitUserSelect = "";
      window.getSelection()?.removeAllRanges();

      const targeted = erasingIdsRef.current;
      if (targeted && targeted.size > 0) {
        const removed = highlightsRef.current.filter((h) => targeted.has(h.id));
        if (removed.length) {
          setUndoStack((prev) => [...prev, removed]);
          setHighlights((prev) => prev.filter((h) => !targeted.has(h.id)));
        }
      }

      setErasingIds(null);
      setEraseBox(null);
      eraseStartRef.current = null;
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup",   onUp);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [handleMouseDown]);

  useEffect(() => {
    if (!explainLoading) {
      setTooltipPos(null);
      setSelectedText("");
      window.getSelection()?.removeAllRanges();
    }
  }, [explainLoading]);

  // ── Explain from tooltip ───────────────────────────────────────────────────

  function handleExplain() {
    if (!selectedText || explainLoading) return;

    let highlightId = null;

    if (lastRangeRef.current && scrollAreaRef.current) {
      const raw = Array.from(lastRangeRef.current.getClientRects())
        .filter((r) => r.width > 1 && r.height > 1)
        .map((r) => toScrollAreaCoords(r, scrollAreaRef.current, zoom));
      const newRects = mergeRects(raw);

      const existing = overlapsExisting(newRects, selectedText, highlightsRef.current);

      if (existing) {
        highlightId = existing.id;
        pendingExplainIdRef.current = existing.id;
        setHighlights((prev) =>
          prev.map((h) => h.id === existing.id ? { ...h, aiLoading: true, aiError: null } : h)
        );
      } else {
        const newId = createHighlightFromRange(lastRangeRef.current, selectedText);
        if (newId) {
          highlightId = newId;
          pendingExplainIdRef.current = newId;
          setHighlights((prev) =>
            prev.map((h) => h.id === newId ? { ...h, aiLoading: true } : h)
          );
        }
      }
    }

    startExplainTimeout(highlightId);
    onExplainRequest(selectedText, highlightId);
  }

  function handleDismiss() {
    setTooltipPos(null);
    setSelectedText("");
    window.getSelection()?.removeAllRanges();
  }

  // ── [Phase 5] Fit to width ─────────────────────────────────────────────────
  function handleFitToWidth() {
    const el   = scrollAreaRef.current;
    const base = baseWidthRef.current;
    if (!el || !base) return;

    // Available width minus the 24px padding on each side
    const available = el.clientWidth - 48;
    const newZoom   = parseFloat(
      Math.max(0.5, Math.min(3, available / base)).toFixed(2)
    );
    setZoom(newZoom);
  }

  // ── [Phase 6] Download — annotated PDF via pdf-lib ───────────────────────
  async function handleDownload() {
    if (!file || downloadPhase) return; // prevent double-click mid-export

    const base = baseWidthRef.current;
    const el   = scrollAreaRef.current;
    if (!base || !el) return;

    // Compute cx once from the live DOM — same value used by toScrollAreaCoords
    const pageCX = (() => {
      const pageEl = el.querySelector(".pdf-page");
      if (!pageEl) return el.clientWidth / 2;
      const areaRect = el.getBoundingClientRect();
      const pageRect = pageEl.getBoundingClientRect();
      return pageRect.left - areaRect.left + el.scrollLeft + pageRect.width / 2;
    })();

    try {
      await downloadAnnotatedPDF(
        file,
        highlights,
        base,
        pageCX,
        (phase) => setDownloadPhase(phase),
      );
    } catch (err) {
      console.error("[downloadAnnotatedPDF] failed:", err);
      alert("Export failed: " + err.message);
    } finally {
      setDownloadPhase(null);
    }
  }

  // ── [Phase 5] Scroll to page ───────────────────────────────────────────────
  function handleScrollToPage(pageNum) {
    const el = scrollAreaRef.current;
    if (!el) return;
    const pageEls = el.querySelectorAll(".pdf-page");
    const target  = pageEls[pageNum - 1];
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ── Document load handlers ────────────────────────────────────────────────

  function onDocumentLoadSuccess({ numPages }) {
    setNumPages(numPages);
    setLoadError(null);
    // Detect initial page after first render
    setTimeout(updateCurrentPage, 300);
  }

  function onDocumentLoadError(err) {
    console.error(err);
    setLoadError("Failed to load PDF.");
  }

  if (!file) return null;

  const pageWidth = Math.round((baseWidthRef.current || 800) * zoom);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="pdf-viewer" ref={containerRef}>
      <PDFToolbar
        mode={mode}
        onModeChange={handleModeChange}
        zoom={zoom}
        onZoomChange={setZoom}
        numPages={numPages}
        currentPage={currentPage}
        fileName={file.name}
        onFitToWidth={handleFitToWidth}
        onDownload={handleDownload}
        onScrollToPage={handleScrollToPage}
        downloadPhase={downloadPhase}
      />

      <div
        ref={scrollAreaRef}
        className="pdf-scroll-area"
        onMouseUp={handleMouseUp}
        onClick={handleClick}
        style={{
          userSelect: (mode === "annotate" || mode === "clear") ? "none" : "text",
          cursor:     MODE_CURSOR[mode],
          position:   "relative",
        }}
      >
        {loadError ? (
          <div className="pdf-load-error">{loadError}</div>
        ) : (
          <Document
            file={file}
            onLoadSuccess={onDocumentLoadSuccess}
            onLoadError={onDocumentLoadError}
            loading={
              <div className="pdf-loading">
                <span className="spinner" /><span>Loading PDF…</span>
              </div>
            }
          >
            {Array.from({ length: numPages ?? 0 }, (_, i) => (
              <Page
                key={`page_${i + 1}`}
                pageNumber={i + 1}
                width={pageWidth}
                className="pdf-page"
                renderTextLayer={true}
                renderAnnotationLayer={false}
              />
            ))}
          </Document>
        )}

        <HighlightLayer
          highlights={highlights}
          onHighlightClick={handleHighlightClick}
          mode={mode}
          flashingId={flashingId}
          zoom={zoom}
          scrollAreaRef={scrollAreaRef}
          erasingIds={erasingIds}
          onEraseHover={handleEraseHover}
          onEraseLeave={handleEraseLeave}
        />

        {/* [Phase 6] Drag-to-erase selection rectangle */}
        <EraseSelectionBox box={eraseBox} />

        {/* [Phase 5] Annotation marker layer — rendered above highlights */}
        <AnnotationLayer
          annotations={annotations}
          onMarkerClick={handleMarkerClick}
          activeAnnotationId={activeAnnotation?.id ?? null}
          zoom={zoom}
          scrollAreaRef={scrollAreaRef}
        />
      </div>

      {/* Highlight annotation popup */}
      {activeHighlight && (
        <AnnotationPopup
          highlight={activeHighlight}
          onSave={handleSaveNote}
          onDelete={handleDeleteHighlight}
          onClose={() => setActiveHighlight(null)}
          onReExplain={handleReExplain}
          explainLoading={explainLoading}
        />
      )}

      {/* [Phase 5] Point annotation note popup */}
      {activeAnnotation && (
        <AnnotationNotePopup
          annotation={activeAnnotation}
          onSave={handleSaveAnnotationNote}
          onDelete={handleDeleteAnnotation}
          onClose={() => setActiveAnnotation(null)}
        />
      )}

      {/* [Phase 6] Undo button — visible only in clear mode when stack is non-empty */}
      {mode === "clear" && undoStack.length > 0 && (
        <button
          className="erase-undo-btn"
          onClick={handleUndo}
          title="Undo last erase (Ctrl+Z)"
        >
          ↩ Undo
        </button>
      )}

      {mode === "select" && (
        <SelectionTooltip
          position={tooltipPos}
          onExplain={handleExplain}
          onDismiss={handleDismiss}
          loading={explainLoading}
        />
      )}
    </div>
  );
}