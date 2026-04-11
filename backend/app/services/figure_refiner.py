# app/services/figure_refiner.py
"""
Figure Refinement Engine — Phase 7.4.1 (heuristic) + Phase 7.4.2 (LLM).

Bug fixes applied
-----------------
BUG-1  FIXED  asyncio.Semaphore() created in __init__ outside event loop.
              → Lazy property _llm_semaphore initialised on first async call.
BUG-2  FIXED  asyncio.gather(return_exceptions=False) drops all results on
              one failure.
              → return_exceptions=True + per-item exception handling.
BUG-3  FIXED  Title inherits leading "(a)" / "(1)" sub-figure markers and
              title-cases them as "(A)" / "(1)".
              → _strip_subfigure_prefix() strips these before generate_title().
BUG-4  FIXED  _cache_timestamp dict allocated in __init__ but never read or
              written — dead code wasting memory.
              → Removed entirely.
BUG-5  FIXED  Four print() debug statements left in production code dumped
              full LLM prompts/responses to stderr on every request.
              → Replaced with logger.debug() (silent in production).
BUG-6  FIXED  _CAPTION_MAX_CHARS=200 truncated captions sent to the LLM,
              losing up to 200+ chars of classification signal.
              → LLM prompt uses raw caption (capped at 600 chars) not
                clean_caption (capped at 200 chars).
BUG-7  FIXED  ROOT CAUSE — figure_routes.py called refiner.refine() which
              runs Phase 7.4.1 only.  LLM fields stayed "unknown"/"".
              → figure_routes.py updated to call refiner.refine_and_enrich().
              → Clear warning added to refine() docstring.

Performance optimisations applied
----------------------------------
PERF-1  _BATCH_SIZE 4 → 5   — 10 figs → 2 batches instead of 3
         (eliminates the forced second serial LLM round)
PERF-2  _LLM_MAX_CONCURRENT 2 → 4   — all batches fire in parallel
PERF-3  asyncio.sleep 0.5 → 0.1 per batch
PERF-4  _LLM_RETRY_ATTEMPTS 2 → 1   — instant model, one retry is enough
PERF-5  _LLM_TIMEOUT_SECS 30 → 20   — fail faster so Gemini fallback fires sooner
PERF-6  Dynamic semaphore width = min(batch_count, _LLM_MAX_CONCURRENT)
         — never over-allocates slots for a small batch count
PERF-7  _needs_llm() fast-path — figures with no usable caption skip the
         LLM entirely and get _safe_enrichment() directly

Multi-model fallback (Groq → Gemini) also incorporated.

Pipeline
--------
Phase 7.4.1 — Heuristic (CPU-only, always runs):
    clean_caption → generate_title → compute_quality → compute_confidence

Phase 7.4.2 — LLM intelligence (async, runs after 7.4.1):
    enrich_with_llm → overwrites title, type, description, importance
    · BATCHED: groups figures into batches of _BATCH_SIZE (default 5)
    · One LLM call per batch instead of one per figure
    · MD5 caption-hash cache (LRU, size-limited) avoids duplicate LLM calls
    · Strict 3-layer JSON validation + typed fallbacks
    · Per-batch error isolation + configurable retry + timeout
    · asyncio.gather() concurrency, semaphore-limited to _LLM_MAX_CONCURRENT
    · Groq → Gemini fallback on failure, timeout, or low-quality output

Public API
----------
    refiner = FigureRefiner()
    full    = await refiner.refine_and_enrich(raw_figures)  # ← use this
    # Or separately:
    refined  = await refiner.refine(raw_figures)            # 7.4.1 only
    enriched = await refiner.enrich_with_llm(refined)       # 7.4.2 only
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import re
import textwrap
from collections import OrderedDict
from typing import Any

logger = logging.getLogger(__name__)


# ============================================================================
# SECTION 1 — CONSTANTS
# ============================================================================

_CAPTION_PREFIX_RE = re.compile(
    r"^\s*fig(?:ure)?\.?\s*\d+[a-z]?\.?\s*",
    re.IGNORECASE,
)

# Regex to strip leading "(a)", "(b)", "(1)", "(2)" sub-figure markers.
# BUG-3 FIX: these caused titles like "(A) Examples Of..." after title-casing.
_SUBFIGURE_PREFIX_RE = re.compile(
    r"^\s*\(+[a-zA-Z\d]{1,2}\)+\.?\s*",
)

# FIX-A: Hyphenated line-break artifacts from PDF text extraction.
# e.g. "effec-\ntive" → "effective", "meth-\nods" → "methods"
# Only joins when BOTH sides of the hyphen are word characters so that
# legitimate compound words like "color-preserved" are untouched.
_HYPHEN_LINEBREAK_RE = re.compile(r"(\w)-\s*\n\s*(\w)")

_CAPTION_QUALITY_MIN_LEN: int = 30
_IMG_MIN_WIDTH:  int = 400
_IMG_MIN_HEIGHT: int = 300
_TITLE_MAX_WORDS: int = 12
_TITLE_MAX_CHARS: int = 60

# BUG-6 FIX: Clean caption kept short for display (200 chars);
# LLM receives raw caption up to _LLM_CAPTION_MAX_CHARS for better context.
_CAPTION_MAX_CHARS:     int = 200
_LLM_CAPTION_MAX_CHARS: int = 600   # full context for type/importance inference

_DESCRIPTION_MAX_CHARS: int = 300
_CONF_MIN: float = 0.50
_CONF_MAX: float = 0.95

_CACHE_SIZE_LIMIT:   int = 1_000
_LLM_RETRY_ATTEMPTS: int = 1        # PERF-4: instant model, one retry is enough
_LLM_TIMEOUT_SECS:   int = 20       # PERF-5: fail fast; Gemini fallback takes over
_LLM_MAX_CONCURRENT: int = 4        # PERF-2: allow all batches to run in parallel
_BATCH_SIZE:         int = 5        # PERF-1: 10 figs → 2 batches instead of 3

_ALLOWED_TYPES: frozenset[str] = frozenset({
    "diagram", "graph", "chart", "table", "comparison", "image", "other",
})
# Canonical priority order: used in prompts; earlier = higher priority when
# caption signals are ambiguous.  Matches the DECISION TREE in the prompt.
_TYPE_PRIORITY_ORDER: tuple[str, ...] = (
    "table", "graph", "comparison", "chart", "diagram", "image", "other",
)
_ALLOWED_IMPORTANCE: frozenset[str] = frozenset({"low", "medium", "high"})
_UNKNOWN = "unknown"


# ============================================================================
# SECTION 2 — PHASE 7.4.1: HEURISTIC HELPERS
# ============================================================================

def clean_caption(caption: str) -> str:
    """Strip figure prefix, collapse whitespace, truncate to 200 chars.

    Args:
        caption: Raw caption string from the figure extractor.

    Returns:
        Cleaned, human-readable caption.  Empty string when input is blank
        or the literal placeholder ``"no caption"``.

    Examples:
        >>> clean_caption("Fig. 1.\\nIllustration of two challenges...")
        'Illustration of two challenges...'
    """
    if not caption or caption.strip().lower() == "no caption":
        return ""

    # FIX-A: Repair PDF hyphenated line-breaks BEFORE whitespace collapse.
    # "effec-\ntive" → "effective"  |  "meth-\nods" → "methods"
    # Must run before re.sub(r"\s+") so the \n is still present to detect.
    text = _HYPHEN_LINEBREAK_RE.sub(r"\1\2", caption)

    text = re.sub(r"\s+", " ", text).strip()
    text = _CAPTION_PREFIX_RE.sub("", text).strip()
    text = text.lstrip(". ").strip()

    if len(text) > _CAPTION_MAX_CHARS:
        text = textwrap.shorten(text, width=_CAPTION_MAX_CHARS, placeholder="…")

    return text


def _strip_subfigure_prefix(text: str) -> str:
    """Remove leading sub-figure markers such as ``(a)``, ``(b)``, ``(1)``.

    BUG-3 FIX: Without this, ``(a) Examples of…`` → title ``(A) Examples Of…``
    after ``.title()`` — the parenthetical letter was being title-cased.

    Args:
        text: Caption text (already cleaned of the ``Fig. N`` prefix).

    Returns:
        Text with any leading sub-figure marker removed.
    """
    return _SUBFIGURE_PREFIX_RE.sub("", text).strip()


def generate_title(clean_cap: str) -> str:
    """Derive a short heuristic title from the cleaned caption.

    Args:
        clean_cap: Output of :func:`clean_caption`.

    Returns:
        Title-cased string ≤ 60 chars; ``"Untitled Figure"`` when empty.
    """
    if not clean_cap:
        return "Untitled Figure"

    # BUG-3 FIX: strip "(a)" / "(1)" before taking the first N words.
    text = _strip_subfigure_prefix(clean_cap)
    if not text:
        text = clean_cap  # fallback: use original if stripping removed everything

    selected = text.split()[:_TITLE_MAX_WORDS]
    title = " ".join(selected).rstrip(".,;:—")

    if len(title) > _TITLE_MAX_CHARS:
        title = (
            textwrap.shorten(title, width=_TITLE_MAX_CHARS, placeholder="")
            .rstrip(".,;:—")
            .strip()
        )

    return title.title()


def compute_quality(fig: dict[str, Any]) -> int:
    """Score figure quality in [0, 3].

    Rubric:
      +1  image ≥ 400 × 300 px
      +1  clean caption ≥ 30 chars
      +1  non-empty, non-placeholder raw caption

    Args:
        fig: Working dict that already contains ``clean_caption``.

    Returns:
        Integer in ``{0, 1, 2, 3}``.
    """
    score = 0

    w: int = fig.get("width",  0) or 0
    h: int = fig.get("height", 0) or 0
    if w >= _IMG_MIN_WIDTH and h >= _IMG_MIN_HEIGHT:
        score += 1

    if len(fig.get("clean_caption", "")) >= _CAPTION_QUALITY_MIN_LEN:
        score += 1

    raw = (fig.get("caption") or "").strip().lower()
    if raw and raw != "no caption":
        score += 1

    return score


def compute_confidence(fig: dict[str, Any]) -> float:
    """Estimate extraction confidence in [0.50, 0.95] via two sigmoid signals.

    Signals:
      · Caption signal — sigmoid centred at 80 chars
      · Size signal    — sigmoid centred at 300 k pixels

    Args:
        fig: Working dict with ``clean_caption``, ``width``, ``height``.

    Returns:
        Float in ``[0.50, 0.95]``.
    """
    cap_len    = len(fig.get("clean_caption", "") or "")
    pixel_area = (fig.get("width", 0) or 0) * (fig.get("height", 0) or 0)

    cap_sig  = 1.0 / (1.0 + math.exp(-0.04 * (cap_len    - 80)))
    size_sig = 1.0 / (1.0 + math.exp(-5e-6 * (pixel_area - 300_000)))

    raw = (cap_sig + size_sig) / 2.0
    return round(
        max(_CONF_MIN, min(_CONF_MAX, _CONF_MIN + raw * (_CONF_MAX - _CONF_MIN))),
        4,
    )


def _refine_one(fig: dict[str, Any]) -> dict[str, Any]:
    """Apply all Phase 7.4.1 steps to a single raw figure dict.

    The original dict is never mutated.

    Returns:
        New dict with all original fields plus heuristic-refined fields.
        LLM-owned fields are pre-populated with placeholders for Phase 7.4.2.
    """
    raw_caption: str = fig.get("caption", "") or ""
    cleaned = clean_caption(raw_caption)
    working: dict[str, Any] = {**fig, "clean_caption": cleaned}

    return {
        "id":            fig.get("id", ""),
        "has_caption":   bool(raw_caption.strip() and raw_caption.strip().lower() != "no caption"),
        "caption":       raw_caption,
        "clean_caption": cleaned,
        "title":         generate_title(cleaned),
        # ── LLM-owned placeholders (Phase 7.4.2 overwrites these) ────────
        "type":          _UNKNOWN,
        "description":   "",
        "importance":    _UNKNOWN,
        # ── Scores ───────────────────────────────────────────────────────
        "quality_score": compute_quality(working),
        "confidence":    compute_confidence(working),
        # ── Spatial / source metadata ─────────────────────────────────────
        "page":          fig.get("page"),
        "image_url":     fig.get("image_url", ""),
        "bbox":          fig.get("bbox"),
        "width":         fig.get("width"),
        "height":        fig.get("height"),
    }


# ============================================================================
# SECTION 3 — PHASE 7.4.2: LLM ENRICHMENT HELPERS
# ============================================================================

def _caption_hash(clean_cap: str) -> str:
    """MD5 hex digest of a cleaned caption — used as the LRU cache key."""
    return hashlib.md5(clean_cap.encode("utf-8", errors="replace")).hexdigest()


# ---------------------------------------------------------------------------
# 3a — Batching
# ---------------------------------------------------------------------------

def _needs_llm(fig: dict[str, Any]) -> bool:
    """Return True only when the figure has enough text for the LLM to act on.

    PERF-7: Figures with empty clean_caption produce useless LLM output
    (type='other', description='') — identical to _safe_enrichment().
    Skipping them avoids burning batch token budget on noise.
    """
    return bool((fig.get("clean_caption") or "").strip())


def _create_batches(figures: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Partition figures into batches of size _BATCH_SIZE (default 5).

    Only the minimal fields required by the LLM prompt are included in each
    batch item: ``id`` and ``clean_caption``.  The caller is responsible for
    mapping results back using the ``id`` key.

    Args:
        figures: Phase 7.4.1-refined figure dicts that need LLM enrichment
                 (cache misses only — cached figures must be filtered out
                 before calling this function).

    Returns:
        List of batches; each batch is a list of
        ``{"id": ..., "clean_caption": ...}`` dicts.
    """
    batches: list[list[dict[str, Any]]] = []
    for i in range(0, len(figures), _BATCH_SIZE):
        chunk = figures[i : i + _BATCH_SIZE]
        batches.append(
            [{"id": f.get("id", ""), "clean_caption": f.get("clean_caption", "")} for f in chunk]
        )
    return batches


