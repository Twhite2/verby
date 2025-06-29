from pydantic import BaseModel, Field
from typing import List, Dict, Optional, Any
from datetime import datetime
import uuid


class UserBase(BaseModel):
    """Base User model."""
    name: str
    preferred_language: str


class UserCreate(UserBase):
    """User creation model."""
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))


class UserUpdate(BaseModel):
    """User update model."""
    name: Optional[str] = None
    preferred_language: Optional[str] = None


class User(UserBase):
    """Complete User model."""
    id: str
    
    class Config:
        orm_mode = True


class CallCreate(BaseModel):
    """Call creation model."""
    creator_id: str
    created_at: datetime = Field(default_factory=datetime.utcnow)


class CallSession(BaseModel):
    """Complete Call Session model."""
    id: str
    creator_id: str
    participant_ids: List[str] = []
    active: bool = True
    created_at: datetime
    
    class Config:
        orm_mode = True


class AudioChunk(BaseModel):
    """Audio chunk model for processing."""
    user_id: str
    source_language: str
    target_language: str
    audio_data: bytes
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class TranscriptionResult(BaseModel):
    """Speech-to-Text transcription result."""
    text: str
    language: str
    confidence: float


class TranslationResult(BaseModel):
    """Translation result."""
    source_text: str
    source_language: str
    translated_text: str
    target_language: str
