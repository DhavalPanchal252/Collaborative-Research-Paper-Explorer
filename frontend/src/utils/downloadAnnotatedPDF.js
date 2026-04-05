// src/utils/downloadAnnotatedPDF.js
//
// Converts stored highlight rects (scroll-area / zoom-1 space) into
// pdf-lib rectangle draws on the correct PDF page, at the correct position.
//
// ─────────────────────────────────────────────────────────────────────────────
// COORDINATE SYSTEM — read this before touching the math
// ─────────────────────────────────────────────────────────────────────────────
//
// What toScrollAreaCoords stores (zoom-normalised scroll-area space):
//
//   storedX = cx + (rawX − cx) / zoom        cx = page centre in scroll area
//   storedY = py + (rawY − py) / zoom        py = 24 (top padding)
//   storedW = domWidth  / zoom
//   storedH = domHeight / zoom
//
// At zoom=1 the rendered page pixel width = baseWidth (baseWidthRef.current).
// react-pdf scales the page proportionally, so:
//   renderedPageHeight@zoom1 = pdfPageHeight × (baseWidth / pdfPageWidth)
//
// The page's left edge in scroll-area space at zoom=1:
//   pageLeftX = cx − baseWidth / 2
//
// So a rect's position relative to the page's top-left corner at zoom=1:
//   relX = storedX − pageLeftX  =  storedX − cx + baseWidth/2
//   relY = storedY − py          (py=24 is the padding above the first page;
//                                  for page N we subtract accumulated page heights)
//
// pdf-lib coordinate system: origin is BOTTOM-LEFT of the page.
//   scale = pdfPageWidth / baseWidth          (same for X and Y — uniform)
//   pdfX  = relX × scale
//   pdfY  = pdfPageHeight − (relY × scale) − (storedH × scale)
//
// ─────────────────────────────────────────────────────────────────────────────

import { PDFDocument, rgb } from "pdf-lib";

// Gap between pages in the scroll area (matches `.pdf-scroll-area { gap: 16px }`)
const PAGE_GAP = 16; // px
// Top padding of the scroll area (matches `.pdf-scroll-area { padding: 24px }`)
const TOP_PAD  = 24; // px

// Highlight colour variants (RGBA, opacity applied separately via pdf-lib)
const COLOR_DEFAULT = rgb(1.00, 0.84, 0.00); // warm yellow
const COLOR_NOTED   = rgb(1.00, 0.75, 0.00); // deeper amber
const COLOR_AI      = rgb(0.35, 0.74, 1.00); // AI blue
const COLOR_ERROR   = rgb(0.88, 0.36, 0.36); // red

const OPACITY_DEFAULT = 0.38;
const OPACITY_NOTED   = 0.42;
const OPACITY_AI      = 0.32;

/**
 * downloadAnnotatedPDF
 *
 * @param {File}    file       — the original PDF File object
 * @param {Array}   highlights — the highlights array from PDFViewer state
 * @param {number}  baseWidth  — baseWidthRef.current (rendered page width at zoom=1)
 * @param {number}  cx         — page centre X in scroll-area space (from getPageCenterX)
 * @param {Function} onProgress — optional (phase: "loading"|"drawing"|"saving") => void
 */
