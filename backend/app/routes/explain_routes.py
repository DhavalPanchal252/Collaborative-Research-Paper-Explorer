"""
explain_routes.py
=================
Endpoint for explaining user-selected text from the PDF viewer.

Pipeline
--------
  selected_text ──► build_explain_prompt ──► LLM ──► explanation
"""

import logging

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.services.llm.factory import get_llm
from app.services.llm.llm_utils import build_explain_prompt

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Explain"])


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

class ExplainRequest(BaseModel):
    selected_text: str = Field(..., min_length=1, max_length=3000)
    model: str         = Field(default="groq", pattern="^(groq|ollama)$")


class ExplainResponse(BaseModel):
    explanation: str


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------

@router.post(
    "/explain-selection",
    response_model=ExplainResponse,
    status_code=status.HTTP_200_OK,
    summary="Explain a passage of text selected from the PDF in simple terms.",
)
async def explain_selection(request: ExplainRequest) -> ExplainResponse:
    """
    Accepts raw selected text and returns a plain-language explanation.

    Does NOT require a session or prior PDF upload — the selected text
    itself is the entire context, so this endpoint is stateless.
    """

    logger.info(
        "Explain | model=%s text_len=%d",
        request.model,
        len(request.selected_text),
    )

    try:
        llm = get_llm(request.model)
    except ValueError:
        logger.warning("Unknown model '%s', falling back to groq.", request.model)
        llm = get_llm("groq")

    try:
        prompt = build_explain_prompt(request.selected_text)
        explanation: str = llm(prompt=prompt)
    except Exception as exc:
        logger.exception("Explain generation error.")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Explanation generation failed. Please try again.",
        ) from exc

    logger.info("Explanation ready | text_len=%d", len(request.selected_text))
    return ExplainResponse(explanation=explanation)