// src/App.jsx
import { useState, useCallback } from "react";
import UploadPanel from "./components/UploadPanel";
import ChatPanel from "./components/ChatPanel";
import PDFViewer from "./components/PDFViewer";
import ModelSelector from "./components/ModelSelector";
import { uploadPDF } from "./api/upload";
import { explainSelection } from "./api/explain";

export default function App() {
  const [uploadedFile, setUploadedFile] = useState(null);
  const [uploadMeta, setUploadMeta] = useState(null);
  const [model, setModel] = useState("groq");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);

  // ── Explain state: injected message for ChatPanel ─────────────────────────
  const [explainLoading, setExplainLoading] = useState(false);
  const [injectMessage, setInjectMessage] = useState(null); // { question, answer }

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

  // ── Called by PDFViewer when user clicks "Explain" ───────────────────────
  const handleExplainRequest = useCallback(
    async (selectedText) => {
      if (!selectedText || explainLoading) return;

      setExplainLoading(true);

      // Immediately show user's selected text as a "question" in chat
      const userQuestion = `✦ Explain: "${selectedText.slice(0, 120)}${selectedText.length > 120 ? "…" : ""}"`;

      try {
        const { explanation } = await explainSelection(selectedText, model);
        // Signal ChatPanel to display this exchange
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

  // After ChatPanel consumes the injected message, clear it
  const handleInjectConsumed = useCallback(() => {
    setInjectMessage(null);
  }, []);

  const hasPaper = !!uploadedFile;

  return (
    <div className="app-shell">
      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div className="sidebar-logo">
          <span className="logo-icon">◈</span>
          <span className="logo-text">
            Arxiv<em>Mind</em>
          </span>
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
            {/* PDF Viewer — 65% */}
            <div className="workspace-pdf">
              <PDFViewer
                file={uploadedFile}
                onExplainRequest={handleExplainRequest}
                explainLoading={explainLoading}
              />
            </div>

            {/* Chat Panel — 35% */}
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
      <p>
        Ask questions, extract insights, and explore ideas — all powered by
        your chosen LLM.
      </p>
      <ul className="empty-hints">
        <li>→ Summarise the methodology</li>
        <li>→ Explain the key findings</li>
        <li>→ Highlight any passage to explain it instantly</li>
      </ul>
    </div>
  );
}