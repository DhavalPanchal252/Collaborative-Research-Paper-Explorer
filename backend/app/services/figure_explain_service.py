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

_LLM_TIMEOUT_SECS: int = 20       # fail fast; fallback fires before the request hangs
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

# ---------------------------------------------------------------------------
# 2a. Mode-specific instructions
# ---------------------------------------------------------------------------
# Each entry teaches the model *how to think* for that mode, not just
# how many bullets to produce. The framing shifts the model's internal
# reasoning posture, which produces qualitatively different outputs.

_MODE_INSTRUCTIONS: dict[ExplainMode, str] = {
    ExplainMode.QUICK: textwrap.dedent("""\
        MODE: QUICK SCAN
        ----------------
        The reader has 10 seconds. Your job is to give them the single most
        useful thing to know about this figure — fast.

        - Write 1–2 insights maximum. Each must be a standalone observation
          that could not be inferred from the caption alone.
        - summary: 1 tight sentence. No setup. No "this figure shows".
          Lead with the finding, not the description.
        - simple_explanation: 1–2 sentences. Imagine explaining to a
          smart friend who skimmed the paper.
        - key_takeaway: the ONE sentence a reader should remember.
        - Do NOT pad. Fewer words is better here."""),

    ExplainMode.DETAILED: textwrap.dedent("""\
        MODE: DEEP EXPLANATION
        ----------------------
        The reader wants to *understand*, not just be informed.
        Think like a PhD advisor explaining this to a first-year student.

        - Write 3–5 insights. CRITICAL: Each belongs in ONE category ONLY.
          Insights MUST be in separate boxes — no bleeding between them.

          STRICT DIMENSIONAL SEPARATION (each insight addresses ONE only):
            DIMENSION 1 — MECHANISM: How does this work technically?
                          Focus on the approach, structure, or algorithm.
                          (e.g., masks partition regions, how data flows)
                          Do NOT include comparison or benefits here.
            
            DIMENSION 2 — COMPARISON: How is this different from standard?
                          Focus on what changed relative to prior work.
                          (e.g., "unlike global transfer, this is regional")
                          Do NOT duplicate the mechanism or benefits here.
            
            DIMENSION 3 — IMPLICATION / BENEFIT: Why does this matter?
                          Focus on what it enables, unlocks, or solves.
                          (e.g., "users can now control style per-region")
                          Do NOT re-explain the mechanism here.
            
            DIMENSION 4+ (optional): Technical behavior, limitations, or
                          design implications. (e.g., "independence of
                          regions enables parallel processing")

          CRITICAL TEST: If you remove the insight, does Dimension 2 or 3
          still make sense? If yes, you've repeated yourself. REWRITE.

          ✗ BAD (Repetition across dimensions):
            Dimension 1: "Uses masks to partition regions."
            Dimension 3: "Masks partition regions, enabling control."
            ❌ Both mention masks + partition. REJECTED.

          ✓ GOOD (Truly separate):
            Dimension 1: "Masks independently partition the image into
                        disjoint style regions, each processed separately."
            Dimension 2: "Unlike traditional global style transfer, this
                        approach enables spatial granularity."
            Dimension 3: "Users can now apply different styles to different
                        image regions without affecting others."
            ✅ Zero overlap. Each stands alone.

        - summary: 2–3 sentences. NEVER open with 'This figure shows',
          'X is achieved through Y', or other template openers.
          Instead: directly state the KEY INSIGHT or unique property.
          Avoid generic language — be specific to THIS figure.
        - simple_explanation: Restate the core MECHANISM in everyday terms.
          An analogy is encouraged — but ground it in the actual data pattern.
        - key_takeaway: Distil the MECHANISM into ONE sentence that would
          survive being quoted out of context. Name the design choice, not just
          the result.
        - Prioritise WHY and SO WHAT (mechanism and implication) over WHAT."""),

    ExplainMode.SIMPLE: textwrap.dedent("""\
        MODE: PLAIN ENGLISH
        -------------------
        The reader is new to this topic. Your job is to build intuition,
        not deliver precision.

        - Write 2–3 insights. Each must be jargon-free. If a technical term
          is unavoidable, define it inline in one clause.
        - Use one concrete analogy somewhere in simple_explanation —
          pick something from everyday life (cooking, sports, maps, music).
        - summary: 2 sentences max. Short words. Short sentences.
          A 16-year-old should be able to follow it.
        - key_takeaway: 1 sentence. Plain English. No acronyms.
        - Do NOT water down the insight — being simple does not mean being
          vague. Be precise, just in accessible language."""),
}

