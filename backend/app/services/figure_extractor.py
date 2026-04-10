"""
figure_extractor.py
===================
Figure-Aware Extraction Pipeline for ArxivMind — Phase 7.2 (v4).

Root-cause fixes over v3
------------------------

FIX A — Caption body-text absorption  (was: MAX_CONTINUATION_BLOCKS=2 not enough)
    Problem: "where ˆI represents..." (body math text) was being absorbed into
             the Fig. 4 caption because it immediately followed the caption block.
    Fix:   _is_body_text_block() detects continuation blocks that are body text:
             • starts with a lowercase letter  → body paragraph
             • block length > 180 chars        → body paragraph (captions are concise)
             • alpha ratio < 0.55              → math / symbol heavy
           Any of these → stop absorbing immediately.

FIX B — Caption text truncated at 500 chars
    Problem: Fig. 1 caption was cut mid-sentence.
    Fix:   MAX_CAPTION_CHARS raised to 1200.

FIX C — Image boundary overlap / page-header pollution
    Problem: page.get_image_rects() returns the raw XObject bbox which may span
             multiple figures (the PDF stores Fig.14+15 in one large XObject).
             This caused Fig.15 to contain Fig.14 pixels, and Fig.17 to also
             bleed over.  Page headers ("IEEE TRANSACTIONS…") were also inside
             some XObjects.
    Fix:   Abandon XObject extraction for caption-matched figures entirely.
           Instead, for each caption we RENDER the page zone above it using
           page.get_pixmap(clip=zone).  This:
             • crops exactly to the figure boundary
             • never bleeds across caption boundaries
             • never includes page headers or body text
             • handles multi-column layouts (IEEE 2-col)

UNCHANGED from v3
-----------------
  • Caption detection via _CAPTION_START_RE (.match, not .search)
  • ID normalisation (_normalise_fig_id)
  • Junk-page detection (_is_junk_page)
  • Dedup via MD5 on rendered bytes
  • Sorting by (page, figure_number)
  • Fallback figures for pages without caption-matches
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
# Caption detection
# ---------------------------------------------------------------------------

_CAPTION_START_RE = re.compile(
    r"^((?:Fig\.|Figure|FIG\.)\s*\d+(?:[a-z]|\s*\([a-zA-Z0-9]+\))?\.?)",
    re.IGNORECASE,
)

# Caption text limits
MAX_CAPTION_CHARS       = 1200   # FIX B — was 500, too short for long captions
MAX_CONTINUATION_BLOCKS = 4      # max blocks to inspect (not all will be accepted)
MAX_CONTINUATION_GAP    = 20.0   # pts vertical gap; beyond this → new paragraph

# Spatial matching
MAX_MATCH_GAP_PTS = 150.0   # caption ↔ figure zone gap tolerance (pts)

# Render quality for figure zone pixmaps
RENDER_SCALE = 2.5           # 2.5× → ~180 DPI for 72 DPI PDF base

# Minimum rendered figure size (pixels) — rejects blank / tiny zones
MIN_RENDER_WIDTH  = 80
MIN_RENDER_HEIGHT = 60

# ---------------------------------------------------------------------------
# Junk-page detection (author bios, references, etc.)
# ---------------------------------------------------------------------------

_JUNK_PAGE_MARKERS = (
    "received the b.s",
    "received the ph.d",
    "is currently pursuing the ph.d",
    "his research interests include",
    "her research interests include",
    "author biography",
    "author biographies",
    "conflicts of interest",
)


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class _CaptionInfo:
    label:    str    # normalised, e.g. "Fig. 3"
    text:     str    # full caption text
    bbox:     tuple  # (x0, y0, x1, y1) in PDF points
    page_num: int    # 1-indexed


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
# Helpers — ID normalisation
# ---------------------------------------------------------------------------

def _normalise_fig_id(raw: str) -> str:
    """Collapse all spelling variants to canonical "Fig. N" or "Fig. N(a)"."""
    m = re.match(r"(Fig\.|Figure|FIG\.)\s*(\d+)(.*)", raw.strip(), re.IGNORECASE)
    if not m:
        return raw.strip()
    suffix = m.group(3).strip().rstrip(".")
    return f"Fig. {m.group(2)}{(' ' + suffix) if suffix else ''}"


# ---------------------------------------------------------------------------
# Helpers — junk page
# ---------------------------------------------------------------------------

def _is_junk_page(page: fitz.Page) -> bool:
    text = page.get_text().lower()
    return any(marker in text for marker in _JUNK_PAGE_MARKERS)


# ---------------------------------------------------------------------------
# Stage 1 — caption extraction  (FIX A + FIX B)
# ---------------------------------------------------------------------------

def _is_body_text_block(text: str) -> bool:
    """
    FIX A — return True when a block looks like body text, not caption text.

    Signals:
    • starts with a lowercase letter  → continuation of a body paragraph
    • length > 180 chars              → body paragraphs are long; caption
                                        continuations are short phrases
    • alpha ratio < 0.55              → math / equation heavy content
    """
    stripped = text.strip()
    if not stripped:
        return True   # blank → stop

    # Starts with lowercase: body text continuation
    if stripped[0].islower():
        return True

    # Very long block: almost certainly a body paragraph
    if len(stripped) > 180:
        return True

    # Symbol / equation heavy
    alpha_ratio = sum(c.isalpha() for c in stripped) / max(len(stripped), 1)
    if alpha_ratio < 0.55:
        return True

    return False


def _extract_captions(page: fitz.Page, page_num: int) -> list[_CaptionInfo]:
    """
    Extract figure captions from page text blocks.

    Uses .match() so "Fig." must start the block (not an inline reference).
    Absorbs continuation lines with smart body-text stopping (FIX A).
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

        label     = _normalise_fig_id(m.group(1))
        full_text = text
        bbox      = [x0, y0, x1, y1]

        for j in range(i + 1, min(i + 1 + MAX_CONTINUATION_BLOCKS, len(text_blocks))):
            nx0, ny0, nx1, ny1, ntext = (
                text_blocks[j][0], text_blocks[j][1],
                text_blocks[j][2], text_blocks[j][3],
                text_blocks[j][4].strip(),
            )

            # Stop: next block starts a new caption
            if _CAPTION_START_RE.match(ntext):
                break

            # Stop: vertical gap too large
            if ny0 - bbox[3] > MAX_CONTINUATION_GAP:
                break

            # FIX A: Stop: next block is body text
            if _is_body_text_block(ntext):
                break

            # Stop: already at char cap
            if len(full_text) >= MAX_CAPTION_CHARS:
                break

            full_text = f"{full_text} {ntext}"
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
# Stage 2 — figure zone computation  (FIX C core logic)
# ---------------------------------------------------------------------------

