# app/services/figure_refiner.py
"""
Phase 7.4.1 — Core Figure Refinement Engine (heuristic-only, no LLM).

Responsibilities:
  - Caption cleaning  (strip prefix, normalise whitespace, truncate)
  - Title generation  (first N words, title-cased, capped at 60 chars)
  - Quality scoring   (0–3 integer based on image size + caption richness)
  - Confidence score  (0.50–0.95 float based on combined heuristics)
  - Batch refinement  (async, processes the full figures list in one call)

This module is intentionally free of LLM calls.  Placeholder fields
(`type`, `description`, `importance`) are injected here so downstream
consumers always receive a stable schema — they will be filled by the
LLM enrichment layer in Phase 7.4.2.
"""

from __future__ import annotations

import math
import re
import textwrap
from typing import Any


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Regex that matches common figure-prefix patterns at the start of a string.
# Handles:  "Fig. 1.", "Fig. 1", "Fig.1", "Figure 2.", "Figure 2",
#           "FIG. 3", "FIG.3", "FIGURE 4."  — case-insensitive.
_CAPTION_PREFIX_RE = re.compile(
    r"^\s*fig(?:ure)?\.?\s*\d+[a-z]?\.?\s*",
    re.IGNORECASE,
)

# Minimum caption length (chars) to award a quality point.
_CAPTION_QUALITY_MIN_LEN: int = 30

# Image dimensions considered "reasonable" quality.
_IMG_MIN_WIDTH:  int = 400
_IMG_MIN_HEIGHT: int = 300

# Title word budget.
_TITLE_MIN_WORDS: int = 8
_TITLE_MAX_WORDS: int = 12
_TITLE_MAX_CHARS: int = 60

# Caption character cap after cleaning.
_CAPTION_MAX_CHARS: int = 200

# Confidence normalisation bounds.
_CONF_MIN: float = 0.50
_CONF_MAX: float = 0.95


# ---------------------------------------------------------------------------
# Helper — caption cleaning
# ---------------------------------------------------------------------------

def clean_caption(caption: str) -> str:
    """Remove figure prefix, collapse whitespace, and truncate to 200 chars.

    Args:
        caption: Raw caption string as returned by the figure extractor.

    Returns:
        A clean, human-readable caption string.

    Examples:
        >>> clean_caption("Fig. 1.\\nIllustration of two challenges...")
        'Illustration of two challenges...'
    """
    if not caption or caption.strip().lower() == "no caption":
        return "Figure without caption"

    # 1. Replace every whitespace sequence (\\n, \\t, multiple spaces) with a
    #    single space so the regex below operates on a flat string.
    text = re.sub(r"\s+", " ", caption).strip()

    # 2. Strip the leading "Fig. X" / "Figure X" prefix.
    text = _CAPTION_PREFIX_RE.sub("", text).strip()

    # 3. Remove a lone trailing/leading period left over from the prefix.
    text = text.lstrip(". ").strip()

    # 4. Truncate without cutting mid-word.
    if len(text) > _CAPTION_MAX_CHARS:
        text = textwrap.shorten(text, width=_CAPTION_MAX_CHARS, placeholder="…")

    return text


# ---------------------------------------------------------------------------
# Helper — title generation
# ---------------------------------------------------------------------------

def generate_title(clean_caption: str) -> str:
    """Derive a short title from the cleaned caption (no LLM).

    Strategy: take the first 8–12 words, title-case them, cap at 60 chars.

    Args:
        clean_caption: Output of :func:`clean_caption`.

    Returns:
        A title-cased string of at most ``_TITLE_MAX_CHARS`` characters.
        Returns an empty string when the input is empty.
    """
    if not clean_caption:
        return "Untitled Figure"

    words = clean_caption.split()
    # Prefer up to _TITLE_MAX_WORDS words, but use at least _TITLE_MIN_WORDS
    # when available.
    selected = words[:_TITLE_MAX_WORDS]
    title = " ".join(selected).rstrip(".,;:—")

    # Hard character cap — shorten word-boundary aware.
    if len(title) > _TITLE_MAX_CHARS:
        title = textwrap.shorten(title, width=_TITLE_MAX_CHARS, placeholder="")
        title = title.rstrip(".,;:—").strip()

    return title.title()


# ---------------------------------------------------------------------------
# Helper — quality score
# ---------------------------------------------------------------------------

def compute_quality(fig: dict[str, Any]) -> int:
    """Assign a discrete quality score in the range [0, 3].

    Scoring rubric:
      +1  image dimensions meet the minimum threshold
      +1  cleaned caption is at least 30 characters long
      +1  a non-empty, non-placeholder caption exists

    Args:
        fig: Partially refined figure dict; must contain ``width``,
             ``height``, ``caption``, and ``clean_caption`` keys.

    Returns:
        Integer in ``{0, 1, 2, 3}``.
    """
    score: int = 0

    width:  int = fig.get("width",  0) or 0
    height: int = fig.get("height", 0) or 0
    if width >= _IMG_MIN_WIDTH and height >= _IMG_MIN_HEIGHT:
        score += 1

    clean: str = fig.get("clean_caption", "")
    if len(clean) >= _CAPTION_QUALITY_MIN_LEN:
        score += 1

    raw: str = (fig.get("caption") or "").strip().lower()
    if raw and raw != "no caption":
        score += 1

    return score