# ---------------------------------------------------------------------------
# 2b. Type-specific reasoning instructions
# ---------------------------------------------------------------------------
# These go beyond "what to look for" (the old hint) and tell the model
# *how to reason* about each figure type. The difference matters:
# observation → reasoning → insight.

_TYPE_REASONING: dict[FigureType, str] = {
    FigureType.GRAPH: textwrap.dedent("""\
        GRAPH / LINE PLOT REASONING:
        1. Identify what the X-axis and Y-axis represent — name the quantities
           and their units if stated. Do not skip this.
        2. Describe the shape of the curve(s): monotonic? plateauing?
           oscillating? diverging? Name which line represents what.
        3. Locate the inflection point or the most significant region.
           What happens there and why does it matter? Focus on WHAT CHANGES.
        4. If multiple lines exist, explain what their separation, convergence,
           or divergence MEANS mechanically — why does one lead? What causes
           the gap to widen or narrow? Do not just describe the gap, explain it.
        5. State the MECHANISM underlying the trend: what design choice,
           data property, or algorithmic difference causes the observed pattern?
           The trend is evidence; your job is to name what it is evidence of."""),

    FigureType.CHART: textwrap.dedent("""\
        CHART / BAR / PIE REASONING:
        1. Name what is being measured and how it is broken down
           (categories, groups, time periods).
        2. Identify the dominant category or the most surprising proportion.
        3. Highlight the gap between the best and worst performer —
           is it marginal or substantial? That difference has meaning.
        4. Explain what the distribution pattern implies (skewed?
           balanced? concentrated?).
        5. Connect the chart's conclusion to the paper's hypothesis:
           does this chart confirm, challenge, or nuance it?"""),

    FigureType.DIAGRAM: textwrap.dedent("""\
        DIAGRAM / VISUAL PROCESS REASONING:
        1. Identify what transformation is being shown (not just components).
        2. If masks or regions are present:
           - explain how different regions are treated differently
           - what each region represents
        3. Describe how input changes into output.
        4. Focus on WHAT changes and WHERE (spatial behavior).
        5. Explain what capability this enables (e.g., control, flexibility).
        Avoid treating this as a neural network architecture unless clearly shown."""),

    FigureType.IMAGE: textwrap.dedent("""\
        IMAGE / VISUAL OUTPUT REASONING:
        1. Identify what the image is showing — is it raw input, processed
           output, intermediate result, or a comparison across conditions?
        2. Describe the most salient visual difference between examples
           (if multiple are shown). Be specific: texture, sharpness,
           artefacts, completeness, colour fidelity.
        3. State what that visual difference *demonstrates* — is it showing
           improvement, degradation, a failure mode, or a qualitative shift?
        4. If there is a baseline vs. proposed comparison, name which is
           better and in what specific way.
        5. Note any visual artefact, edge case, or failure visible in the
           image that the authors may be drawing attention to (or glossing over)."""),

    FigureType.TABLE: textwrap.dedent("""\
        TABLE REASONING:
        1. Identify what each row and column represent — methods/models
           as rows, metrics as columns (or vice versa).
        2. Find the best-performing row on the primary metric. By how much
           does it lead? Is the margin meaningful or marginal?
        3. Find the biggest *unexpected* result: a method that beats
           expectations, or a metric where rankings reverse.
        4. Highlight trade-offs: does the best method on metric A lose on
           metric B? This is usually the most interesting story in a table.
        5. State what conclusion the full table is designed to support.
           Tables in papers are not neutral — they are arguments."""),

    FigureType.COMPARISON: textwrap.dedent("""\
        COMPARISON FIGURE REASONING:
        1. Identify *exactly* what is being compared: methods, models,
           hyper-parameters, conditions, or outputs?
        2. Identify the single most important difference in the results.
           Do not list everything — pick the one that matters most.
        3. Explain *why* that difference exists, not just that it does.
           What design choice, data property, or algorithm causes it?
        4. Identify any case where the expected winner does not win —
           those reversals reveal the limits of the proposed method.
        5. State what this comparison proves in the context of the paper's
           contribution. Is it ablation? Baseline comparison? Robustness check?"""),
}

