// src/services/figureService.js
// Phase 7.3 — Figure data fetching layer with full error handling.

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

/**
 * Derives a display type from the figure caption using keyword matching.
 * Backend does not supply a type field, so we infer it client-side.
 *
 * @param {string} caption
 * @returns {"diagram" | "chart" | "comparison" | "graph"}
 */
function inferType(caption = "") {
  const c = caption.toLowerCase();
  if (c.includes("compar") || c.includes("versus") || c.includes(" vs "))
    return "comparison";
  if (c.includes("chart") || c.includes("bar") || c.includes("pie"))
    return "chart";
  if (c.includes("diagram") || c.includes("architecture") || c.includes("pipeline") || c.includes("flow"))
    return "diagram";
  return "graph"; // default
}

/**
 * Converts a relative static path to a fully-qualified URL.
 *
 * @param {string} imageUrl  e.g. "/static/figures/xyz.png"
 * @returns {string}         e.g. "http://localhost:8000/static/figures/xyz.png"
 */
function resolveImageUrl(imageUrl = "") {
  if (!imageUrl) return "";
  // Already absolute (http/https/data)
  if (/^(https?:\/\/|data:)/.test(imageUrl)) return imageUrl;
  return `${API_BASE}${imageUrl.startsWith("/") ? "" : "/"}${imageUrl}`;
}

/**
 * Normalises a raw API figure record into a consistent shape used throughout
 * the UI.  Keeps all original fields; adds `image` (resolved URL) and `type`.
 *
 * @param {object} raw  Raw figure object from the API.
 * @returns {object}    Normalised figure.
 */
function normaliseFigure(raw) {
  return {
    ...raw,
    // Canonical image URL used by <img> tags
    image: resolveImageUrl(raw.image_url),
    // Derived display type (diagram / chart / comparison / graph)
    type: inferType(raw.caption),
  };
}

/**
 * Fetches all figures for a given session.
 *
 * @param {string} sessionId
 * @returns {Promise<{ figures: object[], total: number, sessionId: string }>}
 * @throws {Error} with a user-readable `message`
 */
export async function getFigures(sessionId) {
  if (!sessionId) {
    throw new Error("No session ID — please upload a paper first.");
  }

  const url = `${API_BASE}/api/v1/figures?session_id=${encodeURIComponent(sessionId)}`;

  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(30_000), // 30 s hard timeout
    });
  } catch (networkErr) {
    if (networkErr.name === "TimeoutError") {
      throw new Error("Request timed out. The server may be busy — try again.");
    }
    throw new Error(`Network error: ${networkErr.message}`);
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.detail ?? body?.message ?? "";
    } catch {
      // Ignore parse failures
    }
    throw new Error(
      detail ||
        `Server returned ${res.status} ${res.statusText}. Please try again.`
    );
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("Invalid response from server. Please try again.");
  }

  const rawFigures = Array.isArray(data.figures) ? data.figures : [];

  return {
    sessionId: data.session_id ?? sessionId,
    total: data.total_figures ?? rawFigures.length,
    figures: rawFigures.map(normaliseFigure),
  };
}