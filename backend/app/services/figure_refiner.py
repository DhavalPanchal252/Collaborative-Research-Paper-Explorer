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
    · MD5 caption-hash cache (LRU, size-limited) avoids duplicate LLM calls
    · Strict 3-layer JSON validation + typed fallbacks
    · Per-figure error isolation + configurable retry + timeout

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
_LLM_RETRY_ATTEMPTS: int = 2       # retries on transient failures
_LLM_TIMEOUT_SECS:   int = 15      # per-call hard timeout
_LLM_MAX_CONCURRENT: int = 2       # semaphore width (rate limiting)

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

    text = re.sub(r"\s+", " ", caption).strip()
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


def _build_enrichment_prompt(fig: dict[str, Any]) -> str:
    """Construct a strict, domain-agnostic LLM enrichment prompt.

    BUG-6 FIX: Uses the full raw caption (capped at 600 chars) as the primary
    LLM signal instead of the 200-char display caption.  This prevents the LLM
    from mis-classifying figures whose captions were truncated during cleaning.

    Args:
        fig: Phase 7.4.1-refined figure dict.

    Returns:
        Fully-formed prompt string.  Instructs the model to return raw JSON
        only — no fences, no prose — so the response passes to json.loads()
        directly.
    """
    fig_id   = fig.get("id", "unknown")
    raw      = (fig.get("caption") or "").strip()
    clean    = (fig.get("clean_caption") or "").strip()

    # BUG-6 FIX: prefer full raw caption for LLM context (more signal).
    # Cap at _LLM_CAPTION_MAX_CHARS to avoid context overflow.
    if raw and raw.lower() != "no caption":
        llm_caption = raw[:_LLM_CAPTION_MAX_CHARS]
        if len(raw) > _LLM_CAPTION_MAX_CHARS:
            llm_caption += "…"
    else:
        llm_caption = clean or "(no caption)"

    return (
        "You are a scientific figure analyst. "
        "Analyse the figure caption below and return ONLY a JSON object. "
        "No markdown, no code fences, no explanation — raw JSON only.\n\n"
        f"Figure ID: {fig_id}\n"
        f"Caption:\n\"\"\"\n{llm_caption}\n\"\"\"\n\n"
        "Return a JSON object with EXACTLY these four keys:\n"
        "{\n"
        '  "title":       "<concise, informative title, max 12 words>",\n'
        '  "type":        "<one of: diagram | graph | chart | table | comparison | image | other>",\n'
        '  "description": "<1–3 sentence plain-English description of what this figure shows>",\n'
        '  "importance":  "<one of: low | medium | high>"\n'
        "}\n\n"
        "RULES:\n"
        "• title  — specific and descriptive; NOT generic like 'Research Figure'.\n"
        "• type   — pick the single best match from the allowed list.\n"
        "• description — describe what the figure SHOWS, not the paper's topic.\n"
        "• importance — high = central result/method; medium = supporting; low = supplementary.\n"
        "• If the caption is absent or uninformative, use your best inference.\n"
        "• Output ONLY the JSON object. Nothing else."
    )


def _safe_enrichment(fallback: dict[str, Any]) -> dict[str, Any]:
    """Return safe placeholder enrichment when LLM response cannot be parsed."""
    return {
        "title":       fallback.get("title", "Untitled Figure"),
        "type":        "other",
        "description": fallback.get("description", ""),
        "importance":  fallback.get("importance", _UNKNOWN),
    }