# Fallback for FigureType.OTHER / FigureType.UNKNOWN
_TYPE_REASONING_FALLBACK: str = textwrap.dedent("""\
    UNKNOWN / OTHER FIGURE REASONING:
    The type of this figure is not specified. Reason from the metadata:
    1. Infer the most likely figure type from the title, description,
       and caption. State your inference at the start of the summary.
    2. Apply the reasoning approach most appropriate for your inferred type.
    3. If the figure type is genuinely ambiguous, focus on PURPOSE:
       what argument is this figure making in the paper?
    4. Avoid over-specific assumptions — prefer confident general insights
       over uncertain specific ones.""")


# ---------------------------------------------------------------------------
# 2c. Shared negative examples (few-shot anti-patterns)
# ---------------------------------------------------------------------------
# These are concrete examples of BAD output. Showing the model what NOT to
# produce is often more effective than abstract rules alone.

_ANTI_PATTERNS: str = textwrap.dedent("""\
    ANTI-PATTERNS — outputs like these will be rejected:

    BAD summary (meta-commentary, generic openers):
      "This figure shows..." "The figure illustrates..." "The figure
       demonstrates..." "In this figure, we see..." "As shown here..."
    GOOD summary (mechanism-first, no meta-commentary):
      "Normalizing contrast at each layer helps the IN model separate
       style from content — the widening gap against BN proves this
       architectural choice scales better as training data grows."

    BAD insight (restates caption, no interpretation):
      "The figure presents encoder and decoder components connected by
       cross-attention layers."
    GOOD insight (mechanism + implication):
      "Inserting cross-attention at every block, rather than only at the
       final layer, lets the model course-correct domain shift incrementally —
       this is the architectural bet the paper is making."

    BAD key_takeaway (vague, could apply to any paper):
      "The method performs well and is an important contribution."
    GOOD key_takeaway (specific mechanism, actionable):
      "Per-block contrast normalization enables the model to adapt style
       more effectively than batch normalization with 3x less overfitting risk."

    BAD simple_explanation (analogy disconnected from graph):
      "An analogy about a smart artist, but doesn't explain the curves."
    GOOD simple_explanation (analogy grounded in data):
      "Think of it like adjusting the contrast on a photo at each step — the
       more often you adjust (at each layer), the better the final image,
       which is why the IN curve keeps pulling away from BN.""")


# ---------------------------------------------------------------------------
# 2d. Prompt assembler
# ---------------------------------------------------------------------------

