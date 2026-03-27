import { useState, useRef, useEffect } from "react";
import { sendQuestion } from "../api/chat";
import ChatMessage from "./ChatMessage";

const SUGGESTIONS = [
  "Summarise this paper in 3 bullet points",
  "What is the main contribution?",
  "Explain the methodology",
  "What are the limitations?",
];

export default function ChatPanel({ model, paperName }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

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
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const isEmpty = messages.length === 0;

  return (
    <div className="chat-panel">
      {/* Header */}
      <div className="chat-header">
        <div className="chat-header-left">
          <span className="chat-paper-icon">📄</span>
          <span className="chat-paper-name" title={paperName}>
            {paperName.length > 50 ? paperName.slice(0, 47) + "..." : paperName}
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

        {messages.map((msg, i) => (
          <ChatMessage key={i} role={msg.role} content={msg.content} />
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

        {error && (
          <div className="chat-error">
            <span>⚠ {error}</span>
          </div>
        )}

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
