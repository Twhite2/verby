import asyncio
import tempfile
import os
import io
import time
from typing import Optional, Dict, Any
import numpy as np
import soundfile as sf
import logging

# Set up logging
logger = logging.getLogger(__name__)

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


# Language-voice mapping for different TTS engines
# Maps language codes to appropriate voice configurations
LANGUAGE_VOICE_MAPPING = {
    # English voices
    "en": {
        "speaker_id": 7306,  # CMU Arctic - US English male
        "gender": "male",
        "name": "US English Male",
        "pyttsx3_id": "HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Speech\Voices\Tokens\TTS_MS_EN-US_DAVID_11.0"
    },
    "en-female": {
        "speaker_id": 7307,  # CMU Arctic - US English female
        "gender": "female",
        "name": "US English Female",
        "pyttsx3_id": "HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Speech\Voices\Tokens\TTS_MS_EN-US_ZIRA_11.0"
    },
    # European languages
    "fr": {
        "speaker_id": 6561,  # Selected from dataset
        "gender": "male",
        "name": "French Male"
    },
    "es": {
        "speaker_id": 6653,  # Selected from dataset
        "gender": "female",
        "name": "Spanish Female"
    },
    "de": {
        "speaker_id": 6308,  # Selected from dataset
        "gender": "male",
        "name": "German Male"
    },
    "it": {
        "speaker_id": 6441,  # Selected from dataset
        "gender": "female",
        "name": "Italian Female"
    },
    "pt": {
        "speaker_id": 6579,  # Selected from dataset
        "gender": "male",
        "name": "Portuguese Male"
    },
    # Asian languages
    "zh": {
        "speaker_id": 7015,  # Selected from dataset  
        "gender": "male",
        "name": "Chinese Male"
    },
    "ja": {
        "speaker_id": 7184,  # Selected from dataset
        "gender": "female",
        "name": "Japanese Female"
    },
    # Other languages
    "ru": {
        "speaker_id": 6903,  # Selected from dataset
        "gender": "male",
        "name": "Russian Male"
    },
    "ar": {
        "speaker_id": 6257,  # Selected from dataset
        "gender": "female",
        "name": "Arabic Female"
    },
    "yo": {  # Yoruba - using a similar tonal language voice profile
        "speaker_id": 6400,  # Selected as close match
        "gender": "male",
        "name": "Yoruba Male"
    },
    # Fallback for any other language
    "default": {
        "speaker_id": 7306,  # Default English voice
        "gender": "male",
        "name": "Default Male"
    }
}