def _parse_llm_response(raw_response: str, fallback: dict[str, Any]) -> dict[str, Any]:
    """Parse and validate the LLM JSON response with three defence layers.

    Layer 1 — Strip markdown fences.
    Layer 2 — JSON parse; fallback to extracting first {...} block.
    Layer 3 — Per-field validation; replace invalid values with safe defaults.

    Returns:
        Dict with ``title``, ``type``, ``description``, ``importance`` —
        all guaranteed non-None and schema-conformant.
    """
    # ── Layer 1: strip markdown wrappers ─────────────────────────────────────
    cleaned = raw_response.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```$",          "", cleaned).strip()

    # ── Layer 2: JSON parse ──────────────────────────────────────────────────
    data: dict | None = None
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", cleaned, re.DOTALL)
        if match:
            try:
                data = json.loads(match.group())
            except json.JSONDecodeError:
                pass

    if data is None:
        logger.warning("_parse_llm_response: JSON parse failed — using safe fallback.")
        return _safe_enrichment(fallback)

    # ── Layer 3: per-field validation ─────────────────────────────────────────
    title: str = str(data.get("title") or "").strip()
    if not title:
        title = fallback.get("title", "Untitled Figure")

    fig_type: str = str(data.get("type") or "").strip().lower()
    if fig_type not in _ALLOWED_TYPES:
        logger.debug(
            "_parse_llm_response: type '%s' not allowed — defaulting to 'other'.",
            fig_type,
        )
        fig_type = "other"

    description: str = str(data.get("description") or "").strip()
    if not description:
        description = fallback.get("description", "")
    if len(description) > _DESCRIPTION_MAX_CHARS:
        description = description[:_DESCRIPTION_MAX_CHARS].rstrip() + "…"

    importance: str = str(data.get("importance") or "").strip().lower()
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


# ============================================================================
# SECTION 4 — PUBLIC CLASS
# ============================================================================

class FigureRefiner:
    """Two-phase figure refinement pipeline.

    Phase 7.4.1 — ``refine(figures)``
        Heuristic caption cleaning, title generation, quality / confidence.
        ⚠ LLM fields remain ``"unknown"`` / ``""`` after this phase alone.

    Phase 7.4.2 — ``enrich_with_llm(refined_figures)``
        LLM-backed enrichment: fills title, type, description, importance.
        LRU cache (size-limited) avoids repeated calls for the same caption.
        Per-figure error isolation — one LLM failure never aborts the batch.
        Parallel execution with semaphore-based rate limiting.

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
        # BUG-4 FIX: removed _cache_timestamp (was allocated but never used)

        # BUG-1 FIX: Semaphore is NOT created here.
        # asyncio.Semaphore() requires a running event loop.  Creating it in
        # __init__ (called at import/startup time, outside any loop) causes
        # DeprecationWarning in Python ≥3.10 and RuntimeError in ≥3.12 when
        # the semaphore is later used in FastAPI's event loop.
        # Solution: lazy property — initialised on first async call.
        self._llm_semaphore: asyncio.Semaphore | None = None

        # Observability counters
        self._llm_calls:    int = 0
        self._llm_timeouts: int = 0
        self._cache_hits:   int = 0
        self._cache_misses: int = 0

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
    # Phase 7.4.2
    # ------------------------------------------------------------------

    async def enrich_with_llm(
        self,
        figures: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Enrich Phase 7.4.1-refined figures with LLM semantic understanding.

        For each figure:
          1. Hash ``clean_caption`` and check LRU cache.
          2. Cache hit  → merge cached enrichment, skip LLM.
          3. Cache miss → call LLM (with retry + timeout), validate JSON, cache.
          4. Any error  → log it, return figure with 7.4.1 placeholder values.

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
            "enrich_with_llm: starting enrichment for %d figures (cache_size=%d)",
            len(figures), len(self._cache),
        )

        # BUG-2 FIX: return_exceptions=True so one failure does not cancel
        # the entire gather.  Exceptions are handled per-item below.
        raw_results = await asyncio.gather(
            *[self._enrich_one_limited(fig, llm) for fig in figures],
            return_exceptions=True,
        )

        # Resolve exceptions: fall back to original figure on unexpected error
        enriched: list[dict[str, Any]] = []
        for fig, result in zip(figures, raw_results):
            if isinstance(result, Exception):
                logger.error(
                    "enrich_with_llm: unexpected error for fig='%s': %s — "
                    "returning Phase 7.4.1 output.",
                    fig.get("id"), result,
                )
                enriched.append(fig)
            else:
                enriched.append(result)

        logger.info(
            "enrich_with_llm: complete | total=%d | cache_size=%d | "
            "hits=%d | misses=%d | llm_calls=%d | timeouts=%d",
            len(enriched), len(self._cache),
            self._cache_hits, self._cache_misses,
            self._llm_calls, self._llm_timeouts,
        )
        return enriched

    async def _enrich_one_limited(
        self,
        fig: dict[str, Any],
        llm: Any,
    ) -> dict[str, Any]:
        """Run _enrich_one() under the concurrency semaphore.

        BUG-1 FIX: Semaphore obtained via _get_semaphore() (lazy init inside
        running event loop) instead of from __init__.
        """
        async with self._get_semaphore():
            return await self._enrich_one(fig, llm)

    async def _enrich_one(
        self,
        fig: dict[str, Any],
        llm: Any,
    ) -> dict[str, Any]:
        """Enrich a single figure; isolated so failures cannot affect siblings.

        Features:
          · Non-blocking LLM call via asyncio.to_thread()
          · Configurable retry with backoff for transient failures
          · Hard timeout per call
          · LRU cache eviction at _CACHE_SIZE_LIMIT

        Args:
            fig: Phase 7.4.1-refined figure dict.
            llm: Callable LLM instance (GroqLLM, OllamaLLM, …).

        Returns:
            Figure dict with LLM-owned fields merged in.
            Returns original dict unchanged on any unrecoverable error.
        """
        clean     = (fig.get("clean_caption") or "").strip()
        cache_key = _caption_hash(clean)

        # ── Cache hit ─────────────────────────────────────────────────────────
        if cache_key in self._cache:
            self._cache_hits += 1
            self._cache.move_to_end(cache_key)  # refresh LRU position
            logger.debug(
                "_enrich_one: cache hit  fig='%s' key=%s…",
                fig.get("id"), cache_key[:8],
            )
            return {**fig, **self._cache[cache_key]}

        # ── LLM call with retry ───────────────────────────────────────────────
        self._cache_misses += 1
        prompt = _build_enrichment_prompt(fig)
        # BUG-5 FIX: Removed 4 print() debug statements; use logger.debug()
        logger.debug("_enrich_one: prompt built for fig='%s' (%d chars)", fig.get("id"), len(prompt))

        raw_response: str | None = None

        for attempt in range(_LLM_RETRY_ATTEMPTS):
            try:
                self._llm_calls += 1
                raw_response = await asyncio.wait_for(
                    asyncio.to_thread(llm, prompt=prompt),
                    timeout=_LLM_TIMEOUT_SECS,
                )
                logger.debug(
                    "_enrich_one: LLM response  fig='%s' (%d chars)",
                    fig.get("id"), len(raw_response or ""),
                )
                # Add delay after each successful call to rate-limit LLM
                await asyncio.sleep(1)
                break  # success

            except asyncio.TimeoutError:
                self._llm_timeouts += 1
                if attempt < _LLM_RETRY_ATTEMPTS - 1:
                    logger.warning(
                        "_enrich_one: timeout (attempt %d/%d) fig='%s' — retrying",
                        attempt + 1, _LLM_RETRY_ATTEMPTS, fig.get("id"),
                    )
                    await asyncio.sleep(0.5 * (attempt + 1))
                else:
                    logger.error(
                        "_enrich_one: timeout after %d attempts fig='%s'",
                        _LLM_RETRY_ATTEMPTS, fig.get("id"),
                    )
                    return fig

            except Exception as exc:  # noqa: BLE001
                if attempt < _LLM_RETRY_ATTEMPTS - 1:
                    logger.warning(
                        "_enrich_one: LLM error (attempt %d/%d) fig='%s': %s — retrying",
                        attempt + 1, _LLM_RETRY_ATTEMPTS, fig.get("id"), exc,
                    )
                    await asyncio.sleep(0.5 * (attempt + 1))
                else:
                    logger.error(
                        "_enrich_one: LLM failed after %d attempts fig='%s': %s",
                        _LLM_RETRY_ATTEMPTS, fig.get("id"), exc,
                    )
                    return fig

        if raw_response is None:
            return fig

        # ── Parse + validate ──────────────────────────────────────────────────
        enrichment = _parse_llm_response(raw_response, fallback=fig)
        logger.debug(
            "_enrich_one: fig='%s' → type='%s' importance='%s' title='%.50s'",
            fig.get("id"), enrichment["type"], enrichment["importance"], enrichment["title"],
        )

        # ── LRU cache store ───────────────────────────────────────────────────
        self._cache[cache_key] = enrichment
        self._cache.move_to_end(cache_key)
        if len(self._cache) > _CACHE_SIZE_LIMIT:
            evicted, _ = self._cache.popitem(last=False)
            logger.debug("_enrich_one: LRU eviction key=%s…", evicted[:8])

        return {**fig, **enrichment}

    # ------------------------------------------------------------------
    # Combined convenience  ← USE THIS IN figure_routes.py  (BUG-7 FIX)
    # ------------------------------------------------------------------

    async def refine_and_enrich(
        self,
        figures: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Run Phase 7.4.1 heuristics then Phase 7.4.2 LLM enrichment.

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
        """Return current performance and cache statistics."""
        total = self._cache_hits + self._cache_misses
        return {
            "llm_calls":      self._llm_calls,
            "llm_timeouts":   self._llm_timeouts,
            "cache_hits":     self._cache_hits,
            "cache_misses":   self._cache_misses,
            "cache_size":     len(self._cache),
            "cache_hit_rate": round(self._cache_hits / total * 100, 1) if total else 0.0,
        }

    def reset_metrics(self) -> None:
        """Reset all metrics counters (useful for per-batch benchmarking)."""
        self._llm_calls    = 0
        self._llm_timeouts = 0
        self._cache_hits   = 0
        self._cache_misses = 0