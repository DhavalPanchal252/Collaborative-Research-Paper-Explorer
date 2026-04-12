// src/components/figure/FigureToolbar.jsx
// UPDATED — Phase 7.3.B: importance filter group, multi-key sort cycling.
// Props added: importanceFilter, onImportanceFilter, sortBy (replaces sortAsc).
// All existing props kept — FigureExplorer.jsx needs to pass the new ones.

export default function FigureToolbar({
  search,
  onSearch,
  filter,
  onFilter,
  // NEW — importance filter: "all" | "high" | "medium" | "low"
  importanceFilter = "all",
  onImportanceFilter,
  // UPDATED — sortBy: "page" | "confidence" | "importance"  (replaces sortAsc bool)
  sortBy = "page",
  onSort,
  resultCount = null,
  totalCount  = null,
}) {
  // ── Filter definitions ──────────────────────────────────────────────────

  const TYPE_FILTERS = [
    { value: "all",        label: "All"         },
    { value: "graph",      label: "Graphs"      },
    { value: "diagram",    label: "Diagrams"    },
    { value: "chart",      label: "Charts"      },
    { value: "comparison", label: "Comparisons" },
    { value: "image",      label: "Images"      },
  ];

  // NEW
  const IMPORTANCE_FILTERS = [
    { value: "all",    label: "Any"    },
    { value: "high",   label: "High"   },
    { value: "medium", label: "Med"    },
    { value: "low",    label: "Low"    },
  ];

  // NEW — sort cycle order + display labels
  const SORT_MODES = [
    { value: "page",       label: "Page",       icon: "↕" },
    { value: "confidence", label: "Confidence", icon: "◉" },
    { value: "importance", label: "Priority",   icon: "▲" },
  ];
  const currentSort = SORT_MODES.find((m) => m.value === sortBy) ?? SORT_MODES[0];

  const showCount =
    resultCount !== null &&
    totalCount  !== null &&
    (search.trim() !== "" || filter !== "all" || importanceFilter !== "all");

  return (
    <div className="fig-toolbar">

      {/* ── Search ── (unchanged internals) */}
      <div className="fig-toolbar-search-wrap">
        <span className="fig-toolbar-search-icon">🔍</span>
        <input
          className="fig-toolbar-search"
          type="text"
          placeholder="Search title or description…"
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

      {/* ── Type filter pills (unchanged) ── */}
      <div className="fig-toolbar-filters">
        {TYPE_FILTERS.map((f) => (
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

      {/* NEW — Divider between filter groups */}
      <div className="fig-toolbar-divider" aria-hidden="true" />

      {/* NEW — Importance filter group */}
      <div className="fig-toolbar-filters fig-toolbar-filters--importance">
        {IMPORTANCE_FILTERS.map((f) => (
          <button
            key={f.value}
            className={`fig-filter-pill fig-filter-pill--importance${
              importanceFilter === f.value ? " fig-filter-pill--imp-active fig-filter-pill--imp-active--" + f.value : ""
            }`}
            onClick={() => onImportanceFilter?.(f.value)}
            aria-pressed={importanceFilter === f.value}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* ── Right side ── */}
      <div className="fig-toolbar-right">
        {showCount && (
          <span className="fig-result-count">
            {resultCount} of {totalCount}
          </span>
        )}

        {/* UPDATED — cycles through sort modes on click */}
        <button
          className="fig-sort-btn"
          onClick={onSort}
          title="Cycle sort: Page → Confidence → Priority"
          aria-label={`Sort by ${currentSort.label}`}
        >
          <span className="fig-sort-icon">{currentSort.icon}</span>
          {currentSort.label}
        </button>
      </div>
    </div>
  );
}