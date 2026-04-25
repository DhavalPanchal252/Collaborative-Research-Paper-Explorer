from dotenv import load_dotenv
load_dotenv()  # ← must be FIRST, before any other imports

from fastapi import FastAPI
from app.routes.upload import router as upload_router
from app.routes.chat_routes import router as chat_router
from fastapi.middleware.cors import CORSMiddleware
from app.routes.explain_routes import router as explain_router
from app.routes.figure_routes import router as figure_router
from fastapi.staticfiles import StaticFiles
from app.routes.figure_explain import router as figure_explain_router
from app.routes.citation_graph import router as citation_router
from app.routes.papers import router as papers_router
from app.routes import paper_loader

app = FastAPI()
app.include_router(paper_loader.router)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(papers_router)
app.include_router(upload_router)
app.include_router(chat_router)
app.include_router(explain_router)
app.include_router(figure_router)
app.include_router(figure_explain_router)

app.mount("/uploaded_papers", StaticFiles(directory="uploaded_papers"), name="uploaded_papers")
app.mount("/static", StaticFiles(directory="static"), name="static")
app.include_router(citation_router, prefix="/api/v1")

@app.get("/")
def home():
    return {"message": "API running 🚀"}