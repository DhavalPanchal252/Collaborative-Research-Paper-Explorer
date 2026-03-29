import os
import logging
import uuid
from pathlib import Path
import glob

from fastapi import APIRouter, File, HTTPException, UploadFile, status
from fastapi.responses import JSONResponse

from app.services import store
from app.services.embedding import create_vector_store
from app.services.pdf_parser import extract_text
from app.utils.chunker import chunk_text
from app.routes.chat_routes import _get_or_create_session

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------





logger = logging.getLogger(__name__)

UPLOAD_DIR = Path("uploaded_papers")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_CONTENT_TYPES = {"application/pdf"}
MAX_FILE_SIZE_MB = 20
MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024

router = APIRouter(prefix="/api/v1", tags=["Upload"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def clear_old_pdfs():
    """Delete all previously uploaded PDFs (MVP = single active paper)."""
    files = glob.glob(str(UPLOAD_DIR / "*.pdf"))
    for f in files:
        try:
            os.remove(f)
        except Exception as e:
            logger.warning("Failed to delete %s: %s", f, e)



def _validate_pdf(file: UploadFile, content: bytes) -> None:
    """Raise HTTPException if the upload fails basic validation."""
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

# --- CLEAN OLD STATE ---
clear_old_pdfs()

def _safe_filename(original: str) -> str:
    """
    Return a collision-free filename while preserving the original stem
    for traceability (e.g. 'paper_<uuid>.pdf').
    """
    stem = Path(original).stem[:50]          # cap length
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
async def upload_pdf(file: UploadFile = File(...),session_id: str | None = None) -> JSONResponse:
    """
    Pipeline
    --------
    1. Validate file type, size and magic bytes.
    2. Persist the PDF to disk with a collision-safe filename.
    3. Extract raw text via PyMuPDF.
    4. Chunk the text and build a FAISS index.
    5. Write the new index + chunks into the shared in-memory store.
    6. Return upload metadata to the caller.
    """
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

    # --- 3. Extract text ---------------------------------------------------
    try:
        text: str = extract_text(str(file_path))
    except Exception as exc:
        logger.exception("Text extraction failed for '%s'.", file_path)
        file_path.unlink(missing_ok=True)   # clean up orphaned file
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Could not extract text from the PDF. The file may be scanned or corrupted.",
        ) from exc

    if not text.strip():
        file_path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="No extractable text found. The PDF may contain only images.",
        )

    # --- 4. Chunk & embed --------------------------------------------------
    try:
        chunks: list[str] = chunk_text(text)
        if not chunks:
            raise HTTPException(
                status_code=500,
                detail="Chunking failed",
            )
        index, _ = create_vector_store(chunks)
    except Exception as exc:
        logger.exception("Embedding/indexing failed for '%s'.", file_path)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to build the vector index.",
        ) from exc

    # --- 5. Update shared store --------------------------------------------
   
    session_id, session = _get_or_create_session(session_id)

    session["chunks"] = chunks
    session["index"] = index

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
            "session_id" : session_id,
            "chunks_created": len(chunks),
            "file_size_bytes": len(content),
        },
    )