# ---------------------------------------------------------------------------
# Helper — confidence score
# ---------------------------------------------------------------------------

def compute_confidence(fig: dict[str, Any]) -> float:
    """Estimate extraction confidence as a float in [0.50, 0.95].

    The heuristic combines two normalised signals:

    * **Caption signal** — sigmoid of caption-length bucket
      (empty → 0, very long → approaches 1).
    * **Size signal**    — sigmoid of pixel-area bucket
      (tiny → 0, large → approaches 1).

    Both signals are averaged and then linearly projected onto
    [``_CONF_MIN``, ``_CONF_MAX``].

    Args:
        fig: Partially refined figure dict; must contain ``width``,
             ``height``, and ``clean_caption`` keys.

    Returns:
        Float confidence value in ``[0.50, 0.95]``.
    """
    clean_caption: str = fig.get("clean_caption", "") or ""
    width:  int = fig.get("width",  0) or 0
    height: int = fig.get("height", 0) or 0

    # Caption signal: sigmoid centred at 80 chars, scale factor 0.04.
    # At  0 chars → ~0.02;  at 80 chars → 0.50;  at 200 chars → ~0.98
    cap_len = len(clean_caption)
    cap_signal: float = 1.0 / (1.0 + math.exp(-0.04 * (cap_len - 80)))

    # Size signal: sigmoid centred at 300k pixels, scale 5e-6.
    # At 80k px → ~0.22;  at 300k px → 0.50;  at 780k px → ~0.95
    pixel_area = width * height
    size_signal: float = 1.0 / (1.0 + math.exp(-5e-6 * (pixel_area - 300_000)))

    # Blend equally and project onto [_CONF_MIN, _CONF_MAX].
    raw_score: float = (cap_signal + size_signal) / 2.0
    confidence: float = _CONF_MIN + raw_score * (_CONF_MAX - _CONF_MIN)

    # Clamp for floating-point safety.
    return round(max(_CONF_MIN, min(_CONF_MAX, confidence)), 4)


# ---------------------------------------------------------------------------
# Core refinement — single figure
# ---------------------------------------------------------------------------

def _refine_one(fig: dict[str, Any]) -> dict[str, Any]:
    """Apply all refinement steps to a single raw figure dict.

    Args:
        fig: Raw figure as returned by the figure extractor.

    Returns:
        A new dict containing all original fields plus the refined ones.
        The original dict is never mutated.
    """
    raw_caption: str = fig.get("caption", "") or ""
    cleaned = clean_caption(raw_caption)

    # Build a working copy so scoring helpers can access clean_caption.
    working: dict[str, Any] = {**fig, "clean_caption": cleaned}

    return {
        # ── Identity ──────────────────────────────────────────────────────
        "id":            fig.get("id", ""),

        # ── Caption fields ────────────────────────────────────────────────
        "has_caption": bool(cleaned),
        "caption":       raw_caption,        # original, untouched
        "clean_caption": cleaned,
        "title":         generate_title(cleaned),

        # ── AI placeholders (Phase 7.4.2 will populate these via LLM) ────
        "type":          "unknown",
        "description":   "",
        "importance":    "unknown",

        # ── Scores ────────────────────────────────────────────────────────
        "quality_score": compute_quality(working),
        "confidence":    compute_confidence(working),

        # ── Spatial / source metadata ─────────────────────────────────────
        "page":          fig.get("page"),
        "image_url":     fig.get("image_url", ""),
        "bbox":          fig.get("bbox"),
        "width":         fig.get("width"),
        "height":        fig.get("height"),
    }


# ---------------------------------------------------------------------------
# Public class
# ---------------------------------------------------------------------------

class FigureRefiner:
    """Heuristic refinement pipeline for raw extracted figures.

    This class is intentionally stateless so it can be safely instantiated
    once at application startup and reused across requests.

    Usage::

        refiner = FigureRefiner()
        refined = await refiner.refine(raw_figures)
    """

    async def refine(self, figures: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Refine a batch of raw figures.

        Processes each figure through caption cleaning, title generation,
        quality scoring, and confidence estimation.  The operation is CPU-bound
        but kept async so it can be awaited inside FastAPI route handlers
        without blocking the event loop when the list is small (typical case).
        For very large batches consider offloading via ``asyncio.to_thread``.

        Args:
            figures: List of raw figure dicts from the figure extractor.

        Returns:
            List of refined figure dicts in the same order as the input.
            Returns an empty list when ``figures`` is empty.
        """
        if not figures:
            return []

        return [_refine_one(fig) for fig in figures]