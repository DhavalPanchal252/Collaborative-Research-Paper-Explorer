// src/components/PDFToolbar.jsx
// Phase 5: Viewer Controls — fit-to-width, download, page navigation wired up.

// ── Tiny reusable button ──────────────────────────────────────────────────────
function ToolBtn({ label, icon, active, onClick, title }) {
  return (
    <button
      className={`pdf-tool-btn${active ? " pdf-tool-btn--active" : ""}`}
      onClick={onClick}
      title={title ?? label}
      aria-pressed={active}
    >
      {icon && <span className="pdf-tool-btn-icon">{icon}</span>}
      {label}
    </button>
  );
}

// ── Thin vertical divider between groups ─────────────────────────────────────
function Divider() {
  return <span className="pdf-toolbar-divider" />;
}

// ── PDFToolbar ────────────────────────────────────────────────────────────────
export default function PDFToolbar({
  mode,           // "select" | "highlight" | "annotate"
  onModeChange,   // (mode: string) => void
  zoom,           // number, e.g. 1 = 100%
  onZoomChange,   // (zoom: number) => void
  numPages,       // number | null
  currentPage,    // number — auto-tracked by scroll observer
  fileName,       // string
  onFitToWidth,   // () => void   — Phase 5
  onDownload,     // () => void   — Phase 5
  onScrollToPage, // (page: number) => void — Phase 5
}) {
  const zoomPct = Math.round((zoom ?? 1) * 100);

  function handleZoomIn() {
    const next = Math.min((zoom ?? 1) + 0.1, 3);
    onZoomChange?.(parseFloat(next.toFixed(2)));
  }

  function handleZoomOut() {
    const next = Math.max((zoom ?? 1) - 0.1, 0.5);
    onZoomChange?.(parseFloat(next.toFixed(2)));
  }

  function handleFit() {
    onFitToWidth?.();
  }

  function handleDownload() {
    onDownload?.();
  }

  // Clicking the page info area scrolls to that page (simple: click → same page, future: input)
  function handlePageClick() {
    if (currentPage) onScrollToPage?.(currentPage);
  }

  return (
    <div className="pdf-toolbar pdf-toolbar--v2">

      {/* ── LEFT: Mode buttons ── */}
      <div className="pdf-toolbar-group">
        <ToolBtn
          label="Highlight"
          icon="✦"
          active={mode === "highlight"}
          onClick={() => onModeChange("highlight")}
          title="Highlight mode — select text to highlight"
        />
        <ToolBtn
          label="Annotate"
          icon="✎"
          active={mode === "annotate"}
          onClick={() => onModeChange("annotate")}
          title="Annotate mode — click anywhere to drop a note"
        />
        <ToolBtn
          label="Select"
          icon="⌖"
          active={mode === "select"}
          onClick={() => onModeChange("select")}
          title="Select mode — select text to explain with AI"
        />
      </div>

      <Divider />

      {/* ── RIGHT: Viewer controls + page info ── */}
      <div className="pdf-toolbar-group pdf-toolbar-group--right">

        {/* Zoom controls */}
        <div className="pdf-zoom-group">
          <button
            className="pdf-zoom-btn"
            onClick={handleZoomOut}
            title="Zoom out (−10%)"
            aria-label="Zoom out"
            disabled={(zoom ?? 1) <= 0.5}
          >−</button>
          <span className="pdf-zoom-label">{zoomPct}%</span>
          <button
            className="pdf-zoom-btn"
            onClick={handleZoomIn}
            title="Zoom in (+10%)"
            aria-label="Zoom in"
            disabled={(zoom ?? 1) >= 3}
          >+</button>
        </div>

        <ToolBtn label="Fit"      icon="⛶"  onClick={handleFit}      title="Fit PDF to container width" />
        <ToolBtn label="Download" icon="↓"   onClick={handleDownload}  title="Download original PDF" />

        <Divider />

        {/* Page info — clicking scrolls to current page (hook for future page-jump input) */}
        <button
          className="pdf-page-info pdf-page-info--btn"
          onClick={handlePageClick}
          title="Click to scroll to this page"
          aria-label={`Page ${currentPage ?? 1} of ${numPages ?? "?"}`}
        >
          Page{" "}
          <span className="pdf-page-info-current">{currentPage ?? 1}</span>
          {" "}of{" "}
          <span className="pdf-page-info-total">{numPages ?? "—"}</span>
        </button>
      </div>

    </div>
  );
}