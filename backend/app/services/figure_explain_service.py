# app/services/figure_explain_service.py
"""
figure_explain_service.py
=========================
LLM service layer for:

    POST /api/v1/figure/explain

Responsibilities
----------------
1. Prompt construction  — ``build_explain_prompt()``
   Assembles a tightly scoped, mode-aware prompt from figure metadata.
   Lives here (not in the route) so it can be unit-tested independently.

2. LLM call             — ``FigureExplainService.explain()``
   Async, non-blocking (``asyncio.to_thread``).
   Timeout-protected (``asyncio.wait_for``).
   Provider-pluggable via the existing ``get_llm()`` factory.
   Primary: Groq.  Fallback: Gemini.

3. JSON parsing         — ``_parse_llm_response()``
   Strips markdown fences, parses JSON, validates all required fields.
   Returns safe fallbacks on any parse failure — never raises.

4. In-memory LRU cache  — keyed on ``(figure_id, mode)``
   Avoids duplicate LLM calls for the same figure.
   Size-limited (``_CACHE_MAX_SIZE``) to prevent unbounded memory growth.

Design choices
--------------
* Mirrors the async patterns in ``figure_refiner.py`` exactly
  (``asyncio.to_thread`` + ``asyncio.wait_for``).
* Prompt builder returns a plain string — it has no knowledge of which
  LLM provider is used, keeping the two concerns cleanly separated.
* ``get_llm()`` factory is the only coupling point to provider code —
  swapping providers requires only changing the string argument.
* All LLM errors are caught and converted to safe fallback responses so
  the API always returns a valid ``FigureExplainResponse`` shape, even
  on provider failure.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import textwrap
import time
from collections import OrderedDict
from typing import Any

from app.services.llm.factory import get_llm
from app.schemas.figure_explain import (
    ExplainMode,
    FigureExplainRequest,
    FigureExplainResponse,
    FigureType,
)

logger = logging.getLogger(__name__)


# ============================================================================
# SECTION 1 — CONSTANTS
# ============================================================================

_LLM_TIMEOUT_SECS: int = 25       # fail fast; fallback fires before the request hangs
_CACHE_MAX_SIZE:   int = 512       # (figure_id, mode) pairs kept in LRU memory
_PRIMARY_PROVIDER: str = "groq"    # primary LLM — fast, low latency
_FALLBACK_PROVIDER: str = "gemini" # fallback on primary failure or timeout

# Maximum chars from the caption forwarded to the LLM.
# Long captions are truncated in FigureExplainRequest._truncate_caption (600 chars).
# We double-check here so service is safe even when called directly (not via route).
_CAPTION_MAX_CHARS: int = 600

# Minimum non-empty content required to attempt LLM enrichment.
# If title + description + caption together are shorter than this, the figure
# has too little signal — we return a safe fallback immediately without an LLM call.
_MIN_CONTENT_CHARS: int = 20


# ============================================================================
# SECTION 2 — PROMPT BUILDER
# ============================================================================

# Mode-specific instructions injected into the prompt's TASK block.
_MODE_INSTRUCTIONS: dict[ExplainMode, str] = {
    ExplainMode.QUICK: (
        "Be concise. Provide 1–2 sharp insights. "
        "Skip deep reasoning — the reader wants a fast overview."
    ),
    ExplainMode.DETAILED: (
        "Provide deeper reasoning. Give 3–5 insights covering what the "
        "figure shows, why it is significant, and what it implies for the "
        "research. Use precise language appropriate for a technical reader."
    ),
    ExplainMode.SIMPLE: (
        "Write for a beginner. Avoid jargon — if you must use a technical "
        "term, define it immediately in plain English. Use an analogy if "
        "the concept is abstract. Give 2–3 clear insights."
    ),
}

# Figure-type-specific hint injected when the type is known.
_TYPE_HINTS: dict[FigureType, str] = {
    FigureType.GRAPH:      "This is a graph — comment on trends, axes, and what the shape of the curve reveals.",
    FigureType.DIAGRAM:    "This is a diagram — explain what each component does and how they relate to each other.",
    FigureType.TABLE:      "This is a table — highlight the most important rows/columns and what they reveal when compared.",
    FigureType.IMAGE:      "This is an image — describe what is visually shown and what the researchers intended to illustrate.",
    FigureType.CHART:      "This is a chart — interpret the distribution, proportions, or comparisons shown.",
    FigureType.COMPARISON: "This is a comparison figure — focus on what is being compared, which performs best, and by how much.",
}


def build_explain_prompt(req: FigureExplainRequest) -> str:
    """
    Construct a structured, mode-aware LLM prompt from figure metadata.

    Prompt layout (top-down priority)
    ----------------------------------
    1. System persona     — one line, scoped to research figures.
    2. Figure metadata    — title, description, caption, type, page.
    3. Mode instruction   — depth and tone directive.
    4. Type hint          — optional visual-specific guidance.
    5. Output contract    — strict JSON schema with field descriptions.
    6. Hard rules         — no hallucination, no caption repetition.

    The JSON schema is embedded in the prompt rather than requested as a
    separate system message so it works across Groq, Gemini, and Ollama
    without provider-specific system-message configuration.

    Parameters
    ----------
    req : FigureExplainRequest
        Validated request model.  Caption is already truncated to 600 chars
        by the Pydantic validator.

    Returns
    -------
    str
        Fully formed prompt string ready for any chat-completion backend.
    """
    mode         = req.mode
    fig_type     = req.type
    mode_instr   = _MODE_INSTRUCTIONS[mode]
    type_hint    = _TYPE_HINTS.get(fig_type, "")

    # ── Figure metadata block ─────────────────────────────────────────────────
    # Use the richest available text field for each slot.
    # Fall back gracefully when fields are empty (un-enriched figures).
    title_line       = f"Title:       {req.title}"       if req.title       else "Title:       (not available)"
    description_line = f"Description: {req.description}" if req.description else "Description: (not available)"
    caption_line     = f"Caption:     {req.caption}"     if req.caption     else "Caption:     (not available)"
    type_line        = f"Type:        {fig_type.value}"
    page_line        = f"Page:        {req.page}"        if req.page        else ""

    metadata_lines = [title_line, description_line, caption_line, type_line]
    if page_line:
        metadata_lines.append(page_line)

    metadata_block = "\n".join(metadata_lines)

    # ── Type hint block (optional) ────────────────────────────────────────────
    type_hint_block = f"\nFIGURE-TYPE GUIDANCE:\n{type_hint}\n" if type_hint else ""

    # ── Insight count hint (derived from mode) ────────────────────────────────
    insight_counts = {
        ExplainMode.QUICK:    "1-2",
        ExplainMode.DETAILED: "3-5",
        ExplainMode.SIMPLE:   "2-3",
    }
    insight_count = insight_counts[mode]

    # ── Assemble ──────────────────────────────────────────────────────────────
    return textwrap.dedent(f"""\
        You are an AI research assistant specialising in explaining figures from academic papers.
        Analyse the following figure and produce a structured explanation.

        --- FIGURE METADATA ---
        {metadata_block}
        --- END METADATA ---
        {type_hint_block}
        MODE: {mode.value.upper()}
        INSTRUCTION: {mode_instr}

        OUTPUT RULES (STRICT — violations cause a retry):
        • Do NOT repeat or paraphrase the caption verbatim.
        • Do NOT invent data, numbers, or details not present in the metadata.
        • Do NOT open any field with filler like "Certainly!" or "This figure shows...".
        • summary must be 2-3 sentences that explain what the figure communicates.
        • insights must contain exactly {insight_count} distinct, non-redundant bullet points.
        • simple_explanation must use plain English and be accessible to a non-expert.
        • key_takeaway must be a SINGLE sentence — the most important conclusion.

        Respond ONLY with a valid JSON object — no markdown fences, no preamble, no trailing text.
        The JSON must match this exact schema:

        {{
          "summary":            "<2-3 sentence explanation of what the figure shows>",
          "insights":           ["<insight 1>", "<insight 2>"],
          "simple_explanation": "<beginner-friendly explanation>",
          "key_takeaway":       "<one powerful takeaway sentence>"
        }}
    """)


# ============================================================================
# SECTION 3 — JSON PARSER
# ============================================================================

# Pre-compiled to avoid recompilation on every response.
_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL)


def _parse_llm_response(
    raw:       str,
    figure_id: str,
    mode:      ExplainMode,
) -> FigureExplainResponse:
    """
    Parse and validate the LLM's raw text output into a ``FigureExplainResponse``.

    Strategy
    --------
    1. Strip markdown code fences (```json … ```) if present.
    2. Attempt JSON parse.
    3. Validate required fields — replace missing / empty ones with safe
       fallbacks so the response is always structurally valid.

    This function never raises.  All exceptions are caught and logged;
    the caller receives a gracefully degraded response instead.

    Parameters
    ----------
    raw       : Raw string returned by the LLM.
    figure_id : Echoed into the response.
    mode      : Echoed into the response.

    Returns
    -------
    FigureExplainResponse
        Fully populated response (may contain fallback text on parse failure).
    """
    # ── Strip markdown fences ─────────────────────────────────────────────────
    fence_match = _JSON_FENCE_RE.search(raw)
    clean = fence_match.group(1) if fence_match else raw.strip()

    # ── Attempt JSON parse ────────────────────────────────────────────────────
    try:
        data: dict[str, Any] = json.loads(clean)
    except json.JSONDecodeError as exc:
        logger.warning(
            "_parse_llm_response: JSON decode failed for fig='%s' | error=%s | "
            "raw_preview='%s'",
            figure_id, exc, raw[:120],
        )
        return _safe_response(figure_id, mode)

    # ── Validate + extract fields ─────────────────────────────────────────────
    summary            = _safe_str(data.get("summary"))
    insights           = _safe_list(data.get("insights"))
    simple_explanation = _safe_str(data.get("simple_explanation"))
    key_takeaway       = _safe_str(data.get("key_takeaway"))

    # Apply fallbacks for any field that came back empty
    if not summary:
        logger.warning("_parse_llm_response: missing 'summary' for fig='%s'", figure_id)
        summary = "The figure illustrates key aspects of the research methodology or results."

    if not insights:
        logger.warning("_parse_llm_response: missing 'insights' for fig='%s'", figure_id)
        insights = ["No specific insights could be extracted from the available metadata."]

    if not simple_explanation:
        logger.warning("_parse_llm_response: missing 'simple_explanation' for fig='%s'", figure_id)
        simple_explanation = "This figure visually presents important information from the paper."

    if not key_takeaway:
        logger.warning("_parse_llm_response: missing 'key_takeaway' for fig='%s'", figure_id)
        key_takeaway = "Refer to the caption and surrounding text for full context."

    return FigureExplainResponse(
        figure_id=figure_id,
        mode=mode,
        summary=summary,
        insights=insights,
        simple_explanation=simple_explanation,
        key_takeaway=key_takeaway,
        cached=False,
    )


def _safe_str(value: Any) -> str:
    """Return a stripped string if value is a non-empty string, else ``''``."""
    return str(value).strip() if isinstance(value, str) and value.strip() else ""


def _safe_list(value: Any) -> list[str]:
    """Return a list of non-empty strings if value is a list, else ``[]``."""
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if isinstance(item, str) and str(item).strip()]


def _safe_response(figure_id: str, mode: ExplainMode) -> FigureExplainResponse:
    """Return a gracefully degraded response when parsing fails completely."""
    return FigureExplainResponse(
        figure_id=figure_id,
        mode=mode,
        summary=(
            "The figure could not be automatically explained at this time. "
            "Please refer to the caption and surrounding text in the paper."
        ),
        insights=["Explanation unavailable — the AI response could not be parsed."],
        simple_explanation="This figure appears in the paper and contains relevant information.",
        key_takeaway="Please read the figure caption in the original paper for full context.",
        cached=False,
    )


# ============================================================================
# SECTION 4 — EXPLAIN SERVICE
# ============================================================================

class FigureExplainService:
    """
    Stateless service that calls the LLM and manages the explanation cache.

    Cache
    -----
    LRU, in-memory, size-capped at ``_CACHE_MAX_SIZE`` entries.
    Key: ``(figure_id, mode)`` tuple.
    The cache is instance-level, not process-level, but since the service
    is a module-level singleton (see bottom of this file), it is effectively
    shared across all requests in the same worker.

    LLM Providers
    -------------
    Primary:  Groq (fast, cloud, llama-3.1-8b-instant).
    Fallback: Gemini (triggered on timeout or any exception from Groq).
    Providers are loaded lazily via ``get_llm()`` so startup is not blocked
    by missing API keys — the error surfaces only on the first request.

    Thread Safety
    -------------
    ``asyncio.to_thread`` wraps the synchronous LLM calls so the event loop
    is never blocked.  The LRU cache dict is accessed only in the main
    async coroutine (before/after the thread), so no locking is needed.

    Usage
    -----
        service = FigureExplainService()       # singleton
        response = await service.explain(req)  # from route handler
    """

    def __init__(self) -> None:
        # OrderedDict used as an LRU: move_to_end on hit, popitem(last=False) on evict.
        self._cache: OrderedDict[tuple[str, ExplainMode], FigureExplainResponse] = OrderedDict()

        # Observability counters — cheap, no lock needed (single event loop)
        self._cache_hits:   int = 0
        self._cache_misses: int = 0
        self._llm_calls:    int = 0
        self._llm_errors:   int = 0
        self._fallback_hits: int = 0

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def explain(self, req: FigureExplainRequest) -> FigureExplainResponse:
        """
        Return a structured AI explanation for the given figure.

        Pipeline
        --------
        1. Check in-memory LRU cache — return immediately on hit.
        2. Check if figure has enough content to explain.
        3. Build prompt with ``build_explain_prompt()``.
        4. Call primary LLM (Groq) via ``asyncio.to_thread`` + ``wait_for``.
        5. On timeout or exception → call fallback LLM (Gemini).
        6. Parse + validate LLM response via ``_parse_llm_response()``.
        7. Store in cache.
        8. Return ``FigureExplainResponse``.

        Parameters
        ----------
        req : FigureExplainRequest
            Validated and sanitised request model from the route.

        Returns
        -------
        FigureExplainResponse
            Always returns a valid response — never raises.
        """
        cache_key = (req.figure_id, req.mode)

        # ── 1. Cache hit ──────────────────────────────────────────────────────
        if cache_key in self._cache:
            self._cache_hits += 1
            self._cache.move_to_end(cache_key)
            cached = self._cache[cache_key]
            logger.info(
                "explain: cache hit | fig='%s' mode=%s | "
                "total_hits=%d",
                req.figure_id, req.mode.value, self._cache_hits,
            )
            # Return a copy with cached=True so the caller can see it
            return cached.model_copy(update={"cached": True})

        self._cache_misses += 1

        # ── 2. Content guard — skip LLM for figures with no metadata ─────────
        available_content = " ".join(filter(None, [req.title, req.description, req.caption]))
        if len(available_content.strip()) < _MIN_CONTENT_CHARS:
            logger.warning(
                "explain: insufficient content for fig='%s' (len=%d) — "
                "returning safe fallback",
                req.figure_id, len(available_content),
            )
            return _safe_response(req.figure_id, req.mode)

        # ── 3. Build prompt ───────────────────────────────────────────────────
        prompt = build_explain_prompt(req)
        logger.debug(
            "explain: prompt built | fig='%s' mode=%s | len=%d",
            req.figure_id, req.mode.value, len(prompt),
        )

        # ── 4. Call primary LLM ───────────────────────────────────────────────
        raw_response: str | None = None

        try:
            llm = get_llm(_PRIMARY_PROVIDER)
            start = time.perf_counter()

            raw_response = await asyncio.wait_for(
                asyncio.to_thread(llm, prompt),
                timeout=_LLM_TIMEOUT_SECS,
            )
            self._llm_calls += 1
            elapsed = time.perf_counter() - start
            logger.info(
                "explain: primary LLM ok | fig='%s' provider=%s "
                "mode=%s | %.2fs | response_len=%d",
                req.figure_id, _PRIMARY_PROVIDER,
                req.mode.value, elapsed, len(raw_response or ""),
            )

        except asyncio.TimeoutError:
            self._llm_errors += 1
            logger.warning(
                "explain: primary LLM timeout (>%ds) | fig='%s' — "
                "trying fallback provider=%s",
                _LLM_TIMEOUT_SECS, req.figure_id, _FALLBACK_PROVIDER,
            )

        except Exception as exc:
            self._llm_errors += 1
            logger.warning(
                "explain: primary LLM error for fig='%s': %s — "
                "trying fallback provider=%s",
                req.figure_id, exc, _FALLBACK_PROVIDER,
            )

        # ── 5. Fallback LLM (Gemini) if primary failed ────────────────────────
        if raw_response is None:
            try:
                fallback_llm = get_llm(_FALLBACK_PROVIDER)
                start = time.perf_counter()

                raw_response = await asyncio.wait_for(
                    asyncio.to_thread(fallback_llm, prompt),
                    timeout=_LLM_TIMEOUT_SECS,
                )
                self._fallback_hits += 1
                elapsed = time.perf_counter() - start
                logger.info(
                    "explain: fallback LLM ok | fig='%s' provider=%s "
                    "mode=%s | %.2fs",
                    req.figure_id, _FALLBACK_PROVIDER,
                    req.mode.value, elapsed,
                )

            except Exception as exc:
                # Both providers failed — return safe fallback response
                self._llm_errors += 1
                logger.error(
                    "explain: both providers failed for fig='%s': %s — "
                    "returning safe fallback",
                    req.figure_id, exc,
                )
                return _safe_response(req.figure_id, req.mode)

        # ── 6. Parse + validate ───────────────────────────────────────────────
        response = _parse_llm_response(raw_response, req.figure_id, req.mode)

        # ── 7. Cache result ───────────────────────────────────────────────────
        self._cache[cache_key] = response
        self._cache.move_to_end(cache_key)

        # Evict LRU entry if over size limit
        if len(self._cache) > _CACHE_MAX_SIZE:
            evicted_key, _ = self._cache.popitem(last=False)
            logger.debug(
                "explain: LRU eviction | evicted_key=%s",
                evicted_key,
            )

        logger.info(
            "explain: done | fig='%s' mode=%s | cache_size=%d",
            req.figure_id, req.mode.value, len(self._cache),
        )
        return response

    # ------------------------------------------------------------------
    # Observability
    # ------------------------------------------------------------------

    def get_metrics(self) -> dict[str, Any]:
        """Return cache + LLM call statistics for monitoring / debug endpoints."""
        total = self._cache_hits + self._cache_misses
        return {
            "cache_hits":    self._cache_hits,
            "cache_misses":  self._cache_misses,
            "cache_size":    len(self._cache),
            "cache_hit_rate": round(self._cache_hits / total * 100, 1) if total else 0.0,
            "llm_calls":     self._llm_calls,
            "llm_errors":    self._llm_errors,
            "fallback_hits": self._fallback_hits,
        }

    def clear_cache(self) -> int:
        """Flush the explanation cache.  Returns number of entries cleared."""
        count = len(self._cache)
        self._cache.clear()
        logger.info("explain: cache cleared (%d entries)", count)
        return count


# ---------------------------------------------------------------------------
# Module-level singleton — safe to share across all requests in one process.
# Stateless per-request; only the cache dict accumulates state.
# ---------------------------------------------------------------------------
explain_service = FigureExplainService()