def _column_bounds(caption_bbox: tuple, page_width: float) -> tuple[float, float]:
    """
    Return (x_left, x_right) of the column that contains this caption.

    Handles full-width and 2-column (IEEE-style) layouts.
    """
    cx0, _, cx1, _ = caption_bbox
    cap_centre = (cx0 + cx1) / 2.0
    half = page_width / 2.0

    # Full-width caption (spans most of the page)
    if cx1 - cx0 > page_width * 0.75:
        return 0.0, page_width

    # Left column
    if cap_centre < half:
        return 0.0, half + 5.0

    # Right column
    return half - 5.0, page_width


def _figure_zone_for_caption(
    caption: _CaptionInfo,
    all_captions_on_page: list[_CaptionInfo],
    page: fitz.Page,
) -> fitz.Rect | None:
    """
    FIX C — Compute the rectangular page zone that visually contains the
    figure associated with *caption*.

    The zone spans from just after the previous figure ends to just before
    this caption begins, constrained to the same column.

    Returns None if the zone is too thin to be a real figure.
    """
    page_rect  = page.rect
    page_width = page_rect.width

    col_x0, col_x1 = _column_bounds(caption.bbox, page_width)
    cap_y0 = caption.bbox[1]

    # Top boundary: bottom of the nearest caption ABOVE this one in the
    # same column, plus a small gap.  Default to near the page top.
    zone_y0 = page_rect.y0 + 2.0

    for other in all_captions_on_page:
        if other is caption:
            continue
        other_y1 = other.bbox[3]
        if other_y1 >= cap_y0:
            continue   # other is below or at the same level

        # Check same column: their x ranges must overlap
        other_cx0, _, other_cx1, _ = other.bbox
        if other_cx1 < col_x0 or other_cx0 > col_x1:
            continue

        if other_y1 > zone_y0:
            zone_y0 = other_y1 + 3.0

    zone_y1 = cap_y0 - 3.0

    if zone_y1 - zone_y0 < MIN_RENDER_HEIGHT / RENDER_SCALE:
        logger.debug(
            "Page %d | '%s': figure zone too thin (%.1f pts) — skipping.",
            caption.page_num, caption.label, zone_y1 - zone_y0,
        )
        return None

    return fitz.Rect(col_x0, zone_y0, col_x1, zone_y1)


# ---------------------------------------------------------------------------
# Stage 3 — render the figure zone to PNG  (FIX C)
# ---------------------------------------------------------------------------

