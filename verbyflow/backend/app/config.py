from pydantic_settings import BaseSettings
from typing import List, Dict, Optional
import os
from pathlib import Path


class Settings(BaseSettings):
    """Application settings."""
    
    # API Settings
    API_V1_STR: str = "/api"
    PROJECT_NAME: str = "VerbyFlow"
    
    # OpenAI API Key
    OPENAI_API_KEY: Optional[str] = None
    
    # CORS Settings
    BACKEND_CORS_ORIGINS: List[str] = ["http://localhost", "http://localhost:8080", "http://localhost:3000"]
    
    # Available languages
    AVAILABLE_LANGUAGES: Dict[str, str] = {
        "en": "English",
        "es": "Spanish",
        "fr": "French",
        "de": "German",
        "zh": "Chinese",
        "ja": "Japanese",
        "ru": "Russian",
        "pt": "Portuguese",
        "ar": "Arabic",
        "hi": "Hindi",
        "yo": "Yoruba",  # Nigerian language
        "ha": "Hausa",   # Nigerian language
        "ig": "Igbo",    # Nigerian language
        "ij": "Ijaw"     # Nigerian language
    }
    
    # Audio settings
    AUDIO_SAMPLE_RATE: int = 16000
    AUDIO_CHANNELS: int = 1
    
    # Service keys and URLs
    OPENAI_API_KEY: Optional[str] = None
    
    class Config:
        env_file = ".env"
        case_sensitive = True


settings = Settings()
