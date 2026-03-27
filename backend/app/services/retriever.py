"""
retriever.py
============
Production-grade semantic retriever for a FAISS-backed RAG pipeline.

Design principles
-----------------
* Query-only encoding  — chunks are NEVER re-encoded here; the FAISS index
  already holds their embeddings.
* Over-fetch + filter  — retrieves top_k * 3 candidates, then removes noisy
  or irrelevant chunks before final ranking.
* Adaptive threshold   — if no chunk clears the similarity floor, the best
  available candidates are returned so the LLM always has something to work
  with (unless the index itself is empty).
* Zero extra deps      — only sentence-transformers, faiss (via the index
  object), numpy, and the stdlib.
"""

from __future__ import annotations

import logging
from typing import Optional

import numpy as np
from sentence_transformers import SentenceTransformer

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Embedding model — loaded once at import time; shared across all calls.
# ---------------------------------------------------------------------------

_MODEL_NAME = "all-MiniLM-L6-v2"
_model: Optional[SentenceTransformer] = None


def _get_model() -> SentenceTransformer:
    """Lazy-load the embedding model (singleton)."""
    global _model
    if _model is None:
        logger.info("Loading SentenceTransformer model: %s", _MODEL_NAME)
        _model = SentenceTransformer(_MODEL_NAME)
    return _model


# ---------------------------------------------------------------------------
# Configuration — change these without touching any logic below.
# ---------------------------------------------------------------------------

DEFAULT_TOP_K = 7
MIN_CHUNK_LENGTH = 150       # characters — drop headers / stray lines
MAX_CHUNK_LENGTH = 8_000     # characters — drop likely parsing artifacts
MIN_ALPHA_RATIO = 0.25       # at least 25 % real letters — 0.30 over-drops math/equation-heavy chunks
SIMILARITY_THRESHOLD = 0.15  # cosine-like score floor; 0 disables threshold
MAX_RETURNED_CHUNKS = 5      # hard cap on chunks sent to the LLM
OVERFETCH_FACTOR = 3         # fetch top_k * factor candidates before filtering
HEAD_SCAN_CHARS = 120        # how many leading chars to inspect for section tags

# Section headings that are never useful as RAG context.
# Matched against the *first HEAD_SCAN_CHARS characters* of each chunk (lower-cased).
_GARBAGE_PREFIXES: tuple[str, ...] = (
    "references",
    "bibliography",
    "acknowledgment",
    "acknowledgement",
    "author biography",
    "author biographies",
    "biography",
    "about the author",
    "ieee member",
    "conflicts of interest",
    "funding",
    "appendix",
    "supplementary",
    "received:",        # IEEE/journal submission metadata
    "doi:",
    "arxiv:",
)

# Boilerplate phrases matched anywhere in the chunk (lower-cased full text).
_GARBAGE_ANYWHERE: tuple[str, ...] = (
    "all rights reserved",
    "permission to make digital",
    "this work is licensed under",
    "©",                # stray copyright lines
)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _is_quality_chunk(text: str) -> bool:
    """
    Return ``True`` only when *text* is substantive and likely useful as
    RAG context.  Rejects chunks that are:

    * Too short  — headers, page numbers, stray whitespace lines.
    * Too long   — almost certainly a parsing artifact or merged sections.
    * Symbol-heavy — reference lists, equation-only blocks, tables of
      symbols.  We require at least ``MIN_ALPHA_RATIO`` real letters.
    * Starts with a known garbage section heading (checked in the first
      ``HEAD_SCAN_CHARS`` characters).
    * Contains a known boilerplate phrase anywhere.
    """
    stripped = text.strip()

    # ── Length bounds ───────────────────────────────────────────────────────
    length = len(stripped)
    if length < MIN_CHUNK_LENGTH:
        logger.debug("Chunk too short (%d chars): %.60s…", length, stripped)
        return False

    if length > MAX_CHUNK_LENGTH:
        logger.debug("Chunk too long (%d chars): %.60s…", length, stripped)
        return False

    # ── Alpha-character ratio ───────────────────────────────────────────────
    alpha_ratio = sum(c.isalpha() for c in stripped) / length
    if alpha_ratio < MIN_ALPHA_RATIO:
        logger.debug(
            "Low alpha ratio (%.2f) in chunk: %.60s…", alpha_ratio, stripped
        )
        return False

    lowered = stripped.lower()

    # ── Section-heading prefix filter ──────────────────────────────────────
    head = lowered[:HEAD_SCAN_CHARS]
    if any(head.startswith(prefix) for prefix in _GARBAGE_PREFIXES):
        logger.debug("Garbage-section prefix detected: %.60s…", stripped)
        return False

    # ── Full-text boilerplate filter ────────────────────────────────────────
    if any(pattern in lowered for pattern in _GARBAGE_ANYWHERE):
        logger.debug("Boilerplate pattern detected: %.60s…", stripped)
        return False

    return True


