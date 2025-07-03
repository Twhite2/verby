import asyncio
import tempfile
import os
import io
import time
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

# Try to import SpeechT5 for high-quality TTS
try:
    import torch
    from transformers import SpeechT5Processor, SpeechT5ForTextToSpeech, SpeechT5HifiGan
    from datasets import load_dataset
    SPEECH_T5_AVAILABLE = True
    print("Microsoft SpeechT5 is available for high-quality TTS")
except ImportError:
    SPEECH_T5_AVAILABLE = False
    print("Microsoft SpeechT5 is not available, falling back to other TTS methods")


class SpeechT5Model:
    """Class for high-quality text-to-speech using Microsoft's SpeechT5"""
    
    def __init__(self):
        if not SPEECH_T5_AVAILABLE:
            raise ImportError("SpeechT5 dependencies not available")
        
        self.device = "cuda:0" if torch.cuda.is_available() else "cpu"
        print(f"Initializing SpeechT5 TTS on {self.device}")
        
        # Load models
        self.processor = SpeechT5Processor.from_pretrained("microsoft/speecht5_tts", normalize=True)
        self.model = SpeechT5ForTextToSpeech.from_pretrained("microsoft/speecht5_tts").to(self.device)
        self.vocoder = SpeechT5HifiGan.from_pretrained("microsoft/speecht5_hifigan").to(self.device)
        
        # Load speaker embeddings
        self._load_speaker_embeddings()
    
    def _load_speaker_embeddings(self):
        """Load speaker embeddings for voice characteristics"""
        try:
            # Use CMU Arctic dataset for speaker embeddings
            embeddings_dataset = load_dataset("Matthijs/cmu-arctic-xvectors", split="validation")
            self.speaker_embeddings = torch.tensor(embeddings_dataset[7306]["xvector"]).unsqueeze(0).to(self.device)
            print("Speaker embeddings loaded successfully")
        except Exception as e:
            print(f"Error loading speaker embeddings: {e}")
            # Create a fallback random embedding if loading fails
            self.speaker_embeddings = torch.randn(1, 512).to(self.device)
            print("Using random speaker embeddings as fallback")
    
    def synthesize(self, text):
        """Generate speech from text using SpeechT5"""
        try:
            start_time = time.time()
            
            # Process text input
            inputs = self.processor(text=text, return_tensors="pt").to(self.device)
            
            # Generate speech
            speech = self.model.generate_speech(
                inputs["input_ids"],
                self.speaker_embeddings,
                vocoder=self.vocoder
            )
            
            end_time = time.time()
            print(f"SpeechT5 synthesis: '{text[:20]}...' (took {end_time - start_time:.2f}s)")
            
            # Convert to bytes
            speech_cpu = speech.cpu().numpy()
            buffer = io.BytesIO()
            sf.write(buffer, speech_cpu, self.model.config.sampling_rate, format='WAV')
            buffer.seek(0)
            return buffer.read()
            
        except Exception as e:
            print(f"Error in SpeechT5 synthesis: {e}")
            return None

# Try to initialize SpeechT5 model
speech_t5_model = None
if SPEECH_T5_AVAILABLE:
    try:
        speech_t5_model = SpeechT5Model()
    except Exception as e:
        print(f"Failed to initialize SpeechT5 model: {e}")
        SPEECH_T5_AVAILABLE = False

async def synthesize_speech(text: str, language: str = "en") -> bytes:
    """
    Convert text to speech audio data.
    
    Args:
        text: Text to convert to speech
        language: ISO language code
    
    Returns:
        Audio data as bytes
    """
    # Use SpeechT5 if available (best quality)
    if SPEECH_T5_AVAILABLE and speech_t5_model:
        print("Using SpeechT5 for text-to-speech synthesis")
        result = await asyncio.to_thread(speech_t5_model.synthesize, text)
        if result:
            return result
        print("SpeechT5 synthesis failed, falling back to other methods")
    
    # Fallback to other TTS methods
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
