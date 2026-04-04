// src/components/PDFViewer.jsx
// Phase 2: Text Highlight System
// Overlay-based highlight rendering — does NOT touch the PDF text layer.

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
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let _uid = 0;
function uid() { return ++_uid; }

/**
 * Convert a DOMRect (viewport-relative) to coordinates relative to
 * scrollArea's top-left corner, accounting for scroll position.
 *
 * Why scrollArea and not containerRef?
 *   .pdf-viewer is flex-column with no position:relative — absolute children
 *   escape it. .pdf-scroll-area is where `position:relative` is set (via CSS
 *   addition below), and its scrollTop must be added back because
 *   getBoundingClientRect() gives viewport coords, not document coords.
 */
function toScrollAreaCoords(domRect, scrollAreaEl) {
  const areaRect = scrollAreaEl.getBoundingClientRect();
  return {
    x:      domRect.left   - areaRect.left + scrollAreaEl.scrollLeft,
    y:      domRect.top    - areaRect.top  + scrollAreaEl.scrollTop,
    width:  domRect.width,
    height: domRect.height,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SelectionTooltip — unchanged
// ─────────────────────────────────────────────────────────────────────────────
function SelectionTooltip({ position, onExplain, onDismiss, loading }) {
  if (!position) return null;
  return (
    <div
      className="selection-tooltip"
      style={{
        position: "fixed",
        left: position.x,
        top: position.y,
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
// HighlightLayer — renders all highlight rects inside the scroll container
// ─────────────────────────────────────────────────────────────────────────────
function HighlightLayer({ highlights }) {
  if (!highlights.length) return null;
  return (
    <div className="pdf-highlight-layer" aria-hidden="true">
      {highlights.map((h) =>
        h.rects.map((rect, ri) => (
          <div
            key={`${h.id}-${ri}`}
            className="pdf-highlight"
            style={{
              left:   rect.x,
              top:    rect.y,
              width:  rect.width,
              height: rect.height,
            }}
          />
        ))
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Cursor map
// ─────────────────────────────────────────────────────────────────────────────
const MODE_CURSOR = {
  select:    "text",
  highlight: "text",      // keep text cursor so selection still feels natural
  annotate:  "crosshair",
};

// ─────────────────────────────────────────────────────────────────────────────
// PDFViewer
// ─────────────────────────────────────────────────────────────────────────────
export default function PDFViewer({ file, onExplainRequest, explainLoading }) {
  const [numPages, setNumPages]           = useState(null);
  const [loadError, setLoadError]         = useState(null);
  const [tooltipPos, setTooltipPos]       = useState(null);
  const [selectedText, setSelectedText]   = useState("");

  // Phase 0
  const [mode, setMode] = useState("select");
  const [zoom, setZoom] = useState(1);

  // Phase 2 — highlight store
  const [highlights, setHighlights] = useState([]);

  const containerRef  = useRef(null);   // .pdf-viewer div
  const scrollAreaRef = useRef(null);   // .pdf-scroll-area div — anchor for overlay

  // ── Mode change — clear lingering state ──────────────────────────────────
  function handleModeChange(next) {
    setMode(next);
    setTooltipPos(null);
    setSelectedText("");
    window.getSelection()?.removeAllRanges();
  }

  // ── PHASE 2: build a highlight from the current browser selection ─────────
  function captureHighlight(selection) {
    if (!scrollAreaRef.current) return;

    const range = selection.getRangeAt(0);
    const rawRects = Array.from(range.getClientRects());

    // Filter out degenerate rects (zero-size artifacts from line breaks)
    const rects = rawRects
      .filter((r) => r.width > 1 && r.height > 1)
      .map((r) => toScrollAreaCoords(r, scrollAreaRef.current));

    if (!rects.length) return;

    const highlight = {
      id:   uid(),
      text: selection.toString().trim(),
      rects,
      page: null, // placeholder for now
    };

    setHighlights(prev => {
      const exists = prev.some(h => h.text === highlight.text);
      if (exists) return prev;
      return [...prev, highlight];
    });
    window.getSelection()?.removeAllRanges();
  }

  // ── Unified mouseUp — mode-driven ────────────────────────────────────────
  const handleMouseUp = useCallback(() => {
    setTimeout(() => {
      const selection = window.getSelection();
      const text = selection?.toString().trim();

      if (mode === "annotate") return;

      if (!text || text.length < 5) {
        setTooltipPos(null);
        setSelectedText("");
        return;
      }

      if (!selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (!containerRef.current?.contains(range.commonAncestorContainer)) return;

      if (mode === "select") {
        const rect = range.getBoundingClientRect();
        setSelectedText(text);
        setTooltipPos({ x: rect.left + rect.width / 2, y: rect.top });

      } else if (mode === "highlight") {
        // Phase 2: create and store highlight overlay rects
        captureHighlight(selection);
      }
    }, 10);
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  // captureHighlight is stable across renders (uses ref, not state)

  // ── Click handler — annotate mode only ───────────────────────────────────
  const handleClick = useCallback((e) => {
    if (mode !== "annotate") return;
    if (e.target.closest(".selection-tooltip")) return;
    const { clientX: x, clientY: y } = e;
    console.log("Annotate at:", { x, y });
  }, [mode]);

  // ── Dismiss tooltip on outside mousedown ─────────────────────────────────
  const handleMouseDown = useCallback((e) => {
    if (!e.target.closest(".selection-tooltip")) {
      setTooltipPos(null);
      setSelectedText("");
    }
  }, []);

  useEffect(() => {
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [handleMouseDown]);

  // ── Dismiss tooltip when explain resolves ────────────────────────────────
  useEffect(() => {
    if (!explainLoading) {
      setTooltipPos(null);
      setSelectedText("");
      window.getSelection()?.removeAllRanges();
    }
  }, [explainLoading]);

  function handleExplain() {
    if (!selectedText) return;
    onExplainRequest(selectedText);
  }

  function handleDismiss() {
    setTooltipPos(null);
    setSelectedText("");
    window.getSelection()?.removeAllRanges();
  }

  function onDocumentLoadSuccess({ numPages }) {
    setNumPages(numPages);
    setLoadError(null);
  }

  function onDocumentLoadError(error) {
    console.error("PDF load error:", error);
    setLoadError("Failed to load PDF. Please try uploading again.");
  }

  if (!file) return null;

  const baseWidth = Math.min(containerRef.current?.clientWidth - 48 || 680, 900);
  const pageWidth = Math.round(baseWidth * zoom);

  return (
    <div className="pdf-viewer" ref={containerRef}>

      {/* Toolbar */}
      <PDFToolbar
        mode={mode}
        onModeChange={handleModeChange}
        zoom={zoom}
        onZoomChange={setZoom}
        numPages={numPages}
        currentPage={1}
        fileName={file.name}
      />

      {/* Scroll container — position:relative so overlay is anchored here */}
      <div
        ref={scrollAreaRef}
        className="pdf-scroll-area"
        onMouseUp={handleMouseUp}
        onClick={handleClick}
        style={{
          userSelect: mode === "annotate" ? "none" : "text",
          cursor:     MODE_CURSOR[mode],
          position:   "relative",   // overlay anchor
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
                <span className="spinner" />
                <span>Loading PDF…</span>
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

        {/* Phase 2: highlight overlay — child of scroll area, shares coordinate space */}
        <HighlightLayer highlights={highlights} />
      </div>

      {/* Tooltip — select mode only */}
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