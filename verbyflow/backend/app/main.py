from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn

from app.config import settings
from app.routers import calls, users

app = FastAPI(
    title=settings.PROJECT_NAME,
    openapi_url=f"{settings.API_V1_STR}/openapi.json",
    docs_url="/docs",
    redoc_url="/redoc",
)

# Set up CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.BACKEND_CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(users.router, prefix=f"{settings.API_V1_STR}/users", tags=["users"])
app.include_router(calls.router, prefix=f"{settings.API_V1_STR}/calls", tags=["calls"])


@app.get("/")
def root():
    """Root endpoint."""
    return {"message": "Welcome to VerbyFlow API", "version": "1.0.0"}


@app.get(f"{settings.API_V1_STR}/languages")
def get_languages():
    """Get available languages."""
    return {"languages": settings.AVAILABLE_LANGUAGES}


if __name__ == "__main__":
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