def _distances_to_scores(distances: np.ndarray, index) -> np.ndarray:
    """
    Normalise raw FAISS distances to a cosine-like similarity score in
    approximately [0, 1] (higher = more similar).

    * ``IndexFlatIP``  — inner-product of unit vectors **is** cosine
      similarity; distances are returned as-is.
    * ``IndexFlatL2``  — stores squared L2 distance.  For unit vectors:
      ``cos(u, v) = 1 − ‖u − v‖² / 2``.  We apply that conversion so
      callers always work in the same score space.
    * Any other index type falls back to the L2 conversion as a safe
      default.
    """
    index_type = type(index).__name__
    if "IP" in index_type:
        # Already cosine similarity for normalized embeddings
        return distances
    else:
        # L2-squared → cosine proxy (valid for unit vectors)
        return np.clip(1.0 - distances / 2.0, 0.0, 1.0)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def retrieve_chunks(
    query: str,
    chunks: list[str],
    index,
    top_k: int = DEFAULT_TOP_K,
    similarity_threshold: float = SIMILARITY_THRESHOLD,
    return_scores: bool = False,
) -> list[str] | list[tuple[str, float]]:
    """
    Retrieve the *top_k* most relevant chunks for *query*.

    Parameters
    ----------
    query:
        The user's question / search string.
    chunks:
        The flat list of raw text chunks that correspond 1-to-1 with
        the vectors stored in *index*.
    index:
        A live FAISS index (``IndexFlatIP`` or ``IndexFlatL2``).
        Must already contain normalised embeddings for *chunks*.
    top_k:
        Candidate pool size before filtering.  The actual number of
        returned chunks is capped at ``MAX_RETURNED_CHUNKS``.
    similarity_threshold:
        Cosine-like score floor.  Chunks below this value are dropped.
        Pass ``0`` to disable threshold filtering entirely.
        If *all* quality chunks fall below the threshold, the pipeline
        falls back to the best quality chunks so the result is never
        empty (unless the index itself is empty).
    return_scores:
        When ``True``, returns ``list[tuple[str, float]]`` (text, score)
        pairs — useful for debugging or re-ranking in the caller.
        Default is ``False`` (plain ``list[str]``).

    Returns
    -------
    list[str]
        Up to ``MAX_RETURNED_CHUNKS`` chunks, best-first, or an empty
        list only when the index / chunk store is empty.

    Pipeline
    --------
    1. Validate inputs (empty query / empty store).
    2. Encode **only** the query — one ``model.encode`` call total.
    3. Over-fetch ``top_k * OVERFETCH_FACTOR`` FAISS candidates.
    4. Convert raw distances → cosine-like scores.
    5. Discard out-of-bounds FAISS indices (FAISS returns ``-1`` when
       the index is smaller than the requested k).
    6. Quality filter — remove short / noisy / symbol-heavy chunks.
    7. Similarity threshold — remove chunks below the score floor.
       Fall back to all quality chunks if the threshold is too strict.
    8. Sort descending by score and cap at ``MAX_RETURNED_CHUNKS``.
    """

    # ── 1. Input validation ─────────────────────────────────────────────────
    if not chunks or index is None:
        logger.warning("retrieve_chunks: empty chunk store or index — returning [].")
        return []

    if not query.strip():
        logger.warning("retrieve_chunks: empty query received — returning [].")
        return []

    logger.debug("Query received: %s", query)

    # ── 2. Encode query (single call — no chunk re-encoding) ────────────────
    model = _get_model()
    query_vec: np.ndarray = model.encode(
        [query],
        normalize_embeddings=True,
        convert_to_numpy=True,
    ).astype("float32")                   # FAISS requires float32

    # ── 3. Over-fetch FAISS candidates ──────────────────────────────────────
    fetch_k = min(top_k * OVERFETCH_FACTOR, len(chunks))
    raw_distances, raw_indices = index.search(query_vec, fetch_k)

    distances: np.ndarray = raw_distances[0]    # shape: (fetch_k,)
    faiss_indices: np.ndarray = raw_indices[0]  # shape: (fetch_k,)

    logger.debug("FAISS raw indices  : %s", faiss_indices.tolist())
    logger.debug("FAISS raw distances: %s", distances.tolist())

    # ── 4. Convert distances → cosine-like scores ────────────────────────────
    scores: np.ndarray = _distances_to_scores(distances, index)

    # ── 5. Bounds check — FAISS uses -1 for padding when k > index size ──────
    candidates: list[tuple[float, str]] = [
        (float(score), chunks[int(idx)])
        for score, idx in zip(scores, faiss_indices)
        if 0 <= int(idx) < len(chunks)         # discard -1 sentinel values
    ]

    if not candidates:
        logger.warning("retrieve_chunks: no valid FAISS indices returned.")
        return []

    # ── 6. Quality filter ────────────────────────────────────────────────────
    quality: list[tuple[float, str]] = [
        (score, text)
        for score, text in candidates
        if _is_quality_chunk(text)
    ]

    logger.debug(
        "Quality filter: %d → %d chunks retained.",
        len(candidates), len(quality),
    )

    if not quality:
        # All chunks failed quality checks — this usually signals a data issue,
        # but we still try to return something rather than crashing the pipeline.
        logger.warning(
            "retrieve_chunks: all %d candidates failed quality filter.  "
            "Returning raw candidates as fallback.",
            len(candidates),
        )
        quality = candidates

    # ── 7. Similarity threshold with automatic fallback ──────────────────────
    if similarity_threshold > 0:
        above_threshold = [
            (score, text)
            for score, text in quality
            if score >= similarity_threshold
        ]

        logger.debug(
            "Similarity threshold (%.2f): %d → %d chunks.",
            similarity_threshold, len(quality), len(above_threshold),
        )

        if above_threshold:
            scored = above_threshold
        else:
            # Threshold is too strict for this query — fall back gracefully
            # rather than returning an empty list.
            logger.warning(
                "retrieve_chunks: no chunks above threshold %.2f "
                "(best score=%.3f).  Using all quality chunks as fallback.",
                similarity_threshold,
                quality[0][0] if quality else float("nan"),
            )
            scored = quality
    else:
        # Threshold disabled — use all quality chunks
        scored = quality

    # ── 8. Sort descending by score and cap result size ──────────────────────
    scored.sort(key=lambda pair: pair[0], reverse=True)
    final = scored[:MAX_RETURNED_CHUNKS]

    logger.info(
        "retrieve_chunks → %d chunk(s) returned  "
        "[query=%d chars | top_score=%.3f | threshold=%.2f].",
        len(final),
        len(query),
        final[0][0] if final else 0.0,
        similarity_threshold,
    )

    # ── Return format ────────────────────────────────────────────────────────
    if return_scores:
        return final                              # list[tuple[str, float]]
    return [text for _, text in final]            # list[str]  (default)