def build_explain_prompt(req: FigureExplainRequest) -> str:
    """
    Construct a structured, mode-aware LLM prompt from figure metadata.

    Prompt layout (top-down)
    ------------------------
    1. Role + mission statement  — scoped persona, NOT to summarise
    2. Figure metadata           — all available fields, labelled
    3. Chain-of-thought scaffold — 4 guided reasoning questions
    4. Type-specific reasoning   — how to analyse THIS kind of figure
    5. Mode instruction          — depth, tone, insight count
    6. Anti-patterns             — few-shot negative examples
    7. Output contract           — strict JSON schema with field rules
    8. Final hard rules          — repeated for emphasis at the end

    Parameters
    ----------
    req : FigureExplainRequest
        Validated request model. Caption is already truncated to 600 chars.

    Returns
    -------
    str
        Fully formed prompt string ready for any chat-completion backend.
    """
    mode       = req.mode
    fig_type   = req.type
    mode_instr = _MODE_INSTRUCTIONS[mode]
    type_logic = _TYPE_REASONING.get(fig_type, _TYPE_REASONING_FALLBACK)

    # ── Dynamic shortening to prevent token explosion ─────────────────────
    safe_caption = ""
    if req.caption:
        safe_caption = req.caption[:300] + "..." if len(req.caption) > 300 else req.caption

    safe_desc = ""
    if req.description:
        safe_desc = req.description[:250] + "..." if len(req.description) > 250 else req.description

    # ── Metadata block — rich labelling, graceful fallback ────────────────
    title_line       = f"Title:       {req.title}"       if req.title       else "Title:       (not provided)"
    description_line = f"Description: {safe_desc}"       if safe_desc       else "Description: (not provided)"
    caption_line     = f"Caption:     {safe_caption}"    if safe_caption    else "Caption:     (not provided)"
    type_line        = f"Type:        {fig_type.value}"
    page_line        = f"Page:        {req.page}"        if req.page        else ""

    meta_lines = [title_line, description_line, caption_line, type_line]
    if page_line:
        meta_lines.append(page_line)
    metadata_block = "\n".join(meta_lines)

    # ── Grounding block — strict anti-hallucination constraint ────────────────
    GROUNDING_BLOCK = textwrap.dedent("""\
        ════════════════════════════════════════════════════════
        STRICT GROUNDING (CRITICAL)
        ════════════════════════════════════════════════════════

        You MUST base your explanation ONLY on the provided metadata:
        Title, Description, Caption, and Type.

        DO NOT:
        - introduce concepts not present in the metadata
        - reference other figures from the paper
        - assume training details or architecture unless explicitly stated
        - use prior knowledge about the paper if not mentioned here

        If the metadata is limited:
        - make the best possible inference
        - stay conservative
        - DO NOT hallucinate missing details

        If the figure mentions masks, regions, or spatial control:
        focus ONLY on region-wise transformations and masking behavior.

        Your answer will be rejected if it includes unrelated concepts.
        """)

    # ── Insight count derived from mode ────────────────────────────────────
    insight_counts = {
        ExplainMode.QUICK:    "1–2",
        ExplainMode.DETAILED: "3–5",
        ExplainMode.SIMPLE:   "2–3",
    }
    insight_count = insight_counts[mode]

    # ── Assemble ───────────────────────────────────────────────────────────
    return textwrap.dedent(f"""\
        ════════════════════════════════════════════════════════
        ROLE
        ════════════════════════════════════════════════════════
        You are an expert AI research assistant who specialises in helping
        students deeply understand figures from academic papers.

        Your mission is NOT to summarise. It is to unlock meaning.
        A student reading your output should think:
        "I finally understand WHY this figure is here and what it proves."

        ════════════════════════════════════════════════════════
        FIGURE METADATA
        ════════════════════════════════════════════════════════
        {metadata_block}

        {GROUNDING_BLOCK}

        ════════════════════════════════════════════════════════
        STEP 1 — THINK (internal reasoning, not in output)
        ════════════════════════════════════════════════════════
        Before writing a single output field, reason through these four
        questions silently. Your answers will shape every field below.

        Q1. PURPOSE — Why did the authors include this figure?
            What specific claim or result is it meant to support?

        Q2. MECHANISM — What relationship, pattern, or transformation
            does it demonstrate? What is the independent and dependent
            variable (or cause and effect)?

        Q3. SIGNIFICANCE — What would be missing from the paper if this
            figure were deleted? What does it prove that text alone cannot?

        Q4. STUDENT TRAP — What is the most likely misconception a student
            will form by looking at this figure without expert guidance?
            Your explanation must preemptively correct that misconception.

        ════════════════════════════════════════════════════════
        STEP 2 — FIGURE-TYPE REASONING
        ════════════════════════════════════════════════════════
        {type_logic}

        ════════════════════════════════════════════════════════
        STEP 3 — MODE INSTRUCTIONS
        ════════════════════════════════════════════════════════
        {mode_instr}

        The insights array must contain exactly {insight_count} items.
        Each insight must be distinct — no overlap in content or angle.

        ════════════════════════════════════════════════════════
        STEP 4 — AVOID THESE ANTI-PATTERNS
        ════════════════════════════════════════════════════════
        {_ANTI_PATTERNS}

        ════════════════════════════════════════════════════════
        FINAL SELF-CHECK (MANDATORY)
        ════════════════════════════════════════════════════════
        Before returning your response, verify:

        - Does every insight directly relate to the given metadata?
        - Did I introduce any concept not mentioned?
        - Would this explanation still make sense if the figure changed?

        If the answer to any question is NO, FIX it before returning.

        ════════════════════════════════════════════════════════
        OUTPUT CONTRACT
        ════════════════════════════════════════════════════════
        Return ONLY a valid JSON object — no markdown fences, no preamble,
        no trailing commentary. The object must match this exact schema:

        {{
          "summary":            "<See field rules below>",
          "insights":           ["<insight 1>", "<insight 2>", ...],
          "simple_explanation": "<See field rules below>",
          "key_takeaway":       "<See field rules below>"
        }}

        Field rules:
        • summary            — {_FIELD_RULES["summary"]}
        • insights           — {_FIELD_RULES["insights"].format(insight_count=insight_count)}
        • simple_explanation — {_FIELD_RULES["simple_explanation"]}
        • key_takeaway       — {_FIELD_RULES["key_takeaway"]}

        ════════════════════════════════════════════════════════
        HARD RULES (violations invalidate the response)
        ════════════════════════════════════════════════════════
        ✗ Do NOT open summary or any field with:
          - "This figure shows"
          - "The figure illustrates"
          - "The figure demonstrates" ← THIS IS CRITICAL
          - "In this figure", "As shown here", "We see"
          These are meta-commentary that wastes words. Lead with MECHANISM.

        ✗ Do NOT copy or paraphrase the caption verbatim.
        ✗ Do NOT invent numbers, statistics, or details not in the metadata.
        ✗ Do NOT use filler openers: "Certainly!", "Great question", "Sure".
        ✗ Do NOT produce vague or generic statements that could apply to
          any figure in any paper (e.g., "The method works well...").
        ✗ Do NOT write insights that merely restate the caption or title.

        ════════════════════════════════════════════════════════
        TECHNICAL LENS MANDATE (CRITICAL FOR DEPTH)
        ════════════════════════════════════════════════════════
        At least ONE insight must explain HOW THE MODEL BEHAVES internally,
        not just what the user gets.

        ✗ SHALLOW (user-facing benefit only):
          "Users can apply different styles to different regions."
        
        ✓ DEEP (model behavior + mechanism):
          "Masks enforce independence: each region's style transfer
           is computed separately, preventing style bleeding between
           regions and enabling fine-grained spatial control."

        EXAMPLES OF TECHNICAL LENS:
        • How regions are separated or isolated
        • How the model processes data within each region
        • Computational independence or parallelization opportunity
        • Why this architectural choice prevents failure modes
        • Internal constraints that enable external benefits

        Without at least one technical insight, your explanation is incomplete.
        Students should understand not just WHAT the figure does,
        but HOW the model makes it happen.

        ════════════════════════════════════════════════════════
        INSIGHT DIVERSITY RULES (CRITICAL FOR PRODUCTION)
        ════════════════════════════════════════════════════════
        MANDATORY: Insights must provide different angles, NOT rewording.

        ✗ ANTI-PATTERN (Multiple insights that are the same idea):
          Insight 1: "Masks enable regional control of style."
          Insight 2: "Masks allow selective style transfer to regions."
          Insight 3: "Masks provide regional style control."
          ❌ These are identical — just different words. REJECTED.

        ✓ GOOD (Different angles on the same capability):
          Insight 1: "The mechanism uses binary masks to partition the image
                      into independent regions for style transfer."
          Insight 2: "This differs from prior work by enabling SPATIAL control,
                      whereas traditional style transfer applies globally."
          Insight 3: "This enables users to apply different artistic styles
                      to different parts of the same image — unlocking fine-grained
                      creative control."
          ✅ Same capability, three different perspectives.

        DIVERSITY CHECKLIST (before returning):
        1. Does each insight live in ONE dimension only?
           (Mechanism ≠ Comparison ≠ Implication ≠ Technical Behavior)
           If insight 1 mentions "masks enable control", check that insights
           2 and 3 do NOT mention masks + control combination.
        
        2. Remove all keywords (masks, regions, style, transfer) — do
           insights still sound different? If they collapse to the same
           idea, they fail dimensional separation. REWRITE.
        
        3. At least ONE insight must explain MODEL BEHAVIOR (technical),
           not just user benefit or architectural comparison.
        
        4. If all insights feel similar, rewrite them until they diverge.

        ════════════════════════════════════════════════════════
        RELEVANCE FILTER (ANTI-HALLUCINATION SHIELD)
        ════════════════════════════════════════════════════════
        ✗ Do NOT mention concepts not present in metadata
          (e.g., if no curves → do not talk about training graphs)

        ✗ If your explanation could apply to a different figure,
          it is WRONG — make it specific to THIS figure

        ════════════════════════════════════════════════════════

        ✓ Every sentence must earn its place — specific, grounded in the
          metadata, and focused on MECHANISM (WHY, not just WHAT).
        ✓ Analogies in simple_explanation must connect to the actual
          patterns in the figure, not float free.
    """)


