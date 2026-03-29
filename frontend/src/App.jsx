// src/App.jsx
import { useState, useCallback } from "react";
import UploadPanel from "./components/UploadPanel";
import ChatPanel from "./components/ChatPanel";
import PDFViewer from "./components/PDFViewer";
import ModelSelector from "./components/ModelSelector";
import PaperInfo from "./components/sidebar/PaperInfo";
import SectionsPanel from "./components/sidebar/SectionsPanel";
import NotesPanel from "./components/sidebar/NotesPanel";
import { uploadPDF } from "./api/upload";
import { explainSelection } from "./api/explain";

// ─────────────────────────────────────────────────────────────────────────────
// Static section data (replace with backend-driven data when ready)
// Shape: { title, page, subsections?: [{ title, page }] }
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_SECTIONS = [
  { title: "Abstract", page: 1 },
  {
    title: "Introduction",
    page: 1,
    subsections: [
      { title: "Background",     page: 2 },
      { title: "Contributions",  page: 3 },
    ],
  },
  {
    title: "Model Architecture",
    page: 5,
    subsections: [
      { title: "Encoder & Decoder",   page: 6 },
      { title: "Attention",           page: 7 },
      { title: "Multi-Head Attention", page: 8 },
    ],
  },
  { title: "Training", page: 9 },
  { title: "Results",  page: 10 },
];

// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  // ── Upload / paper state ──────────────────────────────────────────────────
  const [uploadedFile,  setUploadedFile]  = useState(null);
  const [uploadMeta,    setUploadMeta]    = useState(null);
  const [model,         setModel]         = useState("groq");
  const [uploading,     setUploading]     = useState(false);
  const [uploadError,   setUploadError]   = useState(null);

  // ── Explain feature state ─────────────────────────────────────────────────
  const [explainLoading, setExplainLoading] = useState(false);
  const [injectMessage,  setInjectMessage]  = useState(null);

  // ── Navigation state (owned here, NOT inside PDFViewer) ──────────────────
  const [currentPage,    setCurrentPage]    = useState(1);
  const [activeSection,  setActiveSection]  = useState(null); // section title string

  // ─────────────────────────────────────────────────────────────────────────
  // Handlers
  // ─────────────────────────────────────────────────────────────────────────

  async function handleUpload(file) {
    setUploading(true);
    setUploadError(null);
    try {
      localStorage.removeItem("session_id");
      const meta = await uploadPDF(file);
      setUploadedFile(file);
      setUploadMeta(meta);
      // Reset navigation for the new paper
      setCurrentPage(1);
      setActiveSection(null);
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
    setCurrentPage(1);
    setActiveSection(null);
  }

  /**
   * Called by SectionsPanel when user clicks any section or subsection.
   * @param {{ title: string, page: number }} section
   */
  const handleSectionClick = useCallback(({ title, page }) => {
    setCurrentPage(page);
    setActiveSection(title);
  }, []);

  const handleExplainRequest = useCallback(
    async (selectedText) => {
      if (!selectedText || explainLoading) return;
      setExplainLoading(true);
      const userQuestion = `✦ Explain: "${selectedText.slice(0, 120)}${selectedText.length > 120 ? "…" : ""}"`;
      try {
        const { explanation } = await explainSelection(selectedText, model);
        setInjectMessage({ question: userQuestion, answer: explanation });
      } catch (err) {
        setInjectMessage({
          question: userQuestion,
          answer: `⚠ Could not explain: ${err.message || "Unknown error"}`,
        });
      } finally {
        setExplainLoading(false);
      }
    },
    [model, explainLoading]
  );

  const handleInjectConsumed = useCallback(() => setInjectMessage(null), []);

  const hasPaper = !!uploadedFile;

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="app-shell">

      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div className="sidebar-logo">
          <span className="logo-icon">◈</span>
          <span className="logo-text">Arxiv<em>Mind</em></span>
        </div>

        {hasPaper ? (
          /* ─── POST-UPLOAD: Research panel ─── */
          <>
            <div className="sidebar-section">
              <p className="section-label">PAPER</p>
              <PaperInfo
                uploadedFile={uploadedFile}
                uploadMeta={uploadMeta}
                onReset={handleReset}
              />
            </div>

            <div className="sidebar-section sidebar-section--grow">
              <p className="section-label">SECTIONS</p>
              {/*
                Pass sections data, the click handler, and activeSection so
                the panel can highlight the current context.
                In a future iteration, `sections` can be fetched from the
                backend after upload (backend-driven sections).
              */}
              <SectionsPanel
                sections={DEFAULT_SECTIONS}
                activeSection={activeSection}
                onSectionClick={handleSectionClick}
              />
            </div>

            <div className="sidebar-section">
              <p className="section-label">NOTES</p>
              <NotesPanel />
            </div>
          </>
        ) : (
          /* ─── PRE-UPLOAD: Upload + model ─── */
          <>
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
          </>
        )}

        <div className="sidebar-footer">
          <span className="status-dot" data-ready={hasPaper} />
          <span className="status-text">
            {hasPaper
              ? `${uploadMeta?.chunks_created ?? "—"} chunks indexed`
              : "No paper loaded"}
          </span>
        </div>
      </aside>

      {/* ── Main workspace ── */}
      <div className="workspace">
        {hasPaper ? (
          <>
            <div className="workspace-pdf">
              {/*
                PDFViewer is a controlled component:
                - currentPage comes from App state
                - it does NOT own page state internally
              */}
              <PDFViewer
                file={uploadedFile}
                currentPage={currentPage}
                onExplainRequest={handleExplainRequest}
                explainLoading={explainLoading}
              />
            </div>
            <div className="workspace-chat">
              <ChatPanel
                model={model}
                paperName={uploadedFile.name}
                injectMessage={injectMessage}
                onInjectConsumed={handleInjectConsumed}
              />
            </div>
          </>
        ) : (
          <EmptyState />
        )}
      </div>
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