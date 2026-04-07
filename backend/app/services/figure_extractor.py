"""
figure_extractor.py
===================
Figure-Aware Extraction Pipeline — v4 (Render-Based).

WHY v3 FAILED ON THIS PAPER
----------------------------
v3 extracted *embedded bitmap images* from the PDF's XObject stream.
Research papers routinely contain architecture diagrams, flowcharts and
plots drawn entirely in vector graphics — they have **zero embedded
bitmaps**.  v3 therefore returned nothing for those figures.

Additionally, composite figures (grids of sub-images like Fig. 1 or
Fig. 6 in the TUDA paper) are stored as many small bitmaps.  v3 picked
only the nearest one to the caption, losing the rest of the figure.

v4 APPROACH — Render, Don't Extract
-------------------------------------
Instead of mining PDF XObjects, v4 **renders each page region** that
corresponds to a figure using PyMuPDF's rasteriser.  A clipping
rectangle is computed from:
  • Caption position   → defines the BOTTOM of the figure region
  • Previous boundary → defines the TOP of the figure region
  • Caption width      → determines single- vs. double-column x-range

This gives us the exact pixels the reader sees — vector or raster,
simple or composite — with zero fragility to PDF internals.

LAYOUT HANDLING (IEEE two-column)
----------------------------------
Caption spans > 55 % of page width  →  double-column figure
Caption spans ≤ 55 % of page width  →  single-column figure
  left-column  if caption centre-x < 50 % of page width
  right-column otherwise

Each column tracks its own prev_boundary so adjacent figures in the
two columns are not confused.

BLANK-REGION FILTER
--------------------
A render that is nearly all white (e.g. pure text region between two
captions) is discarded by checking rendered PNG file size.  Real
figures with ink are significantly larger than blank white areas.

WHAT IS PRESERVED FROM v3
--------------------------
• Caption detection (regex anchored at block start)
• ID normalisation ("Fig.3" → "Fig. 3")
• Multi-line caption absorption with hard caps
• Junk-page detection (biography / references pages)
• MD5 deduplication
• Sort by (page, figure number)
"""

from __future__ import annotations

import hashlib
import logging
import re
import uuid
from dataclasses import dataclass
from pathlib import Path

import fitz  # PyMuPDF

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Rendered figure region filters
RENDER_ZOOM             = 2.0      # 2× zoom → decent resolution
MIN_RENDERED_PIXELS     = 40_000   # width × height of the rendered PNG
MIN_RENDERED_BYTES      = 8_000    # blank white PNGs are < 3 KB at 2×
MIN_FIGURE_HEIGHT_PTS   = 35.0     # ignore slivers < 35 PDF points tall
MIN_FIGURE_WIDTH_PTS    = 60.0     # ignore narrow strips

# Caption layout thresholds
DOUBLE_COL_THRESHOLD    = 0.55     # caption width / page width

# Caption detection
MAX_CAPTION_CHARS        = 600
MAX_CONTINUATION_BLOCKS  = 3
MAX_CONTINUATION_GAP_PTS = 22.0

# Spatial gap between caption top and figure bottom (render search radius)
MAX_UPWARD_SEARCH_PTS   = 350.0    # figure can be at most 350 pts above caption

_CAPTION_START_RE = re.compile(
    r"^((?:Fig\.|Figure|FIG\.)\s*\d+(?:[a-z]|\s*\([a-zA-Z0-9]+\))?\.?)",
    re.IGNORECASE,
)

_JUNK_PAGE_MARKERS = (
    "received the b.s",
    "received the ph.d",
    "is currently pursuing the ph.d",
    "his research interests include",
    "her research interests include",
    "author biography",
    "author biographies",
    "conflicts of interest",
    "acknowledgment\n",
    "acknowledgement\n",
)


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class _CaptionInfo:
    label:    str
    text:     str
    bbox:     tuple   # (x0, y0, x1, y1) PDF points
    page_num: int


@dataclass
class FigureMetadata:
    id:        str
    caption:   str
    image_url: str
    page:      int
    bbox:      list[float]
    width:     int
    height:    int

    def to_dict(self) -> dict:
        return {
            "id":        self.id,
            "caption":   self.caption,
            "image_url": self.image_url,
            "page":      self.page,
            "bbox":      self.bbox,
            "width":     self.width,
            "height":    self.height,
        }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _md5(data: bytes) -> str:
    return hashlib.md5(data, usedforsecurity=False).hexdigest()


def _normalise_fig_id(raw: str) -> str:
    """Collapse all Fig./Figure/FIG. variants to 'Fig. N [suffix]'."""
    m = re.match(r"(Fig\.|Figure|FIG\.)\s*(\d+)(.*)", raw.strip(), re.IGNORECASE)
    if not m:
        return raw.strip()
    suffix = m.group(3).strip().rstrip(".")
    return f"Fig. {m.group(2)}{(' ' + suffix) if suffix else ''}"


def _is_junk_page(page: fitz.Page) -> bool:
    text = page.get_text().lower()
    return any(marker in text for marker in _JUNK_PAGE_MARKERS)


