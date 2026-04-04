// src/components/PDFViewer.jsx
// Phase 1: Mode-Based Interaction System
// Toolbar mode drives ALL user interaction. No cross-mode bleed.

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
      <button
        className="tooltip-explain-btn"
        onClick={onExplain}
        disabled={loading}
      >
        {loading ? (
          <><span className="spinner spinner--xs" />Explaining…</>
        ) : (
          <><span className="tooltip-icon">✦</span>Explain</>
        )}
      </button>
      <button className="tooltip-dismiss-btn" onClick={onDismiss} aria-label="Dismiss">
        ✕
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Cursor map — mode → CSS cursor value
// ─────────────────────────────────────────────────────────────────────────────
const MODE_CURSOR = {
  select:    "text",
  highlight: "crosshair",
  annotate:  "crosshair",
};

// ─────────────────────────────────────────────────────────────────────────────
// PDFViewer
// ─────────────────────────────────────────────────────────────────────────────
export default function PDFViewer({ file, onExplainRequest, explainLoading }) {
  const [numPages, setNumPages]         = useState(null);
  const [loadError, setLoadError]       = useState(null);
  const [tooltipPos, setTooltipPos]     = useState(null);
  const [selectedText, setSelectedText] = useState("");

  // ── Phase 0: toolbar state ────────────────────────────────────────────────
  const [mode, setMode] = useState("select");
  const [zoom, setZoom] = useState(1);

  const containerRef = useRef(null);

  // ── PHASE 1: Mode change clears any lingering tooltip / selection ─────────
  function handleModeChange(next) {
    setMode(next);
    setTooltipPos(null);
    setSelectedText("");
    window.getSelection()?.removeAllRanges();
  }

  // ── PHASE 1: Unified mouseUp handler — behaviour driven by mode ───────────
  const handleMouseUp = useCallback(() => {
    setTimeout(() => {
      const selection = window.getSelection();
      const text = selection?.toString().trim();

      // ── annotate mode: mouseUp is irrelevant, click handler owns it ──────
      if (mode === "annotate") return;

      if (!text || text.length < 5) {
        setTooltipPos(null);
        setSelectedText("");
        return;
      }

      // Guard: selection must be within the PDF container
      if (!selection || selection.rangeCount === 0) return;

      const range = selection.getRangeAt(0);

      if (!containerRef.current?.contains(range.commonAncestorContainer)) return;

      if (mode === "select") {
        // ── select: existing explain-tooltip behaviour ─────────────────────
        const rect = range.getBoundingClientRect();
        setSelectedText(text);
        setTooltipPos({ x: rect.left + rect.width / 2, y: rect.top });

      } else if (mode === "highlight") {
        // ── highlight: capture only, no tooltip ───────────────────────────
        console.log("Highlight:", text);
        // Clear browser selection so it doesn't linger
        window.getSelection()?.removeAllRanges();
      }
    }, 10);
  }, [mode]);

  // ── PHASE 1: Click handler — annotate mode only ───────────────────────────
  const handleClick = useCallback((e) => {
    if (mode !== "annotate") return;
    if (!e.target.closest(".pdf-page")) return;
    if (e.target.closest(".selection-tooltip")) return;

    const { clientX: x, clientY: y } = e;
    console.log("Annotate at:", { x, y });
  }, [mode]);

  // ── Dismiss tooltip on mousedown outside it ───────────────────────────────
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

  // ── Dismiss tooltip when explain resolves ─────────────────────────────────
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

  // ── PDF callbacks ─────────────────────────────────────────────────────────
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

      {/* ── Toolbar ── */}
      <PDFToolbar
        mode={mode}
        onModeChange={handleModeChange}
        zoom={zoom}
        onZoomChange={setZoom}
        numPages={numPages}
        currentPage={1}
        fileName={file.name}
      />

      {/* ── Document area
            userSelect blocks browser text selection in highlight/annotate.
            cursor reflects the active mode.
      ── */}
      <div
        className="pdf-scroll-area"
        onMouseUp={handleMouseUp}
        onClick={handleClick}
        style={{
          userSelect: mode === "select" ? "text" : "none",
          cursor: MODE_CURSOR[mode],
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
      </div>

      {/* ── Tooltip — only rendered in select mode ── */}
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