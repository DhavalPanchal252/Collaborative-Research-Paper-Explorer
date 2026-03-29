"""
llm_utils.py
============
Intent detection + prompt construction for all LLM providers.

Design goals
------------
* detect_intent()  — fast keyword scan, priority-ordered, casual-first.
* is_casual()      — quick guard used by chat_routes to short-circuit the
                     full RAG pipeline for acknowledgement messages.
* build_prompt()   — assembles a clean, strict, tone-matched prompt that
                     injects RAG context + session history.

Prompt quality principles
-------------------------
1. Casual inputs never reach the RAG pipeline — handled upstream.
2. Every intent has a single, unambiguous output instruction.
3. History is capped so it never crowds out retrieved context.
4. Weak context → natural fallback, not a robotic error message.
5. Rules are minimal — only what's needed to prevent known failure modes.
"""

from __future__ import annotations

import re

# ============================================================================
# SECTION 1 — CASUAL DETECTION
# Short-circuit guard.  If is_casual() returns True, chat_routes must reply
# with a brief acknowledgement and skip retrieval + LLM entirely.
# ============================================================================

# Exact-match phrases (after stripping punctuation and lowercasing).
_CASUAL_EXACT: frozenset[str] = frozenset({
    "ok", "okay", "k", "kk",
    "great", "nice", "cool", "awesome", "perfect",
    "thanks", "thank you", "ty", "thx", "thank u",
    "got it", "understood", "noted", "alright", "sure",
    "good", "fine", "sounds good", "makes sense",
    "wow", "interesting", "i see", "oh i see",
    "no", "nope", "yes", "yep", "yeah", "yup",
    "lol", "haha", "hehe", "😊", "👍",
})

# Patterns that are casual even with extra words.
_CASUAL_PATTERNS: tuple[re.Pattern, ...] = (
    re.compile(r"^(ok|okay|alright)[,!.\s]*$", re.I),
    re.compile(r"^(thanks?|thank\s?you)[,!.\s]*$", re.I),
    re.compile(r"^(great|nice|cool|awesome|perfect)[,!.\s]*$", re.I),
    re.compile(r"^(got\s?it|makes?\s?sense|understood)[,!.\s]*$", re.I),
    re.compile(r"^(yes|no|yeah|nope|yep|yup)[,!.\s]*$", re.I),
)

# Replies that feel natural for casual inputs (cycled deterministically).
# Short, warm, varied — not the same corporate phrase every time.
_CASUAL_REPLIES: tuple[str, ...] = (
    "Got it 👍",
    "Nice! 😄",
    "Cool, what's next?",
    "Glad that helped!",
    "Alright — what else would you like to know?",
    "Sure thing!",
    "Noted 👍",
    "Happy to help — ask away!",
)


def is_casual(text: str) -> bool:
    text = text.strip().lower()

    # Step 1 — if it looks like a real question → NOT casual
    QUESTION_WORDS = ("what", "explain", "why", "how", "give", "describe")

    if any(q in text for q in QUESTION_WORDS):
        return False
    
    # Step 2 - exact casual matches
    CASUAL_SET = {
        "ok", "okay", "great", "nice", "thanks", "thank you",
        "cool", "alright", "fine", "got it"
    }

    if text in CASUAL_SET:
        return True

    # regex casual patterns
    import re
    if re.fullmatch(r"(ok|okay|thanks|thank you|nice|great)[.!]*", text):
        return True

    # ❌ REMOVE length-based heuristic completely
    return False

def get_casual_reply(turn_index: int = 0) -> str:
    """Return a casual reply string, cycling through the pool."""
    return _CASUAL_REPLIES[turn_index % len(_CASUAL_REPLIES)]


# ============================================================================
# SECTION 2 — INTENT DETECTION
# ============================================================================