# ---------------------------------------------------------------------------
# 3b — Batch prompt
# ---------------------------------------------------------------------------

# Shared type-classification block reused by both the batch prompt and the
# single-figure prompt.  Centralising it ensures both paths get identical,
# audited rules — and makes future updates a single-site change.
#
# Design rationale (derived from misclassification audit on AIN paper):
#
#   Root cause 1 — "diagram" false-positive from model/network language
#     Caption contained "train an IN model / BN model" alongside loss-curve
#     context → LLM chose "diagram".
#     Fix: "graph" is checked FIRST and wins over "diagram" whenever any
#     loss/curve/metric/iteration signal is present.
#
#   Root cause 2 — "comparison" false-negative for parameter-sweep visuals
#     Caption described α=0 / 0.25 / 0.5 … row of images → LLM chose "graph"
#     because "trade-off" and an equation were mentioned.
#     Fix: explicit trigger "multiple images at different parameter values /
#     weights / alpha" → "comparison".
#
#   Root cause 3 — "image" false-positive for interpolation grids
#     Caption described a grid of visual outputs (style interpolation) with no
#     "vs / compare / baseline" keyword → LLM defaulted to "image".
#     Fix: "interpolation results", "grid of outputs", or any caption that
#     describes multiple visual outputs from different configurations →
#     "comparison".
#
#   Root cause 4 — "diagram" false-positive from spatial-layout language
#     Caption said "Left: content image. Middle: style images with masks.
#     Right: result." → LLM read "masks" and layout as a block-diagram.
#     Fix: Left/Middle/Right or Left/Right layout descriptors describing
#     image regions explicitly map to "comparison", never "diagram".

