"""
figure_extractor.py
===================
Visual data pipeline for ArxivMind — Phase 7.2.

Extracts high-quality figures from research paper PDFs using PyMuPDF.
Built for extension in:
  - Phase 7.3  (frontend integration)
  - Phase 7.5  (AI explanation)
  - Phase 7.6  (caption detection)

Design principles
-----------------
* Extraction  — raw images pulled via PyMuPDF's xref system.
* Filtering   — size, file-weight, and aspect-ratio gates remove noise.
* Dedup       — MD5 hashing eliminates repeated logos / watermarks.
* Storage     — UUID filenames; deterministic output_dir layout.
* Logging     — structured counters at every filter stage for observability.
"""

from __future__ import annotations

import hashlib
import logging
import uuid
from pathlib import Path
from typing import TypedDict

import fitz  # PyMuPDF

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Quality-filter thresholds — adjust here; never scatter magic numbers in code
# ---------------------------------------------------------------------------

MIN_PIXEL_AREA      = 15_000   # width × height; removes icons / thumbnails
MIN_FILE_SIZE_BYTES = 8_000    # raw image bytes; removes low-quality artefacts
MIN_ASPECT_RATIO    = 0.3      # width / height; removes extreme slivers
MAX_ASPECT_RATIO    = 5.0      # width / height; removes horizontal banners

# Supported image extensions that PyMuPDF can return
_SUPPORTED_EXTS = {"png", "jpeg", "jpg", "bmp", "tiff"}


# ---------------------------------------------------------------------------
# Public type
# ---------------------------------------------------------------------------

class FigureMetadata(TypedDict):
    id:     str    # filename  (e.g. "3f2a…uuid….png")
    image:  str    # URL path  (e.g. "/static/figures/3f2a…uuid….png")
    page:   int    # 1-indexed page number
    width:  int    # pixels
    height: int    # pixels


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _md5(data: bytes) -> str:
    return hashlib.md5(data, usedforsecurity=False).hexdigest()


def _passes_quality_gate(
    image_bytes: bytes,
    width: int,
    height: int,
    ext: str,
) -> tuple[bool, str]:
    """
    Run all quality checks and return (passes, reason_if_rejected).
    Keeps filter logic in one place for easy future tuning.
    """
    if ext.lower() not in _SUPPORTED_EXTS:
        return False, f"unsupported extension '{ext}'"

    if width * height < MIN_PIXEL_AREA:
        return False, f"pixel area too small ({width}×{height}={width * height})"

    if len(image_bytes) < MIN_FILE_SIZE_BYTES:
        return False, f"file size too small ({len(image_bytes)} bytes)"

    if height == 0:
        return False, "zero-height image"

    ratio = width / height
    if ratio < MIN_ASPECT_RATIO or ratio > MAX_ASPECT_RATIO:
        return False, f"aspect ratio out of range ({ratio:.2f})"

    return True, ""


def _save_image(image_bytes: bytes, ext: str, output_dir: Path) -> str:
    """
    Persist image bytes to output_dir with a UUID filename.
    Returns the filename (stem + ext).
    """
    filename = f"{uuid.uuid4().hex}.{ext}"
    dest = output_dir / filename
    dest.write_bytes(image_bytes)
    return filename


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def extract_figures(
    pdf_path: str,
    output_dir: str = "static/figures",
) -> list[FigureMetadata]:
    """
    Extract and filter high-quality figures from a research-paper PDF.

    Parameters
    ----------
    pdf_path:
        Absolute or relative path to the source PDF file.
    output_dir:
        Directory where extracted images are saved.
        Created automatically if it does not exist.

    Returns
    -------
    list[FigureMetadata]
        Filtered, deduplicated figures — each with id, image URL,
        page number, width, and height.  Empty list on failure or
        when no quality figures are found.

    Raises
    ------
    Does NOT raise — all errors are caught and logged so the calling
    route can always return a valid (possibly empty) response.
    """
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    # Counters for structured logging at the end
    stats = {
        "total_raw":       0,
        "filtered_quality": 0,
        "filtered_dupe":   0,
        "saved":           0,
    }

    figures:    list[FigureMetadata] = []
    seen_hashes: set[str]            = set()

    try:
        doc = fitz.open(pdf_path)
    except Exception as exc:
        logger.error("extract_figures: cannot open PDF '%s': %s", pdf_path, exc)
        return []

    try:
        for page_index, page in enumerate(doc, start=1):
            raw_images = page.get_images(full=True)

            for img_info in raw_images:
                xref = img_info[0]
                stats["total_raw"] += 1

                # ── Extract raw image data ──────────────────────────────────
                try:
                    base_image = doc.extract_image(xref)
                except Exception as exc:
                    logger.debug(
                        "Page %d | xref %d: extraction failed — %s",
                        page_index, xref, exc,
                    )
                    continue

                image_bytes: bytes = base_image["image"]
                ext: str           = base_image.get("ext", "png").lower()
                width: int         = base_image.get("width", 0)
                height: int        = base_image.get("height", 0)

                # ── Quality gate ────────────────────────────────────────────
                passes, reason = _passes_quality_gate(image_bytes, width, height, ext)
                if not passes:
                    stats["filtered_quality"] += 1
                    logger.debug(
                        "Page %d | xref %d: rejected — %s",
                        page_index, xref, reason,
                    )
                    continue

                # ── Duplicate check ─────────────────────────────────────────
                digest = _md5(image_bytes)
                if digest in seen_hashes:
                    stats["filtered_dupe"] += 1
                    logger.debug(
                        "Page %d | xref %d: duplicate (md5=%s)", page_index, xref, digest
                    )
                    continue
                seen_hashes.add(digest)

                # ── Persist ──────────────────────────────────────────────────
                try:
                    filename = _save_image(image_bytes, ext, output_path)
                except OSError as exc:
                    logger.error(
                        "Page %d | xref %d: failed to save image — %s",
                        page_index, xref, exc,
                    )
                    continue

                stats["saved"] += 1
                figures.append(
                    FigureMetadata(
                        id=filename,
                        image=f"/static/figures/{filename}",
                        page=page_index,
                        width=width,
                        height=height,
                    )
                )

    finally:
        doc.close()

    logger.info(
        "extract_figures('%s') — raw=%d | quality_filtered=%d | "
        "dupes_removed=%d | saved=%d",
        Path(pdf_path).name,
        stats["total_raw"],
        stats["filtered_quality"],
        stats["filtered_dupe"],
        stats["saved"],
    )

    return figures