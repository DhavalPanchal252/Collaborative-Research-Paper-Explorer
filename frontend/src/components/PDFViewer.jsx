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

function toScrollAreaCoords(domRect, scrollAreaEl) {
  const area = scrollAreaEl.getBoundingClientRect();
  return {
    x:      domRect.left  - area.left + scrollAreaEl.scrollLeft,
    y:      domRect.top   - area.top  + scrollAreaEl.scrollTop,
    width:  domRect.width,
    height: domRect.height,
  };
}

/**
 * Compute fixed-position {x,y} for the annotation popup anchored to a
 * highlight. Converts scroll-area coords → viewport coords, then clamps.
 *
 * Preference: below-left-aligned → flip above if no room below.
 */
function computePopupPosition(highlight, scrollAreaEl) {
  if (!scrollAreaEl || !highlight?.rects?.[0]) return { x: 120, y: 160 };

  const r    = highlight.rects[0];
  const area = scrollAreaEl.getBoundingClientRect();

  // scroll-area relative → viewport fixed
  const vx = r.x + area.left - scrollAreaEl.scrollLeft;
  const vy = r.y + area.top  - scrollAreaEl.scrollTop;

  const PW  = 316;   // matches popup CSS width
  const PH  = 460;   // conservative max-height
  const PAD = 12;    // screen-edge padding
  const GAP = 8;     // gap between highlight bottom and popup top

  let x = vx;
  let y = vy + r.height + GAP;  // default: below highlight

  if (x + PW > window.innerWidth - PAD)  x = window.innerWidth - PW - PAD;
  x = Math.max(PAD, x);

  if (y + PH > window.innerHeight - PAD) y = vy - PH - GAP; // flip above
  y = Math.max(PAD, y);

  return { x, y };
}

/** True if highlight is already fully visible inside the scroll area. */
function isHighlightVisible(highlight, scrollAreaEl, margin = 80) {
  if (!scrollAreaEl || !highlight?.rects?.[0]) return false;
  const rect   = highlight.rects[0];
  const areaH  = scrollAreaEl.clientHeight;
  const relTop = rect.y - scrollAreaEl.scrollTop;
  return relTop >= margin && relTop + rect.height <= areaH - margin;
}

/** True if two rect arrays represent the same text selection (5 px tolerance). */
function rectsMatch(a, b) {
  if (!a?.length || !b?.length) return false;

  const tol = Math.max(5, a[0].width * 0.05);

  return (
    Math.abs(a[0].x - b[0].x) < tol &&
    Math.abs(a[0].y - b[0].y) < tol
  );
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
function HighlightLayer({ highlights, onHighlightClick, mode, flashingId }) {
  if (!highlights.length) return null;
  const interactive = mode === "select";

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
                left:          rect.x,
                top:           rect.y,
                width:         rect.width,
                height:        rect.height,
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
    if (!h || isHighlightVisible(h, el)) return;
    const rect = h.rects[0];
    el.scrollTo({
      top:      Math.max(0, rect.y - el.clientHeight / 2 + rect.height / 2),
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
      position: computePopupPosition(highlight, scrollAreaRef.current),
    });
  }

  // Recompute popup position on resize
  useEffect(() => {
    function onResize() {
      setActiveHighlight((prev) =>
        prev
          ? { ...prev, position: computePopupPosition(prev, scrollAreaRef.current) }
          : null
      );
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

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
              prev ? { ...prev, ...fresh, position: computePopupPosition(fresh, el) } : null
            );
          } else {
            setActiveHighlight(prev => {
              if (!prev) return null;

              const fresh = highlightsRef.current.find(h => h.id === prev.id);
              if (!fresh) return null;

              return {
                ...prev,
                ...fresh,
                position: computePopupPosition(fresh, el),
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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Live-sync popup when highlight data changes (aiExplanation, aiLoading, aiError)
  useEffect(() => {
    setActiveHighlight((prev) => {
      if (!prev) return null;
      const fresh = highlights.find((h) => h.id === prev.id);
      return fresh ? { ...fresh, position: prev.position } : null;
    });
  }, [highlights]);

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
    const rects = Array.from(range.getClientRects())
      .filter((r) => r.width > 1 && r.height > 1)
      .map((r) => toScrollAreaCoords(r, scrollAreaRef.current));
    if (!rects.length) return null;

    // Duplicate protection — reuse silently
    const dupe = highlightsRef.current.find(
      (h) => h.text === text && rectsMatch(h.rects, rects)
    );
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
        position: computePopupPosition(h, scrollAreaRef.current),
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
      const newRects = Array.from(lastRangeRef.current.getClientRects())
        .filter((r) => r.width > 1 && r.height > 1)
        .map((r) => toScrollAreaCoords(r, scrollAreaRef.current));

      const existing = highlightsRef.current.find(
        (h) => h.text === selectedText && rectsMatch(h.rects, newRects)
      );

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

  const baseWidth = Math.min(containerRef.current?.clientWidth - 48 || 680, 900);
  const pageWidth = Math.round(baseWidth * zoom);

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