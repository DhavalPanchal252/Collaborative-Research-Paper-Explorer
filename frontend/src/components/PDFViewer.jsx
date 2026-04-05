// src/components/PDFViewer.jsx
// Phase 4+ Premium UX — smart popup anchoring, scroll sync, bidirectional
// chat↔PDF linking, shimmer loading, error/retry, full state consistency.

import { useState, useRef, useCallback, useEffect } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import PDFToolbar from "./PDFToolbar";

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
function toScrollAreaCoords(domRect, scrollAreaEl, zoom = 1) {
  const area = scrollAreaEl.getBoundingClientRect();
  const z    = zoom || 1;

  const rawX = domRect.left  - area.left + scrollAreaEl.scrollLeft;
  const rawY = domRect.top   - area.top  + scrollAreaEl.scrollTop;

  // Fixed anchor points (match HighlightLayer's render anchors exactly)
  const cx = scrollAreaEl.clientWidth / 2;  // horizontal center of scroll area
  const py = 24;                            // top padding (`.pdf-scroll-area { padding: 24px }`)

  return {
    x:      Math.round(cx + (rawX - cx) / z),
    y:      Math.round(py + (rawY - py) / z),
    width:  Math.round(domRect.width  / z),
    height: Math.round(domRect.height / z),
  };
}

/**
 * mergeRects — consolidates the flood of per-span rects into one rect per line.
 *
 * WHY: getClientRects() returns one rect per text *node*, so a single sentence
 * produces 10-20 tiny rects.  Rendering each individually causes visible gaps,
 * overlapping borders, and uneven colour intensity where rects stack.
 *
 * ALGORITHM:
 *  1. Sort top→bottom, left→right.
 *  2. Group rects whose y-centres are within LINE_TOL px — same visual line.
 *     (PDF.js spans on the same line differ by 1–3 px due to sub-pixel layout.)
 *  3. Union the bounding box per group → one seamless rect per line.
 *  4. Expand ±V_PAD px vertically so the highlight covers full glyph ascenders.
 *  5. Round to integers (see above).
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

    if (Math.abs(prevCenter - currCenter) <= 4) {
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
    const right = Math.max(...line.map(r => r.x + r.width));
    const bottom = Math.max(...line.map(r => r.y + r.height));

    return {
      x: Math.round(x),
      y: Math.round(y - 1),
      width: Math.round(right - x),
      height: Math.round(bottom - y + 2),
    };
  });
}

/**
 * overlapsExisting — prevent genuinely stacked/duplicate highlights.
 *
 * WHAT CHANGED AND WHY:
 *
 * Old logic: checked only newRects[0] with a boolean touch test (any x+y
 * bounding-box contact counted as overlap).  This blocked adjacent highlights
 * on the same line because:
 *   • After mergeRects, stored rects have height = lineHeight + 2px (V_PAD).
 *   • Two selections on the same line share identical y-ranges → yOverlap=true.
 *   • Pixel rounding at the shared x-boundary (e.g. right=250, left=250 rounds
 *     to 249/251) caused xOverlap=true even for non-overlapping selections.
 *   → Result: the second selection was silently swallowed.
 *
 * New logic:
 *   1. Check ALL newRects (not just [0]) against ALL stored rects — more accurate
 *      for multi-line selections.
 *   2. Use intersection AREA instead of a boolean touch:
 *        xIntersect = overlap width in px
 *        yIntersect = overlap height in px
 *      Both must exceed OVERLAP_MIN (4 px) to count as a real overlap.
 *      This absorbs ±1-2 px rounding at line/word boundaries while still
 *      catching genuine re-selections of already-highlighted text.
 */
const OVERLAP_MIN = 4; // px — intersection in both axes required to block

