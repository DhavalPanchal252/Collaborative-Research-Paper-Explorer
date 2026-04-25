# 📋 Phase 1 File Structure & Architecture

**Project:** GenAI Research Paper Explorer (ArxivMind)  
**Status:** Phase 1 Complete ✅  
**Next:** Phase 2 Implementation

---

## 📁 Directory Structure

```
GenAI_Project/
├── backend/                          # FastAPI Python backend
│   ├── app/
│   │   ├── main.py                  # FastAPI app initialization + middleware
│   │   ├── routes/                  # Endpoint definitions
│   │   │   ├── chat_routes.py       # POST /chat (RAG + memory)
│   │   │   ├── upload.py            # POST /upload (PDF indexing)
│   │   │   └── __init__.py
│   │   ├── services/                # Business logic layer
│   │   │   ├── embedding.py         # Vector embeddings (sentence-transformers)
│   │   │   ├── pdf_parser.py        # PyMuPDF text extraction
│   │   │   ├── retriever.py         # FAISS retrieval
│   │   │   ├── store.py             # Session/storage utilities
│   │   │   ├── llm/                 # LLM provider abstraction
│   │   │   │   ├── factory.py       # Provider selector (Groq/Ollama)
│   │   │   │   ├── groq_llm.py      # Groq API client (llama-3.1-8b-instant)
│   │   │   │   ├── ollama_llm.py    # Ollama local client (fallback)
│   │   │   │   ├── llm_utils.py     # Intent detection + prompt building
│   │   │   │   └── __init__.py
│   │   │   └── __pycache__/
│   │   ├── utils/                   # Utility functions
│   │   │   ├── chunker.py           # Text chunking (semantic splitting)
│   │   │   └── __pycache__/
│   │   └── __pycache__/
│   ├── requirements.txt             # Python dependencies
│   ├── .env                         # Secrets (GROQ_API_KEY) - NOT in git
│   └── uploaded_papers/             # PDF storage (transient)
├── frontend/                         # React + Vite
│   ├── src/
│   │   ├── App.jsx                  # Main component (layout + state)
│   │   ├── main.jsx                 # React entry point
│   │   ├── index.css                # Global styles
│   │   ├── components/              # React components
│   │   │   ├── UploadPanel.jsx     # PDF upload form
│   │   │   ├── ChatPanel.jsx       # Chat interface (Q&A)
│   │   │   ├── ChatMessage.jsx     # Message display (user/assistant)
│   │   │   ├── ModelSelector.jsx   # Groq/Ollama toggle
│   │   │   └── (future: AnnotationPanel.jsx, SummaryPanel.jsx)
│   │   ├── api/                     # API client functions
│   │   │   ├── upload.js           # fetch wrapper: POST /upload
│   │   │   ├── chat.js             # fetch wrapper: POST /chat
│   │   │   └── (future: annotation.js, summary.js)
│   │   └── (future: utils/, hooks/, etc.)
│   ├── package.json                 # npm dependencies (React, Vite, etc.)
│   ├── vite.config.js              # Vite dev server (port 5173)
│   ├── index.html                  # HTML entry point
│   ├── .env                        # VITE_API_URL
│   └── public/                     # Static assets
├── .gitignore                       # Python + Node exclusions + .env
├── TESTING_REPORT.md               # Phase 1 test results (11 tests ✅)
└── PHASE_1_FILE_STRUCTURE.md       # This file

```

---

## 🔧 Key Files & Responsibilities

### **Backend - Routes (Endpoints)**

#### [`backend/app/routes/upload.py`](backend/app/routes/upload.py)
**Purpose:** PDF upload + indexing  
**Endpoint:** `POST /upload`  
**Request:** FormData with `file` (PDF)  
**Response:**
```json
{
  "message": "PDF uploaded successfully",
  "original_filename": "paper.pdf",
  "stored_as": "uploaded_papers/paper_<uuid>.pdf",
  "session_id": "<uuid>",
  "chunks_created": 12,
  "file_size_bytes": 2456789
}
```
**Key Logic:**
- Validates file type (PDF), size, magic bytes
- Extracts text via PyMuPDF (`pdf_parser.extract_text()`)
- Chunks text semantically (`chunker.chunk_text()`)
- Creates FAISS vector store (`embedding.create_vector_store()`)
- Stores chunks & index in session (`_sessions[session_id]`)
- Clears old PDFs (single-paper design for MVP)

---

#### [`backend/app/routes/chat_routes.py`](backend/app/routes/chat_routes.py)
**Purpose:** RAG chat with memory  
**Endpoint:** `POST /chat`  
**Request:**
```json
{
  "question": "Explain the methodology",
  "model": "groq",
  "session_id": "<uuid>" (optional)
}
```
**Response:**
```json
{
  "answer": "The paper proposes...",
  "session_id": "<uuid>",
  "chunks_used": 3
}
```
**Pipeline:**
1. Resolve/create session
2. **Casual short-circuit** — if "ok"/"thanks" → reply immediately, skip RAG
3. Guard: paper must be indexed
4. Enrich query with domain keywords
5. Retrieve chunks via FAISS
6. **Build prompt** with context + history (if follow-up)
7. LLM generation
8. Save turn to history
9. Return response

