// src/components/ChatMessage.jsx
// Phase 4+: highlightId + onHighlightClick enable chat → PDF navigation.
// UX Upgrade: typing reveal animation for explain responses, accent styling.

import { useState, useEffect, useRef } from "react";

export default function ChatMessage({ role, content, source, highlightId, onHighlightClick }) {
  const isUser      = role === "user";
  const isAssistant = role === "assistant";
  const isExplain   = source === "explain";

  // A message is "linked" when it carries a highlightId and a handler exists
  const isLinked = isAssistant && highlightId != null && typeof onHighlightClick === "function";

  // ── Typing reveal effect for explain AI responses ──────────────────────────
  const [revealed, setRevealed] = useState(!isExplain || isUser ? content : "");
  const [isTyping, setIsTyping] = useState(isExplain && isAssistant);
  const indexRef = useRef(0);

  useEffect(() => {
    if (!isExplain || !isAssistant || !content) return;
    if (typeof content !== "string") { setRevealed(content); setIsTyping(false); return; }

    indexRef.current = 0;
    setRevealed("");
    setIsTyping(true);

    const len = content.length;
    // Reveal speed: fast for long text, slower for short
    const charsPerTick = Math.max(2, Math.ceil(len / 60));
    const interval = setInterval(() => {
      indexRef.current += charsPerTick;
      if (indexRef.current >= len) {
        setRevealed(content);
        setIsTyping(false);
        clearInterval(interval);
      } else {
        setRevealed(content.slice(0, indexRef.current));
      }
    }, 16);

    return () => clearInterval(interval);
  }, [content, isExplain, isAssistant]);

  function handleLinkClick(e) {
    e.stopPropagation();
    onHighlightClick(highlightId);
  }

  const displayContent = (isExplain && isAssistant) ? revealed : content;

  return (
    <div className={`chat-message chat-message--${role}${isExplain && isAssistant ? " chat-message--explain-entry" : ""}`}>
      <div className={`msg-avatar ${isUser ? "msg-avatar--user" : "msg-avatar--ai"}`}>
        {isUser ? "U" : "◈"}
      </div>

      <div className={[
        "msg-bubble",
        isUser ? "msg-bubble--user" : "msg-bubble--ai",
        isLinked ? "msg-bubble--linked" : "",
        isExplain && isAssistant ? "msg-bubble--explain" : "",
      ].filter(Boolean).join(" ")}>

        {/* Explain badge — shown on AI explain messages */}
        {isExplain && isAssistant && (
          <div className="msg-explain-badge">
            <span>✦ Selection Explanation</span>
            {isLinked && (
              <button
                className="msg-pdf-link"
                onClick={handleLinkClick}
                title="Jump to highlight in PDF"
              >
                ↗ View in PDF
              </button>
            )}
          </div>
        )}

        <div className={`msg-content${isTyping ? " msg-content--typing" : ""}`}>
          <FormattedContent content={displayContent} />
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FormattedContent — unchanged from previous phase, safety guards kept
// ─────────────────────────────────────────────────────────────────────────────
function FormattedContent({ content }) {
  if (!content || typeof content !== "string") {
    return <div className="msg-content msg-content--empty">⚠ No response available</div>;
  }

  const parts = content.split(/(```[\s\S]*?```)/g);

  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("```")) {
          const code = part.replace(/^```[^\n]*\n?/, "").replace(/```$/, "");
          return <pre key={i} className="msg-code-block"><code>{code}</code></pre>;
        }

        const lines = part.split("\n");
        return (
          <span key={i}>
            {lines.map((line, li) => (
              <span key={li}>
                {inlineFormat(line)}
                {li < lines.length - 1 && <br />}
              </span>
            ))}
          </span>
        );
      })}
    </>
  );
}

function inlineFormat(text) {
  if (!text || typeof text !== "string") {
    return <span className="msg-content--empty">⚠ Invalid text</span>;
  }
  const segments = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return segments.map((seg, i) => {
    if (seg.startsWith("**") && seg.endsWith("**"))
      return <strong key={i}>{seg.slice(2, -2)}</strong>;
    if (seg.startsWith("`") && seg.endsWith("`"))
      return <code key={i} className="msg-inline-code">{seg.slice(1, -1)}</code>;
    return seg;
  });
}