function overlapsExisting(newRects, newText, existing) {
  for (const h of existing) {
    // Fast path: exact same text → always a duplicate
    if (h.text === newText) return h;

    // Geometric check: any new rect meaningfully overlaps any stored rect?
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
 * Compute fixed-position {x,y} for the annotation popup anchored to a
 * highlight. Converts scroll-area coords → viewport coords, then clamps.
 *
 * Preference: below-left-aligned → flip above if no room below.
 */
function computePopupPosition(highlight, scrollAreaEl, zoom = 1) {
  if (!scrollAreaEl || !highlight?.rects?.[0]) return { x: 120, y: 160 };

  const r    = highlight.rects[0];
  const area = scrollAreaEl.getBoundingClientRect();
  const z    = zoom || 1;

  // stored coords are at zoom=1 → scale back to current zoom for viewport mapping
  const vx = r.x * z + area.left - scrollAreaEl.scrollLeft;
  const vy = r.y * z + area.top  - scrollAreaEl.scrollTop;

  const PW  = 316;
  const PH  = 460;
  const PAD = 12;
  const GAP = 8;

  let x = vx;
  let y = vy + r.height * z + GAP;  // scale stored height by zoom

  if (x + PW > window.innerWidth - PAD)  x = window.innerWidth - PW - PAD;
  x = Math.max(PAD, x);

  if (y + PH > window.innerHeight - PAD) y = vy - PH - GAP; // flip above
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


const MODE_CURSOR = { select: "text", highlight: "text", annotate: "crosshair" };

// ─────────────────────────────────────────────────────────────────────────────
// AnnotationPopup
//
// Premium UX:
//   • Anchored to highlight rects, not click position
//   • Never closes or flickers during AI loading
//   • Skeleton shimmer while waiting
//   • Error state with inline retry
//   • Outside-click suppressed while loading
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

  // Outside-click closes popup — suppressed while AI is loading
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
      {/* Header */}
      <div className="annotation-popup-header">
        <span className="annotation-popup-label">✦ Annotation</span>
        <button
          className="annotation-popup-close"
          onClick={onClose}
          disabled={isLoading}
          aria-label="Close"
        >✕</button>
      </div>

      {/* Quote preview */}
      <p className="annotation-popup-quote">
        "{highlight.text.length > 90
          ? highlight.text.slice(0, 90) + "…"
          : highlight.text}"
      </p>

      {/* AI block */}
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

      {/* Note textarea */}
      <textarea
        className="annotation-popup-textarea"
        placeholder="Add a personal note…"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
      />

      {/* Actions */}
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
// HighlightLayer — states: default | noted | ai-ready | loading | error | flash
// ─────────────────────────────────────────────────────────────────────────────
function HighlightLayer({ highlights, onHighlightClick, mode, flashingId, zoom, scrollAreaWidth }) {
  if (!highlights.length) return null;
  const interactive = mode === "select";
  const z = zoom || 1;

  // Mirror the exact anchor points used in toScrollAreaCoords at capture time.
  // cx: page is flex-centered — scale X relative to the container centre, not 0.
  // py: scroll area has fixed padding:24px — scale Y above that baseline only.
  const cx = scrollAreaWidth > 0 ? scrollAreaWidth / 2 : 0;
  const py = 24; // matches `.pdf-scroll-area { padding: 24px }` in index.css

  return (
    <div className="pdf-highlight-layer" aria-hidden="true">
      {highlights.map((h) =>
        h.rects.map((rect, ri) => {
          const cls = [
            "pdf-highlight",
            h.note          ? "pdf-highlight--noted"   : "",
            h.aiExplanation ? "pdf-highlight--ai"      : "",
            h.aiLoading     ? "pdf-highlight--loading" : "",
            h.aiError       ? "pdf-highlight--error"   : "",
            flashingId === h.id ? "pdf-highlight--flash" : "",
          ].filter(Boolean).join(" ");

          const isTarget = interactive && ri === 0;

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
                pointerEvents: isTarget ? "auto" : "none",
                cursor:        isTarget ? "pointer" : "default",
              }}
              onClick={isTarget
                ? (e) => { e.stopPropagation(); onHighlightClick(e, h); }
                : undefined}
            />
          );
        })
      )}
    </div>
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
//
// New props (Phase 4+):
//   onExplainRequest(text, highlightId)  — highlightId wires chat linking
//   focusedHighlightId                   — set by chat click; triggers scroll+flash
//   onFocusedHighlightConsumed           — called after acting so App can reset
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

  const containerRef        = useRef(null);
  const scrollAreaRef       = useRef(null);
  const pendingExplainIdRef = useRef(null);   // which highlight is waiting for AI
  const lastRangeRef        = useRef(null);   // browser Range from last mouseUp
  const explainTimeoutRef   = useRef(null);   // 15 s safety timeout
  const highlightsRef       = useRef(highlights);
  const activeHighlightRef  = useRef(activeHighlight);

  useEffect(() => { highlightsRef.current = highlights; },           [highlights]);
  useEffect(() => { activeHighlightRef.current = activeHighlight; }, [activeHighlight]);
  useEffect(() => () => clearTimeout(explainTimeoutRef.current), []);

  // ── Helpers ──────────────────────────────────────────────────────────────

  function scrollToHighlightSmooth(id) {
    const el = scrollAreaRef.current;
    if (!el) return;
    const h = highlightsRef.current.find((h) => h.id === id);
    if (!h || isHighlightVisible(h, el, zoom)) return;
    const rect = h.rects[0];
    const z    = zoom || 1;
    el.scrollTo({
      top: Math.round(
          rect.y * z - el.clientHeight / 2 + rect.height * z / 2),
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

  // ── Mode ──────────────────────────────────────────────────────────────────

  function handleModeChange(next) {
    setMode(next);
    setTooltipPos(null);
    setSelectedText("");
    setActiveHighlight(null);
    window.getSelection()?.removeAllRanges();
  }

  // ── Highlight click → anchor popup ───────────────────────────────────────

  function handleHighlightClick(e, highlight) {
    if (activeHighlight?.id === highlight.id) { setActiveHighlight(null); return; }
    setActiveHighlight({
      ...highlight,
      position: computePopupPosition(highlight, scrollAreaRef.current, zoom),
    });
  }

  // Recompute popup position on resize
  useEffect(() => {
    function onResize() {
      setActiveHighlight((prev) =>
        prev
          ? { ...prev, position: computePopupPosition(prev, scrollAreaRef.current, zoom) }
          : null
      );
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    setActiveHighlight(prev =>
      prev
        ? {
            ...prev,
            position: computePopupPosition(prev, scrollAreaRef.current, zoom),
          }
        : null
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
          const cur = activeHighlightRef.current;
          if (!cur) return;

          if (cur.aiLoading) {
            const fresh = highlightsRef.current.find((h) => h.id === cur.id);
            if (!fresh) { setActiveHighlight(null); return; }

            setActiveHighlight(prev =>
              prev ? { ...prev, ...fresh, position: computePopupPosition(fresh, el, zoom) } : null
            );
          } else {
            setActiveHighlight(prev => {
              if (!prev) return null;

              const fresh = highlightsRef.current.find(h => h.id === prev.id);
              if (!fresh) return null;

              return {
                ...prev,
                ...fresh,
                position: computePopupPosition(fresh, el, zoom),
              };
            });
          }

          ticking = false;
        });

        ticking = true;
      }
    }

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live-sync popup when highlight data changes (aiExplanation, aiLoading, aiError)
  useEffect(() => {
    setActiveHighlight((prev) => {
      if (!prev) return null;
      const fresh = highlights.find((h) => h.id === prev.id);
      return fresh ? { ...fresh, position: prev.position } : null;
    });
  }, [highlights]);


  useEffect(() => {
    if (!scrollAreaRef.current) return;

    let raf1 = requestAnimationFrame(() => {
      let raf2 = requestAnimationFrame(() => {
        setHighlights(prev => [...prev]);
      });
    });

    return () => {
      cancelAnimationFrame(raf1);
    };
  }, [zoom]);


  // ── CRUD ──────────────────────────────────────────────────────────────────

  function handleSaveNote(id, note) {
    setHighlights((prev) => prev.map((h) => (h.id === id ? { ...h, note } : h)));
  }

  function handleDeleteHighlight(id) {
    setHighlights((prev) => prev.filter((h) => h.id !== id));
    setActiveHighlight(null);
  }

  function createHighlightFromRange(range, text) {
    if (!scrollAreaRef.current) return null;

    // 1. Convert viewport rects → scroll-area coords, normalised to zoom=1
    const raw = Array.from(range.getClientRects());

    const normalizedRects = raw
      .filter(r => r.width > 1 && r.height > 1)
      .map(r => toScrollAreaCoords(r, scrollAreaRef.current, zoom)); // ✅ FIRST

    if (!normalizedRects.length) return null;

    // 2. Merge adjacent same-line rects → one clean rect per line
    const rects = mergeRects(normalizedRects);
    if (!rects.length) return null;

    // 3. Overlap / duplicate guard — reuse existing highlight, never stack
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

  // ── Re-explain ────────────────────────────────────────────────────────────

  function handleReExplain(highlight) {
    if (explainLoading) return;
    pendingExplainIdRef.current = highlight.id;
    setHighlights((prev) =>
      prev.map((h) => h.id === highlight.id ? { ...h, aiLoading: true, aiError: null } : h)
    );
    startExplainTimeout(highlight.id);
    onExplainRequest(highlight.text, highlight.id); // passes highlightId for chat linking
  }

  // ── Consume explainResult ─────────────────────────────────────────────────

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
      setTimeout(() => flashHighlight(targetId), 200); // flash after scroll settles
    }

    pendingExplainIdRef.current = null;
    onExplainResultConsumed?.();
  }, [explainResult]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Bidirectional: focus from chat ───────────────────────────────────────

  useEffect(() => {
    if (!focusedHighlightId) return;
    const h = highlightsRef.current.find((h) => h.id === focusedHighlightId);
    onFocusedHighlightConsumed?.();
    if (!h) return;

    scrollToHighlightSmooth(focusedHighlightId);
    flashHighlight(focusedHighlightId);

    // Open popup after scroll animation runs
    setTimeout(() => {
      setActiveHighlight({
        ...h,
        position: computePopupPosition(h, scrollAreaRef.current, zoom),
      });
    }, 320);
  }, [focusedHighlightId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mouse / event handlers ────────────────────────────────────────────────

  const handleMouseUp = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0).cloneRange();
    const text  = selection.toString().trim();

    setTimeout(() => {
      if (mode === "annotate") return;
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

  const handleClick = useCallback((e) => {
    if (mode !== "annotate") return;
    if (e.target.closest(".selection-tooltip")) return;
    if (e.target.closest(".annotation-popup")) return;
  }, [mode]);

  const handleMouseDown = useCallback((e) => {
    if (!e.target.closest(".selection-tooltip")) { setTooltipPos(null); setSelectedText(""); }
  }, []);

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

  // ── Explain from tooltip ──────────────────────────────────────────────────

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

  function onDocumentLoadSuccess({ numPages }) { setNumPages(numPages); setLoadError(null); }
  function onDocumentLoadError(err) { console.error(err); setLoadError("Failed to load PDF."); }

  if (!file) return null;

  const baseWidthRef = useRef(null);

  if (!baseWidthRef.current && containerRef.current) {
    baseWidthRef.current = Math.min(containerRef.current.clientWidth - 48, 900);
  }

  const pageWidth = Math.round((baseWidthRef.current || 800) * zoom);

  return (
    <div className="pdf-viewer" ref={containerRef}>
      <PDFToolbar
        mode={mode}
        onModeChange={handleModeChange}
        zoom={zoom}
        onZoomChange={setZoom}
        numPages={numPages}
        currentPage={1}
        fileName={file.name}
      />

      <div
        ref={scrollAreaRef}
        className="pdf-scroll-area"
        onMouseUp={handleMouseUp}
        onClick={handleClick}
        style={{
          userSelect: mode === "annotate" ? "none" : "text",
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
            loading={<div className="pdf-loading"><span className="spinner" /><span>Loading PDF…</span></div>}
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
          scrollAreaWidth={scrollAreaRef.current?.clientWidth ?? 0}
        />
      </div>

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