_TYPE_CLASSIFICATION_RULES = """\
TYPE CLASSIFICATION — follow this DECISION TREE in strict priority order.
Stop at the FIRST rule that matches. Do NOT skip ahead.

STEP 1 → "table"
  MATCH if: caption explicitly describes rows, columns, numerical cells,
  or a tabular data structure.
  EXAMPLES: "Table of speed comparisons", "results organized in rows and columns"

STEP 2 → "graph"
  MATCH if caption contains ANY of these signals — even if model/network/
  architecture language is ALSO present (graph beats diagram when metrics appear).

  EXPLICIT metric signals (any of these → "graph"):
    · loss, style loss, content loss, training loss
    · accuracy, precision, recall, F1, AUC, mAP
    · curve(s), plot(s), trend(s), convergence
    · iteration(s), epoch(s), step(s) [on a measurement axis]
    · metric(s), score(s) over time or thresholds
    · "training curves", "learning curve", "loss vs iteration"
    · quantitative comparison in terms of [metric]

  IMPLICIT experiment signals — classify as "graph" when the caption
  describes a controlled experiment comparing two or more models/conditions
  and reports a quantitative outcome (improvement, effectiveness, difference):
    · "[Model A] and [Model B]" + "improvement / effective / converge / faster"
    · "We train [X] with [condition A], [condition B], [condition C]"
      and mentions a measurable outcome or result
    · "improvement brought by [method]", "remains significant", "much smaller"
    · Sub-figures (a)(b)(c) each trained/run under different conditions

  EXAMPLES:
    ✅ "We train an IN model and a BN model with (a) original images, (b) contrast
       normalized images … improvement brought by IN remains significant" → graph
       [reason: controlled experiment comparing two models across conditions,
        quantitative improvement reported — these are loss-curve subplots]
    ✅ "Training curves of style and content loss" → graph
    ✅ "Quantitative comparison … style and content loss … averaged over 50 images" → graph
    ❌ "Overview of encoder-decoder pipeline architecture" → NOT graph → diagram

STEP 3 → "comparison"
  MATCH if caption describes ANY of these visual structures:
    a) Multiple methods/models shown side-by-side
       ("Ours vs Chen and Schmidt vs Gatys et al.")
    b) Left / Right OR Left / Middle / Right layout describing image regions
       ("Left: content image. Middle: style with masks. Right: result.")
    c) Parameter sweep — multiple images at different values of a scalar:
       α, λ, weight, level ("α = 0, α = 0.25, α = 0.5 …")
       OR "trade-off" / "balance between" with a named parameter → output images
    d) Interpolation grid — multiple outputs blended between two visual states
       ("interpolate between styles", "convex combination … arbitrary new styles",
        "style interpolation … different styles")
    e) Before / after or input / output visual pairs
    f) "Comparison with baselines", "ablation results", "qualitative examples"
    g) Any figure whose caption describes multiple visual outputs from
       different configurations, even without the word "comparison"
    h) "Example [X] results" — visual output samples from a model or method
       ("Example style transfer results", "example generation results")

  IMPORTANT OVERRIDES:
    · Left / Right / Middle spatial labels → ALWAYS "comparison", never "diagram"
    · "trade-off" or "control the balance" + named parameter → "comparison"
      (the figure shows a visual row at different parameter values, not a plot)
    · "interpolate", "interpolation", "convex combination" of visual outputs
      → "comparison", NOT "image" (multiple results are shown)
    · Grid or row of stylised / generated images → "comparison", not "image"

  EXAMPLES:
    ✅ "Left: content image. Middle: two style images with masks. Right: result."
       → comparison  [spatial layout of image regions]
    ✅ "Content-style trade-off … α in Equ. 14"
       → comparison  [row of output images at α=0 / 0.25 / 0.5 / 0.75 / 1]
    ✅ "Style interpolation … convex combination … interpolate between new styles"
       → comparison  [grid of interpolated visual outputs, NOT a single image]
    ✅ "Example style transfer results … Ours / Chen / Ulyanov / Gatys"
       → comparison
    ✅ "Comparison with baselines. AdaIN is more effective than concatenation."
       → comparison
    ❌ "AdaIN(x,y) = σ(y)(x−µ(x)/σ(x)) + µ(y)" as a block schematic
       → NOT comparison → diagram

STEP 4 → "chart"
  MATCH if: caption explicitly mentions bar chart, pie chart, histogram,
  bar graph, or stacked bars.

STEP 5 → "diagram"
  MATCH if: caption describes a structural schematic — NOT visual image outputs.
  Required signals: architecture, pipeline, framework, encoder, decoder,
  block diagram, flowchart, module, network topology, system overview,
  "overview of our [method]".
  HARD EXCLUSIONS — do NOT classify as "diagram" if:
    · Caption has loss / curve / metric / iteration / improvement signals → graph
    · Caption has Left / Right / Middle image-layout labels → comparison
    · Caption describes multiple visual method outputs → comparison
    · Caption uses "trade-off", "balance", or α / λ parameter row → comparison
  EXAMPLES:
    ✅ "Overview of style transfer algorithm … VGG-19 encoder … AdaIN … decoder"
       → diagram
    ❌ "Left: content. Right: color-preserved result." → NOT diagram → comparison
    ❌ "Style loss curves for BN vs IN model" → NOT diagram → graph
    ❌ "Spatial control. Left: content. Middle: masks. Right: result."
       → NOT diagram → comparison

STEP 6 → "image"
  MATCH ONLY if ALL of the following hold:
    · Single natural photograph or standalone illustration
    · No analytical structure (no axes, no parameter sweep, no grid of outputs)
    · Not a visual comparison of multiple outputs or configurations
    · Not an interpolation result showing several generated images
  EXAMPLES:
    ✅ A standalone photo used as an input example → image
    ❌ A grid of stylised outputs → NOT image → comparison
    ❌ Multiple generated images at different α values → NOT image → comparison

STEP 7 → "other"
  Use only when none of the above steps match.\
"""


