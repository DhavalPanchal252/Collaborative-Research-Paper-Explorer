// src/components/AnnotationLayer.jsx
// Phase 5 — Annotation marker layer (point-based notes)
//
// COORDINATE SYSTEM — mirrors HighlightLayer exactly:
//   renderX = cx + (storedX − cx) × z
//   renderY = py + (storedY − py) × z
//
// WHY scrollAreaRef instead of scrollAreaWidth:
//   getPageCenterX reads the actual page element's bounding rect to determine
//   cx.  This is immune to scrollbar-width drift, which makes clientWidth/2
//   wrong at high zoom on OS themes with visible scrollbars.  Using the same
//   helper that HighlightLayer and toScrollAreaCoords use keeps all three in
//   perfect sync — capture, highlight render, and annotation render all share
//   the same ground-truth cx regardless of zoom level or scrollbar state.

// ── getPageCenterX — inline copy so this component has no cross-file dep ────
function getPageCenterX(scrollAreaEl) {
  const pageEl = scrollAreaEl.querySelector(".pdf-page");
  if (!pageEl) return scrollAreaEl.clientWidth / 2;

  const areaRect = scrollAreaEl.getBoundingClientRect();
  const pageRect = pageEl.getBoundingClientRect();
  return pageRect.left - areaRect.left + scrollAreaEl.scrollLeft + pageRect.width / 2;
}

export default function AnnotationLayer({
  annotations,
  onMarkerClick,
  activeAnnotationId,
  zoom,
  scrollAreaRef,       // RefObject<HTMLElement> — replaces scrollAreaWidth
}) {
  if (!annotations.length) return null;

  const z  = zoom || 1;
  const el = scrollAreaRef?.current;

  // cx via getPageCenterX — immune to scrollbar drift, same as HighlightLayer
  const cx = el ? getPageCenterX(el) : 0;
  const py = 24; // matches `.pdf-scroll-area { padding: 24px }`

  return (
    <div className="pdf-annotation-layer" aria-hidden="true">
      {annotations.map((ann) => {
        // Same render formula as HighlightLayer:
        //   renderX = cx + (storedX − cx) × z
        //   renderY = py + (storedY − py) × z
        const renderX = Math.round(cx + (ann.x - cx) * z);
        const renderY = Math.round(py + (ann.y - py) * z);
        const isActive = activeAnnotationId === ann.id;

        return (
          <button
            key={ann.id}
            className={[
              "pdf-annotation-marker",
              isActive  ? "pdf-annotation-marker--active" : "",
              ann.note  ? "pdf-annotation-marker--noted"  : "",
            ].filter(Boolean).join(" ")}
            
            style={{ left: renderX, top: renderY }}
            onClick={(e) => { e.stopPropagation(); onMarkerClick(e, ann); }}
            title={ann.note ? ann.note : "Annotation (click to edit)"}
            aria-label="Annotation marker"
          >
            <span className="pdf-annotation-marker-pin">✎</span>
            {ann.note && (
              <span className="pdf-annotation-marker-dot" />
            )}
          </button>
        );
      })}
    </div>
  );
}