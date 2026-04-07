"""
figure_routes.py
================
Thin API layer for Phase 7.2 — Figure Extraction.

All business logic lives in app.services.figure_extractor.
This router is intentionally minimal: validate → delegate → respond.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import JSONResponse

from app.services.figure_extractor import FigureMetadata, extract_figures
from app.routes.chat_routes import _get_or_create_session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1", tags=["Figures"])

# Directory that maps to the /static/figures URL mount.
# Must stay in sync with the StaticFiles mount in main.py.
_FIGURES_OUTPUT_DIR = "static/figures"


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------

@router.get(
    "/figures",
    summary="Extract and return all high-quality figures from the active PDF.",
    response_description="List of figure metadata objects (id, image URL, page, dimensions).",
)
async def get_figures(session_id: str | None = None) -> JSONResponse:
    """
    Retrieve figures extracted from the PDF that is currently loaded
    in the given session.

    Query Parameters
    ----------------
    session_id:
        The session ID returned by ``POST /api/v1/upload``.
        If omitted, a new empty session is created and an informative
        error is returned (no PDF has been uploaded yet).

    Response
    --------
    ``200 OK`` — JSON array of :class:`FigureMetadata` objects.
    ``404 Not Found`` — session exists but no PDF has been uploaded.
    ``422 Unprocessable Entity`` — PDF path recorded in session is missing on disk.
    ``500 Internal Server Error`` — unexpected extraction failure.
    """
    # ── Resolve session ─────────────────────────────────────────────────────
    session_id, session = _get_or_create_session(session_id)

    pdf_path: str | None = session.get("pdf_path")

    if not pdf_path:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(
                "No PDF is associated with this session.  "
                "Upload a paper via POST /api/v1/upload first."
            ),
        )

    # ── Validate the file still exists on disk ──────────────────────────────
    if not Path(pdf_path).exists():
        logger.error("get_figures: PDF path recorded in session not found on disk: %s", pdf_path)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The PDF referenced by this session no longer exists on disk.",
        )

    # ── Delegate to service ─────────────────────────────────────────────────
    try:
        figures: list[FigureMetadata] = extract_figures(
            pdf_path=pdf_path,
            output_dir=_FIGURES_OUTPUT_DIR,
        )
    except Exception as exc:
        logger.exception("get_figures: unexpected error during extraction for session '%s'.", session_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Figure extraction failed due to an internal error.",
        ) from exc

    logger.info(
        "get_figures: session='%s' | figures_returned=%d", session_id, len(figures)
    )

    return JSONResponse(
        status_code=status.HTTP_200_OK,
        content={
            "session_id": session_id,
            "total_figures": len(figures),
            "figures": figures,
        },
    )