import asyncio
import os
import time
import tempfile
import speech_recognition as sr
from typing import Dict, Optional, Tuple, List
import io
import uuid
import base64
import soundfile as sf
import numpy as np
from datetime import datetime, timedelta
from pydub import AudioSegment
from app.config import settings
from pydub.utils import mediainfo
from queue import Queue

# Try to import optional dependencies
try:
    import openai
    from openai import OpenAI
    WHISPER_API_AVAILABLE = settings.OPENAI_API_KEY is not None
    if WHISPER_API_AVAILABLE:
        client = OpenAI(api_key=settings.OPENAI_API_KEY)
except ImportError:
    WHISPER_API_AVAILABLE = False

# Try to import whisper for local processing
WHISPER_LOCAL_AVAILABLE = False
try:
    import torch
    try:
        # First try to import the correct openai-whisper package
        import whisper
        # Check if it's the right whisper package by trying to access a known attribute
        if hasattr(whisper, 'load_model'):
            WHISPER_LOCAL_AVAILABLE = True
            print("OpenAI Whisper local model is available")
    except (ImportError, TypeError) as e:
        print(f"Error importing whisper: {e}")
        print("The installed whisper package might not be OpenAI's whisper. Try 'pip install openai-whisper' instead.")
        WHISPER_LOCAL_AVAILABLE = False
except ImportError:
    print("PyTorch not available, local whisper speech recognition disabled")
    WHISPER_LOCAL_AVAILABLE = False

# Initialize speech recognizer
recognizer = sr.Recognizer()


class WhisperLocalModel:
    """Class for handling speech recognition using local Whisper model"""
    
    def __init__(self, model_name="base"):
        if not WHISPER_LOCAL_AVAILABLE:
            raise ImportError("Whisper is not available. Install it with 'pip install whisper'")
            
        self.device = "cuda:0" if torch.cuda.is_available() else "cpu"
        print(f"Loading Whisper model {model_name} on {self.device}")
        self.audio_model = whisper.load_model(model_name, device=self.device)
        self.decoding_options = {"task": "translate"}
        
        # The last time a recording was processed
        self.phrase_time = datetime.utcnow()
        # Current raw audio bytes
        self.last_sample = bytes()
        
    def transcribe(self, audio_data, sample_rate=16000, sample_width=2):
        """Transcribe audio using local Whisper model"""
        try:
            # Convert audio data to format Whisper can use
            audio_obj = sr.AudioData(audio_data, sample_rate, sample_width)
            wav_data = io.BytesIO(audio_obj.get_wav_data())
            with sf.SoundFile(wav_data, mode='r') as sound_file:
                audio = sound_file.read(dtype='float32')
                
                # Process with Whisper
                start_time = time.time()
                result = self.audio_model.transcribe(
                    audio, 
                    fp16=torch.cuda.is_available(), 
                    **self.decoding_options
                )
                end_time = time.time()
                
                text = result['text'].strip()
                print(f"Whisper local transcription: '{text}' (took {end_time - start_time:.2f}s)")
                return text
        except Exception as e:
            print(f"Error during Whisper local transcription: {e}")
            return None

# Try to initialize the Whisper model if available
whisper_local = None
if WHISPER_LOCAL_AVAILABLE:
    try:
        whisper_local = WhisperLocalModel()
    except Exception as e:
        print(f"Failed to initialize Whisper local model: {e}")
        print(f"This is likely due to missing dependencies or incorrect whisper package.")
        print(f"Please install the correct package with: pip install openai-whisper")
        WHISPER_LOCAL_AVAILABLE = False

# Dictionary to store conversation sessions
# Each session has: last_timestamp, audio_buffer, transcript_history
conversation_sessions = {}

