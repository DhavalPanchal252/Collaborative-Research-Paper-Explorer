// src/components/PDFToolbar.jsx
// Phase 0: PDF Viewer Toolbar — UI + State Foundation
// Replaces the old [📄 name] [pages] [hint] header with a structured toolbar.

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
  mode,          // "select" | "highlight" | "annotate"
  onModeChange,  // (mode: string) => void
  zoom,          // number, e.g. 1 = 100%
  onZoomChange,  // (zoom: number) => void  — optional, kept for Phase 1
  numPages,      // number | null
  currentPage,   // number — static for now (prop for future scroll-tracking)
  fileName,      // string
}) {
  const zoomPct = Math.round((zoom ?? 1) * 100);

  function handleFit() {
    console.log("[PDFToolbar] Fit clicked");
  }

  function handleDownload() {
    console.log("[PDFToolbar] Download clicked");
  }

  function handleZoomIn() {
    const next = Math.min(zoom + 0.1, 3);
    onZoomChange?.(next);
    console.log("[PDFToolbar] Zoom →", Math.round(next * 100) + "%");
  }

  function handleZoomOut() {
    const next = Math.max(zoom - 0.1, 0.5);
    onZoomChange?.(next);
    console.log("[PDFToolbar] Zoom →", Math.round(next * 100) + "%");
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
          title="Highlight mode"
        />
        <ToolBtn
          label="Annotate"
          icon="✎"
          active={mode === "annotate"}
          onClick={() => onModeChange("annotate")}
          title="Annotate mode"
        />
        <ToolBtn
          label="Select"
          icon="⌖"
          active={mode === "select"}
          onClick={() => onModeChange("select")}
          title="Select mode"
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
            title="Zoom out"
            aria-label="Zoom out"
          >−</button>
          <span className="pdf-zoom-label">{zoomPct}%</span>
          <button
            className="pdf-zoom-btn"
            onClick={handleZoomIn}
            title="Zoom in"
            aria-label="Zoom in"
          >+</button>
        </div>

        <ToolBtn label="Fit"      icon="⛶" onClick={handleFit}      title="Fit to width" />
        <ToolBtn label="Download" icon="↓" onClick={handleDownload}  title="Download PDF" />

        <Divider />

        {/* Page info */}
        <span className="pdf-page-info">
          Page{" "}
          <span className="pdf-page-info-current">{currentPage ?? 1}</span>
          {" "}of{" "}
          <span className="pdf-page-info-total">{numPages ?? "—"}</span>
        </span>
      </div>

    </div>
  );
}