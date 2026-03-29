// src/components/sidebar/SectionsPanel.jsx
import { useState } from "react";

const DEFAULT_SECTIONS = [
  { id: "abstract",     label: "Abstract" },
  { id: "introduction", label: "Introduction" },
  { id: "method",       label: "Method" },
  { id: "results",      label: "Results" },
  { id: "conclusion",   label: "Conclusion" },
];

export default function SectionsPanel({ sections = DEFAULT_SECTIONS }) {
  const [active, setActive] = useState(null);

  return (
    <div className="sections-panel">
      {sections.map((sec) => (
        <button
          key={sec.id}
          className={`section-item ${active === sec.id ? "section-item--active" : ""}`}
          onClick={() => setActive(sec.id)}
        >
          <span className="section-item-dot" />
          {sec.label}
        </button>
      ))}
    </div>
  );
}