**Session Store:**
```python
_sessions[session_id] = {
    "history": deque(maxlen=10),  # 5 full turns
    "chunks": [...],              # text segments
    "index": faiss_index,         # vector search
}
```

---

### **Backend - Services**

#### [`backend/app/services/embedding.py`](backend/app/services/embedding.py)
**Purpose:** Vector embeddings  
**Model:** `all-MiniLM-L6-v2` (sentence-transformers)  
**Key Functions:**
- `create_vector_store(chunks)` → FAISS index + embedding matrix
- Uses cosine similarity for retrieval

---

#### [`backend/app/services/pdf_parser.py`](backend/app/services/pdf_parser.py)
**Purpose:** PDF → text extraction  
**Tool:** PyMuPDF (`fitz`)  
**Key Functions:**
- `extract_text(file_path)` → raw text from PDF

---

#### [`backend/app/services/retriever.py`](backend/app/services/retriever.py)
**Purpose:** FAISS search + ranking  
**Key Functions:**
- `retrieve_chunks(query, chunks, index)` → top-K relevant chunks
- Filters by similarity threshold
- Returns chunk strings for LLM context

---

#### [`backend/app/services/llm/`](backend/app/services/llm/)
**Purpose:** LLM provider abstraction  

**`factory.py`** — Selector
```python
get_llm(model_name) → GroqLLM | OllamaLLM
```

**`groq_llm.py`** — Groq API wrapper
- Model: `llama-3.1-8b-instant` (updated from deprecated)
- Lazy client initialization (prevents crash if key missing)
- Error handling with fallback

**`ollama_llm.py`** — Ollama local wrapper
- Fallback if Groq unavailable
- Assumes Ollama running on `localhost:11434`

**`llm_utils.py`** — Prompt engineering (🔥 CRITICAL)
- `detect_intent(query)` → one of 7 intents:
  - `brief` (1-2 sentences)
  - `detailed` (6-10 sentences, structured)
  - `simple` (plain language)
  - `method`, `results`, `concept`, `summary`
- `is_followup(query)` → strict detection (uses word list)
- `build_prompt(question, context, history)` → full prompt assembly:
  1. Question (task block)
  2. Context (RAG chunks or fallback)
  3. History (optional, only if follow-up)
  4. Rules (hard constraints for model)
- `_INTENT_KEYWORDS` → keyword → intent mapping
- `_INTENT_INSTRUCTIONS` → output format per intent

---

#### [`backend/app/services/store.py`](backend/app/services/store.py)
**Purpose:** Session/storage utilities  
**Note:** Currently minimal; can expand for database persistence in Phase 2

---

### **Backend - Utils**

#### [`backend/app/utils/chunker.py`](backend/app/utils/chunker.py)
**Purpose:** Text → semantic chunks  
**Algorithm:** Sentence-based, max 300-500 chars per chunk  
**Key Functions:**
- `chunk_text(text, max_chunk_size=500)` → list of chunks

---

### **Frontend - Components**

#### [`frontend/src/App.jsx`](frontend/src/App.jsx)
**Purpose:** Main layout + state management  
**State:**
- `file` — selected PDF file
- `metadata` — upload response (session_id, filename, chunks)
- `model` — "groq" or "ollama"
- `uploading` — upload in progress
- `error` — error message
- `sessionId` — persisted in localStorage

**Functions:**
- `handleUpload()` → clears localStorage session before new upload
- `handleReset()` → clears file + metadata + localStorage

**Layout:**
```
┌─────────────────────────────────────┐
│ Header (Logo + Reset Button)        │
├─────┬───────────────────────────────┤
│     │                               │
│ Sideb│ Main Area                    │
│ ar   │                               │
│ (Uplo│ ChatPanel OR EmptyState       │
│ ad + │                               │
│ Model)                              │
└─────┴───────────────────────────────┘
```

---

#### [`frontend/src/components/UploadPanel.jsx`](frontend/src/components/UploadPanel.jsx)
**Purpose:** PDF file selector + upload button  
**Props:** `onUpload(file)` callback  
**Logic:**
- File input with drag-drop
- Validates file type (.pdf)
- Displays file name + size

---

#### [`frontend/src/components/ChatPanel.jsx`](frontend/src/components/ChatPanel.jsx)
**Purpose:** Chat interface  
**Props:**
- `metadata` (paper info)
- `model` (Groq/Ollama)
- `sessionId` (for backend)
**State:**
- `messages` — conversation history
- `input` — user message in progress
- `loading` — waiting for LLM response
**Flow:**
1. User types → enters in input
2. Click send → calls `chat()` API
3. Displays message + response
4. Stores chunks used (debug info)

---

#### [`frontend/src/components/ChatMessage.jsx`](frontend/src/components/ChatMessage.jsx)
**Purpose:** Single message display (user/assistant bubble)  
**Props:**
- `role` ("user" or "assistant")
- `content` (message text)

---

#### [`frontend/src/components/ModelSelector.jsx`](frontend/src/components/ModelSelector.jsx)
**Purpose:** Groq vs Ollama toggle  
**Props:** `model`, `onChange()` callback