# keyword → intent  (checked in _PRIORITY order — first match wins)
_INTENT_KEYWORDS: dict[str, tuple[str, ...]] = {

    # ── Format modifiers (override topical intents) ──────────────────────────
    "brief": (
        "brief", "briefly", "quick", "quickly", "in short",
        "one line", "one sentence", "tldr", "tl;dr", "in a nutshell",
        "short answer", "just tell me",
    ),

    "simple": (
        "simple", "simply", "simplify", "easy", "plain english",
        "for beginners", "beginner", "like i am 5", "eli5",
        "non-technical", "layman", "in simple terms",
    ),

    "detailed": (
        "in detail", "in-depth", "in depth", "elaborate",
        "explain fully", "comprehensive", "thorough", "deep dive",
        "walk me through", "break it down", "breakdown",
        "step by step", "fully explain", "deep explanation",
        "in very detailed", "very detailed", "very detail", "in greater detail",
        "detailed explanation", "more details", "further detail", "more detail",
        "clearly explain", "detail-oriented", "full analysis",
    ),

    # ── Topical intents ───────────────────────────────────────────────────────
    "method": (
        "method", "methods", "methodology", "approach", "approaches",
        "technique", "techniques", "algorithm", "algorithms",
        "architecture", "how does it work", "how it works",
        "pipeline", "framework", "implementation", "procedure",
        "how was it built", "how is it built", "model design",
    ),

    "results": (
        "result", "results", "finding", "findings", "performance",
        "accuracy", "benchmark", "benchmarks", "evaluation",
        "metric", "metrics", "score", "scores", "outcome",
        "outperform", "comparison", "state of the art", "sota",
        "how well", "how good", "what did it achieve",
    ),

    "concept": (
        "what is", "what are", "what does", "define", "definition",
        "meaning", "explain the term", "explain the concept",
        "terminology", "describe", "what do you mean by", "clarify",
    ),

    "summary": (
        "summary", "summarize", "summarise", "overview",
        "what is this paper about", "what's this paper about",
        "give me an overview", "high level", "high-level",
        "what is this about",
    ),
}

# Checked strictly in this order — format modifiers beat topical intents.
_PRIORITY: tuple[str, ...] = (
    "brief",    # "give me a brief summary" → brief, not summary
    "detailed", # "explain in detail" → detailed, not concept
    "simple",
    "method",
    "results",
    "concept",
    "summary",
    # fallthrough → "general"
)


def detect_intent(query: str) -> str:
    """
    Return the intent label that best matches *query*.

    Priority order: brief → detailed → simple → method → results →
                    concept → summary → general

    How it works:
    - Checks keywords using SUBSTRING MATCHING (partial words OK).
    - Example: "in very detailed" matches keyword "detail" via substring search.
    - First matching intent wins (priority order prevents ambiguity).

    Casual inputs must be filtered by is_casual() BEFORE calling this
    function — they will fall through to "general" otherwise.
    """
    lowered = query.lower()
    for intent in _PRIORITY:
        # SUBSTRING matching: if any keyword appears anywhere in the lowered query
        if any(kw in lowered for kw in _INTENT_KEYWORDS[intent]):
            return intent
    return "general"


# Words that signal the user is referring back to something said earlier.
# History is only injected into the prompt when one of these appears.
_FOLLOW_UP_WORDS: frozenset[str] = frozenset({
    "it", "its", "they", "their", "them",
    "this", "that", "those", "these",
    "he", "she", "the above", "previous", "before",
    "earlier", "mentioned", "said", "you said",
    "what about", "and also", "also", "more about",
    "expand", "elaborate", "continue", "go on",
})


def is_followup(query: str) -> bool:
    """
    Detect if query is a follow-up question.
    
    Strict logic: Only return True if query contains explicit follow-up words.
    Standalone questions like "what is this paper about?" return False.
    """
    query_lower = query.lower()
    
    # STRICT follow-up indicators
    FOLLOW_WORDS = {
        "it", "its", "that", "those", "they",
        "this", "these", "them",
        "expand", "continue", "elaborate",
        "more", "further", "again", "also",
    }
    
    # Split on word boundaries to avoid partial matches
    words = re.findall(r"\b\w+\b", query_lower)
    
    # Return True only if explicit follow-up word found
    return any(word in FOLLOW_WORDS for word in words)


# ============================================================================
# SECTION 3 — INTENT INSTRUCTIONS
# Each value is injected verbatim as the OUTPUT FORMAT directive.
# Language is imperative; no hedge words like "where helpful".
# ============================================================================

