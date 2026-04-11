# app/routes/figure_routes.py
"""
figure_routes.py
================
Thin API layer for Phase 7.4.1 — Figure Extraction + Heuristic Refinement.

Contract
--------
GET /api/v1/figures?session_id=<id>

Response shape (Phase 7.4.1):
{
    "session_id":    "...",
    "total_figures": 12,
    "figures": [
        {
            "id":            "Fig. 3",
            "caption":       "Fig. 3.\\nIllustration of TUDA...",   # original
            "clean_caption": "Illustration of TUDA architecture...", # cleaned
            "title":         "Illustration Of Tuda Architecture",    # generated
            "type":          "unknown",                              # Phase 7.4.2
            "description":   "",                                     # Phase 7.4.2
            "importance":    "unknown",                              # Phase 7.4.2
            "quality_score": 3,
            "confidence":    0.8901,
            "page":          4,
            "image_url":     "/static/figures/<uuid>.png",
            "bbox":          [x0, y0, x1, y1],
            "width":         1200,
            "height":        800
        },
        ...
    ]
}

Pipeline per request
--------------------
1. Resolve session + validate PDF path
2. Return from cache if already refined (avoids re-extraction + re-refinement)
3. extract_figures()  →  raw list[dict]
4. FigureRefiner.refine()  →  refined list[dict]
5. Cache refined result in session
6. Return JSON response

All extraction logic lives in app.services.figure_extractor.
All refinement logic lives in app.services.figure_refiner.
This router: validate → delegate → refine → cache → respond.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import JSONResponse

from app.services.figure_extractor import extract_figures
from app.services.figure_refiner import FigureRefiner
from app.routes.chat_routes import _get_or_create_session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1", tags=["Figures"])

# Module-level singleton — stateless, safe to share across all requests.
_refiner = FigureRefiner()

_FIGURES_OUTPUT_DIR = "static/figures"
_FIGURES_VERSION = "7.4.1"
_FIGURE_COUNT_WARNING_THRESHOLD = 50
_RESPONSE_SIZE_LIMIT = 100  # Prevent UI crash and payload explosion
_EXTRACTION_TIMEOUT_SECONDS = 20  # Prevent infinite hangs on pathological PDFs


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------

@router.get(
    "/figures",
    summary="Extract, refine, and return research figures from the active PDF.",
    response_description=(
        "Structured list of refined figures — each with original caption, "
        "cleaned caption, generated title, quality score, confidence, "
        "image URL, page number, bounding box, and dimensions."
    ),
)
async def get_figures(session_id: str | None = None) -> JSONResponse:
    """
    Retrieve refined figures extracted from the PDF loaded in *session_id*.

    Figures are extracted once per session and cached.  Subsequent calls
    return the cached result immediately without re-processing the PDF.

    Pipeline
    --------
    extract_figures() → raw figures
    FigureRefiner.refine() → cleaned captions, titles, quality + confidence scores
    cache in session → fast subsequent responses

    Query Parameters
    ----------------
    session_id:
        Returned by ``POST /api/v1/upload``.  If omitted or if no PDF has
        been uploaded yet, a 404 is returned with a clear action message.

    Error Responses
    ---------------
    404 — No PDF uploaded for this session.
    422 — PDF path on disk no longer exists.
    500 — Unexpected extraction or refinement failure (logged server-side).
    """
    # ── 0. Generate request ID for debugging ─────────────────────────────────
    request_id = str(uuid.uuid4())
    logger.info(f"[{request_id}] get_figures request started")

    # ── 1. Resolve session ───────────────────────────────────────────────────
    session_id, session = _get_or_create_session(session_id)

    # ── 2. Cache hit — return already-refined figures (with version check) ────
    cached_figures_version = session.get("figures_version")
    if "figures" in session and cached_figures_version == _FIGURES_VERSION:
        start_cache_time = time.time()
        # Cache hits: no timing metadata (already processed)
        result = _build_response(session_id, session["figures"])
        cache_time = time.time() - start_cache_time
        logger.info(
            f"[{request_id}] cache hit for session='{session_id}' (%d figures) | "
            f"version={_FIGURES_VERSION} | time=%.4fs",
            len(session["figures"]), cache_time,
        )
        return result
    
    # Cache miss or version mismatch — clear old cache
    if "figures" in session and cached_figures_version != _FIGURES_VERSION:
        logger.info(
            f"[{request_id}] cache invalidated due to version mismatch | "
            f"cached={cached_figures_version}, current={_FIGURES_VERSION}"
        )
        session.pop("figures", None)
        session.pop("figures_version", None)


    # ── 3. Validate PDF path ─────────────────────────────────────────────────
    pdf_path: str | None = session.get("pdf_path")

    if not pdf_path:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(
                "No PDF is associated with this session. "
                "Upload a paper via POST /api/v1/upload first."
            ),
        )

    if not Path(pdf_path).exists():
        logger.error(
            f"[{request_id}] PDF '{pdf_path}' missing on disk (session='{session_id}')."
        )
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The PDF referenced by this session no longer exists on disk.",
        )

    # ── 4. Extract raw figures (non-blocking with timeout protection) ──────────
    try:
        start_time = time.time()
        logger.info(f"[{request_id}] extraction started for session='{session_id}'")
        # Use asyncio.to_thread() + asyncio.wait_for() for non-blocking execution
        # with timeout protection → prevents server hang on pathological PDFs
        raw_figures: list[dict] = await asyncio.wait_for(
            asyncio.to_thread(
                extract_figures,
                pdf_path=pdf_path,
                output_dir=_FIGURES_OUTPUT_DIR,
            ),
            timeout=_EXTRACTION_TIMEOUT_SECONDS,
        )
        extraction_time = time.time() - start_time
        logger.info(
            f"[{request_id}] extraction completed in {extraction_time:.2f}s | "
            f"{len(raw_figures)} figures extracted"
        )
    except asyncio.TimeoutError:
        logger.error(
            f"[{request_id}] extraction timeout (>{_EXTRACTION_TIMEOUT_SECONDS}s) for "
            f"session='{session_id}'"
        )
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail=f"Figure extraction timed out after {_EXTRACTION_TIMEOUT_SECONDS} seconds. "
                   "The PDF may be too large or complex.",
        )
    except Exception as exc:
        logger.exception(
            f"[{request_id}] extraction failed for session='{session_id}'"
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Figure extraction failed due to an internal error.",
        ) from exc

    # ── 4.3 Empty result handling (edge case) ────────────────────────────────
    if not raw_figures:
        logger.info(
            f"[{request_id}] no figures found in PDF (session='{session_id}')"
        )
        session["figures"] = []
        session["figures_version"] = _FIGURES_VERSION
        session["figures_timestamp"] = time.time()
        # Empty result: include timing metadata
        return _build_response(
            session_id,
            [],
            extraction_time=extraction_time,
            refinement_time=0.0,
        )

    # ── 4.5 Figure count guard ──────────────────────────────────────────────
    if len(raw_figures) > _FIGURE_COUNT_WARNING_THRESHOLD:
        logger.warning(
            f"[{request_id}] large figure count detected | session='{session_id}' | "
            f"count={len(raw_figures)}"
        )

    # ── 5. Refine figures (caption cleaning, titles, scores) ─────────────────
    # NOTE (Phase 7.5+): When LLM calls are added, consider using asyncio.gather()
    #                    for batch refinement to improve scalability.
    try:
        start_time = time.time()
        logger.info(f"[{request_id}] refinement started for {len(raw_figures)} figures")
        refined_figures: list[dict] = await _refiner.refine(raw_figures)
        refinement_time = time.time() - start_time
        logger.info(
            f"[{request_id}] refinement completed in {refinement_time:.2f}s | "
            f"{len(refined_figures)} figures refined"
        )
    except Exception as exc:
        logger.exception(
            f"[{request_id}] refinement failed for session='{session_id}'"
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Figure refinement failed due to an internal error.",
        ) from exc

    # ── 6. Response size guard (prevent UI crash + payload explosion) ─────────
    original_count = len(refined_figures)
    if len(refined_figures) > _RESPONSE_SIZE_LIMIT:
        logger.warning(
            f"[{request_id}] response size limited | session='{session_id}' | "
            f"original={original_count} | limited={_RESPONSE_SIZE_LIMIT}"
        )
        refined_figures = refined_figures[:_RESPONSE_SIZE_LIMIT]

    # ── 6.5 Sort figures by page + numeric ID for consistent UI order ────────
    refined_figures.sort(
        key=lambda x: (x.get("page", 0), _extract_figure_number(x.get("id") or ""))
    )

    # ── 6.7 Cache refined result with version and timestamp ─────────────────
    session["figures"] = refined_figures
    session["figures_version"] = _FIGURES_VERSION
    session["figures_timestamp"] = time.time()  # TTL for future cache invalidation

    # ── 6.9 Total processing time log + metadata ─────────────────────────────
    total_time = extraction_time + refinement_time
    logger.info(
        f"[{request_id}] processing complete | total_time={total_time:.2f}s | "
        f"session='{session_id}' | extracted={len(raw_figures)} | refined={original_count}"
    )

    # ── 7. Respond ───────────────────────────────────────────────────────────
    logger.info(f"[{request_id}] sending response for session='{session_id}'")
    return _build_response(
        session_id,
        refined_figures,
        extraction_time=extraction_time,
        refinement_time=refinement_time,
        total_time=total_time,
    )


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

def _extract_figure_number(fig_id: str) -> int:
    """
    Extract numeric value from figure ID for correct sorting.
    E.g., "Fig. 10" → 10, "Figure 2" → 2, "unknown" → 0.

    Args:
        fig_id: Figure identifier string.

    Returns:
        Extracted number or 0 if no number found.
    """
    match = re.search(r"\d+", fig_id or "")
    return int(match.group()) if match else 0

def _build_response(
    session_id: str,
    figures: list[dict],
    extraction_time: float | None = None,
    refinement_time: float | None = None,
    total_time: float | None = None,
) -> JSONResponse:
    """Construct the standard figures JSON response.

    Centralised here so both the cache-hit and fresh-extraction paths
    produce identical output shapes.

    Args:
        session_id:     Active session identifier.
        figures:        Refined figure list to serialise.
        extraction_time: Time spent extracting figures (optional).
        refinement_time: Time spent refining figures (optional).
        total_time:      Total processing time (optional).

    Returns:
        200 JSONResponse with ``session_id``, ``total_figures``, ``version``,
        ``metadata``, and ``figures``.
    """
    # Build metadata if timing info is available
    metadata = None
    if extraction_time is not None or refinement_time is not None or total_time is not None:
        metadata = {}
        if extraction_time is not None:
            metadata["extraction_time"] = round(extraction_time, 4)
        if refinement_time is not None:
            metadata["refinement_time"] = round(refinement_time, 4)
        if total_time is not None:
            metadata["total_time"] = round(total_time, 4)

    response_content = {
        "session_id":    session_id,
        "total_figures": len(figures),
        "version":       _FIGURES_VERSION,
        "figures":       figures,
    }

    # Include metadata only if available (for fresh extractions, not cache hits)
    if metadata:
        response_content["metadata"] = metadata

    return JSONResponse(
        status_code=status.HTTP_200_OK,
        content=response_content,
    )