# ---------------------------------------------------------------------------
# Stage 1 — caption extraction (unchanged from v3)
# ---------------------------------------------------------------------------

def _extract_captions(page: fitz.Page, page_num: int) -> list[_CaptionInfo]:
    """
    Extract figure captions.  Only text blocks whose first word is
    'Fig.' / 'Figure' are treated as captions; inline body mentions are
    ignored because they don't start a block.
    """
    blocks      = page.get_text("blocks")
    text_blocks = [b for b in blocks if len(b) > 6 and b[6] == 0]

    captions:     list[_CaptionInfo] = []
    skip_indices: set[int]           = set()

    for i, block in enumerate(text_blocks):
        if i in skip_indices:
            continue

        x0, y0, x1, y1, text = block[0], block[1], block[2], block[3], block[4]
        text = text.strip()

        m = _CAPTION_START_RE.match(text)
        if not m:
            continue

        raw_label = m.group(1)
        label     = _normalise_fig_id(raw_label)
        full_text = text
        bbox      = [x0, y0, x1, y1]

        for j in range(i + 1, min(i + 1 + MAX_CONTINUATION_BLOCKS, len(text_blocks))):
            nx0, ny0, nx1, ny1, next_text = (
                text_blocks[j][0], text_blocks[j][1],
                text_blocks[j][2], text_blocks[j][3],
                text_blocks[j][4].strip(),
            )

            if _CAPTION_START_RE.match(next_text):
                break
            if ny0 - bbox[3] > MAX_CONTINUATION_GAP_PTS:
                break
            if len(full_text) >= MAX_CAPTION_CHARS:
                break

            full_text = f"{full_text} {next_text}"
            bbox[2]   = max(bbox[2], nx1)
            bbox[3]   = ny1
            skip_indices.add(j)

        captions.append(
            _CaptionInfo(
                label=label,
                text=full_text[:MAX_CAPTION_CHARS],
                bbox=tuple(bbox),
                page_num=page_num,
            )
        )

    return captions


# ---------------------------------------------------------------------------
# Stage 2 — render figure region (CORE v4 LOGIC)
# ---------------------------------------------------------------------------

def _column_of(caption: _CaptionInfo, page_width: float) -> str:
    """
    Classify a caption into 'full', 'left', or 'right' column.
    """
    cap_width = caption.bbox[2] - caption.bbox[0]
    if cap_width > DOUBLE_COL_THRESHOLD * page_width:
        return "full"
    cap_cx = (caption.bbox[0] + caption.bbox[2]) / 2
    return "left" if cap_cx < page_width / 2 else "right"


