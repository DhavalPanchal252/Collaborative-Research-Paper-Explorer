// src/components/EmptyState.jsx
// Production homepage — drop-in replacement for the inline EmptyState in App.jsx.
// Does NOT touch any existing upload / paper logic.

import { useState, useEffect } from "react";

// ── Static mock data for the demo preview ────────────────────────────────────

const MOCK_FIGURES = [
  {
    id: "fig-1",
    label: "◈ Graph",
    title: "Model Accuracy vs. Epochs",
    page: 4,
    type: "graph",
    color: "#e8a04a",
    pattern: "graph",
  },
  {
    id: "fig-2",
    label: "⬡ Diagram",
    title: "Transformer Architecture Overview",
    page: 7,
    type: "diagram",
    color: "#7b8ef7",
    pattern: "diagram",
  },
  {
    id: "fig-3",
    label: "◉ Chart",
    title: "Benchmark Comparison (BLEU / F1)",
    page: 11,
    type: "chart",
    color: "#4caf7d",
    pattern: "chart",
  },
  {
    id: "fig-4",
    label: "⇄ Compare",
    title: "Ablation Study Results",
    page: 14,
    type: "compare",
    color: "#b87af5",
    pattern: "compare",
  },
];

const MOCK_EXPLANATION = [
  "This figure demonstrates the model's convergence behaviour across 100 training epochs.",
  "Notice the sharp accuracy gain between epochs 10–30, which correlates with the warmup scheduler activating adaptive learning rates.",
  "The plateau after epoch 60 suggests diminishing returns — a common sign of near-optimal convergence on this dataset.",
];

const FEATURE_CARDS = [
  {
    icon: "✦",
    accent: "#e8a04a",
    title: "AI Figure Explanation",
    desc: "Click any figure and get an instant, context-aware explanation grounded in the paper's own text.",
  },
  {
    icon: "◎",
    accent: "#7b8ef7",
    title: "Smart Figure Search",
    desc: "Filter by type, importance, or keyword. Surface the figures that matter in seconds.",
  },
  {
    icon: "⤴",
    accent: "#4caf7d",
    title: "Jump to PDF",
    desc: "One click to jump from any figure directly to the exact page in the original paper.",
  },
];

// ── Mini SVG patterns for mock figure cards ───────────────────────────────────

function MockFigureGraphic({ type, color }) {
  if (type === "graph") {
    return (
      <svg viewBox="0 0 120 64" width="120" height="64" aria-hidden="true">
        <polyline
          points="4,56 18,44 32,38 46,30 60,20 74,16 88,10 102,7 116,4"
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.9"
        />
        <polyline
          points="4,56 18,44 32,38 46,30 60,20 74,16 88,10 102,7 116,4"
          fill={`${color}22`}
          stroke="none"
        />
        {[0, 14, 28, 42, 56, 70, 84, 98, 112].map((x, i) => {
          const ys = [56, 44, 38, 30, 20, 16, 10, 7, 4];
          return <circle key={i} cx={x + 4} cy={ys[i]} r="2.2" fill={color} opacity="0.8" />;
        })}
        <line x1="4" y1="60" x2="116" y2="60" stroke="#ffffff18" strokeWidth="0.8" />
        <line x1="4" y1="4" x2="4" y2="60" stroke="#ffffff18" strokeWidth="0.8" />
      </svg>
    );
  }
  if (type === "diagram") {
    return (
      <svg viewBox="0 0 120 64" width="120" height="64" aria-hidden="true">
        <rect x="44" y="4" width="32" height="14" rx="3" fill={`${color}30`} stroke={color} strokeWidth="1" />
        <text x="60" y="14" textAnchor="middle" fill={color} fontSize="7" fontFamily="monospace">Input</text>
        <line x1="60" y1="18" x2="60" y2="26" stroke={color} strokeWidth="1" opacity="0.5" />
        <rect x="20" y="26" width="32" height="14" rx="3" fill={`${color}30`} stroke={color} strokeWidth="1" />
        <text x="36" y="36" textAnchor="middle" fill={color} fontSize="7" fontFamily="monospace">Attn</text>
        <rect x="68" y="26" width="32" height="14" rx="3" fill={`${color}30`} stroke={color} strokeWidth="1" />
        <text x="84" y="36" textAnchor="middle" fill={color} fontSize="7" fontFamily="monospace">FFN</text>
        <line x1="36" y1="40" x2="60" y2="48" stroke={color} strokeWidth="1" opacity="0.5" />
        <line x1="84" y1="40" x2="60" y2="48" stroke={color} strokeWidth="1" opacity="0.5" />
        <rect x="44" y="48" width="32" height="14" rx="3" fill={`${color}30`} stroke={color} strokeWidth="1" />
        <text x="60" y="58" textAnchor="middle" fill={color} fontSize="7" fontFamily="monospace">Output</text>
      </svg>
    );
  }
  if (type === "chart") {
    const vals = [38, 52, 44, 60, 48, 70, 56];
    return (
      <svg viewBox="0 0 120 64" width="120" height="64" aria-hidden="true">
        {vals.map((v, i) => (
          <rect
            key={i}
            x={8 + i * 16}
            y={64 - v * 0.85}
            width="11"
            height={v * 0.85}
            rx="2"
            fill={color}
            opacity={0.4 + i * 0.08}
          />
        ))}
        <line x1="4" y1="60" x2="116" y2="60" stroke="#ffffff18" strokeWidth="0.8" />
      </svg>
    );
  }
  // compare
  return (
    <svg viewBox="0 0 120 64" width="120" height="64" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => {
        const aW = 20 + i * 8;
        const bW = 44 - i * 6;
        return (
          <g key={i}>
            <rect x="4" y={6 + i * 14} width={aW} height="9" rx="2" fill={color} opacity="0.7" />
            <rect x="4" y={6 + i * 14} width={bW} height="9" rx="2" fill={`${color}40`} stroke={color} strokeWidth="0.5" />
          </g>
        );
      })}
      <line x1="60" y1="4" x2="60" y2="62" stroke={color} strokeWidth="0.8" strokeDasharray="3 2" opacity="0.3" />
    </svg>
  );
}

