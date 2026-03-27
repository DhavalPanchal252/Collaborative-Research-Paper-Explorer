export default function ChatMessage({ role, content }) {
  const isUser = role === "user";

  return (
    <div className={`chat-message chat-message--${role}`}>
      <div className={`msg-avatar ${isUser ? "msg-avatar--user" : "msg-avatar--ai"}`}>
        {isUser ? "U" : "◈"}
      </div>
      <div className={`msg-bubble ${isUser ? "msg-bubble--user" : "msg-bubble--ai"}`}>
        <FormattedContent content={content} />
      </div>
    </div>
  );
}

// Lightweight formatter: bold, inline code, code blocks, line breaks
function FormattedContent({ content }) {
  // Split into code-block segments vs normal text
  const parts = content.split(/(```[\s\S]*?```)/g);

  return (
    <div className="msg-content">
      {parts.map((part, i) => {
        if (part.startsWith("```")) {
          const code = part.replace(/^```[^\n]*\n?/, "").replace(/```$/, "");
          return <pre key={i} className="msg-code-block"><code>{code}</code></pre>;
        }

        // Process inline: **bold**, `code`, newlines
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
  const segments = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return segments.map((seg, i) => {
    if (seg.startsWith("**") && seg.endsWith("**")) {
      return <strong key={i}>{seg.slice(2, -2)}</strong>;
    }
    if (seg.startsWith("`") && seg.endsWith("`")) {
      return <code key={i} className="msg-inline-code">{seg.slice(1, -1)}</code>;
    }
    return seg;
  });
}