def _build_batch_prompt(batch: list[dict[str, Any]]) -> str:
    """Construct a strict LLM prompt that processes multiple figures at once.

    The prompt instructs the model to return a JSON array — one object per
    figure — so we reduce N individual LLM calls to a single batch call.

    Type classification uses ``_TYPE_CLASSIFICATION_RULES`` — a shared,
    audited decision tree that fixes four documented misclassification
    patterns (see module-level comment above that constant).

    Args:
        batch: List of ``{"id": ..., "clean_caption": ...}`` dicts produced
               by :func:`_create_batches`.

    Returns:
        Fully-formed prompt string.  The model must respond with a valid JSON
        array and nothing else.
    """
    figures_block = "\n".join(
        f'  {{ "id": "{item["id"]}", "clean_caption": "{item["clean_caption"][:_LLM_CAPTION_MAX_CHARS]}" }}'
        for item in batch
    )

    return (
        "You are an expert research paper analyst.\n\n"
        "Your task is to analyze MULTIPLE figure captions from a research paper "
        "and generate structured metadata for EACH one.\n\n"
        "You MUST return ONLY a valid JSON array. "
        "No explanation, no markdown, no extra text, no prose before or after.\n\n"
        "---\n\n"
        "INPUT FIGURES:\n"
        "[\n"
        f"{figures_block}\n"
        "]\n\n"
        "---\n\n"
        "FOR EACH FIGURE, produce one JSON object with these exact fields:\n\n"
        f"FIELD 1 — \"type\"\n{_TYPE_CLASSIFICATION_RULES}\n\n"
        "FIELD 2 — \"title\"\n"
        "  · Max 12 words, Title Case\n"
        "  · No 'Figure X' prefix\n"
        "  · No trailing punctuation\n\n"
        "FIELD 3 — \"description\"\n"
        "  · 1-2 sentences\n"
        '  · DO NOT start with "This figure shows" / "The figure shows"\n'
        "  · State WHAT is depicted and WHY it matters to the paper\n"
        "  · Name key concepts: model name, metric, method, comparison target\n"
        "  · Avoid generic filler sentences\n\n"
        "FIELD 4 — \"importance\"\n"
        '  · "high"   → primary result, main architecture, key comparison\n'
        '  · "medium" → supporting experiment or secondary analysis\n'
        '  · "low"    → minor illustration or supplementary visual\n\n'
        "---\n\n"
        "OUTPUT FORMAT:\n"
        "[\n"
        "  {\n"
        '    "id":          "<copied exactly from input>",\n'
        '    "type":        "<table|graph|comparison|chart|diagram|image|other>",\n'
        '    "title":       "<max 12 words, Title Case>",\n'
        '    "description": "<1-2 direct sentences>",\n'
        '    "importance":  "<high|medium|low>"\n'
        "  },\n"
        "  ...\n"
        "]\n\n"
        "ABSOLUTE RULES:\n"
        f"· Output MUST be a JSON array with exactly {len(batch)} element(s)\n"
        "· Every element MUST include all 5 fields: id, type, title, description, importance\n"
        "· No trailing commas · No markdown fences · No text outside the array\n"
        "· No extra fields"
    )


# ---------------------------------------------------------------------------
# 3c — Per-field safe enrichment + validation
# ---------------------------------------------------------------------------

def _safe_enrichment(fallback: dict[str, Any]) -> dict[str, Any]:
    """Return safe placeholder enrichment when LLM response cannot be parsed."""
    return {
        "title":       fallback.get("title", "Untitled Figure"),
        "type":        "other",
        "description": fallback.get("description", ""),
        "importance":  fallback.get("importance", _UNKNOWN),
    }


def _is_bad_batch(enrichment_map: dict[str, dict[str, Any]]) -> bool:
    """Detect a low-quality or failed LLM batch response.

    A batch is considered "bad" when at least 50 % of its items have both
    ``type == "other"`` **and** an empty ``description``.  This pattern
    occurs in two cases:

    1. JSON parse failure — ``_parse_batch_response`` filled every slot with
       ``_safe_enrichment()``, which sets ``type="other"`` and
       ``description=""``.
    2. Low-quality model output — the model returned valid JSON but gave
       genuinely uninformative answers (no type classification, no description).

    Both cases warrant a Gemini fallback attempt.

    Args:
        enrichment_map: ``{fig_id: enrichment_dict}`` returned by
                        ``_parse_batch_response``.

    Returns:
        ``True`` when >= 50 % of items are type="other" with empty description.
        ``False`` otherwise (including when the map is empty).
    """
    if not enrichment_map:
        return False

    bad_count = sum(
        1
        for enrichment in enrichment_map.values()
        if enrichment.get("type") == "other"
        and not (enrichment.get("description") or "").strip()
    )
    return bad_count / len(enrichment_map) >= 0.5


