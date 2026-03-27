"""
ollama_llm.py
=============
Ollama local LLM provider for the RAG pipeline.

Change from previous version
-----------------------------
generate_answer(question, context) → __call__(prompt)

The prompt is now built by chat_routes.py via llm_utils.build_prompt()
so that conversation history can be injected centrally.  This module
stays thin: it only handles the Ollama API call.
"""

from __future__ import annotations

import logging

import ollama

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_MODEL   = "phi3"
_OPTIONS = {
    "temperature": 0.4,
    "num_predict": 1024,
}

# ---------------------------------------------------------------------------
# Provider class
# ---------------------------------------------------------------------------

class OllamaLLM:
    """
    Callable wrapper around the local Ollama runtime.

    Usage (via factory)
    -------------------
        llm = get_llm("ollama")
        answer = llm(prompt=build_prompt(...))
    """

    def __call__(self, prompt: str) -> str:
        """
        Send *prompt* to the local Ollama model and return its reply.

        Parameters
        ----------
        prompt:
            Fully formed prompt produced by llm_utils.build_prompt().
        """
        logger.debug("Ollama prompt length: %d chars", len(prompt))

        try:
            response = ollama.chat(
                model=_MODEL,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You are a helpful, precise AI assistant. "
                            "Follow the instructions in the user message exactly."
                        ),
                    },
                    {"role": "user", "content": prompt},
                ],
                options=_OPTIONS,
            )

            answer = response["message"]["content"]
            logger.info("Ollama response: %d chars | model=%s", len(answer or ""), _MODEL)
            return answer or "The model returned an empty response."

        except Exception as exc:
            logger.error("Ollama error: %s", exc, exc_info=True)
            return f"Error generating response: {exc}"