// ── Typing animation for mock explanation ─────────────────────────────────────

function MockExplanation() {
  const [visibleLines, setVisibleLines] = useState(0);
  const [charCount, setCharCount] = useState(0);
  const [active, setActive] = useState(true);

  useEffect(() => {
    if (!active) return;
    if (visibleLines >= MOCK_EXPLANATION.length) {
      // Pause then restart
      const t = setTimeout(() => {
        setVisibleLines(0);
        setCharCount(0);
      }, 3200);
      return () => clearTimeout(t);
    }
    const target = MOCK_EXPLANATION[visibleLines];
    if (charCount < target.length) {
      const t = setTimeout(() => setCharCount((c) => c + 1), 18);
      return () => clearTimeout(t);
    } else {
      const t = setTimeout(() => {
        setVisibleLines((l) => l + 1);
        setCharCount(0);
      }, 400);
      return () => clearTimeout(t);
    }
  }, [visibleLines, charCount, active]);

  return (
    <div className="hs-explain-body">
      <div className="hs-explain-ai-badge">
        <span className="hs-explain-ai-dot" />
        AI Explanation
      </div>
      <div className="hs-explain-lines">
        {MOCK_EXPLANATION.map((line, i) => {
          if (i < visibleLines) {
            return (
              <p key={i} className="hs-explain-line hs-explain-line--done">
                {line}
              </p>
            );
          }
          if (i === visibleLines) {
            return (
              <p key={i} className="hs-explain-line hs-explain-line--typing">
                {line.slice(0, charCount)}
                <span className="hs-explain-cursor" />
              </p>
            );
          }
          return null;
        })}
      </div>
      <div className="hs-explain-footer">
        <span className="hs-explain-src">Source: Section 4.2 · p.11</span>
        <span className="hs-explain-conf">94% confidence</span>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function EmptyState() {
  const [activeFig, setActiveFig] = useState(MOCK_FIGURES[0]);

  return (
    <div className="hs-root">
      {/* Ambient glow blobs */}
      <div className="hs-blob hs-blob--1" aria-hidden="true" />
      <div className="hs-blob hs-blob--2" aria-hidden="true" />

      {/* ── Hero ── */}
      <header className="hs-hero">
        <div className="hs-hero-eyebrow">
          <span className="hs-eyebrow-dot" />
          AI-Powered Research Tool
        </div>
        <h1 className="hs-hero-headline">
          Understand Research Papers<br />
          <em>in Seconds</em>
        </h1>
        <p className="hs-hero-sub">
          Upload any arxiv paper. ArxivMind extracts every figure, table, and diagram — then lets your AI model explain each one in plain English, grounded in the paper's own context.
        </p>
      </header>

      {/* ── Demo Preview ── */}
      <section className="hs-demo" aria-label="Demo preview">
        {/* Left: figure grid */}
        <div className="hs-demo-grid">
          <p className="hs-demo-grid-label">FIGURES · 14 extracted</p>
          <div className="hs-fig-grid">
            {MOCK_FIGURES.map((fig, i) => (
              <button
                key={fig.id}
                className={`hs-fig-card ${activeFig.id === fig.id ? "hs-fig-card--active" : ""}`}
                onClick={() => setActiveFig(fig)}
                style={{ "--card-accent": fig.color, "--card-i": i }}
              >
                <div className="hs-fig-card-img">
                  <MockFigureGraphic type={fig.type} color={fig.color} />
                  <span className="hs-fig-type-badge" style={{ "--badge-color": fig.color }}>
                    {fig.label}
                  </span>
                </div>
                <div className="hs-fig-card-body">
                  <p className="hs-fig-card-title">{fig.title}</p>
                  <span className="hs-fig-card-page">p.{fig.page}</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Right: explanation panel */}
        <div className="hs-demo-explain">
          <div className="hs-explain-header">
            <p className="hs-explain-fig-label">
              <span className="hs-explain-fig-icon" style={{ color: activeFig.color }}>◈</span>
              {activeFig.title}
            </p>
            <span className="hs-explain-page-badge">p.{activeFig.page}</span>
          </div>
          <MockExplanation key={activeFig.id} />
        </div>
      </section>

      {/* ── Feature Cards ── */}
      <section className="hs-features" aria-label="Features">
        {FEATURE_CARDS.map((f, i) => (
          <div
            key={i}
            className="hs-feat-card"
            style={{ "--feat-accent": f.accent, "--feat-i": i }}
          >
            <span className="hs-feat-icon" style={{ color: f.accent }}>{f.icon}</span>
            <h3 className="hs-feat-title">{f.title}</h3>
            <p className="hs-feat-desc">{f.desc}</p>
          </div>
        ))}
      </section>

      {/* ── Quick Actions ── */}
      <section className="hs-actions" aria-label="Quick actions">
        <p className="hs-actions-label">ONCE YOU UPLOAD A PAPER, TRY</p>
        <div className="hs-action-chips">
          {[
            "→ Summarise the methodology",
            "→ Explain key findings in plain English",
            "→ Compare figures across sections",
            "→ Extract all tables and charts",
            "→ Highlight any passage for instant explanation",
          ].map((a, i) => (
            <span key={i} className="hs-action-chip" style={{ "--chip-i": i }}>
              {a}
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}