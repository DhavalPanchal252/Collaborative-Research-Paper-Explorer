// src/api/explain.js
// Mirrors the pattern of chat.js — same BASE_URL, same error handling.

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

/**
 * Send selected PDF text for plain-English explanation.
 *
 * @param {string} selectedText  - Text highlighted by the user in the PDF.
 * @param {"groq"|"ollama"} model - LLM backend to use.
 * @returns {Promise<{ explanation: string }>}
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

  return res.json(); // { explanation: "..." }
}