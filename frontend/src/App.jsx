// src/App.jsx
// Phase 7.1: Figure Explorer mode added via top-level `viewMode` state.
// All existing PDF/Chat logic is untouched.

import { useState, useCallback, useRef, useEffect } from "react";
import UploadPanel    from "./components/UploadPanel";
import ChatPanel      from "./components/ChatPanel";
import PDFViewer      from "./components/PDFViewer";
import ModelSelector  from "./components/ModelSelector";
import PaperInfo      from "./components/sidebar/PaperInfo";
import SectionsPanel  from "./components/sidebar/SectionsPanel";
import NotesPanel     from "./components/sidebar/NotesPanel";
import Header         from "./components/layout/Header";
import FigureExplorer from "./components/FigureExplorer";
import { uploadPDF }  from "./api/upload";
import { explainSelection } from "./api/explain";

export default function App() {
  const [uploadedFile, setUploadedFile]       = useState(null);
  const [uploadMeta, setUploadMeta]           = useState(null);
  const [model, setModel]                     = useState("groq");
  const [uploading, setUploading]             = useState(false);
  const [uploadError, setUploadError]         = useState(null);
  const [explainLoading, setExplainLoading]   = useState(false);
  const [injectMessage, setInjectMessage]     = useState(null);
  const [explainResult, setExplainResult]     = useState(null);

  // ── Phase 7.1: View mode ──────────────────────────────────────────────────
  // "pdf" | "figures" | "citation" | "export"
  const [viewMode, setViewMode] = useState("pdf");
  const [targetPage, setTargetPage] = useState(null);

  // ── Phase X: Theme system ─────────────────────────────────────────────────
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem("arxivmind_theme");
    const resolved = (saved === "dark" || saved === "light")
      ? saved
      : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", resolved);
    return resolved;
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("arxivmind_theme", theme);
  }, [theme]);

  const [highlights, setHighlights]           = useState([]);
  const [deleteHighlightId, setDeleteHighlightId] = useState(null);
  const [focusedHighlightId, setFocusedHighlightId] = useState(null);
  const pendingHighlightIdRef = useRef(null);

  // ── Upload ────────────────────────────────────────────────────────────────

  async function handleUpload(file) {
    setUploading(true);
    setUploadError(null);
    try {
      localStorage.removeItem("session_id");
      const meta = await uploadPDF(file);
      setUploadedFile(file);
      setUploadMeta(meta);
    } catch (err) {
      setUploadError(err.message || "Upload failed. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  function handleReset() {
    localStorage.removeItem("session_id");
    setUploadedFile(null);
    setUploadMeta(null);
    setUploadError(null);
    setInjectMessage(null);
    setExplainResult(null);
    setFocusedHighlightId(null);
    setHighlights([]);
    setDeleteHighlightId(null);
    setViewMode("pdf");
    pendingHighlightIdRef.current = null;
  }

  // ── Explain flow ──────────────────────────────────────────────────────────

  const handleExplainRequest = useCallback(
    async (selectedText, highlightId = null) => {
      if (!selectedText || explainLoading) return;

      pendingHighlightIdRef.current = highlightId;
      setExplainLoading(true);

      const userQuestion = `✦ Explain: "${selectedText.slice(0, 120)}${
        selectedText.length > 120 ? "…" : ""
      }"`;

      try {
        const { answer, source_chunks, confidence } = await explainSelection(
          selectedText,
          model
        );

        setInjectMessage({
          question:    userQuestion,
          answer:      answer?.trim() ? answer : "⚠ Model returned empty response. Try again.",
          highlightId: pendingHighlightIdRef.current,
        });

        setExplainResult({ text: selectedText, answer, source_chunks, confidence });

      } catch (err) {
        const errorMsg = `⚠ Could not explain: ${err.message || "Unknown error"}`;
        setInjectMessage({
          question:    userQuestion,
          answer:      errorMsg,
          highlightId: pendingHighlightIdRef.current,
        });
        setExplainResult({ text: selectedText, answer: errorMsg });
      } finally {
        pendingHighlightIdRef.current = null;
        setExplainLoading(false);
      }
    },
    [model, explainLoading]
  );

  const handleHighlightFocus = useCallback((id) => setFocusedHighlightId(id), []);

  const handleHighlightsChange         = useCallback((hs) => setHighlights(hs), []);
  const handleSelectHighlight          = useCallback((h)  => setFocusedHighlightId(h.id), []);
  const handleDeleteHighlightFromNotes = useCallback((id) => setDeleteHighlightId(id), []);
  const handleDeleteHighlightConsumed  = useCallback(() => setDeleteHighlightId(null), []);
  const handleInjectConsumed           = useCallback(() => setInjectMessage(null), []);
  const handleExplainResultConsumed    = useCallback(() => setExplainResult(null), []);
  const handleFocusedHighlightConsumed = useCallback(() => setFocusedHighlightId(null), []);

  // ── Figure Explorer hooks (pre-wired for Phase 7.2+) ─────────────────────
  const handleFigureExplain = useCallback((figureId) => {
    console.log("Explain figure", figureId);
    // Phase 7.2: will inject into ChatPanel
  }, []);

  const handleFigureGoToPDF = useCallback((page) => {
    console.log("Go to PDF page", page);
    setTargetPage(page);
    setViewMode("pdf");
  }, []);

  const hasPaper = !!uploadedFile;

  /* ─── PAPER LOADED ───────────────────────────────────────────────────────── */
  // ─────────────────────────────────────────────────────────────────
// App.jsx — ONLY THE CHANGED SECTION (replace the hasPaper return block)
// TASK 1: Remove sidebar when viewMode === "figures"
// ─────────────────────────────────────────────────────────────────
//
// CHANGE 1: Add data-view attribute to app-paper-body so CSS can hide sidebar.
// CHANGE 2: FigureExplorer rendered without paper-pdf wrapper — full bleed.
// Everything else is UNTOUCHED.
// ─────────────────────────────────────────────────────────────────

  if (hasPaper) {
    return (
      <div className="app-paper-layout">
        <Header
          model={model}
          uploadMeta={uploadMeta}
          theme={theme}
          setTheme={setTheme}
          activeTab={viewMode}
          onTabChange={setViewMode}
        />

        {/* UPDATED: data-view lets CSS hide sidebar in figures mode */}
        <div className="app-paper-body" data-view={viewMode}>

          {/* Sidebar — hidden via CSS when viewMode === "figures" */}
          <aside className="sidebar">
            <div className="sidebar-section">
              <p className="section-label">PAPER</p>
              <PaperInfo uploadedFile={uploadedFile} uploadMeta={uploadMeta} onReset={handleReset} />
            </div>
            <div className="sidebar-section sidebar-section--grow">
              <p className="section-label">SECTIONS</p>
              <SectionsPanel />
            </div>
            <div className="sidebar-section">
              <p className="section-label">NOTES</p>
              <NotesPanel
                highlights={highlights}
                onSelectHighlight={handleSelectHighlight}
                onDeleteHighlight={handleDeleteHighlightFromNotes}
                activeId={focusedHighlightId}
              />
            </div>
            <div className="sidebar-footer">
              <span className="status-dot" data-ready="true" />
              <span className="status-text">{uploadMeta?.chunks_created ?? "—"} chunks indexed</span>
            </div>
          </aside>

          {/* ── Center panel: mode-switched ── */}
          {viewMode === "figures" ? (
            // UPDATED: full-bleed — no paper-pdf wrapper needed
            <FigureExplorer
              onExplain={handleFigureExplain}
              onGoToPDF={handleFigureGoToPDF}
            />
          ) : (
            <>
              <div className="paper-pdf">
                <PDFViewer
                  file={uploadedFile}
                  targetPage={targetPage}
                  onTargetPageConsumed={() => setTargetPage(null)}
                  onExplainRequest={handleExplainRequest}
                  explainLoading={explainLoading}
                  explainResult={explainResult}
                  onExplainResultConsumed={handleExplainResultConsumed}
                  focusedHighlightId={focusedHighlightId}
                  onFocusedHighlightConsumed={handleFocusedHighlightConsumed}
                  onHighlightsChange={handleHighlightsChange}
                  deleteHighlightId={deleteHighlightId}
                  onDeleteHighlightConsumed={handleDeleteHighlightConsumed}
                />
              </div>
              <div className="paper-chat">
                <ChatPanel
                  model={model}
                  paperName={uploadedFile.name}
                  injectMessage={injectMessage}
                  onInjectConsumed={handleInjectConsumed}
                  onHighlightClick={handleHighlightFocus}
                />
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  /* ─── HOME SCREEN ────────────────────────────────────────────────────────── */
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <span className="logo-icon">◈</span>
          <span className="logo-text">Arxiv<em>Mind</em></span>
        </div>
        <div className="sidebar-section">
          <p className="section-label">PAPER</p>
          <UploadPanel
            onUpload={handleUpload}
            uploading={uploading}
            uploadedFile={uploadedFile}
            uploadMeta={uploadMeta}
            error={uploadError}
            onReset={handleReset}
          />
        </div>
        <div className="sidebar-section">
          <p className="section-label">MODEL</p>
          <ModelSelector model={model} onChange={setModel} />
        </div>
        <div className="sidebar-footer">
          <span className="status-dot" data-ready="false" />
          <span className="status-text">No paper loaded</span>
        </div>
      </aside>
      <div className="workspace"><EmptyState /></div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <div className="empty-glyph">◈</div>
      <h2>Upload a research paper to begin</h2>
      <p>Ask questions, extract insights, and explore ideas — all powered by your chosen LLM.</p>
      <ul className="empty-hints">
        <li>→ Summarise the methodology</li>
        <li>→ Explain the key findings</li>
        <li>→ Highlight any passage to explain it instantly</li>
      </ul>
    </div>
  );
}