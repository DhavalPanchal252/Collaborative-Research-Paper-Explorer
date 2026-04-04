// src/components/PDFViewer.jsx
// Phase 3: Annotation System — Notes + Interaction Layer
// Highlights are now interactive entities with metadata.

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

function toScrollAreaCoords(domRect, scrollAreaEl) {
  const areaRect = scrollAreaEl.getBoundingClientRect();
  return {
    x:      domRect.left  - areaRect.left + scrollAreaEl.scrollLeft,
    y:      domRect.top   - areaRect.top  + scrollAreaEl.scrollTop,
    width:  domRect.width,
    height: domRect.height,
  };
}

const MODE_CURSOR = {
  select:    "text",
  highlight: "text",
  annotate:  "crosshair",
};

// ─────────────────────────────────────────────────────────────────────────────
// AnnotationPopup
// Appears at fixed (clientX, clientY) of the click that opened it.
// Closes on: outside click, save, delete, X button.
// ─────────────────────────────────────────────────────────────────────────────
function AnnotationPopup({ highlight, onSave, onDelete, onClose }) {
  const [note, setNote]     = useState(highlight.note ?? "");
  const popupRef            = useRef(null);
  const textareaRef         = useRef(null);

  // Auto-focus textarea on open
  useEffect(() => { textareaRef.current?.focus(); }, []);

  // Close on outside click
  useEffect(() => {
    function onMouseDown(e) {
      if (popupRef.current && !popupRef.current.contains(e.target)) {
        onClose();
      }
    }
    // Slight delay so the click that opened the popup doesn't immediately close it
    const t = setTimeout(() => document.addEventListener("mousedown", onMouseDown), 10);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [onClose]);

  // Compute safe popup position — clamp to viewport edges
  const px = Math.min(highlight.position.x, window.innerWidth  - 300);
  const py = Math.min(highlight.position.y, window.innerHeight - 220);

  function handleSave() {
    if (!note.trim()) return;  // 🛑 prevent empty save

    onSave(highlight.id, note);
    onClose();
  }

  function handleDelete() {
    onDelete(highlight.id);
    // onClose is called inside handleDeleteHighlight
  }

  return (
    <div
      ref={popupRef}
      className="annotation-popup"
      style={{ left: px, top: py }}
      // Prevent any click inside popup from bubbling to the PDF layer
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="annotation-popup-header">
        <span className="annotation-popup-label">✦ Note</span>
        <button
          className="annotation-popup-close"
          onClick={onClose}
          aria-label="Close"
        >✕</button>
      </div>

      {/* Selected text preview */}
      <p className="annotation-popup-quote">
        "{highlight.text.length > 80
          ? highlight.text.slice(0, 80) + "…"
          : highlight.text}"
      </p>

      {/* Note textarea */}
      <textarea
        ref={textareaRef}
        className="annotation-popup-textarea"
        placeholder="Add a note…"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={4}
      />

      {/* Actions */}
      <div className="annotation-popup-actions">
        <button
          className="annotation-btn annotation-btn--delete"
          onClick={handleDelete}
        >
          Delete
        </button>
        <button
          className="annotation-btn annotation-btn--save"
          onClick={handleSave}
        >
          Save note
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HighlightLayer — Phase 3: highlights are clickable; annotated ones differ
// ─────────────────────────────────────────────────────────────────────────────
function HighlightLayer({ highlights, onHighlightClick, mode }) {
  if (!highlights.length) return null;

  // Highlights are only clickable when NOT in highlight/annotate capture mode
  const interactive = mode === "select";

  return (
    <div className="pdf-highlight-layer" aria-hidden="true">
      {highlights.map((h) =>
        h.rects.map((rect, ri) => (
          <div
            key={`${h.id}-${ri}`}
            className={`pdf-highlight${h.note ? " pdf-highlight--noted" : ""}`}
            style={{
              left:          rect.x,
              top:           rect.y,
              width:         rect.width,
              height:        rect.height,
              // Only first rect of each highlight is the click target
              // (avoids duplicate popups for multi-line highlights)
              pointerEvents: interactive && ri === 0 ? "auto" : "none",
              cursor:        interactive && ri === 0 ? "pointer" : "default",
            }}
            onClick={interactive && ri === 0
              ? (e) => { e.stopPropagation(); onHighlightClick(e, h); }
              : undefined}
          />
        ))
      )}
    </div>
  );
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

  // Phase 2
  const [highlights, setHighlights]       = useState([]);

  // Phase 3
  const [activeHighlight, setActiveHighlight] = useState(null); // { ...highlight, position:{x,y} }

  const containerRef  = useRef(null);
  const scrollAreaRef = useRef(null);

  // ── Mode change ──────────────────────────────────────────────────────────
  function handleModeChange(next) {
    setMode(next);
    setTooltipPos(null);
    setSelectedText("");
    setActiveHighlight(null);
    window.getSelection()?.removeAllRanges();
  }

  // ── Phase 3: highlight clicked → open popup ──────────────────────────────
  function handleHighlightClick(e, highlight) {
    // 🛑 prevent reopening same popup
    if (activeHighlight?.id === highlight.id) return;

    setActiveHighlight({
      ...highlight,
      position: { x: e.clientX + 12, y: e.clientY + 12 },
    });
  }

  // ── Phase 3: save note to highlight ─────────────────────────────────────
  function handleSaveNote(id, note) {
    setHighlights((prev) =>
      prev.map((h) => h.id === id ? { ...h, note } : h)
    );
  }

  // ── Phase 3: delete highlight ────────────────────────────────────────────
  function handleDeleteHighlight(id) {
    setHighlights((prev) => prev.filter((h) => h.id !== id));
    setActiveHighlight(null);
  }

  // ── Phase 2: capture selection → highlight ───────────────────────────────
  function captureHighlightFromRange(range, text) {
    if (!scrollAreaRef.current) return;

    const rawRects = Array.from(range.getClientRects());

    const rects = rawRects
      .filter((r) => r.width > 1 && r.height > 1)
      .map((r) => toScrollAreaCoords(r, scrollAreaRef.current));

    if (!rects.length) return;

    setHighlights(prev => [
      ...prev,
      {
        id: uid(),
        text,
        rects,
        note: "",
        createdAt: new Date(),
      }
    ]);

    window.getSelection()?.removeAllRanges();
  }

  // ── Unified mouseUp ──────────────────────────────────────────────────────
  const handleMouseUp = useCallback(() => {

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0).cloneRange(); // ✅ ONLY THIS
    const text = selection.toString().trim();

    setTimeout(() => {

      if (mode === "annotate") return;

      if (!text || text.length < 5) {
        setTooltipPos(null);
        setSelectedText("");
        return;
      }

      // ✅ use cloned range ONLY
      if (!containerRef.current?.contains(range.commonAncestorContainer)) return;

      if (mode === "select") {
        const rect = range.getBoundingClientRect();
        setSelectedText(text);
        setTooltipPos({ x: rect.left + rect.width / 2, y: rect.top });

      } else if (mode === "highlight") {
        captureHighlightFromRange(range, text);
      }

    }, 10);

  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Annotate click ───────────────────────────────────────────────────────
  const handleClick = useCallback((e) => {
    if (mode !== "annotate") return;
    if (e.target.closest(".selection-tooltip")) return;
    if (e.target.closest(".annotation-popup"))  return;
    console.log("Annotate at:", { x: e.clientX, y: e.clientY });
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

  useEffect(() => {
    function handleScroll() {
      setActiveHighlight(null);
    }

    const el = scrollAreaRef.current;
    if (!el) return;

    el.addEventListener("scroll", handleScroll);

    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

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

        {/* Phase 2+3: highlight overlay */}
        <HighlightLayer
          highlights={highlights}
          onHighlightClick={handleHighlightClick}
          mode={mode}
        />
      </div>

      {/* Phase 3: annotation popup — fixed position, outside scroll area */}
      {activeHighlight && (
        <AnnotationPopup
          highlight={activeHighlight}
          onSave={handleSaveNote}
          onDelete={handleDeleteHighlight}
          onClose={() => setActiveHighlight(null)}
        />
      )}

      {/* Select-mode tooltip */}
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