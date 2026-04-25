// src/App.jsx

import { useState, useCallback, useRef, useEffect } from "react";
import UploadPanel    from "./components/UploadPanel";
import EmptyState from "./components/EmptyState"; // home page
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

// 🔥 NEW
import ForceGraph2D from "react-force-graph-2d";

export default function App() {
  const [uploadedFile, setUploadedFile]       = useState(null);
  const [uploadMeta, setUploadMeta]           = useState(null);
  const [model, setModel]                     = useState("groq");
  const [uploading, setUploading]             = useState(false);
  const [uploadError, setUploadError]         = useState(null);
  const [explainLoading, setExplainLoading]   = useState(false);
  const [injectMessage, setInjectMessage]     = useState(null);
  const [explainResult, setExplainResult]     = useState(null);

  const [viewMode, setViewMode] = useState("pdf");
  const [targetPage, setTargetPage] = useState(null);

  // 🔥 NEW STATES
  const [sessionId, setSessionId] = useState(null);
  const [graphData, setGraphData] = useState(null);
  const [graphLoading, setGraphLoading] = useState(false);

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

  // ── Upload ─────────────────────────────────────────

  async function handleUpload(file) {
    setUploading(true);
    setUploadError(null);
    try {
      localStorage.removeItem("session_id");

      const meta = await uploadPDF(file);

      setUploadedFile(file);
      setUploadMeta(meta);

      // 🔥 SAVE SESSION ID
      setSessionId(meta.session_id);

      // reset graph when new paper uploaded
      setGraphData(null);

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

    // 🔥 reset graph
    setGraphData(null);
    setSessionId(null);

    pendingHighlightIdRef.current = null;
  }

  // ── GRAPH FETCH ───────────────────────────────────

  const fetchGraph = async () => {
    if (!sessionId) return;

    setGraphLoading(true);

    try {
      const res = await fetch(
        `http://127.0.0.1:8000/api/v1/citation-graph?session_id=${sessionId}`
      );

      const data = await res.json();
      setGraphData(data);
    } catch (err) {
      console.error("Graph fetch failed", err);
    }

    setGraphLoading(false);
  };

  // 🔥 TRIGGER ON TAB CHANGE
  useEffect(() => {
    if (viewMode === "citation" && !graphData) {
      fetchGraph();
    }
  }, [viewMode]);

  // ── Explain flow ─────────────────────────────────

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
          question: userQuestion,
          answer: answer?.trim() ? answer : "⚠ Empty response.",
          highlightId: pendingHighlightIdRef.current,
        });

        setExplainResult({ text: selectedText, answer, source_chunks, confidence });

      } catch (err) {
        const errorMsg = `⚠ Error: ${err.message}`;
        setInjectMessage({
          question: userQuestion,
          answer: errorMsg,
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
                onSelectHighlight={(h) => setFocusedHighlightId(h.id)}
                onDeleteHighlight={(id) => setDeleteHighlightId(id)}
                activeId={focusedHighlightId}
              />
            </div>
            <div className="sidebar-footer">
              <span className="status-dot" data-ready="true" />
              <span className="status-text">{uploadMeta?.chunks_created ?? "—"} chunks indexed</span>
            </div>
          </aside>

          {/* ── CENTER PANEL ── */}
          {viewMode === "figures" ? (
            <FigureExplorer 
              onExplain={handleFigureExplain}
              onGoToPDF={handleFigureGoToPDF}
            />
          ) : viewMode === "citation" ? (
            <div style={{ width: "100%", height: "100%" }}>
              {graphLoading && <p style={{ padding: 20 }}>Loading citation graph...</p>}

              {!graphLoading && graphData && (
                <ForceGraph2D
                  graphData={graphData}

                  backgroundColor="#ffffff"

                  linkColor={() => "rgba(0,0,0,0.1)"}
                  linkWidth={0.5}

                  linkDistance={(link) => {
                    return 200 / Math.sqrt(link.weight || 1);
                  }}

                  nodeCanvasObject={(node, ctx, globalScale) => {
                    const size = node.size || 6;

                    ctx.beginPath();
                    ctx.arc(node.x, node.y, size, 0, 2 * Math.PI);
                    ctx.fillStyle = "#5f8f8f";
                    ctx.fill();

                    const label = node.label?.slice(0, 15) || "";
                    ctx.font = `${10 / globalScale}px Sans-Serif`;
                    ctx.fillStyle = "#333";
                    ctx.fillText(label, node.x + size + 2, node.y);
                  }}

                  cooldownTicks={200}
                  d3AlphaDecay={0.01}
                  d3VelocityDecay={0.4}

                  onNodeClick={(node) => {
                    if (node.url) window.open(node.url, "_blank");
                  }}
                />
              )}
            </div>
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
                  explainLoading={explainLoading}
                />
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // ── What the HOME SCREEN return block looks like (unchanged except import source):

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
      <div className="workspace workspace--home"><EmptyState /></div>
    </div>
  );
}