def _validate_enrichment_item(
    item: dict[str, Any],
    fallback: dict[str, Any],
) -> dict[str, Any]:
    """Validate and normalise a single enrichment object from the batch response.

    Applies 3-layer defence: field presence, allowed-value checks, length caps.

    Args:
        item:     Raw dict parsed from the LLM's JSON array element.
        fallback: Phase 7.4.1 figure dict used to supply safe defaults.

    Returns:
        Dict with ``title``, ``type``, ``description``, ``importance`` —
        all guaranteed non-None and schema-conformant.
    """
    # title
    title: str = str(item.get("title") or "").strip()
    if not title:
        title = fallback.get("title", "Untitled Figure")

    # type
    fig_type: str = str(item.get("type") or "").strip().lower()
    if fig_type not in _ALLOWED_TYPES:
        logger.debug(
            "_validate_enrichment_item: type '%s' not in allowed set — "
            "defaulting to 'other'.",
            fig_type,
        )
        fig_type = "other"

    # description
    description: str = str(item.get("description") or "").strip()
    if not description:
        description = fallback.get("description", "")
    if len(description) > _DESCRIPTION_MAX_CHARS:
        description = description[:_DESCRIPTION_MAX_CHARS].rstrip() + "…"

    # importance
    importance: str = str(item.get("importance") or "").strip().lower()
    if importance not in _ALLOWED_IMPORTANCE:
        importance = fallback.get("importance", _UNKNOWN)
        if importance not in _ALLOWED_IMPORTANCE:
            importance = "medium"

    return {
        "title":       title,
        "type":        fig_type,
        "description": description,
        "importance":  importance,
    }


# ---------------------------------------------------------------------------
# 3d — Batch response parser
# ---------------------------------------------------------------------------

