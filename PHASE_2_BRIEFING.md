# 🚀 Phase 2 Briefing for Claude AI

**Project:** GenAI Research Paper Explorer  
**Status:** Phase 1 Complete + Ready for Phase 2  
**Your Task:** Implement Phase 2 feature(s) maintaining Phase 1 architecture

---

## 📋 Quick Context

**What exists (Phase 1):**
- ✅ PDF upload → text extraction → semantic chunking
- ✅ FAISS vector search + RAG pipeline
- ✅ Multi-model LLM (Groq + Ollama)
- ✅ Session memory with follow-up detection
- ✅ Intent-aware prompting (7 intents)
- ✅ React UI (UploadPanel, ChatPanel, ModelSelector)

**What to build (Phase 2):**
Pick ONE or TWO features below ⬇️

---

## 🔥 Phase 2 Options (Choose 1-2)

### **OPTION A: Section-Wise Summary**

**User Story:**
- User uploads paper
- UI shows "Extract Sections" button
- Backend analyzes paper → extracts section names (Abstract, Introduction, Method, Results, etc.)
- User clicks section → gets summary
- Chat can reference section (e.g., "Explain the methodology section")

**What to Add:**

1. **Backend Route:** `POST /analyze/sections`
   - Input: `session_id`
   - Output: `{"sections": [{"name": "Abstract", "page": 1}, {...}]}`
   - Tech: Regex/heuristics to find section headers in text

2. **Backend Route:** `POST /chat/section/{section_name}`
   - Input: `session_id, section_name`
   - Output: Summary of that section
   - Tech: Retrieve chunks matching section → build prompt → LLM

3. **Frontend Component:** `SummaryPanel.jsx`
   - Displays section list with buttons
   - Shows section summary when clicked
   - Integrates into ChatPanel sidebar

**Implementation Time:** ~2-3 hours  
**Complexity:** Medium  
**Tech Stack:** No new dependencies

---

### **OPTION B: Related Papers Recommendation**

**User Story:**
- User uploads paper
- UI shows "Find Related Papers" button
- System queries embedding similarity → finds 5 similar papers from arXiv
- Displays with links + similarity score

**What to Add:**

1. **Backend Route:** `POST /related`
   - Input: `session_id`
   - Output: `{"related": [{"title": "...", "arxiv_id": "...", "similarity": 0.87, "url": "..."}, {...}]}`
   - Tech: Embed paper → search arXiv embeddings (pre-computed)

2. **Data Preparation:**
   - Need pre-embedded arXiv papers corpus (or API)
   - Option 1: Use arXiv API (free, no auth)
   - Option 2: Pre-compute embeddings for top 1000 papers
   - Option 3: Call external API (but slower)

3. **Frontend Component:** `RelatedPapers.jsx`
   - Shows grid/list of related papers
   - Click → open arXiv link in new tab
   - Display similarity scores

**Implementation Time:** ~3-4 hours  
**Complexity:** Medium-High  
**New Dependencies:** `arxiv` (Python), `requests`

---

### **OPTION C: Smart Annotations (🔥 STRONG USP)**

**User Story:**
- User reads paper in chat
- Selects text → clicks "Annotate"
- Popup allows inline comment
- Comments saved with highlights
- Can export annotations as notes

**What to Add:**

1. **Backend Route:** `POST /annotate`
   - Input: `session_id, text, comment, highlight_color`
   - Output: `{"annotation_id": "...", "timestamp": "..."}`
   - Tech: Store in dictionary (or DB in Phase 3)

2. **Backend Route:** `GET /annotations/{session_id}`
   - Output: List of all annotations for session
   - Tech: Return from stored dict

3. **Backend Route:** `GET /export/notes/{session_id}`
   - Output: Markdown file with highlights + comments
   - Tech: Generate markdown, return as download

4. **Frontend Feature:**
   - Highlight color selector
   - Text selection → annotation popup
   - Sidebar showing all annotations
   - Export button

**Implementation Time:** ~4-5 hours  
**Complexity:** High  
**New Dependencies:** None (use browser Selection API)

---

## 🏗️ Architecture to Maintain

### **Backend Pattern**
```python
# File: backend/app/routes/{feature_name}.py
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

router = APIRouter(tags=["Feature"])

class FeatureRequest(BaseModel):
    session_id: str
    # your fields

class FeatureResponse(BaseModel):
    # your response fields

@router.post("/feature")
async def handle_feature(request: FeatureRequest) -> FeatureResponse:
    """Your feature logic here."""
    return FeatureResponse(...)

# Register in: backend/app/main.py
from app.routes import {feature_name}_routes
app.include_router({feature_name}_routes.router)
```

