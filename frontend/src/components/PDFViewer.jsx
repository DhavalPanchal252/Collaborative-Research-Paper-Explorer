// src/components/PDFViewer.jsx
import { useState, useRef, useCallback, useEffect } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

// Required: point pdfjs to its worker
// pdfjs.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.js`;

// ✅ REPLACE WITH THIS (Vite resolves it from node_modules directly)
// ✅ Correct for react-pdf v10 + Vite
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();
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
        top: position.y,
        transform: "translateX(-50%) translateY(-110%)",
        zIndex: 1000,
      }}
      // Prevent mousedown inside tooltip from clearing selection
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        className="tooltip-explain-btn"
        onClick={onExplain}
        disabled={loading}
      >
        {loading ? (
          <>
            <span className="spinner spinner--xs" />
            Explaining…
          </>
        ) : (
          <>
            <span className="tooltip-icon">✦</span>
            Explain
          </>
        )}
      </button>
      <button
        className="tooltip-dismiss-btn"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PDFViewer
// ─────────────────────────────────────────────────────────────────────────────
export default function PDFViewer({ file, onExplainRequest, explainLoading }) {
  const [numPages, setNumPages] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [tooltipPos, setTooltipPos] = useState(null);
  const [selectedText, setSelectedText] = useState("");
  const containerRef = useRef(null);

  // ── Track text selection ──────────────────────────────────────────────────
  const handleMouseUp = useCallback(() => {
    // Small delay so the selection is fully committed
    setTimeout(() => {
      const selection = window.getSelection();
      const text = selection?.toString().trim();

      if (!text || text.length < 5) {
        setTooltipPos(null);
        setSelectedText("");
        return;
      }

      // Guard: selection must be within the PDF container
      const range = selection.getRangeAt(0);
      if (!containerRef.current?.contains(range.commonAncestorContainer)) {
        return;
      }

      const rect = range.getBoundingClientRect();
      setSelectedText(text);
      setTooltipPos({
        x: rect.left + rect.width / 2,
        y: rect.top,
      });
    }, 10);
  }, []);

  // Dismiss tooltip when user clicks elsewhere
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

  // ── Dismiss tooltip when explainLoading turns false (answer delivered) ─────
  useEffect(() => {
    if (!explainLoading) {
      setTooltipPos(null);
      setSelectedText("");
      window.getSelection()?.removeAllRanges();
    }
  }, [explainLoading]);

  // ── Explain handler ───────────────────────────────────────────────────────
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

  return (
    <div className="pdf-viewer" ref={containerRef}>
      {/* Toolbar */}
      <div className="pdf-toolbar">
        <span className="pdf-toolbar-name">
          <span className="pdf-toolbar-icon">📄</span>
          {file.name}
        </span>
        {numPages && (
          <span className="pdf-toolbar-pages">{numPages} pages</span>
        )}
        <span className="pdf-hint">Select text → Explain</span>
      </div>

      {/* Document */}
      <div className="pdf-scroll-area" onMouseUp={handleMouseUp}>
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
                width={Math.min(containerRef.current?.clientWidth - 48 || 680, 900)}
                className="pdf-page"
                renderTextLayer={true}
                renderAnnotationLayer={false}
              />
            ))}
          </Document>
        )}
      </div>

      {/* Floating tooltip */}
      <SelectionTooltip
        position={tooltipPos}
        onExplain={handleExplain}
        onDismiss={handleDismiss}
        loading={explainLoading}
      />
    </div>
  );
}