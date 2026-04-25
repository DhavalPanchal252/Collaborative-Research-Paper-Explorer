// src/components/EmptyState.jsx
// ─── UPGRADED HOMEPAGE ────────────────────────────────────────────────────────
// Sections: HERO · DEMO VIDEO · FEATURES · QUICK ACTIONS

import { useState, useEffect, useRef } from "react";

// ── Data ──────────────────────────────────────────────────────────────────────

const FEATURE_CARDS = [
  {
    icon: "✦",
    accent: "#e8a04a",
    title: "AI Figure Explanation",
    desc: "Understand any figure instantly with context-aware AI grounded in the paper's own text.",
    tag: "Instant",
  },
  {
    icon: "◎",
    accent: "#7b8ef7",
    title: "Smart Figure Search",
    desc: "Filter by type, importance, or keyword. Surface the figures that matter in seconds.",
    tag: "Efficient",
  },
  {
    icon: "⤴",
    accent: "#4caf7d",
    title: "Jump to PDF",
    desc: "Navigate from any figure directly to the exact page in the original paper — one click.",
    tag: "Seamless",
  },
  {
    icon: "⬡",
    accent: "#b87af5",
    title: "Context-Aware Insights",
    desc: "Every explanation is grounded in the paper's own methodology, never generic knowledge.",
    tag: "Precise",
  },
];

const QUICK_PROMPTS = [
  "→ Summarise the methodology",
  "→ Explain key findings in plain English",
  "→ Compare figures across sections",
  "→ Extract all tables and charts",
  "→ Highlight any passage for instant explanation",
];

// ── Typing cursor component ────────────────────────────────────────────────────

function BlinkCursor() {
  return <span className="hs-cursor" aria-hidden="true" />;
}

// ── Stat counter with animated entrance ───────────────────────────────────────

function StatItem({ num, label, delay = 0 }) {
  return (
    <div className="hs-stat" style={{ "--stat-delay": `${delay}ms` }}>
      <span className="hs-stat-num">{num}</span>
      <span className="hs-stat-label">{label}</span>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function EmptyState() {
  const videoRef = useRef(null);
  const [videoReady, setVideoReady] = useState(false);
  const [videoHovered, setVideoHovered] = useState(false);
  const [playedOnce, setPlayedOnce] = useState(false);

  // Attempt autoplay; mark ready on metadata load
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onMeta = () => setVideoReady(true);
    const onPlay = () => setPlayedOnce(true);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("play", onPlay);
    return () => {
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("play", onPlay);
    };
  }, []);

  return (
    <div className="hs-root">

      {/* ── Ambient glow blobs ───────────────────────────────────────────────── */}
      <div className="hs-blob hs-blob--1" aria-hidden="true" />
      <div className="hs-blob hs-blob--2" aria-hidden="true" />
      <div className="hs-blob hs-blob--3" aria-hidden="true" />

      {/* ══════════════════════════════════════════════════════════════════════
          HERO
         ══════════════════════════════════════════════════════════════════════ */}
      <header className="hs-hero">

        <div className="hs-hero-eyebrow">
          <span className="hs-eyebrow-dot" />
          AI-Powered Research Assistant
        </div>

        <h1 className="hs-hero-headline">
          Understand Research Papers<br />
          <em>in Seconds</em>
        </h1>

        <p className="hs-hero-sub">
          AI-powered figure understanding for modern research workflows.
          Upload any arxiv paper — ArxivMind extracts every figure, table, and diagram,
          then explains each one in plain English grounded in the paper's own context.
        </p>

      </header>

      {/* ══════════════════════════════════════════════════════════════════════
          DEMO VIDEO
         ══════════════════════════════════════════════════════════════════════ */}
      <section className="hs-video-section" aria-label="Product demo">

        <p className="hs-section-eyebrow">
          <span className="hs-section-line" />
          SEE IT IN ACTION
          <span className="hs-section-line" />
        </p>

        <div
          className={`hs-video-wrap${videoHovered ? " hs-video-wrap--hovered" : ""}`}
          onMouseEnter={() => setVideoHovered(true)}
          onMouseLeave={() => setVideoHovered(false)}
        >
          {/* Top badge overlay */}
          <div className="hs-video-top-bar">
            <span className="hs-video-badge">
              <span className="hs-video-badge-dot" />
              Live Demo
            </span>
            <span className="hs-video-duration">30 seconds</span>
          </div>

          <video
            ref={videoRef}
            className="hs-video"
            src="/Video Project 3.mp4"
            autoPlay
            muted
            loop
            controls
            playsInline
            preload="metadata"
          />

          {/* Bottom gradient overlay for readability */}
          <div className="hs-video-gradient" aria-hidden="true" />

          {/* Hover glow ring */}
          <div className="hs-video-glow-ring" aria-hidden="true" />
        </div>

        <p className="hs-video-caption">
          <span className="hs-caption-icon">✦</span>
          See how ArxivMind extracts and explains figures from any research paper in seconds
        </p>

      </section>

      {/* ══════════════════════════════════════════════════════════════════════
          FEATURES
         ══════════════════════════════════════════════════════════════════════ */}
      <section className="hs-features-wrap" aria-label="Features">

        <p className="hs-section-eyebrow">
          <span className="hs-section-line" />
          WHAT YOU CAN DO
          <span className="hs-section-line" />
        </p>

        <div className="hs-features">
          {FEATURE_CARDS.map((f, i) => (
            <div
              key={i}
              className="hs-feat-card"
              style={{ "--feat-accent": f.accent, "--feat-i": i }}
            >
              {/* Animated top-border accent */}
              <div className="hs-feat-accent-bar" aria-hidden="true" />

              <div className="hs-feat-card-top">
                <span className="hs-feat-icon" style={{ color: f.accent }}>{f.icon}</span>
                <span
                  className="hs-feat-tag"
                  style={{ "--tag-color": f.accent }}
                >
                  {f.tag}
                </span>
              </div>

              <h3 className="hs-feat-title">{f.title}</h3>
              <p className="hs-feat-desc">{f.desc}</p>

              {/* Glow on hover */}
              <div className="hs-feat-glow" aria-hidden="true" />
            </div>
          ))}
        </div>

      </section>

      {/* ══════════════════════════════════════════════════════════════════════
          QUICK ACTIONS
         ══════════════════════════════════════════════════════════════════════ */}
      <section className="hs-actions" aria-label="Quick actions">
        <p className="hs-actions-label">ONCE YOU UPLOAD A PAPER, TRY</p>
        <div className="hs-action-chips">
          {QUICK_PROMPTS.map((a, i) => (
            <span key={i} className="hs-action-chip" style={{ "--chip-i": i }}>
              {a}
            </span>
          ))}
        </div>
      </section>

    </div>
  );
}