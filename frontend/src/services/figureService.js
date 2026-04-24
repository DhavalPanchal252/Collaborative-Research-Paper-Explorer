// src/services/figureService.js
// Phase 7.5.2 — Attach session-scoped pdf_url to every normalised figure
// so FigureModal can build page-anchored PDF links without global state.

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

/**
 * Converts a relative static path to a fully-qualified URL.
 *
 * Handles three cases:
 *   "/static/figures/xyz.png"   → "http://localhost:8000/static/figures/xyz.png"
 *   "http://…/xyz.png"          → unchanged (already absolute)
 *   ""                          → ""
 *
 * @param {string} path  Relative or absolute URL from the API.
 * @returns {string}     Fully-qualified URL safe to use in <img src> or window.open.
 */
function resolveUrl(path = "") {
  if (!path) return "";
  if (/^(https?:\/\/|data:)/.test(path)) return path;
  return `${API_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
}

/**
 * Normalises a raw API figure record into a consistent shape used throughout
 * the UI.  Backend (Phase 7.4+) provides: id, title, clean_caption, caption,
 * type, description, importance, quality_score, confidence, page, image_url.
 *
 * Phase 7.5.2 addition: accepts an optional `pdfUrl` (session-scoped, resolved
 * to an absolute URL) and stamps it as `pdf_url` on the returned object.
 * FigureModal reads `figure.pdf_url` to build "#page=N" navigation links.
 *
 * Normalisation rules:
 *  - image        → resolved absolute URL from image_url
 *  - pdf_url      → resolved absolute URL for the source PDF (new)
 *  - type         → backend value (lowercase), fallback "other"
 *  - confidence   → normalised to 0-100 integer (backend may send 0-1 or 0-100)
 *  - importance   → lowercase; fallback "medium"
 *  - title        → fallback id
 *  - description  → fallback clean_caption, then caption
 *
 * @param {object} raw     Raw figure object from the API.
 * @param {string} pdfUrl  Resolved absolute URL for the session PDF (may be "").
 * @returns {object}       Normalised figure with pdf_url attached.
 */
function normaliseFigure(raw, pdfUrl = "") {
  // ── Image URL ─────────────────────────────────────────────────────────────
  const image = resolveUrl(raw.image_url || "");

  // ── Type ──────────────────────────────────────────────────────────────────
  const type = (raw.type ?? "other").toLowerCase();

  // ── Importance ────────────────────────────────────────────────────────────
  const importance = (raw.importance ?? "medium").toLowerCase();

  // ── Confidence (normalise to 0-100 integer) ───────────────────────────────
  // Backend may send a 0-1 float (preferred) or a 0-100 integer.
  // quality_score is 0-3; used as a fallback.
  let confidence = null;
  if (raw.confidence != null) {
    confidence = Math.round(
      raw.confidence <= 1 ? raw.confidence * 100 : raw.confidence,
    );
  } else if (raw.quality_score != null) {
    confidence = Math.round((raw.quality_score / 3) * 100);
  }

  // ── Title / description ───────────────────────────────────────────────────
  const id = raw.id ?? crypto.randomUUID();
  const title = raw.title?.trim() || id;
  const description =
    raw.description?.trim() ||
    raw.clean_caption?.slice(0, 140) ||
    raw.caption?.slice(0, 140) ||
    "";

  return {
    // Spread raw first so nothing is silently dropped (clean_caption, bbox, etc.)
    ...raw,
    // ── Overwrite / add normalised fields ────────────────────────────────────
    id,
    image,
    type,
    importance,
    confidence,   // always 0-100 int or null
    title,
    description,
    // ── Phase 7.5.2: page-anchored PDF navigation ────────────────────────────
    // Resolved absolute URL for the session PDF (e.g.
    // "http://localhost:8000/static/papers/paper.pdf").
    // FigureModal builds: window.open(`${pdf_url}#page=${page}`, "_blank")
    pdf_url: pdfUrl,
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
      // Ignore parse failures — the status message below is sufficient.
    }
    throw new Error(
      detail ||
        `Server returned ${res.status} ${res.statusText}. Please try again.`,
    );
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("Invalid response from server. Please try again.");
  }

  // ── Resolve the session-scoped PDF URL once ───────────────────────────────
  // Backend returns e.g. "/static/papers/paper.pdf"; we resolve it to an
  // absolute URL here so every figure carries a ready-to-use href.
  const resolvedPdfUrl = resolveUrl(data.pdf_url ?? "");

  const rawFigures = Array.isArray(data.figures) ? data.figures : [];

  return {
    sessionId: data.session_id ?? sessionId,
    total:     data.total_figures ?? rawFigures.length,
    figures:   rawFigures.map((fig) => normaliseFigure(fig, resolvedPdfUrl)),
  };
}