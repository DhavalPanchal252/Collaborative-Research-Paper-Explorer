// src/api/explain.js
// Phase 4: updated to consume structured response { answer, source_chunks, confidence }
// (backend /explain-selection now returns this shape instead of { explanation })

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "https://adventurous-upliftment-production.up.railway.app";

/**
 * Send selected PDF text for plain-English explanation.
 *
 * @param {string} selectedText       - Text highlighted by the user in the PDF.
 * @param {"groq"|"ollama"} model     - LLM backend to use.
 * @returns {Promise<{ answer: string, source_chunks: string[], confidence: number }>}
 */
export async function explainSelection(selectedText, model = "groq") {
  const res = await fetch(`${BASE_URL}/explain-selection`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      selected_text: selectedText,
      model,
    }),
  });

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const err = await res.json();
      message = err.detail ?? message;
    } catch {}
    throw new Error(message);
  }

  // Phase 4: backend now returns { answer, source_chunks, confidence }
  return res.json();
}
