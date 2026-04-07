// src/components/FigureExplorer.jsx
// Phase 7.1 — Visual Intelligence Layer: search, filter, grid, modal, skeletons.

import { useState, useMemo, useEffect } from "react";
import FigureToolbar  from "./figure/FigureToolbar";
import FigureCard     from "./figure/FigureCard";
import FigureModal    from "./figure/FigureModal";
import FigureSkeleton from "./figure/FigureSkeleton";

// ── Mock data (replace with API response in Phase 7.2) ────────────────────
const MOCK_FIGURES = [
  {
    id: 1,
    image: "/fig1.png",
    caption: "Figure 1: Model architecture overview showing the encoder-decoder transformer stack with cross-attention layers.",
    page: 3,
    type: "diagram",
  },
  {
    id: 2,
    image: "/fig2.png",
    caption: "Figure 2: Experimental results comparing BLEU scores across baseline, fine-tuned, and proposed models.",
    page: 5,
    type: "graph",
  },
  {
    id: 3,
    image: "/fig3.png",
    caption: "Figure 3: Attention heatmap visualization for sample input tokens across 12 heads.",
    page: 7,
    type: "diagram",
  },
  {
    id: 4,
    image: "/fig4.png",
    caption: "Figure 4: Training loss and validation accuracy curves over 50 epochs.",
    page: 9,
    type: "graph",
  },
  {
    id: 5,
    image: "/fig5.png",
    caption: "Figure 5: Dataset distribution by domain and annotation quality tier.",
    page: 11,
    type: "graph",
  },
  {
    id: 6,
    image: "/fig6.png",
    caption: "Figure 6: System pipeline diagram illustrating data flow from ingestion to inference.",
    page: 14,
    type: "diagram",
  },
];

const SKELETON_COUNT = 6;

export default function FigureExplorer({ onExplain, onGoToPDF }) {
  const [search,        setSearch]        = useState("");
  const [filter,        setFilter]        = useState("all");
  const [sortAsc,       setSortAsc]       = useState(true);
  const [selectedFig,   setSelectedFig]   = useState(null);
  const [isLoading,     setIsLoading]     = useState(true);
  const [figures,       setFigures]       = useState([]);

  // Simulate async figure extraction (Phase 7.2: replace with real fetch)
  useEffect(() => {
    const t = setTimeout(() => {
      setFigures(MOCK_FIGURES);
      setIsLoading(false);
    }, 1200);
    return () => clearTimeout(t);
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();

    return figures
      .filter((f) => {
        const matchesFilter =
          filter === "all" || f.type === filter;

        const matchesSearch =
          !q ||
          f.caption.toLowerCase().includes(q) ||
          String(f.page).includes(q);

        return matchesFilter && matchesSearch;
      })
      .sort((a, b) => sortAsc ? a.page - b.page : b.page - a.page);
  }, [figures, search, filter, sortAsc]);

  function handleExplain(id) {
    onExplain?.(id);
    setSelectedFig(null);
  }

  function handleGoToPDF(page) {
    onGoToPDF?.(page);
    setSelectedFig(null);
  }

  return (
    <div className="fig-explorer">
      {/* Toolbar */}
      <FigureToolbar
        search={search}
        onSearch={setSearch}
        filter={filter}
        onFilter={setFilter}
        onSort={() => setSortAsc((v) => !v)}
      />

      {/* Grid area */}
      <div className="fig-grid-area">
        {isLoading ? (
          // Skeleton placeholders
          <div className="fig-grid">
            {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
              <FigureSkeleton key={i} />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          // Empty state
          <div className="fig-empty">
            <span className="fig-empty-icon">◫</span>
            <p className="fig-empty-title">
              {figures.length === 0
                ? "No figures found in this paper"
                : "No matching figures"}
            </p>
            <p className="fig-empty-sub">
              {figures.length === 0
                ? "Figures will appear here once extracted."
                : "Try adjusting your search or filter."}
            </p>
          </div>
        ) : (
          // Figure grid
          <div className="fig-grid">
            {filtered.map((fig) => (
              <FigureCard
                key={fig.id}
                figure={fig}
                onClick={setSelectedFig}
                onExplain={handleExplain}
              />
            ))}
          </div>
        )}
      </div>

      {/* Modal */}
      {selectedFig && (
        <FigureModal
          figure={selectedFig}
          onClose={() => setSelectedFig(null)}
          onExplain={handleExplain}
          onGoToPDF={handleGoToPDF}
        />
      )}
    </div>
  );
}