import asyncio
import tempfile
import os
import io
from typing import Optional
import numpy as np
import soundfile as sf

# Try to import optional dependencies with fallbacks
try:
    import pyttsx3
    PYTTSX3_AVAILABLE = True
except ImportError:
    PYTTSX3_AVAILABLE = False

# Try to import gTTS
try:
    from gtts import gTTS
    GTTS_AVAILABLE = True
except ImportError:
    GTTS_AVAILABLE = False


async def synthesize_speech(text: str, language: str = "en") -> bytes:
    """
    Convert text to speech audio data.
    
    Args:
        text: Text to convert to speech
        language: ISO language code
    
    Returns:
        Audio data as bytes
    """
    # Run the CPU-intensive TTS in a thread pool
    return await asyncio.to_thread(_synthesize_speech_sync, text, language)


def _synthesize_speech_sync(text: str, language: str) -> bytes:
    """Synchronous implementation of text-to-speech synthesis."""
    
    # Try gTTS first if available
    if GTTS_AVAILABLE:
        try:
            with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as temp_file:
                tts = gTTS(text=text, lang=language)
                tts.save(temp_file.name)
                
                # Convert the MP3 to raw audio bytes
                with open(temp_file.name, "rb") as audio_file:
                    audio_data = audio_file.read()
                
                # Delete the temporary file
                os.unlink(temp_file.name)
                
                return audio_data
        except Exception as e:
            print(f"gTTS error: {e}")
    
    # Fall back to pyttsx3 if available
    if PYTTSX3_AVAILABLE:
        try:
            engine = pyttsx3.init()
            
            # Configure the engine
            voices = engine.getProperty('voices')
            # Set a voice - this is very basic and doesn't support all languages
            # In a more advanced implementation, you'd map languages to appropriate voices
            engine.setProperty('voice', voices[0].id)  # Default voice
            engine.setProperty('rate', 150)  # Speaking rate
            
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_file:
                engine.save_to_file(text, temp_file.name)
                engine.runAndWait()
                
                # Read the WAV file
                with open(temp_file.name, "rb") as audio_file:
                    audio_data = audio_file.read()
                
                # Delete the temporary file
                os.unlink(temp_file.name)
                
                return audio_data
        except Exception as e:
            print(f"pyttsx3 error: {e}")
    
    # If all else fails, generate a simple tone as a placeholder
    try:
        # Generate a simple beep sound
        sample_rate = 16000
        duration = 0.5  # half second
        t = np.linspace(0, duration, int(sample_rate * duration), False)
        tone = np.sin(2 * np.pi * 440 * t) * 0.3  # 440 Hz sine wave at 0.3 amplitude
        
        # Convert to bytes
        buffer = io.BytesIO()
        sf.write(buffer, tone, sample_rate, format='WAV')
        buffer.seek(0)
        return buffer.read()
    except Exception as e:
        print(f"Fallback audio generation error: {e}")
        return b""  # Return empty bytes as last resort