### **Frontend Pattern**
```javascript
// File: frontend/src/api/{feature_name}.js
export const featureAPI = async (sessionId, data) => {
    const response = await fetch('http://127.0.0.1:8000/feature', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, ...data })
    });
    return response.json();
};

// File: frontend/src/components/{FeatureName}.jsx
import { featureAPI } from '../api/{feature_name}';

export default function FeatureName({sessionId, metadata}) {
    const [state, setState] = useState(null);
    
    const handleClick = async () => {
        const result = await featureAPI(sessionId, {...});
        setState(result);
    };
    
    return (
        <div>
            {/* Your UI here */}
        </div>
    );
}
```

### **Session Access Pattern**
Use `session_id` to retrieve paper chunks from Phase 1:
```python
# In any route
session = _sessions.get(session_id)
if not session:
    raise HTTPException(status_code=404, detail="Session not found")

chunks = session["chunks"]  # List of text chunks
faiss_index = session["index"]  # Vector search
history = session["history"]  # Conversation deque
```

### **Error Handling Pattern**
```python
from fastapi import HTTPException, status
import logging

logger = logging.getLogger(__name__)

try:
    # your logic
except Exception as exc:
    logger.exception("Feature failed")
    raise HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail="Feature failed. Please try again."
    ) from exc
```

---

## 📂 File Structure Reference

```
backend/app/
├── routes/
│   ├── chat_routes.py
│   ├── upload.py
│   └── {your_feature}.py          ← Add here
├── services/
│   ├── llm/
│   ├── embedding.py
│   ├── retriever.py
│   └── {your_feature}_service.py  ← Optional service layer
└── utils/
    └── chunker.py

frontend/src/
├── components/
│   ├── ChatPanel.jsx
│   ├── UploadPanel.jsx
│   └── {YourFeature}.jsx           ← Add here
└── api/
    ├── chat.js
    ├── upload.js
    └── {your_feature}.js           ← Add here
```

---

## 🔌 Reusable Services (Don't Reinvent)

### **Vector Search**
```python
from app.services.retriever import retrieve_chunks
chunks = retrieve_chunks(query="math", chunks=session["chunks"], index=session["index"])
```

### **LLM Generation**
```python
from app.services.llm.factory import get_llm
from app.services.llm.llm_utils import build_prompt

llm = get_llm("groq")
prompt = build_prompt(question="Explain X", context="...", history=[])
answer = llm(prompt=prompt)
```

### **Embeddings**
```python
from app.services.embedding import create_vector_store
index, embeddings = create_vector_store(chunks)
```

---

## ✅ Checklist for Phase 2 Implementation

- [ ] Choose ONE feature (A, B, or C)
- [ ] Create backend route file (`{feature}.py`)
- [ ] Create backend service (optional, if heavy logic)
- [ ] Register route in `main.py`
- [ ] Create frontend API client (`{feature}.js`)
- [ ] Create frontend component (`{Feature}.jsx`)
- [ ] Integrate component into `App.jsx` or `ChatPanel.jsx`
- [ ] Test with real PDF upload
- [ ] Handle edge cases (missing session, empty data, etc.)
- [ ] Add logging
- [ ] Commit to git

---

## 🎯 Success Criteria

**Your Phase 2 feature is done when:**
1. ✅ Backend endpoint responds with correct data
2. ✅ Frontend displays data without crashing
3. ✅ Works with session_id from Phase 1
4. ✅ Error handling graceful (no blank screens)
5. ✅ Code follows Phase 1 patterns (FastAPI router, React components, async/await)
6. ✅ Logged to console for debugging

---

## 📞 Important Notes

1. **Use existing session_id system** — don't create new sessions
2. **Maintain localStorage persistence** — session_id should survive page refresh
3. **Keep same error patterns** — HTTPException + 500 status
4. **Reuse LLM pipeline** — don't call Groq/Ollama directly, use factory + llm_utils
5. **Test with localStorage** — ensure Frontend can retrieve session_id

---

## 🔗 File Structure Reference Document

See `PHASE_1_FILE_STRUCTURE.md` for:
- Complete directory tree
- All file responsibilities
- Database schemas (in-memory patterns)
- Dependencies list
- Configuration patterns

---

## 🚀 Ready to Start?

**Share this document + `PHASE_1_FILE_STRUCTURE.md` with Claude AI**

Then request:
```
"Implement Phase 2 Option [A/B/C].

Use the attached PHASE_1_FILE_STRUCTURE.md as reference.
Follow all patterns from Phase 1.
Maintain session_id architecture.
Create files: backend/app/routes/..., frontend/src/api/..., frontend/src/components/..."
```

---

**Document Generated:** March 27, 2026  
**Phase 1:** ✅ Complete  
**Next Step:** Pick Feature + Brief Claude AI