async def transcribe_audio(audio_data: bytes, language: str = "en", session_id: str = None) -> Dict:
    """
    Transcribe audio data to text, supporting continuous conversation.
    
    Args:
        audio_data: Raw audio bytes
        language: ISO language code
        session_id: Optional session ID for continuous conversation tracking
    
    Returns:
        Dictionary with transcription results and session info
    """
    # Generate a new session ID if none provided
    if not session_id:
        session_id = str(uuid.uuid4())
        print(f"Created new conversation session: {session_id}")
    
    # Initialize or update session
    now = datetime.utcnow()
    if session_id not in conversation_sessions:
        conversation_sessions[session_id] = {
            'last_timestamp': now,
            'audio_buffer': audio_data,
            'transcript_history': [],
            'is_final': False
        }
    else:
        # Check if we need to reset the session due to timeout
        session = conversation_sessions[session_id]
        if now - session['last_timestamp'] > timedelta(seconds=10):  # 10 second timeout
            print(f"Session {session_id} timed out, resetting buffer")
            session['audio_buffer'] = audio_data
            session['is_final'] = True  # Mark previous conversation as complete
        else:
            # Append new audio data
            session['audio_buffer'] += audio_data
        
        session['last_timestamp'] = now
    
    # Clean up old sessions (older than 5 minutes)
    _cleanup_old_sessions()
    
    # Get the current session
    session = conversation_sessions[session_id]
    
    # Choose transcription method
    if WHISPER_API_AVAILABLE and settings.OPENAI_API_KEY:
        print("Using OpenAI Whisper API for transcription")
        transcription_func = _transcribe_with_whisper_api
    elif WHISPER_LOCAL_AVAILABLE and whisper_local:
        print("Using local Whisper model for transcription")
        transcription_text = await asyncio.to_thread(whisper_local.transcribe, session['audio_buffer'])
        result = {'text': transcription_text, 'session_id': session_id}
        return result
    else:
        print("Falling back to local speech recognition")
        transcription_func = _transcribe_with_sr
    
    # Run the CPU-intensive task in a separate thread pool
    transcription_text = await asyncio.to_thread(
        transcription_func, 
        session['audio_buffer'], 
        language
    )
    
    if transcription_text:
        # Update session with new transcription
        if session.get('is_final', False):
            # Start fresh with new audio
            session['transcript_history'].append(transcription_text)
            session['is_final'] = False
        else:
            # Replace the last transcript with the updated one that includes new audio
            session['transcript_history'] = [transcription_text]
    
    # Return the result with session info
    result = {
        'text': transcription_text,
        'session_id': session_id,
        'is_final': session.get('is_final', False),
        'history': session.get('transcript_history', [])
    }
    return result


def _cleanup_old_sessions():
    """Remove conversation sessions that are older than 5 minutes"""
    now = datetime.utcnow()
    expired_sessions = [
        session_id for session_id, session in conversation_sessions.items()
        if now - session['last_timestamp'] > timedelta(minutes=5)
    ]
    
    for session_id in expired_sessions:
        print(f"Removing expired session {session_id}")
        del conversation_sessions[session_id]


def _transcribe_with_whisper_api(audio_data: bytes, language: str) -> Optional[str]:
    """Transcribe audio data using OpenAI's Whisper API with simplified direct approach."""
    # Check if API key is configured
    if not settings.OPENAI_API_KEY:
        print("WARNING: OPENAI_API_KEY is not set. Whisper API transcription will not work.")
        print("Set your OpenAI API key in the environment variable OPENAI_API_KEY")
        return None
        
    try:
        client = OpenAI(api_key=settings.OPENAI_API_KEY)
        print("Successfully initialized OpenAI client")
    except Exception as e:
        print(f"Error initializing OpenAI client: {str(e)}")
        return None
    
    # Performance tracking
    start_time = time.time()
    
    # Create a temporary file with .wav extension for OpenAI API
    temp_file = None
    temp_file_name = None
    try:
        temp_file = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        temp_file_name = temp_file.name
        temp_file.write(audio_data)
        temp_file.close()
        
        print(f"Created temporary file: {temp_file_name} with {len(audio_data)} bytes")
        # Direct API call using the temporary file
        try:
            print(f"Sending audio to OpenAI Whisper API for transcription...")
            
            with open(temp_file_name, "rb") as audio_file:
                # Simple direct transcription call with prompt for better context handling
                response = client.audio.transcriptions.create(
                    file=audio_file,
                    model="whisper-1",
                    language=language,
                    response_format="text"
                )
                # Extract the result
                transcript = response
                end_time = time.time()
                print(f"Whisper API transcription successful in {end_time - start_time:.2f}s")
                print(f"Transcript: '{transcript}'")
                
                return transcript.strip() if transcript else None
                
        except Exception as e:
            print(f"Error during Whisper API transcription: {str(e)}")
            return None
    finally:
        # Clean up temporary file
        try:
            if temp_file_name and os.path.exists(temp_file_name):
                os.unlink(temp_file_name)
                print(f"Removed temporary file: {temp_file_name}")
        except Exception as e:
            print(f"Error cleaning up temporary file: {str(e)}")


