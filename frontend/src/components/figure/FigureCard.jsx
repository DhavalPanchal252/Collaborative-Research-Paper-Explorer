// src/components/figure/FigureCard.jsx
// Phase 7.1 — Individual figure card with image, caption, page badge, and hover overlay.

export default function FigureCard({ figure, onClick, onExplain }) {
  const { id, image, caption, page, type } = figure;

  function handleExplain(e) {
    e.stopPropagation();
    onExplain?.(id);
  }

  return (
    <div
      className="fig-card"
      onClick={() => onClick?.(figure)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onClick?.(figure)}
      aria-label={caption}
    >
      {/* Image area */}
      <div className="fig-card-img-wrap">
        <img
          src={image}
          alt={caption}
          className="fig-card-img"
          onError={(e) => { e.currentTarget.style.display = "none"; }}
        />

        {/* Type badge */}
        <span className={`fig-type-badge fig-type-badge--${type}`}>
          {type === "graph" ? "◈ Graph" : "⬡ Diagram"}
        </span>

        {/* Hover overlay */}
        <div className="fig-card-overlay">
          <button
            className="fig-overlay-btn fig-overlay-btn--view"
            onClick={(e) => { e.stopPropagation(); onClick?.(figure); }}
          >
            🔍 View
          </button>
          <button
            className="fig-overlay-btn fig-overlay-btn--explain"
            onClick={handleExplain}
          >
            ✦ Explain
          </button>
        </div>
      </div>

      {/* Card body */}
      <div className="fig-card-body">
        <p className="fig-card-caption">
          {caption.length > 72 ? caption.slice(0, 72) + "…" : caption}
        </p>
        <span className="fig-card-page">p. {page}</span>
      </div>
    </div>
  );
}