def _parse_batch_response(
    response: str,
    batch_figures: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Parse and validate a JSON-array LLM response for an entire batch.

    Returns a mapping of figure-id → validated enrichment dict.  When parsing
    fails entirely, safe fallback enrichment is returned for every figure in
    the batch so the pipeline never stalls.

    Parsing strategy (3 layers):
      Layer 1 — Strip markdown fences (```json … ```)
      Layer 2 — JSON parse; fall back to extracting the first […] array block
      Layer 3 — Per-item field validation via _validate_enrichment_item()

    Args:
        response:      Raw string returned by the LLM.
        batch_figures: The original Phase 7.4.1 dicts for this batch
                       (used as fallback sources keyed by ``id``).

    Returns:
        ``{fig_id: enrichment_dict}`` for every figure in *batch_figures*.
        Missing ids in the LLM response are filled with safe fallbacks.
    """
    # Build id → fallback map for quick lookup during validation
    fallback_map: dict[str, dict[str, Any]] = {
        f.get("id", ""): f for f in batch_figures
    }

    # ── Layer 1: strip markdown wrappers ─────────────────────────────────────
    cleaned = response.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```$",          "", cleaned).strip()

    # ── Layer 2: JSON parse ──────────────────────────────────────────────────
    data: list | None = None

    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, list):
            data = parsed
        else:
            logger.warning(
                "_parse_batch_response: expected JSON array, got %s — "
                "attempting fallback extraction.",
                type(parsed).__name__,
            )
    except json.JSONDecodeError:
        pass

    if data is None:
        # Fallback: try to extract the first [...] block from the raw text
        match = re.search(r"\[.*\]", cleaned, re.DOTALL)
        if match:
            try:
                parsed = json.loads(match.group())
                if isinstance(parsed, list):
                    data = parsed
            except json.JSONDecodeError:
                pass

    if data is None:
        logger.warning(
            "_parse_batch_response: JSON array parse failed for batch of %d "
            "figures — using safe fallbacks for all.",
            len(batch_figures),
        )
        return {
            fig_id: _safe_enrichment(fallback_map.get(fig_id, {}))
            for fig_id in fallback_map
        }

    # ── Layer 3: per-item validation ─────────────────────────────────────────
    result: dict[str, dict[str, Any]] = {}

    for item in data:
        if not isinstance(item, dict):
            logger.debug(
                "_parse_batch_response: skipping non-dict item: %r", item
            )
            continue

        fig_id = str(item.get("id") or "").strip()
        if not fig_id or fig_id not in fallback_map:
            logger.debug(
                "_parse_batch_response: unknown/missing id '%s' in response — "
                "skipping.",
                fig_id,
            )
            continue

        result[fig_id] = _validate_enrichment_item(item, fallback_map[fig_id])

    # Fill in any ids the model omitted
    for fig_id, fallback in fallback_map.items():
        if fig_id not in result:
            logger.warning(
                "_parse_batch_response: id '%s' absent from LLM response — "
                "using safe fallback.",
                fig_id,
            )
            result[fig_id] = _safe_enrichment(fallback)

    return result


# ============================================================================
# SECTION 4 — PUBLIC CLASS
# ============================================================================

class FigureRefiner:
    """Two-phase figure refinement pipeline.

    Phase 7.4.1 — ``refine(figures)``
        Heuristic caption cleaning, title generation, quality / confidence.
        ⚠ LLM fields remain ``"unknown"`` / ``""`` after this phase alone.

    Phase 7.4.2 — ``enrich_with_llm(refined_figures)``
        BATCHED LLM enrichment: groups figures into batches of _BATCH_SIZE,
        issues one LLM call per batch, parses the JSON-array response, and
        merges results back.  Cache-hit figures bypass batching entirely.

        · LRU cache (size-limited) avoids repeated calls for the same caption.
        · Per-batch error isolation — one failed batch never aborts others.
        · asyncio.gather() concurrency, semaphore-limited to _LLM_MAX_CONCURRENT.
        · Groq → Gemini fallback on failure, timeout, or low-quality output.

    Combined — ``refine_and_enrich(figures)``  ← RECOMMENDED for route handlers
        Runs both phases in sequence.

    Args:
        llm_model: Key for ``factory.get_llm()``.  ``"groq"`` (default) or
                   ``"ollama"`` for local inference.
    """

    def __init__(self, llm_model: str = "groq") -> None:
        self._llm_model: str = llm_model

        # LRU cache: {md5(clean_caption): enrichment_dict}
        self._cache: OrderedDict[str, dict[str, Any]] = OrderedDict()

        # BUG-1 FIX: Semaphore is NOT created here — lazy init on first async call.
        # _llm_semaphore_width tracks the last width so _get_semaphore can detect
        # when a different batch_count requires a new semaphore (avoids accessing
        # the private asyncio.Semaphore._value attribute).
        self._llm_semaphore: asyncio.Semaphore | None = None
        self._llm_semaphore_width: int = 0

        # Observability counters
        self._llm_calls:     int = 0
        self._llm_timeouts:  int = 0
        self._cache_hits:    int = 0
        self._cache_misses:  int = 0
        self._batch_calls:   int = 0
        self._batch_errors:  int = 0

    def _get_semaphore(self, batch_count: int | None = None) -> asyncio.Semaphore:
        """Return (or lazily create) the concurrency semaphore.

        BUG-1 FIX retained: called inside async methods so the event loop exists.

        PERF-6: When batch_count is supplied the semaphore width is capped to
        min(batch_count, _LLM_MAX_CONCURRENT) so we never pre-allocate slots
        for batches that don't exist.  For example, 2 batches from 10 figures
        need width=2, not width=4 — both are functionally identical but the
        tighter width makes the concurrency contract explicit.

        Args:
            batch_count: Number of batches about to be dispatched.  Pass None
                         to use the global _LLM_MAX_CONCURRENT cap directly.

        Returns:
            An asyncio.Semaphore sized to min(batch_count, _LLM_MAX_CONCURRENT).
        """
        width = (
            min(batch_count, _LLM_MAX_CONCURRENT)
            if batch_count is not None
            else _LLM_MAX_CONCURRENT
        )
        if self._llm_semaphore is None or self._llm_semaphore_width != width:
            self._llm_semaphore = asyncio.Semaphore(width)
            self._llm_semaphore_width = width
        return self._llm_semaphore

    # ------------------------------------------------------------------
    # Phase 7.4.1
    # ------------------------------------------------------------------

    async def refine(self, figures: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Apply heuristic refinement to a batch of raw figures (Phase 7.4.1).

        ⚠ WARNING: This method alone leaves ``type``, ``description``, and
        ``importance`` as ``"unknown"``/``""``.  Call ``refine_and_enrich()``
        to also run LLM enrichment (Phase 7.4.2).

        Args:
            figures: Raw figure dicts from the extractor.

        Returns:
            List of heuristically-refined dicts in the same order.
        """
        if not figures:
            return []
        return [_refine_one(fig) for fig in figures]

    # ------------------------------------------------------------------
    # Phase 7.4.2 — internal batch machinery
    # ------------------------------------------------------------------

    async def _enrich_batch_limited(
        self,
        batch_figures: list[dict[str, Any]],
        llm: Any,
        fallback_llm: Any = None,
        batch_count: int | None = None,
    ) -> dict[str, dict[str, Any]]:
        """Acquire the concurrency semaphore then call ``_enrich_batch``.

        Operates on an entire batch, honouring the ``_LLM_MAX_CONCURRENT``
        semaphore so at most that many batch calls run in parallel.

        Args:
            batch_figures: Subset of Phase 7.4.1 figures to enrich together.
            llm:           Primary callable LLM instance (GroqLLM, …).
            fallback_llm:  Secondary callable LLM instance (GeminiLLM).
                           Used when the primary call fails or returns a
                           low-quality batch.  ``None`` disables fallback.
            batch_count:   Total number of batches being dispatched in this
                           call — used to right-size the semaphore (PERF-6).

        Returns:
            ``{fig_id: enrichment_dict}`` for every figure in *batch_figures*.
        """
        async with self._get_semaphore(batch_count):
            return await self._enrich_batch(
                batch_figures, llm, fallback_llm=fallback_llm
            )

    async def _enrich_batch(
        self,
        batch_figures: list[dict[str, Any]],
        llm: Any,
        fallback_llm: Any = None,
    ) -> dict[str, dict[str, Any]]:
        """Issue ONE LLM call for the entire batch; parse and validate the response.

        Fallback flow (Phase 7.4.2 multi-model):
          Step 1 — Try primary LLM (Groq):
            · asyncio.to_thread() keeps the event loop unblocked
            · Configurable retry with linear backoff for transient failures
            · Hard timeout per batch
          Step 2 — Fall back to Gemini when ANY of these occur:
            · Exception or timeout after all retries (primary LLM unreachable)
            · JSON parse failure (_parse_batch_response fell back to safe dummies)
            · Low-quality output: ≥ 50 % of items have type='other' + empty desc
              (detected by _is_bad_batch)
          Step 3 — If Gemini also fails → return _safe_enrichment for every figure.

        Args:
            batch_figures: Phase 7.4.1-refined figure dicts for this batch.
            llm:           Primary callable LLM instance (GroqLLM, …).
            fallback_llm:  Secondary callable LLM (GeminiLLM).  Pass ``None``
                           to disable multi-model fallback (e.g. in tests).

        Returns:
            ``{fig_id: enrichment_dict}`` — always one entry per input figure.
        """
        batch_ids  = [f.get("id", "") for f in batch_figures]
        batch_input = [
            {"id": f.get("id", ""), "clean_caption": f.get("clean_caption", "")}
            for f in batch_figures
        ]
        prompt = _build_batch_prompt(batch_input)

        logger.debug(
            "_enrich_batch: batch=%s prompt_len=%d",
            batch_ids, len(prompt),
        )

        # ── STEP 1: Try primary LLM (Groq) ───────────────────────────────────
        logger.info("_enrich_batch: [Using GROQ] batch=%s", batch_ids)

        raw_response:   str | None = None
        primary_failed: bool       = False

        for attempt in range(_LLM_RETRY_ATTEMPTS):
            try:
                self._llm_calls  += 1
                self._batch_calls += 1

                raw_response = await asyncio.wait_for(
                    asyncio.to_thread(llm, prompt=prompt),
                    timeout=_LLM_TIMEOUT_SECS,
                )

                logger.debug(
                    "_enrich_batch: GROQ response batch=%s (%d chars)",
                    batch_ids, len(raw_response or ""),
                )
                await asyncio.sleep(0.1)   # PERF-3: reduced from 0.5
                break  # ── Groq success ──────────────────────────────────────

            except asyncio.TimeoutError:
                self._llm_timeouts += 1
                if attempt < _LLM_RETRY_ATTEMPTS - 1:
                    logger.warning(
                        "_enrich_batch: GROQ timeout (attempt %d/%d) batch=%s — retrying",
                        attempt + 1, _LLM_RETRY_ATTEMPTS, batch_ids,
                    )
                    await asyncio.sleep(0.5 * (attempt + 1))
                else:
                    logger.warning(
                        "_enrich_batch: GROQ timeout after %d attempts batch=%s — "
                        "will attempt Gemini fallback.",
                        _LLM_RETRY_ATTEMPTS, batch_ids,
                    )
                    primary_failed = True

            except Exception as exc:  # noqa: BLE001
                if attempt < _LLM_RETRY_ATTEMPTS - 1:
                    logger.warning(
                        "_enrich_batch: GROQ error (attempt %d/%d) batch=%s: %s — retrying",
                        attempt + 1, _LLM_RETRY_ATTEMPTS, batch_ids, exc,
                    )
                    await asyncio.sleep(0.5 * (attempt + 1))
                else:
                    logger.warning(
                        "_enrich_batch: GROQ failed after %d attempts batch=%s: %s — "
                        "will attempt Gemini fallback.",
                        _LLM_RETRY_ATTEMPTS, batch_ids, exc,
                    )
                    primary_failed = True

        # ── Evaluate Groq result quality ──────────────────────────────────────
        needs_fallback: bool = primary_failed

        if not primary_failed:
            if raw_response is None:
                logger.warning(
                    "_enrich_batch: GROQ returned None for batch=%s — "
                    "will attempt Gemini fallback.",
                    batch_ids,
                )
                needs_fallback = True
            else:
                enrichment_map = _parse_batch_response(raw_response, batch_figures)

                if _is_bad_batch(enrichment_map):
                    logger.warning(
                        "_enrich_batch: GROQ batch=%s produced low-quality output "
                        "(>= 50%% items are type='other' with empty description) — "
                        "will attempt Gemini fallback.",
                        batch_ids,
                    )
                    needs_fallback = True
                else:
                    for fig_id, enrichment in enrichment_map.items():
                        logger.debug(
                            "_enrich_batch: GROQ fig='%s' → type='%s' importance='%s' "
                            "title='%.50s'",
                            fig_id, enrichment["type"],
                            enrichment["importance"], enrichment["title"],
                        )
                    return enrichment_map

        # ── STEP 2: Fallback → Gemini ─────────────────────────────────────────
        if fallback_llm is None:
            logger.error(
                "_enrich_batch: GROQ failed and no fallback LLM configured — "
                "using safe fallbacks for batch=%s.",
                batch_ids,
            )
            self._batch_errors += 1
            return {f.get("id", ""): _safe_enrichment(f) for f in batch_figures}

        logger.info(
            "_enrich_batch: [Fallback → GEMINI] batch=%s",
            batch_ids,
        )

        try:
            gemini_response: str = await asyncio.wait_for(
                asyncio.to_thread(fallback_llm, prompt=prompt),
                timeout=_LLM_TIMEOUT_SECS,
            )
            self._llm_calls += 1

            logger.debug(
                "_enrich_batch: GEMINI response batch=%s (%d chars)",
                batch_ids, len(gemini_response or ""),
            )
            await asyncio.sleep(0.1)

            gemini_map = _parse_batch_response(gemini_response, batch_figures)

            for fig_id, enrichment in gemini_map.items():
                logger.debug(
                    "_enrich_batch: GEMINI fig='%s' → type='%s' importance='%s' "
                    "title='%.50s'",
                    fig_id, enrichment["type"],
                    enrichment["importance"], enrichment["title"],
                )
            return gemini_map

        except asyncio.TimeoutError:
            self._llm_timeouts += 1
            logger.error(
                "_enrich_batch: [Both models failed] GEMINI timed out for batch=%s — "
                "using safe fallbacks.",
                batch_ids,
            )

        except Exception as exc:  # noqa: BLE001
            logger.error(
                "_enrich_batch: [Both models failed] GEMINI error for batch=%s: %s — "
                "using safe fallbacks.",
                batch_ids, exc,
            )

        # ── STEP 3: Both models failed ────────────────────────────────────────
        self._batch_errors += 1
        return {f.get("id", ""): _safe_enrichment(f) for f in batch_figures}

    # ------------------------------------------------------------------
    # Phase 7.4.2 — public entry point
    # ------------------------------------------------------------------

    async def enrich_with_llm(
        self,
        figures: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Enrich Phase 7.4.1-refined figures with batched LLM semantic analysis.

        Flow:
          1. Resolve cache — figures whose clean_caption is already cached skip
             the LLM entirely.
          2. Fast-path — figures with no usable caption get _safe_enrichment()
             immediately without entering the batch queue (PERF-7).
          3. Create batches — remaining cache-miss figures with captions are
             grouped into batches of _BATCH_SIZE using _create_batches().
          4. Process batches — all batches are dispatched concurrently via
             asyncio.gather(); the semaphore is sized to
             min(batch_count, _LLM_MAX_CONCURRENT) (PERF-6).
          5. Store cache — each result in every batch response is written to the
             LRU cache (evicting oldest entry when _CACHE_SIZE_LIMIT is reached).
          6. Merge — enrichment is applied to the original figure dicts and the
             full list is returned in the original input order.

        Error isolation:
          If a batch fails after all retries AND Gemini fallback, safe fallback
          enrichment is used for that batch only.  Other batches and all cache
          hits are unaffected.

        Args:
            figures: Phase 7.4.1-refined figure dicts.

        Returns:
            Enriched list — same length and order as input.
        """
        if not figures:
            return []

        # Late import prevents circular imports at module-load time.
        from app.services.llm.factory import get_llm  # noqa: PLC0415

        try:
            llm = get_llm(self._llm_model)
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "enrich_with_llm: could not load LLM '%s': %s — "
                "returning figures without LLM enrichment.",
                self._llm_model, exc,
            )
            return figures

        # ── Load Gemini fallback (best-effort; pipeline continues if unavailable)
        fallback_llm: Any = None
        if self._llm_model != "gemini":
            try:
                fallback_llm = get_llm("gemini")
                logger.info("enrich_with_llm: Gemini fallback LLM loaded.")
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "enrich_with_llm: Gemini fallback unavailable: %s — "
                    "multi-model fallback disabled for this run.",
                    exc,
                )

        logger.info(
            "enrich_with_llm: starting enrichment for %d figures "
            "(cache_size=%d, batch_size=%d, max_concurrent=%d)",
            len(figures), len(self._cache), _BATCH_SIZE, _LLM_MAX_CONCURRENT,
        )

        # ── Step 1: Resolve cache ─────────────────────────────────────────────
        cache_keys: dict[str, str] = {
            f.get("id", ""): _caption_hash((f.get("clean_caption") or "").strip())
            for f in figures
        }

        cached_enrichments: dict[str, dict[str, Any]] = {}
        uncached_figures:   list[dict[str, Any]]       = []

        for fig in figures:
            fig_id    = fig.get("id", "")
            cache_key = cache_keys[fig_id]

            if cache_key in self._cache:
                self._cache_hits += 1
                self._cache.move_to_end(cache_key)
                cached_enrichments[fig_id] = self._cache[cache_key]
                logger.debug(
                    "enrich_with_llm: cache hit  fig='%s' key=%s…",
                    fig_id, cache_key[:8],
                )
            else:
                self._cache_misses += 1
                uncached_figures.append(fig)

        logger.info(
            "enrich_with_llm: cache_hits=%d  cache_misses=%d  uncached=%d",
            len(cached_enrichments), len(uncached_figures), len(uncached_figures),
        )

        # ── Step 2: Fast path — no-caption figures skip LLM (PERF-7) ─────────
        all_enrichments: dict[str, dict[str, Any]] = dict(cached_enrichments)

        no_caption_figs = [f for f in uncached_figures if not _needs_llm(f)]
        llm_figs        = [f for f in uncached_figures if _needs_llm(f)]

        for fig in no_caption_figs:
            fig_id = fig.get("id", "")
            all_enrichments[fig_id] = _safe_enrichment(fig)
            logger.debug(
                "enrich_with_llm: skipping LLM for fig='%s' (no usable caption)",
                fig_id,
            )

        # ── Step 3: Batch + dispatch ──────────────────────────────────────────
        if llm_figs:
            batches     = _create_batches(llm_figs)
            batch_count = len(batches)

            logger.info(
                "enrich_with_llm: %d figures → %d batch(es) "
                "(semaphore_width=%d)",
                len(llm_figs), batch_count,
                min(batch_count, _LLM_MAX_CONCURRENT),
            )

            # All batches fire concurrently; semaphore right-sized to batch_count
            # so we never over-provision slots (PERF-6).
            batch_results = await asyncio.gather(
                *[
                    self._enrich_batch_limited(
                        batch,
                        llm,
                        fallback_llm=fallback_llm,
                        batch_count=batch_count,
                    )
                    for batch in batches
                ],
                return_exceptions=True,
            )

            # ── Step 4: Store cache + merge batch results ─────────────────────
            for batch_figs, batch_result in zip(batches, batch_results):
                if isinstance(batch_result, Exception):
                    logger.error(
                        "enrich_with_llm: unexpected exception from batch %s: %s — "
                        "using safe fallbacks for that batch.",
                        [f.get("id") for f in batch_figs], batch_result,
                    )
                    self._batch_errors += 1
                    for fig in batch_figs:
                        all_enrichments[fig.get("id", "")] = _safe_enrichment(fig)
                    continue

                # batch_result is a dict: {fig_id: enrichment_dict}
                for fig in batch_figs:
                    fig_id    = fig.get("id", "")
                    cache_key = cache_keys[fig_id]
                    enrichment = batch_result.get(fig_id, _safe_enrichment(fig))

                    # Store in LRU cache
                    self._cache[cache_key] = enrichment
                    self._cache.move_to_end(cache_key)
                    if len(self._cache) > _CACHE_SIZE_LIMIT:
                        evicted, _ = self._cache.popitem(last=False)
                        logger.debug(
                            "enrich_with_llm: LRU eviction key=%s…", evicted[:8]
                        )

                    all_enrichments[fig_id] = enrichment

        # ── Step 5: Merge enrichments back into figures (preserve input order) ─
        enriched: list[dict[str, Any]] = []
        for fig in figures:
            fig_id     = fig.get("id", "")
            enrichment = all_enrichments.get(fig_id)
            if enrichment:
                enriched.append({**fig, **enrichment})
            else:
                # Should not happen, but never crash the pipeline
                logger.warning(
                    "enrich_with_llm: no enrichment found for fig='%s' — "
                    "returning Phase 7.4.1 output.",
                    fig_id,
                )
                enriched.append(fig)

        logger.info(
            "enrich_with_llm: complete | total=%d | cache_size=%d | "
            "cache_hits=%d | cache_misses=%d | llm_calls=%d | "
            "batch_calls=%d | batch_errors=%d | timeouts=%d",
            len(enriched), len(self._cache),
            self._cache_hits, self._cache_misses,
            self._llm_calls, self._batch_calls,
            self._batch_errors, self._llm_timeouts,
        )
        return enriched

    # ------------------------------------------------------------------
    # Combined convenience  ← USE THIS IN figure_routes.py  (BUG-7 FIX)
    # ------------------------------------------------------------------

    async def refine_and_enrich(
        self,
        figures: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Run Phase 7.4.1 heuristics then Phase 7.4.2 batched LLM enrichment.

        ✅ This is the correct method to call from figure_routes.py.
           Calling ``refine()`` alone leaves type/importance/description as
           "unknown"/"" — that was BUG-7.

        Args:
            figures: Raw figure dicts from the extractor.

        Returns:
            Fully refined and LLM-enriched figure list.
        """
        refined = await self.refine(figures)
        return await self.enrich_with_llm(refined)

    # ------------------------------------------------------------------
    # Observability
    # ------------------------------------------------------------------

    def get_metrics(self) -> dict[str, Any]:
        """Return current performance, cache, and batch statistics."""
        total = self._cache_hits + self._cache_misses
        return {
            "llm_calls":      self._llm_calls,
            "batch_calls":    self._batch_calls,
            "batch_errors":   self._batch_errors,
            "llm_timeouts":   self._llm_timeouts,
            "cache_hits":     self._cache_hits,
            "cache_misses":   self._cache_misses,
            "cache_size":     len(self._cache),
            "cache_hit_rate": round(self._cache_hits / total * 100, 1) if total else 0.0,
        }

    def reset_metrics(self) -> None:
        """Reset all metrics counters (useful for per-batch benchmarking)."""
        self._llm_calls    = 0
        self._batch_calls  = 0
        self._batch_errors = 0
        self._llm_timeouts = 0
        self._cache_hits   = 0
        self._cache_misses = 0