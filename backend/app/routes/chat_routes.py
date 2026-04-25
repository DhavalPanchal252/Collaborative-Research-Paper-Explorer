"""
chat_routes.py
==============
Chat endpoint with session memory + casual input short-circuit.

Pipeline (per request)
-----------------------

  [casual?] ──yes──► reply immediately, skip retrieval + LLM
      │
      no
      │
  [paper indexed?] ──no──► 400
      │
      yes
      │
  enrich query ──► FAISS retrieve ──► build_prompt (with history)
      │
  LLM generate ──► save turn ──► return response
"""

import logging
import uuid
from collections import deque
import numpy as np  # 🔥 ADDED

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.services import store
from app.services.retriever import retrieve_chunks
from app.services.llm.factory import get_llm
from app.services.llm.llm_utils import build_prompt, is_casual, get_casual_reply

# 🔥 NEW IMPORT
from app.services.embedding import get_embeddings

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Chat"])

# ---------------------------------------------------------------------------
# Session store
# ---------------------------------------------------------------------------

MAX_HISTORY_MESSAGES = 10   # individual messages; 10 = 5 full turns

# session_id → deque of {"role": ..., "content": ..., "turn": int}
_sessions: dict[str, dict] = {}
# session_id → turn counter (used to cycle casual replies naturally)
_turn_counters: dict[str, int] = {}


def _get_or_create_session(session_id: str | None):
    if not session_id or session_id not in _sessions:
        session_id = str(uuid.uuid4())

        _sessions[session_id] = {
            "history": deque(maxlen=MAX_HISTORY_MESSAGES),
            "chunks": None,
            "embeddings": None   # 🔥 CHANGED (was index)
        }

        _turn_counters[session_id] = 0
        logger.info("New session: %s", session_id)

    return session_id, _sessions[session_id]

def _save_turn(history: deque, session_id: str, question: str, answer: str) -> None:
    history.append({"role": "user",      "content": question})
    history.append({"role": "assistant", "content": answer})
    _turn_counters[session_id] = _turn_counters.get(session_id, 0) + 1


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

class ChatRequest(BaseModel):
    question:   str        = Field(..., min_length=1, max_length=2000)
    model:      str        = Field(default="groq", pattern="^(groq|ollama)$")
    session_id: str | None = Field(default=None, description="Omit to start a new session.")


class ChatResponse(BaseModel):
    answer:      str
    session_id:  str
    chunks_used: int


# ---------------------------------------------------------------------------
# Query enrichment
# ---------------------------------------------------------------------------

def _enrich_query(question: str) -> str:
    """
    Prepend domain framing to short / generic queries so FAISS embeddings
    point toward methodology / results sections rather than author bios.
    """
    q = question.lower()

    if "result" in q:
        return f"research paper results findings experimental evaluation {question}"
    if "method" in q or "approach" in q:
        return f"research paper methodology approach model architecture {question}"
    if "contribution" in q:
        return f"research paper contributions novelty proposed method {question}"
    if any(w in q for w in ["what is", "define", "explain", "meaning"]):
        return f"research concept explanation definition {question}"

    return f"research paper context {question}"


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------

@router.post(
    "/chat",
    response_model=ChatResponse,
    status_code=status.HTTP_200_OK,
    summary="Ask a question about the currently loaded research paper.",
)
async def chat(request: ChatRequest) -> ChatResponse:
    """
    RAG + Memory pipeline with casual short-circuit.

    Steps
    -----
    1. Resolve / create session.
    2. *** Casual check — reply immediately if acknowledgement. ***
    3. Guard: paper must be indexed.
    4. Enrich query for FAISS retrieval.
    5. Retrieve chunks.
    6. Guard: empty retrieval fallback.
    7. Build prompt (context + history) → LLM generate.
    8. Save turn → return response.
    """

    # --- 1. Session --------------------------------------------------------
    session_id, session = _get_or_create_session(request.session_id)
    history = session["history"]
    turn = _turn_counters.get(session_id, 0)

    logger.info(
        "Chat | session=%s model=%s turn=%d question='%s'",
        session_id, request.model, turn, request.question,
    )

    # --- 2. Casual short-circuit ------------------------------------------
    if is_casual(request.question):
        reply = get_casual_reply(turn)
        _save_turn(history, session_id, request.question, reply)
        logger.info("Casual input detected — short-circuit reply.")
        return ChatResponse(answer=reply, session_id=session_id, chunks_used=0)

    # --- 3. Guard: paper must be uploaded ---------------------------------
    if session["chunks"] is None or session.get("embeddings") is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No paper uploaded yet. Please upload a PDF first.",
        )

    # --- 4. Enrich query --------------------------------------------------
    enriched = _enrich_query(request.question)

    # --- 5. Retrieve ------------------------------------------------------
    try:
        # 🔥 REPLACED FAISS WITH COSINE SIMILARITY

        query_embedding = np.array(get_embeddings([enriched])[0])
        stored_embeddings = np.array(session["embeddings"])

        similarities = np.dot(stored_embeddings, query_embedding) / (
            np.linalg.norm(stored_embeddings, axis=1) *
            np.linalg.norm(query_embedding)
        )

        top_k = 3
        top_indices = np.argsort(similarities)[-top_k:][::-1]

        chunks = [session["chunks"][i] for i in top_indices]

    except Exception as exc:
        logger.exception("Retrieval error.")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Retrieval failed. Please try again.",
        ) from exc

    logger.debug("Retrieved %d chunks | session=%s", len(chunks), session_id)

    # --- 6. Empty retrieval fallback --------------------------------------
    if not chunks:
        fallback = (
            "I couldn't find relevant content in the paper for this question. "
            "Try asking about the methodology, results, or contributions — "
            "or rephrase your question."
        )
        _save_turn(history, session_id, request.question, fallback)
        return ChatResponse(answer=fallback, session_id=session_id, chunks_used=0)

    # --- 7. Build prompt + generate ---------------------------------------
    try:
        llm = get_llm(request.model)
    except ValueError:
        logger.warning("Unknown model '%s', falling back to groq.", request.model)
        llm = get_llm("groq")

    try:
        prompt = build_prompt(
            question=request.question,
            context="\n\n".join(chunks),
            history=list(history),
        )
        answer: str = llm(prompt=prompt)
    except Exception as exc:
        logger.exception("LLM generation error.")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Answer generation failed. Please try again.",
        ) from exc

    # --- 8. Save + respond ------------------------------------------------
    _save_turn(history, session_id, request.question, answer)
    logger.info(
        "Answer ready | session=%s chunks=%d model=%s turn=%d",
        session_id, len(chunks), request.model, turn + 1,
    )

    return ChatResponse(answer=answer, session_id=session_id, chunks_used=len(chunks))


# ---------------------------------------------------------------------------
# Utility endpoints
# ---------------------------------------------------------------------------

@router.delete(
    "/chat/session/{session_id}",
    status_code=status.HTTP_200_OK,
    summary="Clear conversation history for a session (new chat).",
)
async def clear_session(session_id: str):
    if session_id not in _sessions:
        raise HTTPException(status_code=404, detail="Session not found.")
    _sessions[session_id].clear()
    _turn_counters[session_id] = 0
    logger.info("Session cleared: %s", session_id)
    return {"message": f"Session {session_id} cleared."}