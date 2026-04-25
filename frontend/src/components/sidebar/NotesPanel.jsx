import { useMemo, useState } from "react";
// src/components/sidebar/NotesPanel.jsx
// Phase 6.5 — Notes Search + Filter System
// Search and filter are local state; highlights remain the single source of truth.

export default function NotesPanel({ highlights = [], onSelectHighlight, onDeleteHighlight, activeId }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType]   = useState("all");

  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return [...highlights]
      .filter((h) => {
        const matchesFilter =
          filterType === "all" ||
          (filterType === "notes" && h.note?.trim()) ||
          (filterType === "ai"    && h.aiExplanation && !h.aiLoading && !h.aiError);

        const matchesSearch =
          !query ||
          h.text?.toLowerCase().includes(query) ||
          h.note?.toLowerCase().includes(query) ||
          h.aiExplanation?.toLowerCase().includes(query);

        return matchesFilter && matchesSearch;
      })
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  }, [highlights, searchQuery, filterType]);

  // True empty — no highlights at all
  if (!highlights.length) {
    return (
      <div className="notes-panel notes-panel--empty">
        <span className="notes-empty-icon">◈</span>
        <p className="notes-empty-text">No notes yet</p>
        <p className="notes-empty-sub">Highlight text to start</p>
      </div>
    );
  }

  return (
    <div className="notes-panel">
      {/* ── Search + Filter bar ── */}
      <div className="notes-controls">
        <div className="notes-search-wrap">
          <span className="notes-search-icon">🔍</span>
          <input
            className="notes-search-input"
            type="text"
            placeholder="Search notes…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            spellCheck={false}
          />
          {searchQuery && (
            <button
              className="notes-search-clear"
              onClick={() => setSearchQuery("")}
              title="Clear search"
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>

        <div className="notes-filter-pills">
          {["all", "notes", "ai"].map((type) => (
            <button
              key={type}
              className={`notes-filter-pill${filterType === type ? " notes-filter-pill--active" : ""}`}
              onClick={() => setFilterType(type)}
            >
              {type === "all" ? "All" : type === "notes" ? "Notes" : "AI"}
            </button>
          ))}
        </div>
      </div>

      {/* ── Results or empty state ── */}
      {filtered.length === 0 ? (
        <div className="notes-panel--empty notes-panel--no-match">
          <span className="notes-empty-icon" style={{ fontSize: "16px" }}>⊘</span>
          <p className="notes-empty-text">No matching notes found</p>
          <p className="notes-empty-sub">Try a different search or filter</p>
        </div>
      ) : (
        filtered.map((h) => (
          <NoteItem
            key={h.id}
            highlight={h}
            onSelect={onSelectHighlight}
            onDelete={onDeleteHighlight}
            active={h.id === activeId}
            query={searchQuery.trim().toLowerCase()}
          />
        ))
      )}
    </div>
  );
}

// ── NoteItem ────────────────────────────────────────────────────────────────

function NoteItem({ highlight: h, onSelect, onDelete, active, query }) {
  const hasNote   = !!h.note?.trim();
  const hasAI     = !!h.aiExplanation && !h.aiLoading && !h.aiError;
  const isLoading = !!h.aiLoading;
  const text      = h.text || "";

  return (
    <div
      className={`note-item${active ? " active" : ""}`}
      onClick={() => onSelect?.(h)}
    >
      <div className="note-item-inner">
        {/* Highlighted text excerpt */}
        <p className="note-item-quote">
          <span className="note-item-quote-mark">"</span>
          <Highlight text={text.length > 90 ? text.slice(0, 90) + "…" : text} query={query} />
          <span className="note-item-quote-mark">"</span>
        </p>

        {/* User note */}
        {hasNote && (
          <p className="note-item-user">
            <span className="note-item-label">Note</span>
            <Highlight
              text={h.note.length > 80 ? h.note.slice(0, 80) + "…" : h.note}
              query={query}
            />
          </p>
        )}

        {/* AI explanation or loading shimmer */}
        {isLoading ? (
          <div className="note-item-ai-loading">
            <span className="spinner spinner--xs" />
            <span className="note-item-ai-loading-text">Generating…</span>
          </div>
        ) : hasAI ? (
          <p className="note-item-ai">
            <span className="note-item-label note-item-label--ai">✦ AI</span>
            <Highlight
              text={h.aiExplanation.length > 80 ? h.aiExplanation.slice(0, 80) + "…" : h.aiExplanation}
              query={query}
            />
          </p>
        ) : null}

        {/* Timestamp */}
        {h.createdAt && (
          <p className="note-item-time"><span className="note-time-icon">⏱</span> {formatTime(h.createdAt)}</p>
        )}
      </div>

      {/* Actions */}
      <div className="note-item-actions" onClick={(e) => e.stopPropagation()}>
        <button
          className="note-action-btn note-action-btn--view"
          onClick={() => onSelect?.(h)}
          title="Scroll to highlight"
        >
          View ↗
        </button>
        <button
          className="note-action-btn note-action-btn--delete"
          onClick={() => onDelete?.(h.id)}
          title="Delete highlight"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

// ── Inline match highlighter ────────────────────────────────────────────────

function Highlight({ text, query }) {
  if (!query || !text) return <>{text}</>;

  const idx = text.toLowerCase().indexOf(query);
  if (idx === -1) return <>{text}</>;

  return (
    <>
      {text.slice(0, idx)}
      <mark className="notes-match-mark">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatTime(date) {
  const d    = date instanceof Date ? date : new Date(date);
  if (isNaN(d)) return "";
  const now  = new Date();
  const diff = now - d;

  if (diff < 60_000)     return "just now";
  if (diff < 3_600_000)  return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}