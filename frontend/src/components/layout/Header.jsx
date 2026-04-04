// src/components/layout/Header.jsx
import { useState } from "react";

const NAV_TABS = [
  { id: "pdf",      label: "PDF View" },
  { id: "citation", label: "Citation Graph" },
  { id: "figure",   label: "Figure Explorer" },
  { id: "export",   label: "Export" },
];

export default function Header({ model, uploadMeta, onTabChange }) {
  const [activeTab, setActiveTab] = useState("pdf");

  function handleTab(id) {
    setActiveTab(id);
    onTabChange?.(id);
  }

  const chunks = uploadMeta?.chunks_created ?? "—";

  return (
    <header className="app-header">
      {/* LEFT: logo */}
      <div className="app-header-left">
        <span className="app-header-logo-icon">◈</span>
        <span className="app-header-logo-text">
          Arxiv<em>Mind</em>
        </span>
      </div>

      {/* CENTER: nav tabs */}
      <nav className="app-header-nav">
        {NAV_TABS.map((tab) => (
          <button
            key={tab.id}
            className={`app-header-tab${activeTab === tab.id ? " app-header-tab--active" : ""}`}
            onClick={() => handleTab(tab.id)}
          >
            {activeTab === tab.id && tab.id === "pdf" && (
              <span className="app-header-tab-dot" />
            )}
            {tab.label}
          </button>
        ))}
      </nav>

      {/* RIGHT: chunks + model pill */}
      <div className="app-header-right">
        <span className="app-header-chunks">
          <span className="status-dot" data-ready="true" />
          {chunks} chunks
        </span>
        <span className={`chat-model-pill chat-model-pill--${model}`}>
          {model === "groq" ? "⚡ Groq" : "🖥 Ollama"}
        </span>
      </div>
    </header>
  );
}