class SpeechT5Model:
    """Enhanced class for high-quality multilingual text-to-speech using Microsoft's SpeechT5"""
    
    def __init__(self):
        """Initialize SpeechT5 models and load speaker embeddings"""
        # Use CUDA if available
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        logger.info(f"Using device {self.device} for SpeechT5")
        
        # Load the processor, model and vocoder
        self.processor = SpeechT5Processor.from_pretrained("microsoft/speecht5_tts")
        self.model = SpeechT5ForTextToSpeech.from_pretrained("microsoft/speecht5_tts").to(self.device)
        
        # Fix the sampling_rate missing attribute issue
        if not hasattr(self.model.config, 'sampling_rate'):
            logger.info("Setting default sampling_rate=16000 for SpeechT5 model config")
            self.model.config.sampling_rate = 16000
            
        self.vocoder = SpeechT5HifiGan.from_pretrained("microsoft/speecht5_hifigan").to(self.device)
        
        # Load speaker embeddings for all supported languages
        self.speaker_embeddings = {}
        self._load_speaker_embeddings()
    
    def _load_speaker_embeddings(self):
        """Load speaker embeddings for all supported languages"""
        try:
            # Load CMU Arctic dataset for speaker embeddings
            embeddings_dataset = load_dataset("Matthijs/cmu-arctic-xvectors", split="validation")
            
            # Load embeddings for each language in the mapping
            for lang_code, voice_config in LANGUAGE_VOICE_MAPPING.items():
                speaker_id = voice_config["speaker_id"]
                try:
                    # Get specific speaker embedding from dataset
                    embedding = torch.tensor(embeddings_dataset[speaker_id]["xvector"]).unsqueeze(0).to(self.device)
                    self.speaker_embeddings[lang_code] = embedding
                    logger.info(f"Loaded speaker embedding for {voice_config['name']} (language: {lang_code})")
                except Exception as e:
                    logger.warning(f"Could not load speaker {speaker_id} for {lang_code}: {e}")
                    # Fall back to default embedding
                    if "default" in self.speaker_embeddings:
                        self.speaker_embeddings[lang_code] = self.speaker_embeddings["default"]
                    else:
                        # Random embedding as last resort
                        self.speaker_embeddings[lang_code] = torch.randn(1, 512).to(self.device)
            
            # Ensure we have at least a default embedding
            if "default" not in self.speaker_embeddings:
                default_id = LANGUAGE_VOICE_MAPPING["default"]["speaker_id"]
                self.speaker_embeddings["default"] = torch.tensor(embeddings_dataset[default_id]["xvector"]).unsqueeze(0).to(self.device)
                
            logger.info(f"Successfully loaded {len(self.speaker_embeddings)} speaker embeddings")
            
        except Exception as e:
            logger.error(f"Error loading speaker embeddings: {e}")
            # Create a fallback random embedding if loading fails
            self.speaker_embeddings["default"] = torch.randn(1, 512).to(self.device)
            logger.warning("Using random speaker embeddings as fallback")
    
    def get_embedding_for_language(self, language_code: str):
        """Get the appropriate speaker embedding for a given language code"""
        # Try exact match first
        if language_code in self.speaker_embeddings:
            return self.speaker_embeddings[language_code]
        
        # Try language code without region
        base_lang = language_code.split('-')[0]
        if base_lang in self.speaker_embeddings:
            return self.speaker_embeddings[base_lang]
        
        # Fall back to default
        logger.warning(f"No speaker embedding for {language_code}, using default")
        return self.speaker_embeddings.get("default", self.speaker_embeddings.get("en", next(iter(self.speaker_embeddings.values()))))
    
    def synthesize(self, text: str, language: str = "en"):
        """Generate speech from text using SpeechT5 with language-specific voice"""
        try:
            start_time = time.time()
            
            # Get appropriate speaker embedding for the language
            speaker_embedding = self.get_embedding_for_language(language)
            
            # Process text input
            inputs = self.processor(text=text, return_tensors="pt").to(self.device)
            
            # Generate speech
            speech = self.model.generate_speech(
                inputs["input_ids"],
                speaker_embedding,
                vocoder=self.vocoder
            )
            
            end_time = time.time()
            logger.info(f"SpeechT5 synthesis in {language}: '{text[:20]}...' (took {end_time - start_time:.2f}s)")
            
            # Convert to bytes
            speech_cpu = speech.cpu().numpy()
            buffer = io.BytesIO()
            sf.write(buffer, speech_cpu, self.model.config.sampling_rate, format='WAV')
            buffer.seek(0)
            return buffer.read()
            
        except Exception as e:
            logger.error(f"Error in SpeechT5 synthesis: {e}")
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
    Convert text to speech audio data with multilingual support.
    
    Args:
        text: Text to convert to speech
        language: ISO language code (e.g., 'en', 'fr', 'es', 'zh')
    
    Returns:
        Audio data as bytes
    """
    # Skip synthesis for empty text
    if not text or not text.strip():
        logger.warning("Empty text provided for speech synthesis, returning silence")
        return _generate_silence(500)  # 500ms of silence
    
    # Normalize language code
    language = language.lower().strip()
    base_language = language.split('-')[0]  # Extract base language from locale codes like 'en-US'
    
    # Use SpeechT5 if available (best quality)
    if SPEECH_T5_AVAILABLE and speech_t5_model:
        logger.info(f"Using SpeechT5 for text-to-speech synthesis in {language}")
        result = await asyncio.to_thread(speech_t5_model.synthesize, text, language)
        if result:
            return result
        logger.warning("SpeechT5 synthesis failed, falling back to other methods")
    
    # Fallback to other TTS methods
    return await asyncio.to_thread(_synthesize_speech_sync, text, language)


def _synthesize_speech_sync(text: str, language: str) -> bytes:
    """Enhanced synchronous implementation of multilingual text-to-speech synthesis."""
    # Normalize language code for better compatibility
    base_language = language.split('-')[0].lower()  # e.g., convert 'en-US' to 'en'
    
    # Try gTTS first if available (good multilingual support)
    if GTTS_AVAILABLE:
        try:
            # Map to supported gTTS language code or fall back to English
            gtts_lang = _map_to_gtts_language(base_language)
            logger.info(f"Using gTTS for {language} (mapped to {gtts_lang})")
            
            with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as temp_file:
                tts = gTTS(text=text, lang=gtts_lang)
                tts.save(temp_file.name)
                
                # Convert the MP3 to raw audio bytes
                with open(temp_file.name, "rb") as audio_file:
                    audio_data = audio_file.read()
                
                # Delete the temporary file
                os.unlink(temp_file.name)
                
                return audio_data
        except Exception as e:
            logger.warning(f"gTTS error for {language}: {e}")
    
    # Fall back to pyttsx3 if available (Windows-native voices)
    if PYTTSX3_AVAILABLE:
        try:
            engine = pyttsx3.init()
            
            # Get all available voices
            voices = engine.getProperty('voices')
            
            # Try to find appropriate voice for the language
            voice_id = None
            voice_config = LANGUAGE_VOICE_MAPPING.get(base_language)
            
            if voice_config and 'pyttsx3_id' in voice_config:
                # Try to use the configured voice ID
                voice_id = voice_config['pyttsx3_id']
            else:
                # Find a voice containing the language code
                for voice in voices:
                    if base_language in voice.id.lower() or base_language in voice.name.lower():
                        voice_id = voice.id
                        break
            
            # Set voice if found, otherwise use default voice
            if voice_id:
                engine.setProperty('voice', voice_id)
                logger.info(f"Using pyttsx3 voice: {voice_id}")
            else:
                logger.warning(f"No specific voice found for {language}, using default")
            
            # Configure speech rate based on language
            # Some languages need slower rates for clarity
            speech_rates = {
                'zh': 120,  # Chinese needs slower rate
                'ja': 130,  # Japanese
                'ar': 140,  # Arabic
                'default': 150  # Default rate
            }
            engine.setProperty('rate', speech_rates.get(base_language, speech_rates['default']))
            
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
            logger.warning(f"pyttsx3 error for {language}: {e}")
    
    # If all else fails, generate a simple notification tone with language indicator
    return _generate_notification_tone(language)

def _generate_notification_tone(language: str) -> bytes:
    """Generate a notification tone with language-specific pitch"""
    try:
        # Generate a tone with pitch based on language for audible feedback
        sample_rate = 22050
        duration = 0.8  # seconds
        t = np.linspace(0, duration, int(sample_rate * duration), False)
        
        # Different base frequencies for different language families
        lang_freq = {
            'en': 440,   # English - A4
            'fr': 466,   # French - A#4
            'es': 494,   # Spanish - B4
            'de': 523,   # German - C5
            'it': 554,   # Italian - C#5
            'pt': 587,   # Portuguese - D5
            'zh': 622,   # Chinese - D#5
            'ja': 659,   # Japanese - E5
            'ru': 698,   # Russian - F5
            'ar': 740,   # Arabic - F#5
            'yo': 784    # Yoruba - G5
        }
        
        # Get base language
        base_lang = language.split('-')[0]
        frequency = lang_freq.get(base_lang, 440)  # Default to A4
        
        # Generate a short melody with the base frequency
        # This creates a distinctive pattern for each language
        tone = np.zeros(int(sample_rate * duration))
        
        # First note
        t1 = np.linspace(0, 0.3, int(sample_rate * 0.3), False)
        tone[:len(t1)] = np.sin(2 * np.pi * frequency * t1) * 0.3
        
        # Second note - higher pitch
        t2 = np.linspace(0, 0.3, int(sample_rate * 0.3), False)
        start_idx = int(sample_rate * 0.3)
        tone[start_idx:start_idx+len(t2)] = np.sin(2 * np.pi * (frequency * 1.2) * t2) * 0.25
        
        # Fade out
        fade_samples = int(sample_rate * 0.2)
        fade_out = np.linspace(1, 0, fade_samples)
        tone[-fade_samples:] = tone[-fade_samples:] * fade_out
        
        # Convert to bytes
        buffer = io.BytesIO()
        sf.write(buffer, tone, sample_rate, format='WAV')
        buffer.seek(0)
        return buffer.read()
    except Exception as e:
        logger.error(f"Error generating notification tone: {e}")
        return _generate_silence(500)  # Return 500ms silence as fallback

def _generate_silence(duration_ms: int = 500) -> bytes:
    """Generate silence of specified duration"""
    sample_rate = 16000
    duration_sec = duration_ms / 1000
    silence = np.zeros(int(sample_rate * duration_sec))
    
    buffer = io.BytesIO()
    sf.write(buffer, silence, sample_rate, format='WAV')
    buffer.seek(0)
    return buffer.read()

def _map_to_gtts_language(language: str) -> str:
    """Map language code to a compatible gTTS language code"""
    # Direct mapping for common languages
    gtts_map = {
        'en': 'en',
        'fr': 'fr',
        'es': 'es',
        'de': 'de',
        'it': 'it',
        'pt': 'pt',
        'zh': 'zh-CN',  # Default to Simplified Chinese
        'ja': 'ja',
        'ru': 'ru',
        'ar': 'ar',
        # For languages with no direct support:
        'yo': 'en',  # Yoruba - fall back to English
        # Add more mappings as needed
    }
    
    return gtts_map.get(language, 'en')  # Default to English if not found
