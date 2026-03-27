import logging
import re

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

CHUNK_SIZE    = 900   # characters  (was 500 — bigger chunks = richer context)
CHUNK_OVERLAP = 150   # characters of overlap between consecutive chunks
                      # prevents a sentence being cut exactly at a boundary


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def chunk_text(text: str) -> list[str]:
    """
    Split *text* into overlapping chunks of ~CHUNK_SIZE characters.

    Strategy
    --------
    1. Normalize whitespace / line breaks from PDF extraction.
    2. Split on sentence boundaries where possible so chunks don't break
       mid-sentence (better embedding quality).
    3. Accumulate sentences into a window of CHUNK_SIZE chars, then step
       forward by (CHUNK_SIZE - CHUNK_OVERLAP) to create the next chunk.

    Why sentence-aware splitting beats naive slicing
    -------------------------------------------------
    Naive character slicing cuts "... the model achie" / "ves 94 % accuracy"
    into two chunks. Each half is nearly meaningless to the embedder.
    Sentence-aware splitting keeps semantically complete units together.
    """
    if not text or not text.strip():
        logger.warning("chunk_text received empty text.")
        return []

    # --- 1. Normalize -------------------------------------------------------
    # Collapse hyphenated line-breaks common in PDF columns
    text = re.sub(r"-\n", "", text)
    # Collapse remaining newlines to spaces
    text = re.sub(r"\n+", " ", text)
    # Collapse multiple spaces
    text = re.sub(r" {2,}", " ", text).strip()

    # --- 2. Sentence tokenization (no NLTK dependency) ---------------------
    # Split after . ! ? followed by whitespace and an uppercase letter,
    # or a digit (handles "Fig. 3" gracefully enough for our purposes).
    sentence_endings = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"])")
    sentences = sentence_endings.split(text)

    if not sentences:
        logger.warning("No sentences found after splitting.")
        return [text[:CHUNK_SIZE]]

    # --- 3. Build overlapping windows -------------------------------------
    chunks: list[str] = []
    current_chars = 0
    window: list[str] = []

    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue

        # If adding this sentence stays within budget — accumulate
        if current_chars + len(sentence) <= CHUNK_SIZE or not window:
            window.append(sentence)
            current_chars += len(sentence) + 1  # +1 for space
        else:
            # Emit current window as a chunk
            chunks.append(" ".join(window))

            # Retain the overlap tail before starting new window
            overlap_text = " ".join(window)[-CHUNK_OVERLAP:]
            window = [overlap_text, sentence] if overlap_text.strip() else [sentence]
            current_chars = len(" ".join(window))

    # Flush the last window
    if window:
        chunks.append(" ".join(window))

    # Drop empty / whitespace-only results
    chunks = [c.strip() for c in chunks if c.strip()]

    logger.info(
        "chunk_text → %d chunks (size=%d, overlap=%d) from %d chars of text.",
        len(chunks), CHUNK_SIZE, CHUNK_OVERLAP, len(text),
    )
    return chunks