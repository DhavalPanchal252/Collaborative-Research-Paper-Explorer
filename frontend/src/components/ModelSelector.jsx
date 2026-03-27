const MODELS = [
  { id: "groq",   label: "Groq",   badge: "Cloud",  desc: "Fast cloud inference" },
  { id: "ollama", label: "Ollama", badge: "Local",  desc: "Private, on-device" },
];

export default function ModelSelector({ model, onChange }) {
  return (
    <div className="model-selector">
      {MODELS.map((m) => (
        <button
          key={m.id}
          className={`model-option ${model === m.id ? "model-option--active" : ""}`}
          onClick={() => onChange(m.id)}
        >
          <div className="model-option-top">
            <span className="model-name">{m.label}</span>
            <span className={`model-badge model-badge--${m.id}`}>{m.badge}</span>
          </div>
          <span className="model-desc">{m.desc}</span>
        </button>
      ))}
    </div>
  );
}
