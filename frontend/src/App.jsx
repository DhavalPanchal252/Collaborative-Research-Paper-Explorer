// src/App.jsx
import { useState, useCallback } from "react";
import UploadPanel from "./components/UploadPanel";
import ChatPanel from "./components/ChatPanel";
import PDFViewer from "./components/PDFViewer";
import ModelSelector from "./components/ModelSelector";
import PaperInfo from "./components/sidebar/PaperInfo";
import SectionsPanel from "./components/sidebar/SectionsPanel";
import NotesPanel from "./components/sidebar/NotesPanel";
import Header from "./components/layout/Header";
import { uploadPDF } from "./api/upload";
import { explainSelection } from "./api/explain";

export default function App() {
  const [uploadedFile, setUploadedFile] = useState(null);
  const [uploadMeta, setUploadMeta] = useState(null);
  const [model, setModel] = useState("groq");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [explainLoading, setExplainLoading] = useState(false);
  const [injectMessage, setInjectMessage] = useState(null);

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
  }

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

  /* ─── PAPER LOADED ─────────────────────────────────────────────────────────
     .app-paper-layout  → flex-column, 100vh
       <Header />        → full-width, 60px, shrink 0
       .app-paper-body   → flex:1, flex-row, overflow hidden
         <aside.sidebar> → 280px fixed, existing styles unchanged
         .paper-pdf      → flex:1, overflow hidden (PDF viewer)
         .paper-chat     → 380px fixed, overflow hidden (chat)
  ─────────────────────────────────────────────────────────────────────────── */
  if (hasPaper) {
    return (
      <div className="app-paper-layout">

        <Header model={model} uploadMeta={uploadMeta} />

        <div className="app-paper-body">

          {/* ── Column 1: Sidebar ── */}
          <aside className="sidebar">
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
              <SectionsPanel />
            </div>

            <div className="sidebar-section">
              <p className="section-label">NOTES</p>
              <NotesPanel />
            </div>

            <div className="sidebar-footer">
              <span className="status-dot" data-ready="true" />
              <span className="status-text">
                {uploadMeta?.chunks_created ?? "—"} chunks indexed
              </span>
            </div>
          </aside>

          {/* ── Column 2: PDF Viewer ── */}
          <div className="paper-pdf">
            <PDFViewer
              file={uploadedFile}
              onExplainRequest={handleExplainRequest}
              explainLoading={explainLoading}
            />
          </div>

          {/* ── Column 3: Chat ── */}
          <div className="paper-chat">
            <ChatPanel
              model={model}
              paperName={uploadedFile.name}
              injectMessage={injectMessage}
              onInjectConsumed={handleInjectConsumed}
            />
          </div>

        </div>
      </div>
    );
  }

  /* ─── NO PAPER: original home screen, pixel-perfect unchanged ─── */
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

      <div className="workspace">
        <EmptyState />
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