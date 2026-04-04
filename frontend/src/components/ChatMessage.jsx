// src/components/ChatMessage.jsx
// Phase 4+: highlightId + onHighlightClick enable chat → PDF navigation.

export default function ChatMessage({ role, content, source, highlightId, onHighlightClick }) {
  const isUser      = role === "user";
  const isAssistant = role === "assistant";
  const isExplain   = source === "explain";

  // A message is "linked" when it carries a highlightId and a handler exists
  const isLinked = isAssistant && highlightId != null && typeof onHighlightClick === "function";

  function handleLinkClick(e) {
    e.stopPropagation();
    onHighlightClick(highlightId);
  }

  return (
    <div className={`chat-message chat-message--${role}`}>
      <div className={`msg-avatar ${isUser ? "msg-avatar--user" : "msg-avatar--ai"}`}>
        {isUser ? "U" : "◈"}
      </div>

      <div className={`msg-bubble ${isUser ? "msg-bubble--user" : "msg-bubble--ai"} ${isLinked ? "msg-bubble--linked" : ""}`}>

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

        <FormattedContent content={content} />
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
    <div className="msg-content">
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
    </div>
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