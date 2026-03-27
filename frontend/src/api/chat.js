const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

/**
 * Send a question to the RAG chat endpoint.
 * @param {string} question
 * @param {"groq"|"ollama"} model
 * @returns {Promise<{ answer: string }>}
 */
export async function sendQuestion(question, model) {

  // 🔥 MUST be outside fetch
  const session_id = localStorage.getItem("session_id") || null;

  const res = await fetch(`${BASE_URL}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question,
      model,
      session_id,   // ✅ correct
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

  const data = await res.json();

  // 🔥 IMPORTANT: store session_id if backend sends it
  if (data.session_id) {
    localStorage.setItem("session_id", data.session_id);
  }

  return data;
}