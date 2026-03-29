from fastapi import FastAPI
from app.routes.upload import router as upload_router
from app.routes.chat_routes import router as chat_router
from fastapi.middleware.cors import CORSMiddleware
from app.routes.explain_routes import router as explain_router
from fastapi.staticfiles import StaticFiles

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],  # Vite dev server
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(upload_router)
app.include_router(chat_router)
app.include_router(explain_router)
app.mount("/uploaded_papers", StaticFiles(directory="uploaded_papers"), name="uploaded_papers")

@app.get("/")
def home():
    return {"message": "API running 🚀"}