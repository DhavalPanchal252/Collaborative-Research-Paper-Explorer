from fastapi import APIRouter, HTTPException
from app.services.supabase_client import supabase
from app.routes.chat_routes import _get_or_create_session

router = APIRouter(prefix="/api/v1")

@router.post("/load-paper/{paper_id}")
def load_paper(paper_id: str, session_id: str | None = None):

    response = supabase.table("paper_chunks") \
        .select("*") \
        .eq("paper_id", paper_id) \
        .execute()

    data = response.data

    if not data:
        raise HTTPException(status_code=404, detail="Paper not found")

    chunks = [row["content"] for row in data]
    embeddings = [row["embedding"] for row in data]

    session_id, session = _get_or_create_session(session_id)

    session["chunks"] = chunks
    session["embeddings"] = embeddings

    return {
        "message": "Paper loaded into session",
        "session_id": session_id,
        "chunks": len(chunks)
    }