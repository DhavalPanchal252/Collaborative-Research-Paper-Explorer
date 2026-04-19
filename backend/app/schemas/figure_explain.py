# app/schemas/figure_explain.py
"""
figure_explain.py  (schemas)
============================
Pydantic request + response models for:

    POST /api/v1/figure/explain

Design goals
------------
* Strict field validation so the route can trust every field downstream.
* Optional fields use sensible defaults so callers don't need to supply
  everything — only ``figure_id`` and ``caption`` are truly required.
* ``ExplainMode`` enum guarantees the LLM service only receives known modes.
* ``FigureExplainResponse`` matches the documented JSON contract exactly —
  the LLM service is responsible for populating every field.
"""

from __future__ import annotations

from enum import Enum
from typing import Annotated

from pydantic import BaseModel, Field, field_validator


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class ExplainMode(str, Enum):
    """Controls how much depth / jargon the LLM explanation uses."""

    QUICK    = "quick"    # 1-2 insights, concise — best for hover / tooltip UX
    DETAILED = "detailed" # 3-5 insights, deeper reasoning — default
    SIMPLE   = "simple"   # beginner-friendly, less jargon


class FigureType(str, Enum):
    """Mirrors the type vocabulary used by FigureRefiner and the frontend."""

    GRAPH      = "graph"
    DIAGRAM    = "diagram"
    IMAGE      = "image"
    TABLE      = "table"
    CHART      = "chart"
    COMPARISON = "comparison"
    OTHER      = "other"
    UNKNOWN    = "unknown"  # tolerate un-enriched figures


# ---------------------------------------------------------------------------
# Request model
# ---------------------------------------------------------------------------

class FigureExplainRequest(BaseModel):
    """
    Payload accepted by ``POST /api/v1/figure/explain``.

    Only ``figure_id`` is mandatory.  All other fields are optional but
    the richer the metadata supplied, the better the explanation quality.

    Attributes
    ----------
    figure_id:
        Unique figure identifier (e.g. ``"Fig. 3"``).  Used as the cache
        key together with ``mode``.
    title:
        LLM-generated or heuristic title from the refiner (may be empty).
    description:
        LLM-generated semantic description from Phase 7.4.2 (may be empty).
    caption:
        Original (or cleaned) caption text extracted from the PDF.
    type:
        Figure classification from FigureRefiner.
    page:
        1-based page number in the source PDF.  Used only for logging /
        debugging — not sent to the LLM.
    mode:
        Explanation depth.  Defaults to ``ExplainMode.DETAILED``.
    """

    figure_id:   str                = Field(..., min_length=1, description="Unique figure ID")
    title:       str                = Field(default="", description="Figure title")
    description: str                = Field(default="", description="Semantic description")
    caption:     str                = Field(default="", description="Raw/cleaned caption")
    type:        FigureType         = Field(default=FigureType.UNKNOWN, description="Figure type")
    page:        int | None         = Field(default=None, ge=1,  description="Source PDF page")
    mode:        ExplainMode        = Field(default=ExplainMode.DETAILED, description="Explanation depth")

    # ── Validators ────────────────────────────────────────────────────────────

    @field_validator("caption")
    @classmethod
    def _truncate_caption(cls, v: str) -> str:
        """Hard-cap caption at 600 chars to prevent prompt token explosion.

        Mirrors ``_LLM_CAPTION_MAX_CHARS`` in figure_refiner.py.
        The truncation is invisible to the caller — the original caption
        is never mutated in the caller's scope.
        """
        return v[:600] if len(v) > 600 else v

    @field_validator("title", "description")
    @classmethod
    def _truncate_text_fields(cls, v: str) -> str:
        """Cap ancillary text fields at 300 chars to keep prompts lean."""
        return v[:300] if len(v) > 300 else v

    model_config = {
        "json_schema_extra": {
            "example": {
                "figure_id":   "Fig. 3",
                "title":       "Illustration of TUDA Architecture",
                "description": "A block diagram showing encoder-decoder components "
                               "with cross-attention between source and target domains.",
                "caption":     "Fig. 3.\nIllustration of TUDA architecture with domain "
                               "adapter layers inserted between each transformer block.",
                "type":        "diagram",
                "page":        4,
                "mode":        "detailed",
            }
        }
    }


# ---------------------------------------------------------------------------
# Response model
# ---------------------------------------------------------------------------

class FigureExplainResponse(BaseModel):
    """
    Structured AI explanation returned by ``POST /api/v1/figure/explain``.

    Every field is always present.  The LLM service guarantees non-empty
    values via safe fallbacks — callers never need to null-check.

    Attributes
    ----------
    summary:
        2–3 sentence overview of what the figure shows.
    insights:
        Bulleted key findings.  Length depends on ``mode``:
        ``quick`` → 1-2, ``detailed`` → 3-5, ``simple`` → 2-3.
    simple_explanation:
        Beginner-friendly restatement of the figure's core message.
        Jargon is avoided or briefly defined.
    key_takeaway:
        Single sentence capturing the most important conclusion.
    figure_id:
        Echoed from the request — lets clients correlate async responses
        when multiple explain calls are in-flight simultaneously.
    mode:
        Echoed from the request — useful for caching and debugging.
    cached:
        ``True`` when the response was served from the in-memory cache.
    """

    figure_id:          str            = Field(..., description="Echo of request figure_id")
    mode:               ExplainMode    = Field(..., description="Echo of request mode")
    summary:            str            = Field(..., description="2-3 sentence explanation")
    insights:           list[str]      = Field(..., description="Key insights list")
    simple_explanation: str            = Field(..., description="Beginner-friendly explanation")
    key_takeaway:       str            = Field(..., description="Single powerful takeaway")
    cached:             bool           = Field(default=False, description="Served from cache")

    model_config = {
        "json_schema_extra": {
            "example": {
                "figure_id":  "Fig. 3",
                "mode":       "detailed",
                "summary":    "This figure illustrates the TUDA architecture, a transformer-based "
                              "model with domain adapter layers. Each encoder block feeds into a "
                              "cross-attention module that aligns source and target representations.",
                "insights": [
                    "Domain adapters are inserted between every transformer block, not just at the output.",
                    "Cross-attention is used instead of concatenation, preserving spatial structure.",
                    "The encoder and decoder share weights, reducing parameter count significantly.",
                ],
                "simple_explanation": "Think of TUDA like a translator that learns two languages at once. "
                                      "The 'adapters' are small helpers between each layer that make sure "
                                      "what the model learns in one domain (language) also works in another.",
                "key_takeaway": "TUDA's per-block adapters enable domain transfer without retraining "
                                "the entire model, which is both faster and more parameter-efficient.",
                "cached": False,
            }
        }
    }