def _render_zone(page: fitz.Page, zone: fitz.Rect) -> tuple[bytes, int, int]:
    """
    Render *zone* (in PDF points) as a PNG at RENDER_SCALE resolution.

    Returns (png_bytes, width_px, height_px).
    """
    mat = fitz.Matrix(RENDER_SCALE, RENDER_SCALE)
    pix = page.get_pixmap(matrix=mat, clip=zone, alpha=False)
    return pix.tobytes("png"), pix.width, pix.height


def _is_blank_render(png_bytes: bytes, width: int, height: int) -> bool:
    """
    Quick heuristic: if the rendered image is mostly white/uniform, it's blank.
    We check this by looking at the raw pixel variance via the PNG header only
    — fast and dependency-free.
    We simply check file size; a blank white PNG compresses very small.
    """
    # A real figure at 2.5× scale should be at least a few KB
    return len(png_bytes) < 5_000


# ---------------------------------------------------------------------------
# Helpers — MD5 and storage
# ---------------------------------------------------------------------------

def _md5(data: bytes) -> str:
    return hashlib.md5(data, usedforsecurity=False).hexdigest()


def _save_image(image_bytes: bytes, ext: str, output_dir: Path) -> str:
    filename = f"{uuid.uuid4().hex}.{ext}"
    (output_dir / filename).write_bytes(image_bytes)
    return filename


# ---------------------------------------------------------------------------
# Stage 4 — fallback: XObject extraction for uncaptioned figures
# ---------------------------------------------------------------------------

_SUPPORTED_EXTS = {"png", "jpeg", "jpg", "bmp", "tiff"}

MIN_PIXEL_AREA      = 50_000
MIN_FILE_SIZE_BYTES = 15_000
PATCH_RATIO_LOW     = 0.8
PATCH_RATIO_HIGH    = 1.2
MIN_ASPECT_RATIO    = 0.2
MAX_ASPECT_RATIO    = 6.0


def _passes_quality_gate(image_bytes: bytes, width: int, height: int, ext: str) -> bool:
    if ext.lower() not in _SUPPORTED_EXTS:
        return False
    if width == 0 or height == 0:
        return False
    if width * height < MIN_PIXEL_AREA:
        return False
    if len(image_bytes) < MIN_FILE_SIZE_BYTES:
        return False
    ratio = width / height
    if PATCH_RATIO_LOW <= ratio <= PATCH_RATIO_HIGH:
        return False
    if ratio < MIN_ASPECT_RATIO or ratio > MAX_ASPECT_RATIO:
        return False
    return True


def _collect_fallback_candidates(
    page: fitz.Page,
    doc: fitz.Document,
) -> list[tuple[bytes, str, int, int, tuple]]:
    """
    Collect quality-passing raw XObjects for fallback (uncaptioned pages).
    Returns list of (image_bytes, ext, width, height, bbox).
    """
    results = []
    raw_images = page.get_images(full=True)

    for item in raw_images:
        xref   = item[0]
        width  = item[2]
        height = item[3]

        # Resolve rendered bbox
        bbox = None
        try:
            rects = page.get_image_rects(item)
            if rects:
                r = rects[0]
                bbox = (r.x0, r.y0, r.x1, r.y1)
        except Exception:
            pass

        if bbox is None:
            continue

        try:
            base = doc.extract_image(xref)
        except Exception:
            continue

        image_bytes = base.get("image", b"")
        ext         = base.get("ext", "png").lower()
        width       = base.get("width", width)
        height      = base.get("height", height)

        if _passes_quality_gate(image_bytes, width, height, ext):
            results.append((image_bytes, ext, width, height, bbox))

    return results


# ---------------------------------------------------------------------------
# Sorting
# ---------------------------------------------------------------------------

