// src/components/sidebar/NotesPanel.jsx
export default function NotesPanel({ notes = [] }) {
  if (notes.length === 0) {
    return (
      <div className="notes-panel notes-panel--empty">
        <span className="notes-empty-icon">🗒</span>
        <p className="notes-empty-text">No notes yet</p>
        <p className="notes-empty-sub">
          Select text in the PDF and click "Explain" to auto-generate notes.
        </p>
      </div>
    );
  }

  return (
    <div className="notes-panel">
      {notes.map((note, i) => (
        <div key={i} className="note-item">
          <p className="note-item-text">{note.content}</p>
          {note.tag && <span className="note-item-tag">{note.tag}</span>}
        </div>
      ))}
    </div>
  );
}