# Per-field rules referenced in the output contract block above.
# Defined separately so they can be updated or unit-tested independently.
_FIELD_RULES: dict[str, str] = {
    "summary": (
        "2–3 sentences. NEVER open with 'This figure shows', 'The figure "
        "demonstrates', 'X is achieved through Y', or other template openers. "
        "Instead, DIRECTLY state the key insight or unique property of this "
        "figure. Lead with WHAT IS SURPRISING or NON-OBVIOUS about it. "
        "Be specific to THIS figure — not a generic explanation that could "
        "apply to any paper. Highlight the novel architectural choice or "
        "capability, then state what it enables or proves."
    ),
    "insights": (
        "Exactly {insight_count} non-redundant strings. CRITICAL: Each must "
        "live in ONE dimension only — no bleeding between categories. "
        "For DETAILED mode: Dimension 1=MECHANISM (how), Dimension 2=COMPARISON "
        "(vs prior), Dimension 3=IMPLICATION (why matters). Zero vocabulary "
        "overlap between insights — if removing keywords leaves them identical, "
        "REWRITE. At least one must have TECHNICAL LENS (model behavior, not "
        "just user benefit). Prioritise WHY and SO WHAT over WHAT. "
        "No bullet prefixes, no numbering — plain strings only."
    ),
    "simple_explanation": (
        "1–3 sentences accessible to a reader new to the field. "
        "Use plain language. If you use an analogy, GROUND it in the "
        "actual graph or mechanism (e.g., 'like turning up contrast at each "
        "step, which is why the curves diverge'). Must preserve the core "
        "insight — being simple does not mean being vague."
    ),
    "key_takeaway": (
        "Exactly ONE sentence. Must be self-contained (readable out of "
        "context). Must name the MECHANISM or design principle that makes "
        "this result possible — not just 'we won' but 'how we won'. "
        "Specific, not generic. Not a generalisation."
    ),
}


