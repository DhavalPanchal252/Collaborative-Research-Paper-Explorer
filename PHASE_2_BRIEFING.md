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
Implement ONLY ONE feature (see selected option below)

---

## 🔴 CRITICAL CONSTRAINTS (READ FIRST)

### ⚠️ IMPORTANT: IMPLEMENT ONLY ONE FEATURE

**DO NOT:**
- ❌ Combine multiple features
- ❌ Implement all options
- ❌ Redesign existing UI
- ❌ Add new frameworks or abstractions
- ❌ Over-engineer services

**DO:**
- ✅ Keep implementation minimal
- ✅ Follow Phase 1 exact patterns
- ✅ Add only required files
- ✅ Integrate into existing components
- ✅ Test with Phase 1 session_id system

### ⚠️ SIMPLICITY RULE

This is an **incremental feature**, not a rewrite.
- Do NOT redesign existing architecture
- Do NOT add unnecessary services or abstractions
- Keep UI changes minimal (only add small new component)
- Reuse existing patterns (FastAPI router, React component, session management)

### ⚠️ UI CONSTRAINT

- Do NOT redesign the UI
- Only add a small SummaryPanel component
- Integrate into existing ChatPanel sidebar (not replace)
- Keep styling consistent with current theme
- No layout changes to main App.jsx

---

## ✅ SELECTED FEATURE (LOCKED)

### **→ IMPLEMENT OPTION A: Section-Wise Summary ONLY**

This is your Phase 2 feature. Ignore Options B and C completely.

**Why Option A?**
- ✅ Clean implementation (2-3 hours)
- ✅ No new dependencies
- ✅ High UX value
- ✅ Works with existing RAG pipeline
- ✅ Platform for future features

**Do NOT attempt:** Options B or C

---

## 🔥 Phase 2 Options (Reference Only)

### **OPTION A: Section-Wise Summary** ← YOUR FEATURE

**User Story:**
- User uploads paper
- UI shows "Extract Sections" button in sidebar
- Backend analyzes paper → extracts section names (Abstract, Introduction, Method, Results, etc.)
- User clicks section → gets AI summary
- Chat can reference section (e.g., "Explain the methodology section")

**What to Add:**

1. **Backend Route:** `POST /analyze/sections`
   - Input: `session_id`
   - Output: `{"sections": [{"name": "Abstract", "start_idx": 0}, {...}]}`
   - Tech: Regex patterns to find section headers in text
   - **Fallback:** If section detection fails, use semantic chunk filtering by keywords

2. **Backend Route:** `POST /chat/section/{section_name}`
   - Input: `session_id, section_name`
   - Output: Summary of that section
   - Tech: Filter chunks by section → build prompt → LLM generate

3. **Frontend Component:** `SectionsPanel.jsx`
   - Small sidebar panel showing section buttons
   - Clicking section calls backend
   - Displays section summary below
   - Integrates into right sidebar of ChatPanel (minimal)

**Implementation Time:** 2-3 hours  
**Complexity:** Medium  
**Tech Stack:** No new dependencies  
**Files to Create:**
- `backend/app/routes/sections.py`
- `backend/app/services/section_analyzer.py` (optional)
- `frontend/src/components/SectionsPanel.jsx`
- `frontend/src/api/sections.js`

---

### **⚠️ OPTIONS B & C (DO NOT IMPLEMENT)**

These are reference options only. **DO NOT build these.**

**OPTION B: Related Papers Recommendation** ❌ SKIP THIS
- Status: Not selected for Phase 2

**OPTION C: Smart Annotations** ❌ SKIP THIS  
- Status: Not selected for Phase 2

**Focus entirely on Option A only.**

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

## 🚨 WHAT CLAUDE MIGHT TRY TO DO (AND SHOULD NOT)

**Common over-engineering patterns to BLOCK:**

### ❌ DO NOT DO THIS:

1. **Create a new service layer called `SectionService`**
   - Just put logic directly in the route file
   - No need for abstraction

2. **Redesign ChatPanel to add tabs/accordion**
   - Just add a small button → sidebar panel
   - Keep existing ChatPanel intact

3. **Add database models for caching sections**
   - Store in session dictionary (`_sessions[session_id]["sections"]`)
   - No persistence needed

4. **Create TypeScript interfaces or complex schemas**
   - Use simple Pydantic models
   - Keep it minimal

5. **Add multiple new files and folder structures**
   - Follow Phase 1 pattern: one route file + optional service file
   - That's it

6. **Build a section editor, section deletion system, etc.**
   - Just: detect → display → summarize
   - Nothing more

### ✅ DO THIS INSTEAD:

- Add 2-3 new files maximum
- Reuse existing LLM pipeline (don't reinvent)
- Route → (optional service) → response
- One new React component only
- Keep styling consistent
- Minimum viable implementation

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

Then request EXACTLY like this:
```
"Implement Phase 2 Option A (Section-Wise Summary) for my research paper explorer.

CONSTRAINTS (VERY IMPORTANT):
- Implement ONLY Option A
- Do NOT implement Options B or C
- Do NOT redesign UI or architecture
- Do NOT add unnecessary services
- Keep implementation minimal and aligned with Phase 1

Use the attached PHASE_1_FILE_STRUCTURE.md as reference.
Follow all patterns from Phase 1.
Maintain session_id architecture.
Create only these files:
  - backend/app/routes/sections.py
  - backend/app/services/section_analyzer.py (if needed)
  - frontend/src/api/sections.js
  - frontend/src/components/SectionsPanel.jsx

Do NOT redesign ChatPanel or App.jsx layout.
Just add SectionsPanel as a small sidebar component."
```

---

**Document Generated:** March 27, 2026  
**Phase 1:** ✅ Complete  
**Phase 2 Feature:** ✅ LOCKED (Option A)  
**Ready to Brief Claude:** ✅ Yes
