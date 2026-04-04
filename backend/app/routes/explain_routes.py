"""
explain_routes.py
=================
Endpoint for explaining user-selected text from the PDF viewer.

Phase 4 change
--------------
  Response schema updated from { explanation } to:
    { answer, source_chunks, confidence }
  so the frontend can use response.answer consistently and display
  additional provenance metadata in the UI.

Pipeline
--------
  selected_text ──► build_explain_prompt ──► LLM ──► ExplainResponse
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
    """
    Phase 4: structured response.

    Fields
    ------
    answer        : The plain-English explanation (was `explanation` in Phase 3).
    source_chunks : RAG chunks used to ground the explanation (empty list when
                    the explain endpoint runs without retrieval, which is the
                    current stateless design).
    confidence    : Placeholder score in [0, 1].  Set to 0.0 until a retrieval
                    step is wired in.  Kept in the schema so the frontend
                    contract is stable when retrieval is added.
    """
    answer:        str        = ""
    source_chunks: list[str]  = Field(default_factory=list)
    confidence:    float      = 0.0


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

    This endpoint is intentionally stateless — the selected text itself is
    the entire context.  `source_chunks` will always be an empty list until
    a session-aware retrieval step is integrated.
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
        prompt      = build_explain_prompt(request.selected_text)
        explanation = llm(prompt=prompt)

        if not explanation or not explanation.strip():
            explanation = "The model returned an empty response."

    except Exception as exc:
        logger.exception("Explain generation error.")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Explanation generation failed. Please try again.",
        ) from exc

    logger.info("Explanation ready | text_len=%d", len(request.selected_text))

    return ExplainResponse(
        answer=explanation.strip(),
        source_chunks=[],   # populated in a future retrieval-aware version
        confidence=0.0,     # placeholder until scoring is implemented
    )