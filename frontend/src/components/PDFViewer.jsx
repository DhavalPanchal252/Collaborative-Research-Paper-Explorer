// src/components/PDFViewer.jsx
// Phase 4: AI-Linked Highlight Intelligence System
// Each highlight is now a knowledge node: text → note → aiExplanation

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
// AnnotationPopup — Phase 4: shows AI explanation + Re-explain button
// ─────────────────────────────────────────────────────────────────────────────
function AnnotationPopup({
  highlight,
  onSave,
  onDelete,
  onClose,
  onReExplain,   // Phase 4: (highlight) => void
  explainLoading, // Phase 4: global explain-in-flight flag
}) {
  const [note, setNote]  = useState(highlight.note ?? "");
  const popupRef         = useRef(null);
  const textareaRef      = useRef(null);

  useEffect(() => { textareaRef.current?.focus(); }, []);

  // Close on outside click
  useEffect(() => {
    function onMouseDown(e) {
      if (popupRef.current && !popupRef.current.contains(e.target)) onClose();
    }
    const t = setTimeout(() => document.addEventListener("mousedown", onMouseDown), 10);
    return () => { clearTimeout(t); document.removeEventListener("mousedown", onMouseDown); };
  }, [onClose]);

  const px = Math.min(highlight.position?.x ?? 100, window.innerWidth - 320);
  const py = Math.min(highlight.position?.y ?? 100, window.innerHeight - 320);

  function handleSave() {
    if (!note.trim()) return;
    onSave(highlight.id, note);
    onClose();
  }

  function handleDelete() {
    onDelete(highlight.id);
  }

  // Phase 4: is AI currently working on THIS highlight?
  const isThisLoading = highlight.aiLoading || (explainLoading && !highlight.aiExplanation);

  return (
    <div
      ref={popupRef}
      className="annotation-popup"
      style={{ left: px, top: py }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="annotation-popup-header">
        <span className="annotation-popup-label">✦ Note</span>
        <button className="annotation-popup-close" onClick={onClose} aria-label="Close">✕</button>
      </div>

      {/* Selected text preview */}
      <p className="annotation-popup-quote">
        "{highlight.text.length > 80
          ? highlight.text.slice(0, 80) + "…"
          : highlight.text}"
      </p>

      {/* ── Phase 4: AI Explanation block ─────────────────────────────────── */}
      <div className="annotation-ai-block">
      <div className="annotation-ai-header">
        <span className="annotation-ai-label">✦ AI Explanation</span>

        <button
          className="annotation-btn annotation-btn--reexplain"
          onClick={() => onReExplain(highlight)}
          disabled={isThisLoading || explainLoading}
          title="Re-generate explanation"
        >
          {isThisLoading ? (
            <>
              <span className="spinner spinner--xs" />
              Generating...
            </>
          ) : (
            "↺ Re-explain"
          )}
        </button>
        </div>

        {isThisLoading ? (
          <div className="annotation-ai-loading">
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-dot" />
          </div>
        ) : highlight.aiExplanation ? (
          <p className="annotation-ai-text">{highlight.aiExplanation}</p>
        ) : (
          <p className="annotation-ai-empty">
            No explanation yet.{" "}
            <button
              className="annotation-ai-trigger-link"
              onClick={() => onReExplain(highlight)}
              disabled={explainLoading}
            >
              Generate one →
            </button>
          </p>
        )}
      </div>

      {/* Note textarea */}
      <textarea
        ref={textareaRef}
        className="annotation-popup-textarea"
        placeholder="Add a personal note…"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
      />

      {/* Actions */}
      <div className="annotation-popup-actions">
        <button className="annotation-btn annotation-btn--delete" onClick={handleDelete}>
          Delete
        </button>
        <button
          className="annotation-btn annotation-btn--save"
          onClick={handleSave}
          disabled={!note.trim()}
        >
          Save note
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HighlightLayer — Phase 4: ai class + flash animation
// ─────────────────────────────────────────────────────────────────────────────
function HighlightLayer({ highlights, onHighlightClick, mode, flashingId }) {
  if (!highlights.length) return null;

  const interactive = mode === "select";

  return (
    <div className="pdf-highlight-layer" aria-hidden="true">
      {highlights.map((h) =>
        h.rects.map((rect, ri) => {
          // Build class list for Phase 4 states
          const classes = [
            "pdf-highlight",
            h.note          ? "pdf-highlight--noted" : "",
            h.aiExplanation ? "pdf-highlight--ai"    : "",
            h.aiLoading     ? "pdf-highlight--loading": "",
            flashingId === h.id ? "pdf-highlight--flash" : "",
          ].filter(Boolean).join(" ");

          return (
            <div
              key={`${h.id}-${ri}`}
              className={classes}
              style={{
                left:          rect.x,
                top:           rect.y,
                width:         rect.width,
                height:        rect.height,
                pointerEvents: interactive && ri === 0 ? "auto" : "none",
                cursor:        interactive && ri === 0 ? "pointer" : "default",
              }}
              onClick={interactive && ri === 0
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
// SelectionTooltip — unchanged from Phase 3
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
// PDFViewer — Phase 4 props: explainResult + onExplainResultConsumed
// ─────────────────────────────────────────────────────────────────────────────
export default function PDFViewer({
  file,
  onExplainRequest,
  explainLoading,
  explainResult,           // Phase 4: { text, answer } | null — from App
  onExplainResultConsumed, // Phase 4: () => void
}) {
  const [numPages, setNumPages]       = useState(null);
  const [loadError, setLoadError]     = useState(null);
  const [tooltipPos, setTooltipPos]   = useState(null);
  const [selectedText, setSelectedText] = useState("");

  // Phase 0
  const [mode, setMode] = useState("select");
  const [zoom, setZoom] = useState(1);

  // Phase 2
  const [highlights, setHighlights]   = useState([]);

  // Phase 3
  const [activeHighlight, setActiveHighlight] = useState(null);

  // Phase 4
  const [flashingId, setFlashingId]   = useState(null);
  const pendingExplainIdRef           = useRef(null); // tracks highlight awaiting AI
  const lastRangeRef                  = useRef(null); // stores selection range for Explain

  const containerRef  = useRef(null);
  const scrollAreaRef = useRef(null);

  // ── Mode change ────────────────────────────────────────────────────────────
  function handleModeChange(next) {
    setMode(next);
    setTooltipPos(null);
    setSelectedText("");
    setActiveHighlight(null);
    window.getSelection()?.removeAllRanges();
  }

  // ── Phase 3: highlight clicked → open popup ──────────────────────────────
  function handleHighlightClick(e, highlight) {
    if (activeHighlight?.id === highlight.id) return;
    setActiveHighlight({
      ...highlight,
      position: { x: e.clientX + 12, y: e.clientY + 12 },
    });
  }

  // ── Phase 3: save note ───────────────────────────────────────────────────
  function handleSaveNote(id, note) {
    setHighlights((prev) => prev.map((h) => h.id === id ? { ...h, note } : h));
    // Sync activeHighlight so popup re-renders with new note
    setActiveHighlight((prev) => prev?.id === id ? { ...prev, note } : prev);
  }

  // ── Phase 3: delete highlight ────────────────────────────────────────────
  function handleDeleteHighlight(id) {
    setHighlights((prev) => prev.filter((h) => h.id !== id));
    setActiveHighlight(null);
  }

  // ── Phase 4: create highlight and return its ID ──────────────────────────
  function createHighlightFromRange(range, text) {
    if (!scrollAreaRef.current) return null;

    const rawRects = Array.from(range.getClientRects());
    const rects = rawRects
      .filter((r) => r.width > 1 && r.height > 1)
      .map((r) => toScrollAreaCoords(r, scrollAreaRef.current));

    if (!rects.length) return null;

    const newId = uid();
    setHighlights((prev) => [
      ...prev,
      {
        id:            newId,
        text,
        rects,
        note:          "",
        aiExplanation: null, // Phase 4
        aiLoading:     false, // Phase 4
        createdAt:     new Date(),
      },
    ]);

    window.getSelection()?.removeAllRanges();
    return newId;
  }

  // ── Phase 4: "Re-explain" from AnnotationPopup ──────────────────────────
  function handleReExplain(highlight) {
    if (explainLoading) return;

    pendingExplainIdRef.current = highlight.id;

    setHighlights((prev) =>
      prev.map((h) =>
        h.id === highlight.id
          ? { ...h, aiLoading: true }
          : h
      )
    );

    // ✅ DO NOT CLOSE POPUP

    onExplainRequest(highlight.text);
  }

  // ── Phase 4: consume explainResult from App ──────────────────────────────

  // 🔥 Timeout safety (10s fallback)
  useEffect(() => {
    if (!pendingExplainIdRef.current) return;

    const timeout = setTimeout(() => {
      console.warn("Explain timeout — resetting loading state");

      setHighlights(prev => {
        if (!pendingExplainIdRef.current) return prev;

        return prev.map(h =>
          h.id === pendingExplainIdRef.current
            ? { ...h, aiLoading: false }
            : h
        );
      });

      pendingExplainIdRef.current = null;
    }, 10000); // 10 sec

    return () => clearTimeout(timeout);
  }, [highlights]);

  useEffect(() => {
    if (!explainResult) return;

    const { text, answer } = explainResult;

    // Guard: don't attach empty responses
    if (!answer || typeof answer !== "string" || answer.trim().length < 5) {
      setHighlights(prev =>
        prev.map(h =>
          h.id === pendingExplainIdRef.current
            ? { ...h, aiLoading: false }
            : h
        )
      );

      pendingExplainIdRef.current = null;
      onExplainResultConsumed?.();
      return;
    }

    const targetId = pendingExplainIdRef.current;

    setHighlights((prev) =>
      prev.map((h) => {
        // Primary match: exact ID (most accurate — handles duplicate text)
        if (targetId && h.id === targetId) {
          return { ...h, aiExplanation: answer, aiLoading: false };
        }
        // Fallback: first un-explained highlight with matching text
        if (!targetId && h.text === text && !h.aiExplanation) {
          return { ...h, aiExplanation: answer, aiLoading: false };
        }
        return h;
      })
    );

    // Flash and scroll to the updated highlight
    if (targetId) {
      setFlashingId(targetId);
      setTimeout(() => setFlashingId(null), 1400);
    }

    pendingExplainIdRef.current = null;
    onExplainResultConsumed?.();
  }, [explainResult]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Phase 4: scroll to flashing highlight ───────────────────────────────
  useEffect(() => {
    if (!flashingId || !scrollAreaRef.current) return;

    const target = highlights.find((h) => h.id === flashingId);
    if (target?.rects?.[0]) {
      scrollAreaRef.current.scrollTo({
        top:      Math.max(0, target.rects[0].y - 120),
        behavior: "smooth",
      });
    }
  }, [flashingId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Phase 4: keep activeHighlight in sync after state updates ───────────
  // (so the popup immediately reflects aiExplanation changes)
  useEffect(() => {
    if (!activeHighlight) return;

    setActiveHighlight(prev => {
      const updated = highlights.find(h => h.id === prev.id);
      if (!updated) return null;

      return {
        ...updated,
        position: prev.position
      };
    });
  }, [highlights]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Phase 2: capture highlight in highlight mode ─────────────────────────
  // (kept for highlight-mode mouseUp, same as Phase 3)
  function captureHighlightFromRange(range, text) {
    createHighlightFromRange(range, text);
  }

  // ── Unified mouseUp ──────────────────────────────────────────────────────
  const handleMouseUp = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0).cloneRange();
    const text  = selection.toString().trim();

    setTimeout(() => {
      if (mode === "annotate") return;
      if (!text || text.length < 5) {
        setTooltipPos(null);
        setSelectedText("");
        return;
      }
      if (!containerRef.current?.contains(range.commonAncestorContainer)) return;

      if (mode === "select") {
        const rect = range.getBoundingClientRect();
        setSelectedText(text);
        setTooltipPos({ x: rect.left + rect.width / 2, y: rect.top });
        lastRangeRef.current = range; // Phase 4: store for Explain
      } else if (mode === "highlight") {
        captureHighlightFromRange(range, text);
      }
    }, 10);
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Annotate click ────────────────────────────────────────────────────────
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
    const el = scrollAreaRef.current;
    if (!el) return;
    const handleScroll = () => setActiveHighlight(null);
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

  // ── Phase 4: Explain button clicked in select mode ───────────────────────
  function handleExplain() {
    if (!selectedText || explainLoading) return;

    // Find existing highlight with same text, or create a new one
    let existing = null;

    if (lastRangeRef.current && scrollAreaRef.current) {
      const rawRects = Array.from(lastRangeRef.current.getClientRects());

      const newRects = rawRects
        .filter(r => r.width > 1 && r.height > 1)
        .map(r => toScrollAreaCoords(r, scrollAreaRef.current));

      existing = highlights.find(h =>
        h.text === selectedText &&
        JSON.stringify(h.rects) === JSON.stringify(newRects)
      );
    }

    if (existing) {
      // Reuse existing highlight — just request a fresh explanation
      pendingExplainIdRef.current = existing.id;
      setHighlights((prev) =>
        prev.map((h) => h.id === existing.id ? { ...h, aiLoading: true } : h)
      );
    } else if (lastRangeRef.current) {
      // Create new highlight and link the pending explain to it
      const newId = createHighlightFromRange(lastRangeRef.current, selectedText);
      if (newId) {
        pendingExplainIdRef.current = newId;
        // Mark as loading immediately
        setHighlights((prev) =>
          prev.map((h) => h.id === newId ? { ...h, aiLoading: true } : h)
        );
      }
    }

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

        {/* Phase 2+3+4: highlight overlay */}
        <HighlightLayer
          highlights={highlights}
          onHighlightClick={handleHighlightClick}
          mode={mode}
          flashingId={flashingId}   // Phase 4
        />
      </div>

      {/* Phase 3+4: annotation popup */}
      {activeHighlight && (
        <AnnotationPopup
          highlight={activeHighlight}
          onSave={handleSaveNote}
          onDelete={handleDeleteHighlight}
          onClose={() => setActiveHighlight(null)}
          onReExplain={handleReExplain}   // Phase 4
          explainLoading={explainLoading} // Phase 4
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