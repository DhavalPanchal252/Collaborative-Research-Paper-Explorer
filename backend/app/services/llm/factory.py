# app/services/llm/factory.py

from app.services.llm.groq_llm   import GroqLLM
from app.services.llm.ollama_llm import OllamaLLM

_REGISTRY = {
    "groq":   GroqLLM,
    "ollama": OllamaLLM,
}


def get_llm(model_name: str):
    cls = _REGISTRY.get(model_name)
    if cls is None:
        raise ValueError(
            f"Invalid model '{model_name}'. "
            f"Available: {list(_REGISTRY.keys())}"
        )
    return cls()