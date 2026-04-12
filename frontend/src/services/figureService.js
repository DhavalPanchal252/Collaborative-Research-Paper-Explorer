// src/services/figureService.js
// Phase 7.4 — Backend now returns structured figure data with type, description,
// importance, quality_score. No client-side inference needed.

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

/**
 * Converts a relative static path to a fully-qualified URL.
 *
 * @param {string} imageUrl  e.g. "/static/figures/xyz.png"
 * @returns {string}         e.g. "http://localhost:8000/static/figures/xyz.png"
 */
function resolveImageUrl(imageUrl = "") {
  if (!imageUrl) return "";
  if (/^(https?:\/\/|data:)/.test(imageUrl)) return imageUrl;
  return `${API_BASE}${imageUrl.startsWith("/") ? "" : "/"}${imageUrl}`;
}

/**
 * Normalises a raw API figure record into a consistent shape used throughout
 * the UI. Backend (Phase 7.4) provides: id, title, clean_caption, caption,
 * type, description, importance, quality_score, confidence, page, image_url.
 *
 * Rules applied here so components never need to handle raw API shapes:
 *  - image        → resolved absolute URL from image_url
 *  - type         → backend value (lowercase), fallback "graph"
 *  - confidence   → backend confidence; fall back to quality_score; normalise
 *                   to 0-100 range (backend may send 0-1 or 0-100)
 *  - importance   → lowercase; fallback "medium"
 *  - title        → fallback id
 *  - description  → fallback clean_caption, then caption
 *
 * @param {object} raw  Raw figure object from the API.
 * @returns {object}    Normalised figure.
 */
function normaliseFigure(raw) {
  // ── Resolve image ──────────────────────────────────────────────────────────
  const image = resolveImageUrl(raw.image_url || "");

  // ── Type — backend provides it directly; guard against missing/wrong case ──
  const type = (raw.type ?? "other").toLowerCase();

  // ── Importance — lowercase + fallback ─────────────────────────────────────
  const importance = (raw.importance ?? "medium").toLowerCase();

  // ── Confidence — prefer explicit confidence, fall back to quality_score ───
  // Normalise to 0-100 integer regardless of whether backend sends 0-1 or 0-100.
  let confidence = null;

  if (raw.confidence != null) {
    confidence = Math.round(raw.confidence * 100);
  } else if (raw.quality_score != null) {
    confidence = Math.round((raw.quality_score / 3) * 100);
  }

  // ── Title / description fallbacks ─────────────────────────────────────────
  const id = raw.id ?? crypto.randomUUID();
  const title = raw.title?.trim() || id;
  const description =
    raw.description?.trim() ||
    raw.clean_caption?.slice(0, 140) ||
    raw.caption?.slice(0, 140) ||
    "";

  return {
    // Spread raw so nothing is lost (clean_caption, caption, etc. stay available)
    ...raw,
    // Overwrite / add normalised fields
    image,
    type,
    importance,
    confidence,   // always 0-100 int or null — no further conversion needed in UI
    title,
    description,
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
      signal: AbortSignal.timeout(30_000),
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
    total:     data.total_figures ?? rawFigures.length,
    figures:   rawFigures.map(normaliseFigure),
  };
}