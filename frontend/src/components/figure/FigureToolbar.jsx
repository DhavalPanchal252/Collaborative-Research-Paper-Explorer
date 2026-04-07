// src/components/figure/FigureToolbar.jsx
// Phase 7.1 — Search, filter, and sort controls for the Figure Explorer.

export default function FigureToolbar({ search, onSearch, filter, onFilter, onSort }) {
  const FILTERS = [
    { value: "all",     label: "All" },
    { value: "graph",   label: "Graph" },
    { value: "diagram", label: "Diagram" },
  ];

  return (
    <div className="fig-toolbar">
      {/* Search */}
      <div className="fig-toolbar-search-wrap">
        <span className="fig-toolbar-search-icon">🔍</span>
        <input
          className="fig-toolbar-search"
          type="text"
          placeholder="Search figures…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          spellCheck={false}
        />
        {search && (
          <button
            className="fig-toolbar-search-clear"
            onClick={() => onSearch("")}
            aria-label="Clear search"
          >
            ×
          </button>
        )}
      </div>

      {/* Filter pills */}
      <div className="fig-toolbar-filters">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            className={`fig-filter-pill${filter === f.value ? " fig-filter-pill--active" : ""}`}
            onClick={() => onFilter(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Sort */}
      <button className="fig-sort-btn" onClick={onSort} title="Sort figures">
        <span className="fig-sort-icon">⇅</span>
        Sort
      </button>
    </div>
  );
}