def _transcribe_with_sr(audio_data: bytes, language: str) -> Optional[str]:
    """Use SpeechRecognition library for transcription with multiple fallback options."""
    # Performance tracking
    start_time = time.time()
    print(f"Received audio data size for local SR: {len(audio_data)} bytes")
    
    # Create a temporary directory to store the files during conversion
    temp_dir = tempfile.mkdtemp()
    original_path = os.path.join(temp_dir, "original_audio")
    wav_path = os.path.join(temp_dir, "audio.wav")
    mp3_path = os.path.join(temp_dir, "audio.mp3")

    try:
        # Write the original audio to a file
        with open(original_path, 'wb') as f:
            f.write(audio_data)
        
        # Attempt multiple conversion methods for better speech recognition
        transcription = None
        errors = []

        # Method 1: Try direct ffmpeg conversion to WAV
        try:
            print("Attempt 1: Converting WebM to WAV with ffmpeg...")
            import subprocess
            subprocess.run(
                [
                    "ffmpeg", 
                    "-y",                # Overwrite output file
                    "-i", original_path, # Input file
                    "-ar", "16000",      # Sample rate: 16kHz
                    "-ac", "1",          # Mono channel
                    "-vn",               # No video
                    wav_path             # Output file
                ],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )
            
            # Try to recognize the converted audio
            with sr.AudioFile(wav_path) as source:
                audio_data_wav = recognizer.record(source)
                text = recognizer.recognize_google(audio_data_wav, language=language)
                print(f"Method 1 successful: '{text}'")
                return text
        except Exception as e:
            errors.append(f"Method 1 failed: {str(e)}")
            print(errors[-1])

        # Method 2: Try pydub conversion with multiple sample rates
        try:
            print("Attempt 2: Converting with pydub with multiple sample rates...")
            from pydub import AudioSegment
            
            # Try different sample rates
            for sample_rate in [16000, 44100, 48000]:
                try:
                    # Try loading as WebM
                    audio = AudioSegment.from_file(original_path, format="webm")
                    audio = audio.set_frame_rate(sample_rate).set_channels(1)
                    audio.export(wav_path, format="wav")
                    
                    with sr.AudioFile(wav_path) as source:
                        audio_data_wav = recognizer.record(source)
                        text = recognizer.recognize_google(audio_data_wav, language=language)
                        print(f"Method 2 successful with sample rate {sample_rate}: '{text}'")
                        return text
                except Exception as inner_e:
                    print(f"Sample rate {sample_rate} failed: {str(inner_e)}")
                    continue
        except Exception as e:
            errors.append(f"Method 2 failed: {str(e)}")
            print(errors[-1])
        
        # Method 3: Try direct recognition from data with different sample rates
        try:
            print("Attempt 3: Raw audio data recognition...")
            import io
            import wave
            import struct
            
            # Try different sample rates for raw PCM data
            for sample_rate in [16000, 44100, 48000]:
                try:
                    # Extract PCM data and create WAV header
                    # This specifically targets browser WebM data with Opus
                    if len(audio_data) > 1000:  # Ensure enough data
                        # Skip potential WebM header and get raw PCM data
                        offset = 1000  # Skip header bytes
                        pcm_data = audio_data[offset:]
                        
                        # Create WAV with proper header
                        with wave.open(wav_path, 'wb') as wav_file:
                            wav_file.setnchannels(1)  # Mono
                            wav_file.setsampwidth(2)  # 16-bit
                            wav_file.setframerate(sample_rate)
                            wav_file.writeframes(pcm_data)
                        
                        # Try recognition
                        with sr.AudioFile(wav_path) as source:
                            audio_data_wav = recognizer.record(source)
                            text = recognizer.recognize_google(audio_data_wav, language=language)
                            print(f"Method 3 successful with sample rate {sample_rate}: '{text}'")
                            return text
                except Exception as inner_e:
                    print(f"Raw PCM attempt with rate {sample_rate} failed: {str(inner_e)}")
                    continue
        except Exception as e:
            errors.append(f"Method 3 failed: {str(e)}")
            print(errors[-1])
        
        # If we got here, all attempts failed
        print(f"All recognition attempts failed after {time.time() - start_time:.2f} seconds")
        return None
                
    except Exception as e:
        print(f"Error in local speech recognition: {str(e)}")
        return None
    finally:
        # Clean up temporary files
        try:
            import shutil
            shutil.rmtree(temp_dir, ignore_errors=True)
        except Exception as e:
            print(f"Error cleaning up temporary directory: {e}")
            pass