export async function downloadAnnotatedPDF(
  file,
  highlights,
  baseWidth,
  cx,
  onProgress
) {
  if (!file) throw new Error("No PDF file provided.");

  onProgress?.("loading");

  // ── 1. Load the original PDF ──────────────────────────────────────────────
  const arrayBuffer = await file.arrayBuffer();
  const pdfDoc      = await PDFDocument.load(arrayBuffer);
  const pages       = pdfDoc.getPages();
  const numPages    = pages.length;

  if (!highlights.length) {
    // No highlights — download original unchanged
    return _triggerDownload(await pdfDoc.save(), file.name);
  }

  onProgress?.("drawing");

  // ── 2. Build page height table ────────────────────────────────────────────
  //
  // For each pdf-lib page we know its PDF dimensions (points).
  // At zoom=1, react-pdf renders the page at pixel width = baseWidth.
  // Because react-pdf scales uniformly:
  //   renderedHeight[i] = pdfH[i] × (baseWidth / pdfW[i])
  //
  // The scroll-area Y coordinate of each page's TOP edge at zoom=1:
  //   pageTopY[0] = TOP_PAD
  //   pageTopY[i] = pageTopY[i-1] + renderedHeight[i-1] + PAGE_GAP
  //
  // This mirrors how the <Page> elements stack inside the flex column.

  const pdfDims       = pages.map((p) => p.getSize());  // { width, height } in PDF points
  const renderedH     = pdfDims.map((d) => d.height * (baseWidth / d.width));
  const pageTopY      = [];
  let   accumY        = TOP_PAD;
  for (let i = 0; i < numPages; i++) {
    pageTopY.push(accumY);
    accumY += renderedH[i] + PAGE_GAP;
  }

  // ── 3. Map each highlight rect → page + pdf coordinates ──────────────────

  for (const h of highlights) {
    const color   = h.aiExplanation ? COLOR_AI
                  : h.note          ? COLOR_NOTED
                  : h.aiError       ? COLOR_ERROR
                  :                   COLOR_DEFAULT;
    const opacity = h.aiExplanation ? OPACITY_AI
                  : h.note          ? OPACITY_NOTED
                  :                   OPACITY_DEFAULT;

    for (const rect of h.rects) {
      // Determine which page this rect's vertical centre falls on.
      // We use storedY (which is in scroll-area space at zoom=1).
      const rectMidY = rect.y + rect.height / 2;
      let   pageIdx  = numPages - 1; // default: last page

      for (let i = 0; i < numPages; i++) {
        const pageBottom = pageTopY[i] + renderedH[i];
        if (rectMidY <= pageBottom) { pageIdx = i; break; }
      }

      const page       = pages[pageIdx];
      const { width: pdfW, height: pdfH } = pdfDims[pageIdx];

      // Uniform scale: how many PDF points per rendered pixel
      const scale = pdfW / baseWidth;

      // Rect position relative to THIS PAGE's top-left corner (rendered px at zoom=1)
      const pageLeft = cx - baseWidth / 2;  // page left edge in scroll-area X space
      const relX     = rect.x - pageLeft;
      const relY     = rect.y - pageTopY[pageIdx]; // distance from page top in px

      // Convert to PDF points (bottom-left origin)
      const pdfX     = relX        * scale;
      const pdfRectH = rect.height * scale;
      const pdfY     = pdfH - (relY * scale) - pdfRectH; // flip Y axis
      const pdfRectW = rect.width  * scale;

      // Clamp to page bounds — handles tiny float overshoots at page edges
      const safeX = Math.max(0, Math.min(pdfX, pdfW - 1));
      const safeY = Math.max(0, Math.min(pdfY, pdfH - 1));
      const safeW = Math.max(1, Math.min(pdfRectW, pdfW - safeX));
      const safeH = Math.max(1, Math.min(pdfRectH, pdfH - safeY));

      page.drawRectangle({
        x:       safeX,
        y:       safeY,
        width:   safeW,
        height:  safeH,
        color,
        opacity,
      });

      // ── Draw note text above the first rect of each highlight ─────────────
      // Only on the first rect (ri=0) to avoid repeating the note per line.
      if (h.note && rect === h.rects[0]) {
        const noteY = safeY + safeH + 2; // 2pt above highlight top
        const clampedNoteY = Math.min(noteY, pdfH - 8);

        try {
          page.drawText(h.note.slice(0, 80), {  // truncate to keep it tidy
            x:    Math.max(0, safeX),
            y:    clampedNoteY,
            size: 7,
            color: rgb(0.15, 0.15, 0.15),
            maxWidth: pdfW - safeX - 4,
          });
        } catch (_) {
          // drawText can throw on exotic unicode — silently skip
        }
      }
    }
  }

  onProgress?.("saving");

  // ── 4. Serialize and trigger browser download ─────────────────────────────
  const pdfBytes = await pdfDoc.save();
  const stem     = file.name.replace(/\.pdf$/i, "");
  _triggerDownload(pdfBytes, `${stem}-annotated.pdf`);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _triggerDownload(pdfBytes, fileName) {
  const blob = new Blob([pdfBytes], { type: "application/pdf" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}