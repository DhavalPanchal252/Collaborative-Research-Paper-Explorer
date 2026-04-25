// src/components/ChatPanel.jsx
// Phase 4+: messages now carry highlightId for bidirectional PDF linking.
// onHighlightClick prop is threaded through to ChatMessage.

import { useState, useRef, useEffect } from "react";
import { sendQuestion } from "../api/chat";
import ChatMessage from "./ChatMessage";

const SUGGESTIONS = [
  "Summarise this paper in 3 bullet points",
  "What is the main contribution?",
  "Explain the methodology",
  "What are the limitations?",
];

export default function ChatPanel({
  model,
  paperName,
  injectMessage,       // { question, answer, highlightId? } | null
  onInjectConsumed,    // () => void
  onHighlightClick,    // (highlightId: number) => void  ← Phase 4+ bidirectional link
}) {
  const [messages, setMessages] = useState([]);
  const [input, setInput]       = useState("");
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const bottomRef               = useRef(null);
  const inputRef                = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // Consume injected explain messages (from PDF selection)
  // highlightId is stored on the assistant message for chat → PDF linking
  useEffect(() => {
    if (!injectMessage) return;
    setMessages((prev) => [
      ...prev,
      { role: "user",      content: injectMessage.question, source: "explain" },
      {
        role:        "assistant",
        content:     injectMessage.answer,
        source:      "explain",
        highlightId: injectMessage.highlightId ?? null, // Phase 4+
      },
    ]);
    onInjectConsumed?.();
  }, [injectMessage, onInjectConsumed]);

  async function handleSend(question) {
    const text = (question ?? input).trim();
    if (!text || loading) return;

    setInput("");
    setError(null);
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setLoading(true);

    try {
      const { answer } = await sendQuestion(text, model);
      setMessages((prev) => [...prev, { role: "assistant", content: answer }]);
    } catch (err) {
      setError(err.message || "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  // 🔥 FIX: prevent crash if messages is undefined
  const isEmpty = (messages || []).length === 0;

  return (
    <div className="chat-panel">
      {/* Header */}
      <div className="chat-header">
        <div className="chat-header-left">
          <span className="chat-paper-icon">📄</span>

          {/* 🔥 FIX: prevent crash if paperName undefined */}
          <span className="chat-paper-name" title={paperName || ""}>
            {(paperName || "").length > 40
              ? (paperName || "").slice(0, 37) + "..."
              : (paperName || "")}
          </span>
        </div>

        <span className={`chat-model-pill chat-model-pill--${model}`}>
          {model === "groq" ? "⚡ Groq" : "🖥 Ollama"}
        </span>
      </div>

      {/* Messages */}
      <div className="chat-messages">
        {isEmpty && (
          <div className="chat-suggestions">
            <p className="suggestions-label">Try asking…</p>
            <div className="suggestions-grid">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="suggestion-chip" onClick={() => handleSend(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 🔥 FIX: prevent crash if messages undefined */}
        {(messages || []).map((msg, i) => (
          <ChatMessage
            key={`${msg.role}-${i}-${msg.highlightId ?? "none"}`}
            role={msg.role}
            content={msg.content}
            source={msg.source}
            highlightId={msg.highlightId}       // Phase 4+
            onHighlightClick={onHighlightClick} // Phase 4+
          />
        ))}

        {loading && (
          <div className="chat-message chat-message--assistant">
            <div className="msg-avatar msg-avatar--ai">◈</div>
            <div className="msg-bubble msg-bubble--loading">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
            </div>
          </div>
        )}

        {error && <div className="chat-error"><span>⚠ {error}</span></div>}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="chat-input-bar">
        <textarea
          ref={inputRef}
          className="chat-input"
          placeholder="Ask a question about this paper…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          disabled={loading}
        />
        <button
          className="send-btn"
          onClick={() => handleSend()}
          disabled={!input.trim() || loading}
          aria-label="Send"
        >
          {loading ? <span className="spinner spinner--sm" /> : "↑"}
        </button>
      </div>
    </div>
  );
}