import { useState } from "react";
import UploadPanel from "./components/UploadPanel";
import ChatPanel from "./components/ChatPanel";
import ModelSelector from "./components/ModelSelector";
import { uploadPDF } from "./api/upload";

export default function App() {
  const [uploadedFile, setUploadedFile] = useState(null);
  const [uploadMeta, setUploadMeta] = useState(null);
  const [model, setModel] = useState("groq");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);

  async function handleUpload(file) {
    setUploading(true);
    setUploadError(null);
    try {
      // Best practice: Clear previous session before uploading new paper
      // This ensures a fresh session with new chunks and no old history
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
    // Clear session when replacing paper
    localStorage.removeItem("session_id");
    setUploadedFile(null);
    setUploadMeta(null);
    setUploadError(null);
  }

  return (
    <div className="app-shell">
      {/* ── Sidebar ── */}
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
          <span className="status-dot" data-ready={!!uploadedFile} />
          <span className="status-text">
            {uploadedFile ? `${uploadMeta?.chunks_created ?? "—"} chunks indexed` : "No paper loaded"}
          </span>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="main-area">
        {uploadedFile ? (
          <ChatPanel model={model} paperName={uploadedFile.name} />
        ) : (
          <EmptyState />
        )}
      </main>
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
        <li>→ Compare with related work</li>
      </ul>
    </div>
  );
}
