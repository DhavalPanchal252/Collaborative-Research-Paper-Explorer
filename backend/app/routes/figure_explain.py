# app/routes/figure_explain.py
"""
figure_explain.py  (route)
==========================
Thin API layer for:

    POST /api/v1/figure/explain

Contract
--------
POST /api/v1/figure/explain

Request JSON:
{
    "figure_id":   "Fig. 3",
    "title":       "Illustration of TUDA Architecture",
    "description": "Block diagram showing encoder-decoder components...",
    "caption":     "Fig. 3.\\nIllustration of TUDA architecture...",
    "type":        "diagram",
    "page":        4,
    "mode":        "detailed"            # optional, default: "detailed"
}

Response JSON (always 200 on success):
{
    "figure_id":          "Fig. 3",
    "mode":               "detailed",
    "summary":            "2-3 sentence explanation...",
    "insights":           ["insight 1", "insight 2", "insight 3"],
    "simple_explanation": "Beginner-friendly explanation...",
    "key_takeaway":       "One powerful sentence.",
    "cached":             false
}

Pipeline per request
--------------------
1. FastAPI validates + deserialises body into ``FigureExplainRequest``.
2. Route delegates entirely to ``FigureExplainService.explain()``.
3. Service handles: cache check → prompt build → LLM call → parse → cache store.
4. Route serialises ``FigureExplainResponse`` → JSON.

Error responses
---------------
422 — Pydantic validation failure (malformed request body).
500 — Unexpected unhandled exception in the service layer (logged server-side).

All other errors (LLM timeout, provider failure, parse failure) are handled
gracefully inside the service layer and return a valid degraded 200 response
rather than propagating as 5xx — this is intentional: the frontend should
always receive a renderable response rather than a toast error.
"""

from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import JSONResponse

from app.schemas.figure_explain import FigureExplainRequest, FigureExplainResponse
from app.services.figure_explain_service import explain_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1", tags=["Figures"])


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------

@router.post(
    "/figure/explain",
    response_model=FigureExplainResponse,
    summary="Generate a structured AI explanation for a research figure.",
    response_description=(
        "Structured explanation containing summary, key insights, "
        "a beginner-friendly description, and a single key takeaway."
    ),
    status_code=status.HTTP_200_OK,
)
async def explain_figure(body: FigureExplainRequest) -> JSONResponse:
    """
    Return an AI-generated explanation for a single research figure.

    The explanation is structured (not raw LLM text) and always contains
    four fields: ``summary``, ``insights``, ``simple_explanation``, and
    ``key_takeaway``.  Depth is controlled by the ``mode`` parameter.

    This endpoint is intentionally **stateless with respect to sessions** —
    it operates purely on the figure metadata supplied in the request body.
    No session lookup or PDF access is required.

    Modes
    -----
    ``quick``    — 1–2 insights, concise; best for hover/tooltip UX.
    ``detailed`` — 3–5 insights with deeper reasoning; default.
    ``simple``   — beginner-friendly, less jargon; uses analogies.

    Caching
    -------
    Responses are cached in memory keyed on ``(figure_id, mode)``.
    Cached responses are identical to fresh ones except ``cached=true``.
    Cache is per-worker; a process restart clears it.

    Error Handling
    --------------
    LLM failures (timeout, provider error, JSON parse failure) are handled
    inside the service and return a gracefully degraded 200 response rather
    than a 5xx.  The ``summary`` field will indicate the failure mode in
    plain language so the frontend can surface it to the user.

    Request Body
    ------------
    figure_id:
        Required.  The unique figure identifier (e.g. ``"Fig. 3"``).
    title:
        Optional.  LLM-generated or heuristic title from FigureRefiner.
    description:
        Optional.  LLM-generated semantic description from Phase 7.4.2.
    caption:
        Optional but strongly recommended.  Raw or cleaned caption text.
        Truncated server-side to 600 chars before prompt construction.
    type:
        Optional.  One of ``graph | diagram | image | table | chart |
        comparison | other | unknown``.  Defaults to ``unknown``.
    page:
        Optional.  Source PDF page number (for logging only, not sent to LLM).
    mode:
        Optional.  ``quick | detailed | simple``.  Defaults to ``detailed``.
    """
    # ── Request ID for end-to-end tracing in logs ──────────────────────────
    request_id = str(uuid.uuid4())[:8]
    logger.info(
        "[%s] explain_figure: started | fig='%s' mode=%s page=%s",
        request_id, body.figure_id, body.mode.value, body.page,
    )

    # ── Delegate to service (handles all LLM logic + caching) ─────────────
    try:
        response: FigureExplainResponse = await explain_service.explain(body)

    except Exception as exc:
        # The service layer should never raise — this is a last-resort guard.
        logger.exception(
            "[%s] explain_figure: unexpected error for fig='%s': %s",
            request_id, body.figure_id, exc,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "An unexpected error occurred while generating the explanation. "
                "Please try again."
            ),
        ) from exc

    logger.info(
        "[%s] explain_figure: complete | fig='%s' mode=%s cached=%s",
        request_id, body.figure_id, body.mode.value, response.cached,
    )

    return JSONResponse(
        status_code=status.HTTP_200_OK,
        content=response.model_dump(),
    )


# ---------------------------------------------------------------------------
# Debug / ops route — not mounted in production
# ---------------------------------------------------------------------------

@router.get(
    "/figure/explain/metrics",
    summary="[DEBUG] Return explanation service cache and LLM call metrics.",
    include_in_schema=False,  # Hidden from public OpenAPI docs
)
async def get_explain_metrics() -> JSONResponse:
    """
    Return internal performance counters for the explanation service.

    Useful for observability dashboards and local debugging.
    Not intended for production exposure — gate behind auth middleware
    or remove the router include in production ``main.py``.
    """
    return JSONResponse(
        status_code=status.HTTP_200_OK,
        content=explain_service.get_metrics(),
    )