# ============================================================================
# SECTION 3 — JSON PARSER
# ============================================================================

# Pre-compiled to avoid recompilation on every response.
_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL)

def _clean_llm_output(text: str) -> str:
    if not text:
        return ""

    text = text.strip()

    # Remove markdown fences
    text = re.sub(r"```json|```", "", text)

    # Try to extract JSON block manually
    start = text.find("{")
    end = text.rfind("}")

    if start != -1 and end != -1:
        text = text[start:end+1]

    return text.strip()
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
    clean = _clean_llm_output(raw)

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

async def _call_with_retry(fn, retries=2):
    for i in range(retries):
        try:
            return await fn()
        except Exception as e:
            if i == retries - 1:
                raise
            
            # Explicitly handle 429 Rate Limit
            if "rate_limit" in str(e).lower() or "429" in str(e):
                await asyncio.sleep(5)
            else:
                await asyncio.sleep(1.5 * (i + 1))


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

            raw_response = await _call_with_retry(
                lambda: asyncio.wait_for(
                    asyncio.to_thread(llm, prompt),
                    timeout=_LLM_TIMEOUT_SECS,
                )
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

                raw_response = await _call_with_retry(
                    lambda: asyncio.wait_for(
                        asyncio.to_thread(fallback_llm, prompt),
                        timeout=_LLM_TIMEOUT_SECS,
                    )
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