import { useMemo } from "react";
// src/components/sidebar/NotesPanel.jsx
// Phase 6 — Notes System
// Fully derived from highlights (single source of truth).
// Bi-directional sync: edits in popup appear instantly; deletes remove instantly.

export default function NotesPanel({ highlights = [], onSelectHighlight, onDeleteHighlight , activeId}) {
  if (!highlights.length) {
    return (
      <div className="notes-panel notes-panel--empty">
        <span className="notes-empty-icon">◈</span>
        <p className="notes-empty-text">No notes yet</p>
        <p className="notes-empty-sub">Highlight text to start</p>
      </div>
    );
  }


  const sorted = useMemo(() => {
    return [...highlights].sort(
      (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
    );
  }, [highlights]);

  return (
    <div className="notes-panel">
      {sorted.map((h) => (
        <NoteItem
          key={h.id}
          highlight={h}
          onSelect={onSelectHighlight}
          onDelete={onDeleteHighlight}
          active = {h.id === activeId}
        />
      ))}
    </div>
  );
}

function NoteItem({ highlight: h, onSelect, onDelete , active}) {
  const hasNote   = !!h.note?.trim();
  const hasAI     = !!h.aiExplanation && !h.aiLoading && !h.aiError;
  const isLoading = !!h.aiLoading;
  const text = h.text || "";

  return (
    <div className={`note-item ${active ? "active" : ""}`} onClick={() => onSelect?.(h)}>
      <div className="note-item-inner">
        {/* Highlighted text excerpt */}
        <p className="note-item-quote">
          <span className="note-item-quote-mark">"</span>
          
          {text.length > 90 ? text.slice(0, 90) + "…" : text}
          <span className="note-item-quote-mark">"</span>
        </p>

        {/* User note */}
        {hasNote && (
          <p className="note-item-user">
            <span className="note-item-label">Note</span>
            {h.note.length > 80 ? h.note.slice(0, 80) + "…" : h.note}
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
            {h.aiExplanation.length > 80
              ? h.aiExplanation.slice(0, 80) + "…"
              : h.aiExplanation}
          </p>
        ) : null}

        {/* Timestamp */}
        {h.createdAt && (
          <p className="note-item-time">{formatTime(h.createdAt)}</p>
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

function formatTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d)) return "";
  const now  = new Date();
  const diff = now - d;

  if (diff < 60_000)    return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}