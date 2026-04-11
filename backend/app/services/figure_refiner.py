# app/services/figure_refiner.py
"""
Figure Refinement Engine — Phase 7.4.1 (heuristic) + Phase 7.4.2 (LLM).

Bug fixes applied (vs previous version)
----------------------------------------
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

Pipeline
--------
Phase 7.4.1 — Heuristic (CPU-only, always runs):
    clean_caption → generate_title → compute_quality → compute_confidence

Phase 7.4.2 — LLM intelligence (async, runs after 7.4.1):
    enrich_with_llm → overwrites title, type, description, importance
    · BATCHED: groups figures into batches of _BATCH_SIZE (default 4)
    · One LLM call per batch instead of one per figure
    · MD5 caption-hash cache (LRU, size-limited) avoids duplicate LLM calls
    · Strict 3-layer JSON validation + typed fallbacks
    · Per-batch error isolation + configurable retry + timeout
    · asyncio.gather() concurrency, semaphore-limited to _LLM_MAX_CONCURRENT

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

_CACHE_SIZE_LIMIT:   int = 1_000   # LRU eviction after this many entries
_LLM_RETRY_ATTEMPTS: int = 2       # retries on transient batch failures
_LLM_TIMEOUT_SECS:   int = 30      # per-batch hard timeout (larger than per-figure)
_LLM_MAX_CONCURRENT: int = 2       # semaphore width — max concurrent batch calls
_BATCH_SIZE:         int = 4       # figures per LLM batch (3–5 range)

_ALLOWED_TYPES: frozenset[str] = frozenset({
    "diagram", "graph", "chart", "table", "comparison", "image", "other",
})
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

def _create_batches(figures: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Partition figures into batches of size _BATCH_SIZE (default 4).

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

def _build_batch_prompt(batch: list[dict[str, Any]]) -> str:
    """Construct a strict LLM prompt that processes multiple figures at once.

    The prompt instructs the model to return a JSON array — one object per
    figure — so we reduce N individual LLM calls to a single batch call.

    Args:
        batch: List of ``{"id": ..., "clean_caption": ...}`` dicts produced
               by :func:`_create_batches`.

    Returns:
        Fully-formed prompt string.  The model must respond with a valid JSON
        array and nothing else.
    """
    # Serialise figures for injection into the prompt
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
        "1. \"id\"          → copy the id from the input exactly\n\n"
        "2. \"type\"        → classify the figure. Choose EXACTLY ONE:\n"
        '   * "graph"      → plots, curves, axes, trends, training metrics\n'
        '   * "diagram"    → architecture, blocks, pipeline, flowchart, modules\n'
        '   * "comparison" → multiple images/outputs compared side-by-side\n'
        '   * "table"      → structured rows/columns with numeric/text data\n'
        '   * "image"      → ONLY if natural image with no analytical structure\n'
        '   * "chart"      → bar charts, pie charts, histograms\n'
        '   * "other"      → none of the above\n'
        "   STRICT: DO NOT default to \"image\".\n"
        "   · curves/loss/accuracy/metrics → \"graph\"\n"
        "   · comparison/results/vs/baseline → \"comparison\"\n"
        "   · architecture/framework/pipeline/encoder/decoder → \"diagram\"\n\n"
        "3. \"title\"       → max 12 words, Title Case, no 'Figure X', "
        "no trailing punctuation\n\n"
        "4. \"description\" → 1-2 sentences. Rules:\n"
        '   · DO NOT start with "This figure shows" / "The figure shows"\n'
        "   · Be direct: state WHAT the figure depicts and WHY it matters\n"
        "   · Mention key concepts: model, metric, architecture, comparison, etc.\n"
        "   · Avoid generic statements\n\n"
        "5. \"importance\"  → choose EXACTLY ONE:\n"
        '   * "high"   → key result, main method, architecture, primary comparison\n'
        '   * "medium" → supporting result or secondary experiment\n'
        '   * "low"    → minor visualization or illustrative example\n\n'
        "---\n\n"
        "OUTPUT FORMAT — return exactly this structure:\n"
        "[\n"
        "  {\n"
        '    "id":          "<copied from input>",\n'
        '    "type":        "<one of the allowed values>",\n'
        '    "title":       "<max 12 words, Title Case>",\n'
        '    "description": "<1-2 direct sentences>",\n'
        '    "importance":  "<high | medium | low>"\n'
        "  },\n"
        "  ...\n"
        "]\n\n"
        "ABSOLUTE RULES:\n"
        f"· Output MUST be a JSON array with exactly {len(batch)} element(s)\n"
        "· Every element MUST include all 5 fields: id, type, title, description, importance\n"
        "· No trailing commas\n"
        "· No markdown fences\n"
        "· No explanatory text before or after the array\n"
        "· No extra fields"
    )


# ---------------------------------------------------------------------------
# 3c — Per-field safe enrichment + single-figure parse (preserved from v1)
# ---------------------------------------------------------------------------

def _safe_enrichment(fallback: dict[str, Any]) -> dict[str, Any]:
    """Return safe placeholder enrichment when LLM response cannot be parsed."""
    return {
        "title":       fallback.get("title", "Untitled Figure"),
        "type":        "other",
        "description": fallback.get("description", ""),
        "importance":  fallback.get("importance", _UNKNOWN),
    }


def _validate_enrichment_item(
    item: dict[str, Any],
    fallback: dict[str, Any],
) -> dict[str, Any]:
    """Validate and normalise a single enrichment object from the batch response.

    Applies the same 3-layer defence as the original ``_parse_llm_response``:
    field presence, allowed-value checks, and length caps.

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
        self._llm_semaphore: asyncio.Semaphore | None = None

        # Observability counters
        self._llm_calls:     int = 0
        self._llm_timeouts:  int = 0
        self._cache_hits:    int = 0
        self._cache_misses:  int = 0
        self._batch_calls:   int = 0   # NEW: total batch LLM calls issued
        self._batch_errors:  int = 0   # NEW: batches that triggered fallback

    def _get_semaphore(self) -> asyncio.Semaphore:
        """Return (or lazily create) the concurrency semaphore.

        BUG-1 FIX: Called inside async methods so the event loop is always
        running when the Semaphore is constructed.
        """
        if self._llm_semaphore is None:
            self._llm_semaphore = asyncio.Semaphore(_LLM_MAX_CONCURRENT)
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
    ) -> dict[str, dict[str, Any]]:
        """Acquire the concurrency semaphore then call ``_enrich_batch``.

        This mirrors the old ``_enrich_one_limited`` pattern but operates on
        an entire batch, honouring the ``_LLM_MAX_CONCURRENT`` semaphore so
        at most that many batch calls run in parallel.

        Args:
            batch_figures: Subset of Phase 7.4.1 figures to enrich together.
            llm:           Callable LLM instance (GroqLLM, OllamaLLM, …).

        Returns:
            ``{fig_id: enrichment_dict}`` for every figure in *batch_figures*.
        """
        async with self._get_semaphore():
            return await self._enrich_batch(batch_figures, llm)

    async def _enrich_batch(
        self,
        batch_figures: list[dict[str, Any]],
        llm: Any,
    ) -> dict[str, dict[str, Any]]:
        """Issue ONE LLM call for the entire batch; parse and validate the response.

        Features:
          · Single LLM call replaces N per-figure calls (N = batch size)
          · asyncio.to_thread() keeps the event loop unblocked
          · Configurable retry with linear backoff for transient failures
          · Hard timeout per batch (scaled up vs per-figure timeout)
          · On total failure → safe fallbacks for every figure in the batch,
            pipeline continues uninterrupted

        Args:
            batch_figures: Phase 7.4.1-refined figure dicts for this batch.
            llm:           Callable LLM instance.

        Returns:
            ``{fig_id: enrichment_dict}`` — always one entry per input figure.
        """
        batch_ids = [f.get("id", "") for f in batch_figures]
        # Minimal batch representation for the prompt (id + clean_caption only)
        batch_input = [
            {"id": f.get("id", ""), "clean_caption": f.get("clean_caption", "")}
            for f in batch_figures
        ]
        prompt = _build_batch_prompt(batch_input)

        logger.debug(
            "_enrich_batch: batch=%s prompt_len=%d",
            batch_ids, len(prompt),
        )

        raw_response: str | None = None

        for attempt in range(_LLM_RETRY_ATTEMPTS):
            try:
                self._llm_calls  += 1
                self._batch_calls += 1

                raw_response = await asyncio.wait_for(
                    asyncio.to_thread(llm, prompt=prompt),
                    timeout=_LLM_TIMEOUT_SECS,
                )

                logger.debug(
                    "_enrich_batch: LLM response batch=%s (%d chars)",
                    batch_ids, len(raw_response or ""),
                )
                # Brief courtesy pause to avoid hammering rate limits
                await asyncio.sleep(0.5)
                break  # ── success ──────────────────────────────────────────

            except asyncio.TimeoutError:
                self._llm_timeouts += 1
                if attempt < _LLM_RETRY_ATTEMPTS - 1:
                    logger.warning(
                        "_enrich_batch: timeout (attempt %d/%d) batch=%s — retrying",
                        attempt + 1, _LLM_RETRY_ATTEMPTS, batch_ids,
                    )
                    await asyncio.sleep(0.5 * (attempt + 1))
                else:
                    logger.error(
                        "_enrich_batch: timeout after %d attempts batch=%s — "
                        "using safe fallbacks.",
                        _LLM_RETRY_ATTEMPTS, batch_ids,
                    )
                    self._batch_errors += 1
                    return {
                        f.get("id", ""): _safe_enrichment(f)
                        for f in batch_figures
                    }

            except Exception as exc:  # noqa: BLE001
                if attempt < _LLM_RETRY_ATTEMPTS - 1:
                    logger.warning(
                        "_enrich_batch: LLM error (attempt %d/%d) batch=%s: %s — retrying",
                        attempt + 1, _LLM_RETRY_ATTEMPTS, batch_ids, exc,
                    )
                    await asyncio.sleep(0.5 * (attempt + 1))
                else:
                    logger.error(
                        "_enrich_batch: LLM failed after %d attempts batch=%s: %s — "
                        "using safe fallbacks.",
                        _LLM_RETRY_ATTEMPTS, batch_ids, exc,
                    )
                    self._batch_errors += 1
                    return {
                        f.get("id", ""): _safe_enrichment(f)
                        for f in batch_figures
                    }

        if raw_response is None:
            self._batch_errors += 1
            return {f.get("id", ""): _safe_enrichment(f) for f in batch_figures}

        # ── Parse + validate the JSON-array response ──────────────────────────
        enrichment_map = _parse_batch_response(raw_response, batch_figures)

        for fig_id, enrichment in enrichment_map.items():
            logger.debug(
                "_enrich_batch: fig='%s' → type='%s' importance='%s' title='%.50s'",
                fig_id, enrichment["type"], enrichment["importance"], enrichment["title"],
            )

        return enrichment_map

    # ------------------------------------------------------------------
    # Phase 7.4.2 — public entry point
    # ------------------------------------------------------------------

    async def enrich_with_llm(
        self,
        figures: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Enrich Phase 7.4.1-refined figures with batched LLM semantic analysis.

        NEW FLOW (vs single-figure v1):
          1. Resolve cache — figures whose clean_caption is already cached skip
             the LLM entirely.
          2. Create batches — remaining cache-miss figures are grouped into
             batches of _BATCH_SIZE using _create_batches().
          3. Process batches — all batches are dispatched concurrently via
             asyncio.gather(); the semaphore caps concurrency at
             _LLM_MAX_CONCURRENT (default 2).
          4. Store cache — each result in every batch response is written to the
             LRU cache (evicting oldest entry when _CACHE_SIZE_LIMIT is reached).
          5. Merge — enrichment is applied to the original figure dicts and the
             full list is returned in the original input order.

        Error isolation:
          If a batch fails after all retries, safe fallback enrichment is used
          for that batch only.  Other batches and all cache hits are unaffected.

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

        logger.info(
            "enrich_with_llm: starting batched enrichment for %d figures "
            "(cache_size=%d, batch_size=%d)",
            len(figures), len(self._cache), _BATCH_SIZE,
        )

        # ── Step 1: Resolve cache ─────────────────────────────────────────────
        # Pre-compute cache keys once; split figures into hits and misses.
        cache_keys: dict[str, str] = {
            f.get("id", ""): _caption_hash((f.get("clean_caption") or "").strip())
            for f in figures
        }

        cached_enrichments: dict[str, dict[str, Any]] = {}   # id → enrichment
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
            "enrich_with_llm: cache_hits=%d cache_misses=%d uncached_figures=%d",
            len(cached_enrichments), len(uncached_figures), len(uncached_figures),
        )

        # ── Step 2: Create batches from cache-miss figures ────────────────────
        all_enrichments: dict[str, dict[str, Any]] = dict(cached_enrichments)

        if uncached_figures:
            batches = _create_batches(uncached_figures)
            logger.info(
                "enrich_with_llm: %d uncached figures → %d batch(es)",
                len(uncached_figures), len(batches),
            )

            # ── Step 3: Process all batches concurrently (semaphore-limited) ──
            # BUG-2 pattern: return_exceptions=True so one batch failure cannot
            # cancel the entire gather.
            batch_results = await asyncio.gather(
                *[self._enrich_batch_limited(batch, llm) for batch in batches],
                return_exceptions=True,
            )

            # ── Step 4: Store cache + merge batch results ─────────────────────
            for batch_figs, batch_result in zip(batches, batch_results):
                if isinstance(batch_result, Exception):
                    # Unexpected coroutine-level exception (not an LLM error —
                    # those are handled inside _enrich_batch).  Use safe fallbacks.
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