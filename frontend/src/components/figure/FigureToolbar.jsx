// src/components/figure/FigureToolbar.jsx
// Phase 7.3 — Search (debounce-ready), expanded filters, sort direction badge,
//             result count display.

export default function FigureToolbar({
  search,
  onSearch,
  filter,
  onFilter,
  onSort,
  sortAsc = true,
  resultCount = null,
  totalCount  = null,
}) {
  const FILTERS = [
    { value: "all",        label: "All" },
    { value: "diagram",    label: "Diagrams" },
    { value: "chart",      label: "Charts" },
    { value: "graph",      label: "Graphs" },
    { value: "comparison", label: "Comparisons" },
  ];

  // Show result count only when a search/filter is active and data has loaded
  const showCount =
    resultCount !== null &&
    totalCount  !== null &&
    (search.trim() !== "" || filter !== "all");

  return (
    <div className="fig-toolbar">
      {/* ── Search ── */}
      <div className="fig-toolbar-search-wrap">
        <span className="fig-toolbar-search-icon">🔍</span>
        <input
          className="fig-toolbar-search"
          type="text"
          placeholder="Search by ID or caption…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          spellCheck={false}
          autoComplete="off"
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

      {/* ── Filter pills ── */}
      <div className="fig-toolbar-filters">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            className={`fig-filter-pill${filter === f.value ? " fig-filter-pill--active" : ""}`}
            onClick={() => onFilter(f.value)}
            aria-pressed={filter === f.value}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* ── Right-side controls ── */}
      <div className="fig-toolbar-right">
        {showCount && (
          <span className="fig-result-count">
            {resultCount} of {totalCount}
          </span>
        )}

        <button
          className="fig-sort-btn"
          onClick={onSort}
          title={`Sort by page — ${sortAsc ? "ascending" : "descending"}`}
          aria-label={`Sort figures by page ${sortAsc ? "ascending" : "descending"}`}
        >
          <span className="fig-sort-icon" style={{ display: "inline-block", transition: "transform 200ms ease", transform: sortAsc ? "scaleY(1)" : "scaleY(-1)" }}>
            ⇅
          </span>
          {sortAsc ? "Asc" : "Desc"}
        </button>
      </div>
    </div>
  );
}