_INTENT_INSTRUCTIONS: dict[str, str] = {

    "brief": (
        "Reply in 1–2 sentences maximum, OR up to 3 bullet points if listing items. "
        "State only the single most important fact. "
        "No preamble. No headers. Stop immediately after the core answer."
    ),

    "simple": (
        "Reply in plain, everyday language — maximum 4 sentences. "
        "Avoid jargon; if a technical term is unavoidable, define it in parentheses. "
        "Write as if explaining to a smart person with no domain background."
    ),

    "detailed": (
        "DETAILED MODE (NON-NEGOTIABLE):\n"
        "• Provide a FULL, structured explanation.\n"
        "• Minimum 6–10 sentences (do NOT give short answers).\n"
        "• Use numbered steps or labeled sections (e.g., [Background], [Mechanism], [Example]).\n"
        "• Cover: what it is → how it works → why it matters → example.\n"
        "• Include concrete details, examples, or numbers from the paper.\n"
        "• Do NOT summarize or truncate. Explain thoroughly.\n"
        "• Be specific and comprehensive.\n"
        "OUTPUT: Multi-paragraph response, not a summary."
    ),

    "method": (
        "Describe ONLY the methodology, architecture, or technical process. "
        "Use a numbered list, one step or component per item. "
        "Do NOT include results, motivation, or background "
        "unless they are inseparable from the method."
    ),

    "results": (
        "Report ONLY key results and findings. "
        "Include specific numbers, dataset names, and comparisons if present in the context. "
        "Do NOT explain methodology or motivation. "
        "Mark anything inferred (not explicitly stated) with '(inferred)'."
    ),

    "concept": (
        "Give a one-sentence definition first. "
        "Follow with one concrete analogy or real-world example (2–3 sentences). "
        "Total response: 5 sentences maximum. "
        "Omit methodology and results unless they are central to the definition."
    ),

    "summary": (
        "Write 3–5 sentences of plain prose covering: "
        "the problem, the proposed solution, and the main outcome. "
        "No bullet points. No section headers."
    ),

    "general": (
        "Answer directly and naturally. "
        "Match length to complexity: short question → short answer, "
        "complex question → longer answer. "
        "Only answer what was asked — do NOT continue or expand on previous answers "
        "unless explicitly requested."
    ),
}


# ============================================================================
# SECTION 4 — CONTEXT QUALITY
# ============================================================================

_WEAK_CONTEXT_THRESHOLD = 150   # characters


def _assess_context(context: str) -> tuple[bool, str]:
    """Return (is_weak, stripped_context)."""
    stripped = (context or "").strip()
    return len(stripped) < _WEAK_CONTEXT_THRESHOLD, stripped


# ============================================================================
# SECTION 5 — HISTORY FORMATTER
# ============================================================================

_MAX_HISTORY_CHARS = 1_200   # hard cap — context always wins over history


def _format_history(history: list[dict]) -> str:
    """
    Convert history list → compact conversation block for prompt injection.

    Walks in reverse (newest first) so the character cap drops the
    oldest turns. Re-reverses before returning for chronological order.

    Returns empty string when history is empty.
    """
    if not history:
        return ""

    lines: list[str] = []
    budget = 0

    for msg in reversed(history):
        role    = "User" if msg.get("role") == "user" else "Assistant"
        content = msg.get("content", "").strip()

        # Truncate very long individual turns (e.g. a detailed answer)
        if len(content) > 400:
            content = content[:397] + "..."

        line = f"{role}: {content}"

        if budget + len(line) > _MAX_HISTORY_CHARS:
            break

        lines.append(line)
        budget += len(line) + 1

    if not lines:
        return ""

    lines.reverse()
    return "--- CONVERSATION HISTORY (for resolving follow-up references) ---\n" \
           + "\n".join(lines) + "\n---"


# ============================================================================
# SECTION 6 — PROMPT BUILDER
# ============================================================================

