import os
import logging
import uuid
from pathlib import Path
import glob

from fastapi import APIRouter, File, HTTPException, UploadFile, status, Request
from fastapi.responses import JSONResponse

from app.services import store
from app.services.embedding import create_vector_store
from app.services.pdf_parser import extract_text
from app.utils.chunker import chunk_text
from app.routes.chat_routes import _get_or_create_session

# 🔥 NEW IMPORT (ADDED)
from app.services.supabase_client import supabase

# 🔥 NEW IMPORTS FOR JWT (ADDED)
from jose import jwt


logger = logging.getLogger(__name__)

UPLOAD_DIR = Path("uploaded_papers")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

FIGURES_DIR = Path("static/figures")
FIGURES_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_CONTENT_TYPES = {"application/pdf"}
MAX_FILE_SIZE_MB = 20
MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024

router = APIRouter(prefix="/api/v1", tags=["Upload"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def clear_old_pdfs():
    files = glob.glob(str(UPLOAD_DIR / "*.pdf"))
    for f in files:
        try:
            os.remove(f)
        except Exception as e:
            logger.warning("Failed to delete %s: %s", f, e)


def clear_old_figures() -> None:
    files = glob.glob(str(FIGURES_DIR / "*"))
    for f in files:
        try:
            file_path = Path(f)
            if file_path.is_file():
                file_path.unlink()
        except Exception as e:
            logger.warning("Failed to delete figure file %s: %s", f, e)


def _validate_pdf(file: UploadFile, content: bytes) -> None:
    if file.content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"Only PDF files are accepted. Received: '{file.content_type}'.",
        )

    if len(content) == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Uploaded file is empty.",
        )

    if len(content) > MAX_FILE_SIZE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds the {MAX_FILE_SIZE_MB} MB size limit.",
        )

    if not content.startswith(b"%PDF"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File content does not appear to be a valid PDF.",
        )


def _safe_filename(original: str) -> str:
    stem = Path(original).stem[:50]
    stem = "".join(c if c.isalnum() or c in "-_" else "_" for c in stem)
    return f"{stem}_{uuid.uuid4().hex}.pdf"


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------

@router.post(
    "/upload",
    status_code=status.HTTP_201_CREATED,
    summary="Upload a research-paper PDF and index it for RAG retrieval.",
)
async def upload_pdf(request: Request, file: UploadFile = File(...), session_id: str | None = None) -> JSONResponse:

    logger.info("Received upload request for file: '%s'", file.filename)

    # --- 1. Read & validate ------------------------------------------------
    try:
        content: bytes = await file.read()
    except Exception as exc:
        logger.exception("Failed to read uploaded file.")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Could not read the uploaded file.",
        ) from exc

    _validate_pdf(file, content)

    # --- 1.5 Clean previous upload artifacts -------------------------------
    clear_old_pdfs()
    clear_old_figures()

    # --- 2. Persist to disk ------------------------------------------------
    safe_name = _safe_filename(file.filename or "paper")
    file_path = UPLOAD_DIR / safe_name

    try:
        file_path.write_bytes(content)
        logger.info("Saved file: %s | size=%d bytes", file_path.name, len(content))
    except OSError as exc:
        logger.exception("Disk write failed for '%s'.", file_path)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to save the uploaded file.",
        ) from exc

    # 🔥 Upload to Supabase Storage
    try:
        user_id = "anonymous"

        try:
            auth_header = request.headers.get("Authorization")
            if auth_header and auth_header.startswith("Bearer "):
                token = auth_header.split(" ")[1]

                decoded = jwt.decode(
                    token,
                    key="",
                    options={
                        "verify_signature": False,
                        "verify_aud": False
                    }
                )
                user_id = decoded.get("sub", "anonymous")

        except Exception as e:
            logger.warning("JWT decode failed: %s", e)

        supabase_path = f"{user_id}/{safe_name}"

        supabase.storage.from_("papers").upload(
            supabase_path,
            content,
            {"content-type": file.content_type}
        )

        url_data = supabase.storage.from_("papers").get_public_url(supabase_path)
        file_url = url_data.get("publicUrl") if isinstance(url_data, dict) else url_data

    except Exception as e:
        logger.warning("Supabase upload failed: %s", e)
        file_url = None

    # --- 3. Extract text ---------------------------------------------------
    try:
        text: str = extract_text(str(file_path))
    except Exception as exc:
        logger.exception("Text extraction failed for '%s'.", file_path)
        file_path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Could not extract text from the PDF.",
        ) from exc

    if not text.strip():
        file_path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="No extractable text found.",
        )

    # --- 4. Chunk & embed --------------------------------------------------
    try:
        chunks: list[str] = chunk_text(text)

        if not chunks:
            raise HTTPException(status_code=500, detail="Chunking failed")

        # 🔥 HF-based embeddings (NO FAISS)
        _, embeddings = create_vector_store(chunks)

    except Exception as exc:
        logger.exception("Embedding/indexing failed for '%s'.", file_path)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to build embeddings.",
        ) from exc

    # --- 5. Update session store -------------------------------------------
    session_id, session = _get_or_create_session(session_id)

    session.pop("figures", None)

    session["chunks"] = chunks
    session["embeddings"] = embeddings.tolist()   # 🔥 IMPORTANT CHANGE
    # 🔥 SAVE CHUNKS + EMBEDDINGS TO DB

    try:
        for chunk, emb in zip(chunks, embeddings):
            supabase.table("paper_chunks").insert({
                "paper_id": safe_name,   # or use actual paper_id if available
                "content": chunk,
                "embedding": emb.tolist()
            }).execute()
    except Exception as e:
        logger.warning("Chunk DB insert failed: %s", e)
    session["pdf_path"] = str(file_path)

    # 🔥 Save metadata in Supabase DB
    try:
        supabase.table("papers").insert({
            "user_id": user_id,
            "title": file.filename,
            "file_url": file_url
        }).execute()
    except Exception as e:
        logger.warning("DB insert failed: %s", e)

    logger.info(
        "Indexed '%s': %d chunks stored.", safe_name, len(chunks)
    )

    # --- 6. Respond --------------------------------------------------------
    return JSONResponse(
        status_code=status.HTTP_201_CREATED,
        content={
            "message": "PDF uploaded and indexed successfully.",
            "original_filename": file.filename,
            "stored_as": safe_name,
            "session_id": session_id,
            "chunks_created": len(chunks),
            "file_size_bytes": len(content),
        },
    )