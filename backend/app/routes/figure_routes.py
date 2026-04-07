"""
figure_routes.py
================
Thin API layer for Phase 7.2 — Figure Extraction (v2).

Contract
--------
GET /api/v1/figures?session_id=<id>

Response shape (updated for Phase 7.2 v2):
{
    "session_id": "...",
    "total_figures": 12,
    "figures": [
        {
            "id":        "Fig. 3",
            "caption":   "Illustration of TUDA architecture...",
            "image_url": "/static/figures/<uuid>.png",
            "page":      4,
            "bbox":      [x0, y0, x1, y1],
            "width":     1200,
            "height":    800
        },
        ...
    ]
}

All business logic lives in app.services.figure_extractor.
This router: validate → delegate → respond.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import JSONResponse

from app.services.figure_extractor import extract_figures
from app.routes.chat_routes import _get_or_create_session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1", tags=["Figures"])

_FIGURES_OUTPUT_DIR = "static/figures"


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------

@router.get(
    "/figures",
    summary="Extract and return research figures from the active PDF.",
    response_description=(
        "Structured list of figures — each with label, caption, image URL, "
        "page number, bounding box, and dimensions."
    ),
)
async def get_figures(session_id: str | None = None) -> JSONResponse:
    """
    Retrieve figures extracted from the PDF loaded in *session_id*.

    Each figure includes its caption text and spatial metadata, making
    the response directly usable by the Figure Explorer and Explain Figure
    features without further processing.

    Query Parameters
    ----------------
    session_id:
        Returned by ``POST /api/v1/upload``.  If omitted or if no PDF has
        been uploaded yet, a 404 is returned with a clear action message.

    Error Responses
    ---------------
    404 — No PDF uploaded for this session.
    422 — PDF path on disk no longer exists.
    500 — Unexpected extraction failure (logged server-side).
    """
    # ── Resolve session ──────────────────────────────────────────────────────
    session_id, session = _get_or_create_session(session_id)

    # 🚀 CACHE: return cached figures if already extracted
    if "figures" in session:
        logger.info("get_figures: returning cached figures for session '%s'", session_id)
        return JSONResponse(
            status_code=status.HTTP_200_OK,
            content={
                "session_id":    session_id,
                "total_figures": len(session["figures"]),
                "figures":       session["figures"],
            },
        )

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
            "get_figures: PDF '%s' (session='%s') not found on disk.",
            pdf_path, session_id,
        )
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The PDF referenced by this session no longer exists on disk.",
        )

    # ── Delegate to service ──────────────────────────────────────────────────
    try:
        figures: list[dict] = extract_figures(
            pdf_path=pdf_path,
            output_dir=_FIGURES_OUTPUT_DIR,
        )
    except Exception as exc:
        logger.exception(
            "get_figures: unexpected error for session '%s'.", session_id
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Figure extraction failed due to an internal error.",
        ) from exc

    # 💾 CACHE: store extracted figures in session for subsequent requests
    session["figures"] = figures

    logger.info(
        "get_figures: session='%s' | figures_returned=%d",
        session_id, len(figures),
    )

    return JSONResponse(
        status_code=status.HTTP_200_OK,
        content={
            "session_id":    session_id,
            "total_figures": len(figures),
            "figures":       figures,
        },
    )