def build_prompt(
    question: str,
    context:  str,
    history:  list[dict] | None = None,
) -> str:
    """
    Assemble a clean, intent-aware, memory-augmented prompt.

    Layout
    ------
    1. Context   — RAG chunks (ground truth, or natural weak-context note)
    2. History   — past turns, only if present
    3. Rules     — minimal, non-negotiable guard-rails
    4. Question  — current user question + output format directive

    The role/persona preamble is intentionally omitted from the user
    message — it belongs in the system message, which each provider
    (groq_llm.py, ollama_llm.py) sets independently.  Duplicating it
    here causes the model to over-explain its own behaviour.

    Parameters
    ----------
    question : str
        The user's raw question (original, not enriched).
    context  : str
        Retrieved RAG chunks joined into a single string.
    history  : list[dict] | None
        Previous {"role", "content"} messages for this session.

    Returns
    -------
    str
        A fully formed prompt ready for any chat-completion backend.
    """
    intent       = detect_intent(question)
    instructions = _INTENT_INSTRUCTIONS[intent]
    is_weak, ctx = _assess_context(context)

    # ── 1. Context block ────────────────────────────────────────────────────
    if is_weak:
        context_block = (
            "[PAPER CONTEXT: not directly available for this question]\n"
            "Answer naturally using your general knowledge about this research area. "
            "If the paper likely covers the topic but the relevant section wasn't retrieved, "
            "mention briefly: 'The paper may cover this — here's the general understanding:'"
        )
    else:
        context_block = (
            "[PAPER CONTEXT — answer from this text only. "
            "Do not add facts absent from it.]\n\n"
            f"--- BEGIN CONTEXT ---\n{ctx}\n--- END CONTEXT ---"
        )

    # ── 2. History block — injected ONLY for follow-up questions ─────────────
    # 🔥 STRICT: Only inject history if this is explicitly a follow-up question
    # Standalone questions should NOT see history (avoids chaining)
    is_this_followup = is_followup(question)
    formatted_history = _format_history(history or []) if is_this_followup else ""
    
    # Add follow-up clarification if history is being injected
    if formatted_history and is_this_followup:
        history_block = formatted_history + "\n[FOLLOW-UP DETECTED: The current question refers to the previous topic. Answer accordingly.]"
    else:
        history_block = ""

    # ── 3. Rules block ───────────────────────────────────────────────────────
    rules_block = (
        "RULES:\n"
        "• ALWAYS answer the CURRENT question above all else.\n"
        "• Ignore previous questions unless explicitly referenced in this message.\n"
        "• Be natural and conversational — match the user's tone.\n"
        "• Answer only what is asked, but ensure the answer is clear and complete.\n"
        "• Do NOT open with filler: 'Certainly!', 'Sure!', 'Great question!' etc.\n"
        "• Do NOT repeat or restate the question before answering.\n"
        "• Do NOT continue or expand a previous answer unless the user explicitly asked.\n"
        "• If the answer is not in the context, answer naturally from general knowledge\n"
        "  and mention briefly: 'The paper doesn't cover this directly, but…'"
    )

    # ── 4. Task block ────────────────────────────────────────────────────────
    task_block = (
        f"QUESTION: {question}\n"
        f"OUTPUT FORMAT: {instructions}"
    )

    # ── Assemble ─────────────────────────────────────────────────────────────
    # 🔥 PRIORITY: Question at top, then context, then optional history, then rules
    sections = [
        task_block,      # QUESTION FIRST (highest priority)
        context_block,   # Then context
    ]
    
    # 🔥 STRICT: Only include history if this is explicitly a follow-up
    if history_block and is_this_followup:
        sections.append(history_block)
    
    sections.append(rules_block)  # Rules at end
    
    return "\n\n".join(sections)

"""
ADDITION TO llm_utils.py
========================
Add this function at the bottom of your existing llm_utils.py file,
after the build_prompt() function (Section 6).

No existing code needs to be modified — this is a pure extension.
"""


# ============================================================================
# SECTION 7 — EXPLAIN PROMPT BUILDER (for text-selection feature)
# ============================================================================

def build_explain_prompt(selected_text: str) -> str:
    """
    Build a focused prompt for explaining a passage of selected PDF text.

    Design goals
    ------------
    * Plain English — no jargon unless the jargon is explained.
    * Concise but not shallow — 3-6 sentences is the sweet spot.
    * Analogy-first for abstract/technical content.
    * Never invents facts; explains based solely on the provided passage.

    Parameters
    ----------
    selected_text : str
        Raw text selected by the user in the PDF viewer.

    Returns
    -------
    str
        A fully formed prompt ready for any chat-completion backend.
    """
    return (
        f"A user has highlighted the following passage from a research paper:\n\n"
        f'"""\n{selected_text.strip()}\n"""\n\n'
        "Your task is to explain this passage in simple, plain English.\n\n"
        "RULES:\n"
        "• Assume the reader is intelligent but NOT a domain expert.\n"
        "• Start directly with the explanation — no preamble like 'This passage says...'.\n"
        "• Use an analogy if the concept is abstract or mathematical.\n"
        "• Keep it concise: 3–6 sentences is ideal. Never exceed 8.\n"
        "• If the passage contains an equation or formula, describe what it computes, "
        "not just what the symbols mean.\n"
        "• Do NOT copy the passage back verbatim.\n"
        "• Do NOT comment on writing style or the authors.\n"
        "OUTPUT: Plain prose, no bullet points, no headers."
    )