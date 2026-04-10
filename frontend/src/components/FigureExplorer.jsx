// src/components/FigureExplorer.jsx
// Phase 7.3 — Real backend integration, debounced search, keyboard nav, error/empty states.

import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import FigureToolbar  from "./figure/FigureToolbar";
import FigureCard     from "./figure/FigureCard";
import FigureModal    from "./figure/FigureModal";
import FigureSkeleton from "./figure/FigureSkeleton";
import { getFigures } from "../services/figureService";

const SKELETON_COUNT = 6;

// ---------------------------------------------------------------------------
// Debounce hook
// ---------------------------------------------------------------------------
function useDebounced(value, delay = 280) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function FigureExplorer({ onExplain, onGoToPDF }) {
  // ── Data state ────────────────────────────────────────────────────────────
  const [figures,   setFigures]   = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);

  // ── UI state ──────────────────────────────────────────────────────────────
  const [search,      setSearch]      = useState("");
  const [filter,      setFilter]      = useState("all");
  const [sortAsc,     setSortAsc]     = useState(true);
  const [selectedFig, setSelectedFig] = useState(null);
  const [gridVisible, setGridVisible] = useState(false);

  // Debounce search so we don't re-filter on every keystroke
  const debouncedSearch = useDebounced(search, 280);

  // ── Fetch ─────────────────────────────────────────────────────────────────
  const sessionId = localStorage.getItem("session_id");

  const fetchFigures = useCallback(async () => {
    setLoading(true);
    setError(null);
    setGridVisible(false);

    try {
      const result = await getFigures(sessionId);
      setFigures(result.figures);
      // Slight delay before fade-in so skeleton unmounts cleanly
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setGridVisible(true));
      });
    } catch (err) {
      setError(err.message ?? "Failed to load figures.");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    fetchFigures();
  }, [fetchFigures]);

  // ── Filter + sort ─────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();

    return figures
      .filter((f) => {
        const matchesFilter =
          filter === "all" || f.type === filter;

        const matchesSearch =
          !q ||
          (f.caption ?? "").toLowerCase().includes(q) ||
          String(f.id ?? "").toLowerCase().includes(q) ||
          String(f.page ?? "").includes(q);

        return matchesFilter && matchesSearch;
      })
      .sort((a, b) =>
        sortAsc ? (a.page ?? 0) - (b.page ?? 0) : (b.page ?? 0) - (a.page ?? 0)
      );
  }, [figures, debouncedSearch, filter, sortAsc]);

  // ── Keyboard navigation (← →) in modal ───────────────────────────────────
  useEffect(() => {
    if (!selectedFig) return;

    function handleKey(e) {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const idx = filtered.findIndex((f) => f.id === selectedFig.id);
        if (idx === -1) return;
        const next =
          e.key === "ArrowRight"
            ? filtered[idx + 1]
            : filtered[idx - 1];
        if (next) setSelectedFig(next);
      }
    }

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [selectedFig, filtered]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  function handleExplain(id) {
    onExplain?.(id);
    setSelectedFig(null);
  }

  function handleGoToPDF(page) {
    onGoToPDF?.(page);
    setSelectedFig(null);
  }

  // ── Derived modal nav state ───────────────────────────────────────────────
  const selectedIdx   = selectedFig ? filtered.findIndex((f) => f.id === selectedFig.id) : -1;
  const hasPrev       = selectedIdx > 0;
  const hasNext       = selectedIdx !== -1 && selectedIdx < filtered.length - 1;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="fig-explorer">
      {/* Toolbar */}
      <FigureToolbar
        search={search}
        onSearch={setSearch}
        filter={filter}
        onFilter={setFilter}
        onSort={() => setSortAsc((v) => !v)}
        sortAsc={sortAsc}
        resultCount={loading ? null : filtered.length}
        totalCount={loading ? null : figures.length}
      />

      {/* Grid area */}
      <div className="fig-grid-area">

        {/* ── Loading ── */}
        {loading && (
          <div className="fig-grid">
            {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
              <FigureSkeleton key={i} index={i} />
            ))}
          </div>
        )}

        {/* ── Error ── */}
        {!loading && error && (
          <div className="fig-error-state">
            <span className="fig-error-icon">⚠</span>
            <p className="fig-error-title">Failed to load figures</p>
            <p className="fig-error-msg">{error}</p>
            <button className="fig-retry-btn" onClick={fetchFigures}>
              ↺ Retry
            </button>
          </div>
        )}

        {/* ── Empty ── */}
        {!loading && !error && filtered.length === 0 && (
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
            {figures.length > 0 && (
              <button
                className="fig-retry-btn fig-retry-btn--soft"
                onClick={() => { setSearch(""); setFilter("all"); }}
              >
                × Clear filters
              </button>
            )}
          </div>
        )}

        {/* ── Grid ── */}
        {!loading && !error && filtered.length > 0 && (
          <div
            className="fig-grid"
            style={{
              opacity: gridVisible ? 1 : 0,
              transition: "opacity 300ms ease",
            }}
          >
            {filtered.map((fig, i) => (
              <FigureCard
                key={fig.id}
                figure={fig}
                onClick={setSelectedFig}
                onExplain={handleExplain}
                animationIndex={i}
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
          onPrev={hasPrev ? () => setSelectedFig(filtered[selectedIdx - 1]) : null}
          onNext={hasNext ? () => setSelectedFig(filtered[selectedIdx + 1]) : null}
          currentIndex={selectedIdx}
          totalCount={filtered.length}
        />
      )}
    </div>
  );
}