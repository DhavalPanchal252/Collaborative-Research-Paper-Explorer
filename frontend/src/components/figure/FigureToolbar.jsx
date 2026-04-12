// src/components/figure/FigureToolbar.jsx
// UPDATED — Phase 7.3.C
// Tasks: T1 active-filter glow · T2 group spacing · T3 sort direction · T4 always-on count
// New props added: sortDir, onSortDir  (all existing props unchanged)

export default function FigureToolbar({
  search,
  onSearch,
  filter,
  onFilter,
  importanceFilter  = "all",
  onImportanceFilter,
  sortBy            = "page",
  onSort,                      // cycles mode: page → confidence → importance
  sortDir           = "asc",   // NEW T3 — "asc" | "desc"
  onSortDir,                   // NEW T3 — toggles direction
  resultCount       = null,
  totalCount        = null,
}) {
  /* ── data ── */
  const TYPE_FILTERS = [
    { value: "all",        label: "All"         },
    { value: "graph",      label: "Graphs"      },
    { value: "diagram",    label: "Diagrams"    },
    { value: "chart",      label: "Charts"      },
    { value: "comparison", label: "Comparisons" },
    { value: "image",      label: "Images"      },
  ];

  const IMPORTANCE_FILTERS = [
    { value: "all",    label: "Any"  },
    { value: "high",   label: "High" },
    { value: "medium", label: "Med"  },
    { value: "low",    label: "Low"  },
  ];

  const SORT_MODES = [
    { value: "page",       label: "Page",       icon: "≡"  },
    { value: "confidence", label: "Confidence", icon: "◉"  },
    { value: "importance", label: "Priority",   icon: "▲"  },
  ];
  const currentSort = SORT_MODES.find((m) => m.value === sortBy) ?? SORT_MODES[0];

  // UPDATED T4 — always show when data loaded; highlight only when filtered
  const showCount        = resultCount !== null && totalCount !== null;
  const isFiltered       = search.trim() !== "" || filter !== "all" || importanceFilter !== "all";

  return (
    <div className="fig-toolbar">

      {/* ── Search ─────────────────────────────────────────────────── */}
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

      {/* ── Type filters ───────────────────────────────────────────── */}
      {/* UPDATED T1 — active pills get --glow modifier for box-shadow */}
      <div className="fig-toolbar-filters">
        {TYPE_FILTERS.map((f) => (
          <button
            key={f.value}
            className={[
              "fig-filter-pill",
              filter === f.value && "fig-filter-pill--active",
              filter === f.value && "fig-filter-pill--glow",
            ].filter(Boolean).join(" ")}
            onClick={() => onFilter(f.value)}
            aria-pressed={filter === f.value}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* UPDATED T2 — divider has more horizontal margin (see CSS) */}
      <div className="fig-toolbar-divider" aria-hidden="true" />

      {/* ── Importance filters ─────────────────────────────────────── */}
      <div className="fig-toolbar-filters fig-toolbar-filters--importance">
        {IMPORTANCE_FILTERS.map((f) => (
          <button
            key={f.value}
            className={[
              "fig-filter-pill",
              "fig-filter-pill--importance",
              importanceFilter === f.value && "fig-filter-pill--imp-active",
              importanceFilter === f.value && `fig-filter-pill--imp-active--${f.value}`,
            ].filter(Boolean).join(" ")}
            onClick={() => onImportanceFilter?.(f.value)}
            aria-pressed={importanceFilter === f.value}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* ── Right controls ─────────────────────────────────────────── */}
      <div className="fig-toolbar-right">

        {/* UPDATED T4 — always-visible count; accent colour when filtered */}
        {showCount && (
          <span className={`fig-result-count${isFiltered ? " fig-result-count--active" : ""}`}>
            Showing <strong>{resultCount}</strong> of {totalCount}
          </span>
        )}

        {/* UPDATED T3 — mode label + separate ↑/↓ direction button */}
        <div className="fig-sort-group">
          <button
            className="fig-sort-btn"
            onClick={onSort}
            title="Cycle: Page → Confidence → Priority"
            aria-label={`Sort by: ${currentSort.label}`}
          >
            <span className="fig-sort-icon">{currentSort.icon}</span>
            {currentSort.label}
          </button>

          {/* NEW T3 — direction arrow spins on toggle */}
          <button
            className={`fig-sort-dir-btn${sortDir === "desc" ? " fig-sort-dir-btn--desc" : ""}`}
            onClick={onSortDir}
            aria-label={sortDir === "asc" ? "Ascending" : "Descending"}
            title={sortDir === "asc" ? "Ascending — click to reverse" : "Descending — click to reverse"}
          >
            <span
              className="fig-sort-dir-arrow"
              style={{
                display: "inline-block",
                transition: "transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1)",
                transform: sortDir === "desc" ? "rotate(180deg)" : "rotate(0deg)",
              }}
            >
              ↑
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}