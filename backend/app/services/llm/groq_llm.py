"""
groq_llm.py
===========
Groq cloud LLM provider for the RAG pipeline.

Change from previous version
-----------------------------
generate_answer(question, context) → __call__(prompt)

The prompt is now built by chat_routes.py via llm_utils.build_prompt()
so that conversation history can be injected centrally.  This module
stays thin: it only handles the Groq API call.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from groq import Groq

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------

_env_path = Path(__file__).resolve().parents[3] / ".env"
load_dotenv(dotenv_path=str(_env_path) if _env_path.exists() else None)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_MODEL       = "llama-3.1-8b-instant"
_TEMPERATURE = 0.4
_MAX_TOKENS  = 1024

# ---------------------------------------------------------------------------
# Client factory
# ---------------------------------------------------------------------------

def _get_client() -> Groq:
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        raise RuntimeError(
            "GROQ_API_KEY is missing. "
            "Add it to backend/.env or set it as an environment variable."
        )
    return Groq(api_key=api_key)


# ---------------------------------------------------------------------------
# Provider class
# ---------------------------------------------------------------------------

class GroqLLM:
    """
    Callable wrapper around the Groq API.

    Usage (via factory)
    -------------------
        llm = get_llm("groq")
        answer = llm(prompt=build_prompt(...))
    """

    def __call__(self, prompt: str) -> str:
        """
        Send *prompt* to Groq and return the model's reply as a string.

        Parameters
        ----------
        prompt:
            Fully formed prompt produced by llm_utils.build_prompt().
        """
        logger.debug("Groq prompt length: %d chars", len(prompt))

        try:
            client   = _get_client()
            response = client.chat.completions.create(
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
                temperature=_TEMPERATURE,
                max_tokens=_MAX_TOKENS,
            )

            answer = response.choices[0].message.content
            logger.info("Groq response: %d chars | model=%s", len(answer or ""), _MODEL)
            return answer or "The model returned an empty response."

        except RuntimeError as exc:
            logger.error("Groq config error: %s", exc)
            return f"Configuration error: {exc}"

        except Exception as exc:
            logger.error("Groq API error: %s", exc, exc_info=True)
            return f"Error generating response: {exc}"