def _render_figure_region(
    page:        fitz.Page,
    caption:     _CaptionInfo,
    prev_bottom: float,
    output_path: Path,
) -> tuple[str, int, int, list[float]] | None:
    """
    Render the PDF region above *caption* (between *prev_bottom* and
    caption.bbox[1]) and save it as a PNG.

    Returns
    -------
    (image_url, width_px, height_px, [x0,y0,x1,y1]) on success
    None on failure or when the region is blank / too small
    """
    page_rect  = page.rect
    page_w     = page_rect.width
    cap_bbox   = caption.bbox

    # --- X range (column-aware) -------------------------------------------
    column = _column_of(caption, page_w)
    if column == "full":
        render_x0 = 0.0
        render_x1 = page_w
    elif column == "left":
        render_x0 = 0.0
        render_x1 = page_w * 0.52       # left column + small overlap
    else:  # right
        render_x0 = page_w * 0.48       # right column
        render_x1 = page_w

    # --- Y range -----------------------------------------------------------
    render_y0 = max(0.0, prev_bottom + 1.0)
    render_y1 = cap_bbox[1] - 1.0      # just above caption top

    fig_height = render_y1 - render_y0
    fig_width  = render_x1 - render_x0

    if fig_height < MIN_FIGURE_HEIGHT_PTS or fig_width < MIN_FIGURE_WIDTH_PTS:
        logger.debug(
            "Page %d | '%s': render region too small (%.0f × %.0f pts) — skip",
            caption.page_num, caption.label, fig_width, fig_height,
        )
        return None

    # Clamp to page bounds
    clip = fitz.Rect(
        max(0.0, render_x0),
        max(0.0, render_y0),
        min(page_rect.width,  render_x1),
        min(page_rect.height, render_y1),
    )

    mat = fitz.Matrix(RENDER_ZOOM, RENDER_ZOOM)
    try:
        pix = page.get_pixmap(matrix=mat, clip=clip, colorspace=fitz.csRGB)
    except Exception as exc:
        logger.debug("Page %d | '%s': pixmap failed — %s", caption.page_num, caption.label, exc)
        return None

    # --- Quality checks on the render ------------------------------------
    if pix.width * pix.height < MIN_RENDERED_PIXELS:
        logger.debug(
            "Page %d | '%s': rendered too small (%d × %d px) — skip",
            caption.page_num, caption.label, pix.width, pix.height,
        )
        return None

    img_bytes = pix.tobytes("png")

    # Blank-whitespace filter: a nearly-white region compresses to < 8 KB
    if len(img_bytes) < MIN_RENDERED_BYTES:
        logger.debug(
            "Page %d | '%s': rendered region appears blank (%d B) — skip",
            caption.page_num, caption.label, len(img_bytes),
        )
        return None

    filename = f"{uuid.uuid4().hex}.png"
    try:
        (output_path / filename).write_bytes(img_bytes)
    except OSError as exc:
        logger.error("Page %d | '%s': save failed — %s", caption.page_num, caption.label, exc)
        return None

    return (
        f"/static/figures/{filename}",
        pix.width,
        pix.height,
        [clip.x0, clip.y0, clip.x1, clip.y1],
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def extract_figures(
    pdf_path: str,
    output_dir: str = "backend/static/figures",
) -> list[dict]:
    """
    Extract research figures from *pdf_path*.

    Uses a render-based approach: for each detected caption, the page
    region above it is rasterised.  This captures vector diagrams,
    composite grid figures, and bitmap images alike.

    Returns
    -------
    list[dict]
        Sorted by (page, figure number).  Empty on failure.
    """
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    # 🔥 CLEAN OLD IMAGES: delete previous extractions before saving new ones
    try:
        for old_file in output_path.glob("*"):
            if old_file.is_file():
                old_file.unlink()
                logger.debug("Removed old image: %s", old_file.name)
    except Exception as exc:
        logger.warning("Failed to clean old images in %s: %s", output_dir, exc)

    stats = {
        "pages":            0,
        "pages_skipped":    0,
        "captions_found":   0,
        "dup_ids_skipped":  0,
        "rendered":         0,
        "blank_skipped":    0,
        "dup_hash_skipped": 0,
        "returned":         0,
    }

    figures:      list[FigureMetadata] = []
    seen_hashes:  set[str]             = set()
    seen_fig_ids: set[str]             = set()

    try:
        doc = fitz.open(pdf_path)
    except Exception as exc:
        logger.error("extract_figures: cannot open '%s': %s", pdf_path, exc)
        return []

    try:
        stats["pages"] = doc.page_count

        for page in doc:
            page_num = page.number + 1

            if _is_junk_page(page):
                stats["pages_skipped"] += 1
                logger.debug("Page %d: junk page — skipping.", page_num)
                continue

            captions = _extract_captions(page, page_num)
            if not captions:
                continue

            stats["captions_found"] += len(captions)

            # Sort captions top-to-bottom (reading order)
            captions.sort(key=lambda c: c.bbox[1])

            page_w = page.rect.width

            # Per-column boundary tracking
            # 'full', 'left', 'right' each independently track
            # where the last rendered figure ended.
            prev_bottom: dict[str, float] = {
                "full":  0.0,
                "left":  0.0,
                "right": 0.0,
            }

            for caption in captions:

                # Dedup by figure ID
                if caption.label in seen_fig_ids:
                    stats["dup_ids_skipped"] += 1
                    logger.debug(
                        "Page %d | '%s': duplicate ID — skip.",
                        page_num, caption.label,
                    )
                    continue

                column = _column_of(caption, page_w)
                pb     = prev_bottom[column]

                result = _render_figure_region(page, caption, pb, output_path)

                if result is None:
                    # The region was blank or too small.
                    # Still advance the boundary so subsequent figures use
                    # the caption bottom as the new floor.
                    stats["blank_skipped"] += 1
                    prev_bottom[column] = caption.bbox[3]
                    seen_fig_ids.add(caption.label)
                    continue

                url, w, h, bbox = result
                img_bytes_for_hash = (output_path / Path(url).name).read_bytes()
                digest = _md5(img_bytes_for_hash)

                if digest in seen_hashes:
                    # Remove the just-saved duplicate
                    try:
                        (output_path / Path(url).name).unlink(missing_ok=True)
                    except OSError:
                        pass
                    stats["dup_hash_skipped"] += 1
                    prev_bottom[column] = caption.bbox[3]
                    seen_fig_ids.add(caption.label)
                    continue

                seen_hashes.add(digest)
                seen_fig_ids.add(caption.label)
                prev_bottom[column] = caption.bbox[3]
                stats["rendered"] += 1

                figures.append(
                    FigureMetadata(
                        id=caption.label,
                        caption=caption.text,
                        image_url=url,
                        page=page_num,
                        bbox=bbox,
                        width=w,
                        height=h,
                    )
                )

    finally:
        doc.close()

    # Sort by page then figure number
    def _sort_key(fig: FigureMetadata) -> tuple[int, int]:
        m = re.search(r"\d+", fig.id)
        return (fig.page, int(m.group()) if m else 9999)

    figures.sort(key=_sort_key)
    stats["returned"] = len(figures)

    logger.info(
        "extract_figures('%s') | pages=%d | junk_skipped=%d | "
        "captions=%d | dup_ids=%d | rendered=%d | blank=%d | "
        "dup_hash=%d | returned=%d",
        Path(pdf_path).name,
        stats["pages"],
        stats["pages_skipped"],
        stats["captions_found"],
        stats["dup_ids_skipped"],
        stats["rendered"],
        stats["blank_skipped"],
        stats["dup_hash_skipped"],
        stats["returned"],
    )

    return [fig.to_dict() for fig in figures]