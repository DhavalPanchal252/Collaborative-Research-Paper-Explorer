// src/components/layout/Header.jsx
// Phase 7.1: activeTab + onTabChange now controlled by App.jsx (lifted state).
// Internal `useState` for activeTab removed — App is the single source of truth.

const NAV_TABS = [
  { id: "pdf",      label: "PDF View" },
  { id: "citation", label: "Citation Graph" },
  { id: "figures",  label: "Figure Explorer" },
  { id: "export",   label: "Export" },
];

export default function Header({ model, uploadMeta, onTabChange, activeTab = "pdf", theme, setTheme }) {
  function handleTab(id) {
    onTabChange?.(id);
  }

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

      {/* RIGHT: theme toggle + model pill */}
      <div className="app-header-right">
        <button
          className="theme-toggle-btn"
          onClick={() => setTheme?.(theme === "dark" ? "light" : "dark")}
          title="Toggle theme"
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        >
          {theme === "dark" ? "☀" : "☾"}
        </button>
        <span className={`chat-model-pill chat-model-pill--${model}`}>
          {model === "groq" ? "⚡ Groq" : "🖥 Ollama"}
        </span>
      </div>
    </header>
  );
}