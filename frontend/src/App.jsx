// src/App.jsx
// Phase 4+: bidirectional chat↔PDF linking.
// onExplainRequest now receives (text, highlightId) and threads highlightId
// through to the chat message so clicking it scrolls back to the highlight.

import { useState, useCallback, useRef } from "react";
import UploadPanel    from "./components/UploadPanel";
import ChatPanel      from "./components/ChatPanel";
import PDFViewer      from "./components/PDFViewer";
import ModelSelector  from "./components/ModelSelector";
import PaperInfo      from "./components/sidebar/PaperInfo";
import SectionsPanel  from "./components/sidebar/SectionsPanel";
import NotesPanel     from "./components/sidebar/NotesPanel";
import Header         from "./components/layout/Header";
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

  // Bidirectional link: when user clicks a chat message with a highlightId,
  // this triggers PDFViewer to scroll + flash the corresponding highlight.
  const [focusedHighlightId, setFocusedHighlightId] = useState(null);

  // Track which highlightId the current explain call belongs to so we can
  // include it in the chat message (enabling the ↗ PDF link button).
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
    pendingHighlightIdRef.current = null;
  }

  // ── Explain flow ──────────────────────────────────────────────────────────
  // PDFViewer passes (text, highlightId) so we can:
  //   1. Store highlightId for inclusion in the chat message
  //   2. Include it in explainResult so PDFViewer can attach it to the highlight
  //   3. Include it in injectMessage so ChatPanel can show the ↗ PDF link

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

        // 1. Inject into chat (with highlightId for the ↗ PDF button)
        setInjectMessage({
          question:    userQuestion,
          answer:      answer?.trim() ? answer : "⚠ Model returned empty response. Try again.",
          highlightId: pendingHighlightIdRef.current,
        });

        // 2. Route result back to PDFViewer to attach to highlight
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

  // ── Bidirectional: chat → PDF ─────────────────────────────────────────────
  // Called by ChatPanel → ChatMessage when user clicks the ↗ PDF link.
  const handleHighlightFocus = useCallback((id) => {
    setFocusedHighlightId(id);
  }, []);

  const handleInjectConsumed          = useCallback(() => setInjectMessage(null),  []);
  const handleExplainResultConsumed   = useCallback(() => setExplainResult(null),  []);
  const handleFocusedHighlightConsumed = useCallback(() => setFocusedHighlightId(null), []);

  const hasPaper = !!uploadedFile;

  /* ─── PAPER LOADED ───────────────────────────────────────────────────────── */
  if (hasPaper) {
    return (
      <div className="app-paper-layout">
        <Header model={model} uploadMeta={uploadMeta} />

        <div className="app-paper-body">
          {/* Sidebar */}
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
              <NotesPanel />
            </div>
            <div className="sidebar-footer">
              <span className="status-dot" data-ready="true" />
              <span className="status-text">{uploadMeta?.chunks_created ?? "—"} chunks indexed</span>
            </div>
          </aside>

          {/* PDF Viewer */}
          <div className="paper-pdf">
            <PDFViewer
              file={uploadedFile}
              onExplainRequest={handleExplainRequest}      // (text, highlightId) => void
              explainLoading={explainLoading}
              explainResult={explainResult}
              onExplainResultConsumed={handleExplainResultConsumed}
              focusedHighlightId={focusedHighlightId}       // Phase 4+ bidirectional
              onFocusedHighlightConsumed={handleFocusedHighlightConsumed}
            />
          </div>

          {/* Chat */}
          <div className="paper-chat">
            <ChatPanel
              model={model}
              paperName={uploadedFile.name}
              injectMessage={injectMessage}
              onInjectConsumed={handleInjectConsumed}
              onHighlightClick={handleHighlightFocus}  // Phase 4+ bidirectional
            />
          </div>
        </div>
      </div>
    );
  }

  /* ─── HOME SCREEN (unchanged) ────────────────────────────────────────────── */
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