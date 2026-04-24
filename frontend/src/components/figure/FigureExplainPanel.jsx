// src/components/figure/FigureExplainPanel.jsx
// Phase 7.5.1 — Full UX redesign of AI explanation panel.
//
// Design goals
// ─────────────
// • ChatGPT / Linear-level spaciousness — NOT a compressed sidebar
// • 14–15px readable body text, 1.65 line-height throughout
// • Mode tabs redesigned as pill group, not cramped tab bar
// • Section headers: uppercase label + icon, strong visual hierarchy
// • Insights: card-per-insight with number badge, generous gap
// • Takeaway: full-width amber quote block, prominent
// • Footer: Regenerate primary CTA + ghost PDF link, always visible

import { useState, useEffect, useCallback, useRef } from "react";

const MODE_CONFIG = {
  quick:    { icon: "⚡", label: "Quick",    desc: "1–2 insights, fast scan"       },
  detailed: { icon: "◈",  label: "Detailed", desc: "3–5 insights, deep analysis"   },
  simple:   { icon: "◎",  label: "Simple",   desc: "Plain English, no jargon"      },
};

async function fetchExplanation(figure, mode, signal) {
  const res = await fetch("/api/v1/figure/explain", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      figure_id:   figure.id,
      title:       figure.title         ?? "",
      description: figure.description  ?? "",
      caption:     figure.clean_caption || figure.caption || "",
      type:        figure.type          ?? "unknown",
      page:        figure.page          ?? null,
      mode,
    }),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const b = await res.json(); if (b?.detail) detail = b.detail; } catch (_) {}
    throw new Error(detail);
  }
  return res.json();
}

export default function FigureExplainPanel({ figure, onBack, onGoToPDF }) {
  const [mode,    setMode]    = useState("detailed");
  const [phase,   setPhase]   = useState("loading");
  const [data,    setData]    = useState(null);
  const [error,   setError]   = useState(null);
  const [fetchId, setFetchId] = useState(0);
  const abortRef              = useRef(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase("loading"); setData(null); setError(null);
    try {
      const result = await fetchExplanation(figure, mode, ctrl.signal);
      if (!ctrl.signal.aborted) { setData(result); setPhase("success"); }
    } catch (e) {
      if (!ctrl.signal.aborted) { setError(e.message || "Explanation failed"); setPhase("error"); }
    }
  }, [figure, mode, fetchId]); // eslint-disable-line

  useEffect(() => { load(); return () => abortRef.current?.abort(); }, [load]);

  return (
    <div className="fep-root">

      {/* ═══ HEADER ════════════════════════════════════════════════ */}
      <div className="fep-header">
        <div className="fep-header-top">
          <button className="fep-back-btn" onClick={onBack} aria-label="Back to details">
            <span className="fep-back-arrow">←</span>
            Back
          </button>

          <div className="fep-header-badges">
            <span className="fep-ai-badge">✦ AI Explanation</span>
            {phase === "success" && data?.cached && (
              <span className="fep-cached-chip" title="Served from in-memory cache">
                ⚡ cached
              </span>
            )}
          </div>
        </div>

        {figure?.title && (
          <p className="fep-figure-title" title={figure.title}>
            {figure.title}
          </p>
        )}

        {/* ── Mode pill group ── */}
        <div className="fep-mode-group" role="tablist" aria-label="Explanation depth">
          {Object.entries(MODE_CONFIG).map(([key, cfg]) => (
            <button
              key={key}
              role="tab"
              aria-selected={mode === key}
              className={`fep-mode-pill${mode === key ? " fep-mode-pill--active" : ""}`}
              onClick={() => { if (key !== mode) setMode(key); }}
              title={cfg.desc}
              disabled={phase === "loading"}
            >
              <span className="fep-mode-icon">{cfg.icon}</span>
              {cfg.label}
            </button>
          ))}
        </div>
      </div>

      {/* ═══ SCROLLABLE BODY ═══════════════════════════════════════ */}
      <div className="fep-body">
        {phase === "loading" && <PanelSkeleton mode={mode} />}
        {phase === "error"   && <PanelError error={error} onRetry={() => setFetchId(n => n + 1)} />}
        {phase === "success" && data && <PanelResult data={data} />}
      </div>

      {/* ═══ STICKY FOOTER ═════════════════════════════════════════ */}
      <div className="fep-footer">
        {phase === "success" && (
          <button
            className="fep-footer-btn fep-footer-btn--regen"
            onClick={() => setFetchId(n => n + 1)}
          >
            <span>↺</span> Regenerate
          </button>
        )}
        <button
          className="fep-footer-btn fep-footer-btn--pdf"
          onClick={() => onGoToPDF?.(figure?.page)}
          disabled={!figure?.page}
        >
          ↗ Go to PDF{figure?.page ? ` · p.${figure.page}` : ""}
        </button>
      </div>

    </div>
  );
}

