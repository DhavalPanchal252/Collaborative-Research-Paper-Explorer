// src/components/sidebar/SectionsPanel.jsx
import { useState, useCallback } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Types (JSDoc for IDE support without TypeScript overhead)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @typedef {{ title: string, page: number }} SectionItem
 * @typedef {{ title: string, page: number, subsections?: SectionItem[] }} Section
 */

// ─────────────────────────────────────────────────────────────────────────────
// SectionsPanel
//
// Props:
//   sections       – Section[]  (hierarchical array from App.jsx)
//   activeSection  – string | null  (title of the active section/subsection)
//   onSectionClick – ({ title, page }) => void
// ─────────────────────────────────────────────────────────────────────────────
export default function SectionsPanel({ sections = [], activeSection, onSectionClick }) {
  // Track which parent sections are expanded (open/close their subsection list)
  // Key: section title, Value: boolean
  const [expanded, setExpanded] = useState(() => {
    // Default: expand the parent section that contains the active section
    const initial = {};
    sections.forEach((sec) => {
      if (sec.subsections?.length) {
        initial[sec.title] = true; // expand all by default for discoverability
      }
    });
    return initial;
  });

  const toggleExpand = useCallback((title) => {
    setExpanded((prev) => ({ ...prev, [title]: !prev[title] }));
  }, []);

  if (!sections.length) {
    return (
      <div className="sections-panel sections-panel--empty">
        <span className="sections-empty-hint">No sections detected</span>
      </div>
    );
  }

  return (
    <nav className="sections-panel" aria-label="Paper sections">
      {sections.map((sec) => {
        const hasChildren  = sec.subsections?.length > 0;
        const isExpanded   = expanded[sec.title] ?? false;
        const isActive     = activeSection === sec.title;

        // A parent is "contextually active" if one of its children is the active section
        const childIsActive = hasChildren &&
          sec.subsections.some((sub) => sub.title === activeSection);

        return (
          <div key={sec.title} className="section-group">

            {/* ── Parent section row ── */}
            <div
              className={[
                "section-item",
                isActive       ? "section-item--active"  : "",
                childIsActive  ? "section-item--child-active" : "",
              ].filter(Boolean).join(" ")}
            >
              {/* Expand/collapse toggle (only if subsections exist) */}
              {hasChildren ? (
                <button
                  className="section-expand-btn"
                  onClick={() => toggleExpand(sec.title)}
                  aria-expanded={isExpanded}
                  aria-label={isExpanded ? "Collapse" : "Expand"}
                >
                  <span className={`section-chevron ${isExpanded ? "section-chevron--open" : ""}`}>
                    ›
                  </span>
                </button>
              ) : (
                /* Spacer so text aligns with expandable rows */
                <span className="section-expand-spacer" />
              )}

              {/* Section label — click navigates to page */}
              <button
                className="section-label-btn"
                onClick={() => onSectionClick({ title: sec.title, page: sec.page })}
                title={`Jump to page ${sec.page}`}
              >
                <span className="section-item-dot" data-active={isActive || childIsActive} />
                <span className="section-item-title">{sec.title}</span>
                <span className="section-item-page">p.{sec.page}</span>
              </button>
            </div>

            {/* ── Subsection rows (indented) ── */}
            {hasChildren && isExpanded && (
              <div className="subsection-list" role="group">
                {sec.subsections.map((sub) => {
                  const isSubActive = activeSection === sub.title;
                  return (
                    <button
                      key={sub.title}
                      className={`section-item section-item--sub ${isSubActive ? "section-item--active" : ""}`}
                      onClick={() => onSectionClick({ title: sub.title, page: sub.page })}
                      title={`Jump to page ${sub.page}`}
                    >
                      <span className="section-item-dot" data-active={isSubActive} />
                      <span className="section-item-title">{sub.title}</span>
                      <span className="section-item-page">p.{sub.page}</span>
                    </button>
                  );
                })}
              </div>
            )}

          </div>
        );
      })}
    </nav>
  );
}