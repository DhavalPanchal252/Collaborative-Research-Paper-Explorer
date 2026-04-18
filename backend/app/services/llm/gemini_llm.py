"""
gemini_llm.py
=============
Gemini cloud LLM provider for the RAG pipeline.

Structure
---------
Mirrors groq_llm.py exactly — thin callable class that only handles the
Google Generative AI API call.  Prompt construction is the caller's
responsibility (figure_refiner._enrich_batch builds it via
_build_batch_prompt; chat_routes uses llm_utils.build_prompt).

Fallback role
-------------
In Phase 7.4.2 (LLM enrichment), GeminiLLM is the secondary provider.
It is invoked by FigureRefiner._enrich_batch only when the primary
GroqLLM call fails (timeout / exception) or produces a low-quality
batch (>= 50 % items with type='other' and empty description).
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from google import genai
from dotenv import load_dotenv

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------

_env_path = Path(__file__).resolve().parents[3] / ".env"
load_dotenv(dotenv_path=str(_env_path) if _env_path.exists() else None)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_MODEL = "gemini-2.5-flash"
_TEMPERATURE = 0.4
_MAX_TOKENS  = 1024

# ---------------------------------------------------------------------------
# Client factory
# ---------------------------------------------------------------------------

def _get_client() -> genai.GenerativeModel:
    """Configure the SDK and return a ready GenerativeModel instance.

    Raises:
        RuntimeError: When GEMINI_API_KEY is absent from the environment.
    """
    api_key = os.getenv("GEMINI_API_KEY")
    
    if not api_key:
        raise RuntimeError(
            "GEMINI_API_KEY is missing. "
            "Add it to backend/.env or set it as an environment variable."
        )
    
    return genai.Client(api_key=api_key)

# ---------------------------------------------------------------------------
# Provider class
# ---------------------------------------------------------------------------

class GeminiLLM:
    """
    Callable wrapper around the Google Generative AI (Gemini) API.

    Usage (via factory or direct fallback)
    ---------------------------------------
        llm = get_llm("gemini")
        answer = llm(prompt=build_prompt(...))

    Or used directly as a fallback inside FigureRefiner._enrich_batch:
        fallback_llm = GeminiLLM()
        answer = fallback_llm(prompt=prompt)

    Raises:
        RuntimeError: Configuration error (missing API key) — caller must
                      catch and handle gracefully.
        Exception:    Any Gemini API-level error — logged and re-raised so
                      the caller (_enrich_batch) can decide whether to use
                      safe fallbacks.
    """

    def __call__(self, prompt: str) -> str:
        """
        Send *prompt* to Gemini and return the model's reply as a string.

        Parameters
        ----------
        prompt:
            Fully formed prompt produced by _build_batch_prompt() or
            llm_utils.build_prompt().

        Returns
        -------
        str
            The model's text response.

        Raises
        ------
        RuntimeError
            When GEMINI_API_KEY is not configured.
        Exception
            Any network or API-level error from the Gemini SDK.
        """
        logger.debug("Gemini prompt length: %d chars", len(prompt))

        try:
            client = _get_client()

            response = client.models.generate_content(
                model=_MODEL,
                contents=prompt,
                config={
                    "temperature": _TEMPERATURE,
                    "max_output_tokens": _MAX_TOKENS,
                },
            )

            # Safe extraction
            text = getattr(response, "text", None)

            if not text:
                logger.warning("Gemini returned empty response")
                return "The model returned an empty response."

            logger.info(
                "Gemini response: %d chars | model=%s",
                len(text), _MODEL
            )

            return text

        except RuntimeError as exc:
            logger.error("Gemini config error: %s", exc)
            raise

        except Exception as exc:
            logger.error("Gemini API error: %s", exc, exc_info=True)
            raise