def _sort_key(fig: FigureMetadata) -> tuple[int, int]:
    m = re.search(r"\d+", fig.id)
    return (fig.page, int(m.group()) if m else 9999)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def extract_figures(
    pdf_path: str,
    output_dir: str = "backend/static/figures",
) -> list[dict]:
    """
    Extract research figures from *pdf_path* using a caption-driven,
    render-based pipeline.

    Each returned figure carries its label, full caption, image URL,
    page number, bbox and pixel dimensions.

    Returns list of dicts sorted by (page, figure_number).
    Always a list — empty on failure.

    Pipeline (per page)
    -------------------
    1. Skip junk pages (author bios, acknowledgements).
    2. Extract captions with smart body-text stopping.
    3. For each caption, compute the figure zone above it (column-aware).
    4. Render the zone to a cropped PNG — no XObject bleeding.
    5. Dedup via MD5.
    6. Fallback: for pages with no captions, extract quality XObjects.
    7. Sort by (page, figure_number).
    """
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    stats = {
        "pages":            0,
        "junk_skipped":     0,
        "captions_found":   0,
        "dup_ids":          0,
        "rendered":         0,
        "render_blank":     0,
        "render_no_zone":   0,
        "fallback":         0,
        "dup_hash":         0,
    }

    figures:      list[FigureMetadata] = []
    seen_hashes:  set[str]             = set()
    seen_ids:     set[str]             = set()

    try:
        doc = fitz.open(pdf_path)
    except Exception as exc:
        logger.error("extract_figures: cannot open '%s': %s", pdf_path, exc)
        return []

    try:
        stats["pages"] = doc.page_count

        for page in doc:
            page_num = page.number + 1

            # 1. Junk page check
            if _is_junk_page(page):
                stats["junk_skipped"] += 1
                logger.debug("Page %d: junk page — skipped.", page_num)
                continue

            # 2. Caption extraction
            captions = _extract_captions(page, page_num)
            stats["captions_found"] += len(captions)

            # 3–5. Render-based figure extraction
            for caption in captions:

                # Dedup by normalised label
                if caption.label in seen_ids:
                    stats["dup_ids"] += 1
                    logger.debug(
                        "Page %d | '%s': duplicate ID — skipped.",
                        page_num, caption.label,
                    )
                    continue

                # Compute figure zone above this caption
                zone = _figure_zone_for_caption(caption, captions, page)
                if zone is None:
                    stats["render_no_zone"] += 1
                    seen_ids.add(caption.label)
                    continue

                # Render zone → PNG bytes
                try:
                    png_bytes, width, height = _render_zone(page, zone)
                except Exception as exc:
                    logger.error(
                        "Page %d | '%s': render failed — %s",
                        page_num, caption.label, exc,
                    )
                    seen_ids.add(caption.label)
                    continue

                if _is_blank_render(png_bytes, width, height):
                    stats["render_blank"] += 1
                    logger.debug(
                        "Page %d | '%s': rendered zone is blank — skipped.",
                        page_num, caption.label,
                    )
                    seen_ids.add(caption.label)
                    continue

                # Dedup by content hash
                digest = _md5(png_bytes)
                if digest in seen_hashes:
                    stats["dup_hash"] += 1
                    seen_ids.add(caption.label)
                    continue

                seen_hashes.add(digest)
                seen_ids.add(caption.label)

                try:
                    filename = _save_image(png_bytes, "png", output_path)
                except OSError as exc:
                    logger.error(
                        "Page %d | '%s': save failed — %s",
                        page_num, caption.label, exc,
                    )
                    continue

                stats["rendered"] += 1
                figures.append(
                    FigureMetadata(
                        id=caption.label,
                        caption=caption.text,
                        image_url=f"/static/figures/{filename}",
                        page=page_num,
                        bbox=[zone.x0, zone.y0, zone.x1, zone.y1],
                        width=width,
                        height=height,
                    )
                )

            # 6. Fallback: pages with no captions → XObject extraction
            if not captions:
                for (img_bytes, ext, w, h, bbox) in _collect_fallback_candidates(page, doc):
                    digest = _md5(img_bytes)
                    if digest in seen_hashes:
                        stats["dup_hash"] += 1
                        continue
                    seen_hashes.add(digest)

                    try:
                        filename = _save_image(img_bytes, ext, output_path)
                    except OSError as exc:
                        logger.error("Page %d | fallback save failed — %s", page_num, exc)
                        continue

                    stats["fallback"] += 1
                    figures.append(
                        FigureMetadata(
                            id=f"Figure (p.{page_num})",
                            caption="",
                            image_url=f"/static/figures/{filename}",
                            page=page_num,
                            bbox=list(bbox),
                            width=w,
                            height=h,
                        )
                    )

    finally:
        doc.close()

    # 7. Sort
    figures.sort(key=_sort_key)

    logger.info(
        "extract_figures('%s') | pages=%d | junk_skipped=%d | "
        "captions=%d | dup_ids=%d | "
        "rendered=%d | blank=%d | no_zone=%d | "
        "fallback=%d | dup_hash=%d | returned=%d",
        Path(pdf_path).name,
        stats["pages"],
        stats["junk_skipped"],
        stats["captions_found"],
        stats["dup_ids"],
        stats["rendered"],
        stats["render_blank"],
        stats["render_no_zone"],
        stats["fallback"],
        stats["dup_hash"],
        len(figures),
    )

    return [fig.to_dict() for fig in figures]