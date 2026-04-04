// src/App.jsx
// Phase 4: explainResult is now passed to PDFViewer so highlights
// can receive and store their AI explanations.

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
  const [uploadedFile, setUploadedFile]   = useState(null);
  const [uploadMeta, setUploadMeta]       = useState(null);
  const [model, setModel]                 = useState("groq");
  const [uploading, setUploading]         = useState(false);
  const [uploadError, setUploadError]     = useState(null);
  const [explainLoading, setExplainLoading] = useState(false);

  // Chat injection (unchanged from Phase 3)
  const [injectMessage, setInjectMessage] = useState(null);

  // Phase 4: structured result routed back to PDFViewer for highlight attachment
  const [explainResult, setExplainResult] = useState(null);

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
  }

  // ── Phase 4: explain flow ─────────────────────────────────────────────────
  // Sends selected text to the backend, then:
  //   1. Injects question + answer into ChatPanel (existing behavior)
  //   2. Sets explainResult so PDFViewer can attach the answer to the highlight
  const handleExplainRequest = useCallback(
    async (selectedText) => {
      if (!selectedText || explainLoading) return;

      setExplainLoading(true);

      const userQuestion = `✦ Explain: "${selectedText.slice(0, 120)}${
        selectedText.length > 120 ? "…" : ""
      }"`;

      try {
        // explainSelection now returns { answer, source_chunks, confidence }
        const { answer, source_chunks, confidence } = await explainSelection(
          selectedText,
          model
        );

        // 1. Inject into chat panel
        setInjectMessage({
          question: userQuestion,
          answer: answer || "⚠ No response from model"
        });

        // 2. Pass structured result to PDFViewer for highlight attachment
        setExplainResult({ text: selectedText, answer, source_chunks, confidence });

      } catch (err) {
        const errorMsg = `⚠ Could not explain: ${err.message || "Unknown error"}`;

        // Still inject error message into chat so the user sees feedback
        setInjectMessage({ question: userQuestion, answer: errorMsg });

        // Pass error result so PDFViewer can clear the loading spinner
        setExplainResult({ text: selectedText, answer: errorMsg });
      } finally {
        setExplainLoading(false);
      }
    },
    [model, explainLoading]
  );

  const handleInjectConsumed      = useCallback(() => setInjectMessage(null),  []);
  const handleExplainResultConsumed = useCallback(() => setExplainResult(null), []);

  const hasPaper = !!uploadedFile;

  /* ─── PAPER LOADED ──────────────────────────────────────────────────────── */
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
              explainResult={explainResult}                       // Phase 4
              onExplainResultConsumed={handleExplainResultConsumed} // Phase 4
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

  /* ─── NO PAPER: home screen (unchanged) ─────────────────────────────────── */
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