// ─── Result ──────────────────────────────────────────────────────────────────

function PanelResult({ data }) {
  const { summary, insights = [], simple_explanation, key_takeaway } = data;
  return (
    <div className="fep-result">

      {/* Summary */}
      {summary && (
        <div className="fep-section fep-section--summary">
          <div className="fep-section-label">
            <span className="fep-section-dot fep-section-dot--amber" />
            Summary
          </div>
          <p className="fep-summary-text">{summary}</p>
        </div>
      )}

      {/* Key Insights */}
      {insights.length > 0 && (
        <div className="fep-section fep-section--insights">
          <div className="fep-section-label">
            <span className="fep-section-dot fep-section-dot--amber" />
            Key Insights
            <span className="fep-insight-badge">{insights.length}</span>
          </div>
          <ol className="fep-insights-list">
            {insights.map((text, i) => (
              <li
                key={i}
                className="fep-insight-item"
                style={{ "--fep-i": i }}
              >
                <span className="fep-insight-num">{i + 1}</span>
                <p className="fep-insight-text">{text}</p>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Plain English */}
      {simple_explanation && (
        <div className="fep-section fep-section--simple">
          <div className="fep-section-label">
            <span className="fep-section-dot fep-section-dot--blue" />
            Plain English
          </div>
          <p className="fep-simple-text">{simple_explanation}</p>
        </div>
      )}

      {/* Key Takeaway */}
      {key_takeaway && (
        <div className="fep-section fep-section--takeaway">
          <div className="fep-section-label">
            <span className="fep-section-dot fep-section-dot--amber" />
            Key Takeaway
          </div>
          <div className="fep-takeaway-block">
            <span className="fep-takeaway-quotemark" aria-hidden="true">"</span>
            <p className="fep-takeaway-text">{key_takeaway}</p>
          </div>
        </div>
      )}

    </div>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function PanelSkeleton({ mode }) {
  const n = mode === "quick" ? 2 : mode === "simple" ? 2 : 4;
  return (
    <div className="fep-skeleton">

      {/* Summary block */}
      <div className="fep-sk-section">
        <div className="fep-sk-label" />
        <div className="fep-sk-line fep-sk-line--full" />
        <div className="fep-sk-line fep-sk-line--wide" />
        <div className="fep-sk-line fep-sk-line--med"  />
      </div>

      {/* Insights */}
      <div className="fep-sk-section">
        <div className="fep-sk-label" />
        {Array.from({ length: n }).map((_, i) => (
          <div key={i} className="fep-sk-insight-card" style={{ "--fep-sk-i": i }}>
            <div className="fep-sk-num" />
            <div className="fep-sk-lines">
              <div className="fep-sk-line fep-sk-line--wide"  />
              <div className="fep-sk-line fep-sk-line--short" />
            </div>
          </div>
        ))}
      </div>

      {/* Takeaway */}
      <div className="fep-sk-section">
        <div className="fep-sk-label" />
        <div className="fep-sk-takeaway-block" />
      </div>

      {/* Thinking dots */}
      <div className="fep-sk-thinking">
        {[0, 1, 2].map(d => (
          <span key={d} className="fep-sk-dot" style={{ "--d": d }} />
        ))}
        <span className="fep-sk-thinking-text">
          Generating {MODE_CONFIG[mode]?.label.toLowerCase()} explanation…
        </span>
      </div>
    </div>
  );
}

// ─── Error ────────────────────────────────────────────────────────────────────

function PanelError({ error, onRetry }) {
  return (
    <div className="fep-error">
      <div className="fep-error-icon">⚠</div>
      <p className="fep-error-title">Explanation failed</p>
      <p className="fep-error-detail">{error}</p>
      <button className="fep-error-retry" onClick={onRetry}>↺ Try again</button>
    </div>
  );
}