---

### **Frontend - API Clients**

#### [`frontend/src/api/upload.js`](frontend/src/api/upload.js)
```javascript
uploadPDF(file) → {
  message, original_filename, stored_as,
  session_id, chunks_created, file_size_bytes
}
```
- POST to `/upload` with FormData
- Handles CORS
- Stores session_id in localStorage

---

#### [`frontend/src/api/chat.js`](frontend/src/api/chat.js)
```javascript
chat(question, model, sessionId) → {
  answer, session_id, chunks_used
}
```
- POST to `/chat` with JSON
- Retrieves sessionId from localStorage

---

## 🏗️ Architecture Patterns

### **Session Management**
- **Storage:** In-memory dict (`_sessions[session_id]`)
- **Identifier:** UUID4 generated on first upload
- **Persistence:** localStorage on frontend
- **Limitation:** Lost on server restart (MVP design)
- **Future (Phase 3):** Database persistence

### **RAG Pipeline**
```
User Query
    ↓
Enrich (add domain keywords)
    ↓
Embed + Retrieve (FAISS)
    ↓
Build Prompt (with history + rules)
    ↓
LLM Generate
    ↓
Save Turn + Return
```

### **Intent-Aware Prompting**
- **7 Intents:** brief, detailed, simple, method, results, concept, summary
- **Keyword Matching:** Strict substring search in priority order
- **Output Instructions:** Custom format per intent
- **Example:**
  - Query: "explain it in very detailed" → Intent: `detailed` → 6-10 sentences, structured

### **History Injection (Follow-up Detection)**
- **Strict Logic:** Only inject history if query contains explicit follow-up words
  - Follow-up words: "it", "its", "that", "they", "more", "expand", etc.
- **Deque Limit:** maxlen=10 (5 full turns)
- **Benefit:** Prevents context chaining for standalone questions

### **Error Handling**
- **Missing Paper:** 400 error
- **Retrieval Failure:** 500 error
- **LLM Generation Failure:** 500 error with fallback message
- **Casual Inputs:** Skip RAG entirely (fast-path)

---

## 🔌 External Dependencies

### **Backend**
```
fastapi              # Web framework
uvicorn              # ASGI server
pydantic             # Schema validation
groq                 # LLM API client
ollama               # Local LLM (optional)
faiss                # Vector search
sentence-transformers # Embeddings
pymupdf              # PDF extraction
python-dotenv        # .env loading
```

### **Frontend**
```
react                # UI framework
vite                 # Build tool
axios/fetch          # HTTP client
```

---

## 🔐 Secrets & Configuration

### **Backend `.env`** (do NOT commit)
```
GROQ_API_KEY=gsk_...
OLLAMA_HOST=http://localhost:11434  (optional)
```

### **Frontend `.env`** (safe to commit)
```
VITE_API_URL=http://127.0.0.1:8000
```

---

## ✅ Phase 1 Completeness Checklist

- [x] PDF upload + text extraction
- [x] Semantic chunking
- [x] Vector embeddings (FAISS)
- [x] RAG retrieval
- [x] Multi-provider LLM (Groq + Ollama)
- [x] Session memory (deque history)
- [x] Follow-up detection (strict)
- [x] Intent-aware prompting
- [x] Casual input handling (short-circuit)
- [x] Clean React UI (upload + chat)
- [x] API error handling + fallbacks
- [x] localStorage session persistence

---

## 🎯 Phase 2 Options (PICK 1-2)

### **Option A: Section-Wise Summary**
New routes: `/analyze/sections`, `/summary/{section}`  
UI: Select section in sidebar → see summary  
Tech: Extract table of contents from paper

### **Option B: Related Papers (Paper Recommendations)**
New route: `/related`  
Tech: Embedding similarity to arXiv corpus  
UI: Show 5 related papers with links

### **Option C: Smart Annotations (STRONG USP)**
New routes: `/annotate`, `/annotation/{doc_id}`  
UI: Highlight text + add comments  
Tech: Store annotations in DB with highlights  
**Why this is 🔥:** Differentiates from competitors

---

## 📝 Code Quality Notes

- **Type Hints:** Used throughout (Python + JSDoc)
- **Logging:** `logging` module for debug/info/error
- **Error Handling:** Try-except with HTTPException wrappers
- **Lazy Loading:** Groq client initialized on first use
- **Deque:** Automatic history trimming (maxlen=10)
- **Docstrings:** Module + function level documentation

---

## 🚀 How to Use This Doc for Phase 2

1. **Share with Claude AI:** Copy entire file
2. **Specify Phase 2 choice:** "Based on this structure, implement Option A (Section-Wise Summary)"
3. **Maintain Patterns:**
   - Keep `/routes/{feature_name}.py` structure
   - Keep `/services/{feature_name}.py` for business logic
   - Keep `/components/{FeatureName}.jsx` for UI
   - Keep async/await patterns
   - Keep error handling pattern (HTTPException + logging)

---

**Document Generated:** March 27, 2026  
**Phase 1 Status:** ✅ Complete  
**Ready for Phase 2:** ✅ Yes
