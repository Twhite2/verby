import asyncio
import tempfile
import subprocess
import os
import time
import io
import traceback
from typing import Dict, Optional, List, Any, Tuple
from datetime import datetime
import numpy as np
import array
import base64
import soundfile as sf
import wave
import subprocess
from datetime import datetime, timedelta
from pydub import AudioSegment
from app.config import settings
from pydub.utils import mediainfo
from queue import Queue

# Import SpeechRecognition
try:
    import speech_recognition as sr
    SPEECH_RECOGNITION_AVAILABLE = True
except ImportError:
    SPEECH_RECOGNITION_AVAILABLE = False
    print("SpeechRecognition not available, some fallback methods will be disabled")

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

# Initialize speech recognizer if available
recognizer = None
if SPEECH_RECOGNITION_AVAILABLE:
    try:
        recognizer = sr.Recognizer()
        print("SpeechRecognition recognizer initialized")
    except Exception as e:
        print(f"Failed to initialize SpeechRecognition: {e}")
        SPEECH_RECOGNITION_AVAILABLE = False

class WhisperLocalModel:
    """Class for handling speech recognition using local Whisper model"""
    
    def __init__(self, model_name="base"):
        if not WHISPER_LOCAL_AVAILABLE:
            raise ImportError("Whisper is not available. Install it with 'pip install whisper'")
            
        self.device = "cuda:0" if torch.cuda.is_available() else "cpu"
        print(f"Loading Whisper model {model_name} on {self.device}")
        self.audio_model = whisper.load_model(model_name, device=self.device)
        
    def transcribe(self, audio_data, sample_rate=16000, sample_width=2):
        """Transcribe audio data using the local Whisper model
        Handles various audio formats by detecting and converting as needed"""
        try:
            # Detect audio format for correct processing
            format_detected = _detect_audio_format(audio_data)
            if format_detected is None:
                print("Warning: Could not detect audio format, defaulting to webm")
                format_detected = 'webm'  # Default to webm if detection fails
            print(f"Detected audio format: {format_detected}")
            
            # Create temporary files for processing
            with tempfile.NamedTemporaryFile(suffix=f".{format_detected}", delete=False) as temp_file:
                input_path = temp_file.name
                temp_file.write(audio_data)
                temp_file.flush()
            
            # If the format is not directly compatible, convert it
            if format_detected not in ['wav', 'mp3']:
                print(f"Converting {format_detected} for local Whisper model")
                wav_path = input_path + ".wav"
                
                try:
                    # Use FFmpeg for reliable conversion
                    subprocess.run([
                        'ffmpeg',
                        '-i', input_path,
                        '-ar', str(sample_rate),
                        '-ac', '1',  # Mono for better transcription
                        '-y',
                        wav_path
                    ], check=True, capture_output=True)
                    
                    # Load the converted audio file
                    audio_array, sr = sf.read(wav_path)
                    print(f"Successfully converted audio for Whisper local model, length: {len(audio_array)}")
                except Exception as e:
                    print(f"FFmpeg conversion failed: {e}, trying direct audio processing")
                    # Fall back to direct processing
                    audio_obj = sr.AudioData(audio_data, sample_rate, sample_width)
                    wav_data = io.BytesIO(audio_obj.get_wav_data())
                    with sf.SoundFile(wav_data, mode='r') as sound_file:
                        audio_array = sound_file.read(dtype='float32')
                finally:
                    # Clean up temporary files
                    if os.path.exists(wav_path):
                        os.unlink(wav_path)
            else:
                # For WAV or MP3 formats, process directly
                try:
                    audio_array, sr = sf.read(input_path)
                    print(f"Direct audio processing, length: {len(audio_array)}")
                except Exception as direct_error:
                    print(f"Direct audio processing failed: {direct_error}, trying AudioData conversion")
                    # Fall back to AudioData conversion
                    audio_obj = sr.AudioData(audio_data, sample_rate, sample_width)
                    wav_data = io.BytesIO(audio_obj.get_wav_data())
                    with sf.SoundFile(wav_data, mode='r') as sound_file:
                        audio_array = sound_file.read(dtype='float32')
            
            # Clean up input file
            if os.path.exists(input_path):
                os.unlink(input_path)
            
            # Transcribe using the local Whisper model
            result = self.audio_model.transcribe(audio_array, fp16=torch.cuda.is_available())
            return result['text'].strip()
            
        except Exception as e:
            print(f"Error in local Whisper transcription: {e}")
            # Try one more time with direct processing as last resort
            try:
                audio_obj = sr.AudioData(audio_data, sample_rate, sample_width)
                wav_data = io.BytesIO(audio_obj.get_wav_data())
                with sf.SoundFile(wav_data, mode='r') as sound_file:
                    audio = sound_file.read(dtype='float32')
                    result = self.audio_model.transcribe(audio, fp16=torch.cuda.is_available())
                    return result['text'].strip()
            except Exception as last_error:
                print(f"Final transcription attempt failed: {last_error}")
                return ""

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
# Structure:
# {
#     'session_id': {
#         'buffer': bytes,           # Audio buffer
#         'last_activity': timestamp, # Last activity timestamp
#         'silence_frames': int,      # Consecutive silence frames
#         'speech_detected': bool,    # Flag if speech was detected
#         'header': bytes,           # Stored header information from first successful chunk
#         'header_extracted': bool    # Whether header has been extracted
#     }
# }
transcription_sessions = {}

def _get_or_create_session(session_id: Optional[str]) -> Tuple[str, Dict[str, Any]]:
    """
    Get an existing transcription session or create a new one.
    
    Args:
        session_id: Existing session ID or None for a new session
        
    Returns:
        Tuple of (session_id, session_data)
    """
    now = time.time()  # Use float timestamp consistently throughout the codebase
    
    # First, clean up old sessions periodically
    _purge_expired_sessions()
    
    # If no session_id is provided or it's not in the sessions dict, create a new one
    if session_id is None or session_id not in transcription_sessions:
        # Generate a new session ID based on timestamp
        new_session_id = f"session_{int(time.time() * 1000)}"
        print(f"Created new transcription session: {new_session_id}")
        
        # Initialize session with empty buffer and current timestamp
        transcription_sessions[new_session_id] = {
            'audio_buffer': bytearray(),  # Empty buffer
            'format_detected': None,
            'last_activity': now,  # Current time as float timestamp
            'transcript_history': [],
            'speech_detected': False,  # No speech detected yet
            'silence_frames': 0,  # No silence frames yet
            'speech_frames': 0,       # Count consecutive speech frames
            'recent_energy': [],       # Store recent audio energy levels for adaptive thresholds
            'header': bytes(),  # Empty header initially
            'header_extracted': False  # No header extracted yet
        }
        return new_session_id, transcription_sessions[new_session_id]
    
    # Update activity timestamp for existing session
    transcription_sessions[session_id]['last_activity'] = now
    
    return session_id, transcription_sessions[session_id]

# Constants for audio processing
MIN_BUFFER_SIZE = 35000  # Minimum buffer size in bytes to attempt transcription (35KB gives better results)
SESSION_TIMEOUT = 30.0  # Seconds of inactivity before session expires
MAX_HISTORY_LENGTH = 10  # Maximum number of utterances to keep in history
MAX_BUFFER_SIZE = 60000  # Maximum buffer size before forcing transcription (increased for better quality)
SILENCE_THRESHOLD = 0.015  # Amplitude threshold for silence detection
MIN_SPEECH_FRAMES = 3  # Minimum speech frames before considering it actual speech
MIN_SILENCE_FRAMES = 5  # Minimum silence frames to consider a pause

def detect_silence(audio_data: bytes, threshold: float = SILENCE_THRESHOLD, sample_width: int = 2) -> bool:
    """
    Detect if audio chunk contains silence based on amplitude threshold.
    
    Args:
        audio_data: Raw audio bytes to analyze
        threshold: Energy threshold below which is considered silence (0.0-1.0)
        sample_width: Audio sample width in bytes
        
    Returns:
        True if the audio contains silence, False otherwise
    """
    if not audio_data or len(audio_data) < 100:  # Need minimal data to analyze
        return True
    
    try:
        # Make sure audio data length is appropriate for the array type
        # We'll examine just a portion of the data if needed
        sample_size = 500  # Analyze at most 500 samples for speed
        
        # Check audio format and handle WebM or other compressed formats
        if audio_data[:4] == b'\x1a\x45\xdf\xa3' or _detect_audio_format(audio_data) != 'unknown':  
            # This is likely WebM or another compressed format, not raw PCM
            # For compressed formats, just check if there's enough variation in bytes
            byte_values = [audio_data[i] for i in range(0, min(len(audio_data), sample_size))]
            variation = max(byte_values) - min(byte_values) if byte_values else 0
            return variation < (255 * threshold)  # Simple heuristic for compressed audio
        
        # For raw PCM, make sure length is compatible with sample width
        usable_length = (len(audio_data) // sample_width) * sample_width
        if usable_length == 0:
            return True  # Not enough data for analysis
        
        # Truncate to usable length
        usable_data = audio_data[:usable_length]
        
        # Convert bytes to array of integers based on sample width
        if sample_width == 2:  # 16-bit audio
            audio_array = array.array('h', usable_data)  # 16-bit signed integers
        elif sample_width == 1:  # 8-bit audio
            audio_array = array.array('b', usable_data)  # 8-bit signed integers
        else:
            # Fallback to simple byte inspection
            audio_array = array.array('B', usable_data)  # unsigned bytes
        
        # Sample the array if it's large
        if len(audio_array) > sample_size:
            step = len(audio_array) // sample_size
            sampled_array = [audio_array[i] for i in range(0, len(audio_array), step)]
            if len(sampled_array) > sample_size:
                sampled_array = sampled_array[:sample_size]
        else:
            sampled_array = audio_array
            
        # Calculate energy (average amplitude) as proportion of max value
        max_value = 32768 if sample_width == 2 else 128  # Max for 16-bit or 8-bit
        values = [abs(x) for x in sampled_array]
        energy = sum(values) / len(values) / max_value if values else 0
        
        # Return True if below threshold (is silence)
        return energy < threshold
    except Exception as e:
        print(f"Error in silence detection: {e}")
        # If we can't analyze, assume it's not silence to be safe
        return False  # Default to not silence on error

def _purge_expired_sessions():
    """Remove expired transcription sessions to avoid memory leaks"""
    global transcription_sessions
    current_time = time.time()
    expired_sessions = []
    
    for session_id, session in transcription_sessions.items():
        if current_time - session.get('last_activity', 0) > SESSION_TIMEOUT:
            expired_sessions.append(session_id)
    
    for session_id in expired_sessions:
        print(f"Removing expired session {session_id}")
        del transcription_sessions[session_id]

# Track FFmpeg availability to avoid repeated checks
ffmpeg_available = None

def _check_ffmpeg_available() -> bool:
    """Check if FFmpeg is available on the system"""
    try:
        subprocess.run(['ffmpeg', '-version'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    except (subprocess.SubprocessError, FileNotFoundError):
        return False

async def transcribe_audio(audio_data: bytes, session_id: Optional[str] = None, language: str = 'en', sample_rate: int = 16000, sample_width: int = 2) -> dict:
    """
    Transcribe audio data, maintaining state across multiple calls for continuous transcription.
    Uses smart chunking based on voice activity detection for better natural language boundaries.
    
    Args:
        audio_data: Audio bytes to transcribe
        session_id: Optional session ID for continuous transcription
        language: ISO language code for transcription
        sample_rate: Audio sample rate in Hz
        sample_width: Audio sample width in bytes
        
    Returns:
        Dictionary with transcription result and session info
    """
    global transcription_sessions
    global ffmpeg_available
    
    session_id, session = _get_or_create_session(session_id)
    
    # Detect format of incoming audio data for header extraction
    detected_format = _detect_audio_format(audio_data)
    print(f"Detected audio format of incoming chunk: {detected_format}")
    
    # Header extraction logic for first chunk with valid headers
    if not session['header_extracted'] and detected_format in ['webm', 'ogg']:
        print(f"First chunk with {detected_format} format detected, extracting header")
        # Extract header from the first chunk (first 1024 bytes should contain all header info)
        header_size = min(1024, len(audio_data))
        session['header'] = audio_data[:header_size]
        session['header_extracted'] = True
        session['format_detected'] = detected_format
        print(f"Extracted {len(session['header'])} bytes of {detected_format} header information")
    
    # For subsequent chunks that need headers
    if session['header_extracted'] and len(session['header']) > 0:
        # Check if this chunk likely needs the header (subsequent chunks usually lack headers)
        if detected_format == 'browser_pcm' or detected_format == 'unknown' or not _has_valid_header(audio_data):
            print(f"Prepending stored {session['format_detected']} header ({len(session['header'])} bytes) to audio chunk")
            # Create composite audio by prepending the stored header
            audio_data = session['header'] + audio_data
    
    # Extract data for PCM buffer and append to existing buffer
    pcm_data = _extract_pcm_data(audio_data)
    if pcm_data:
        session['audio_buffer'].extend(pcm_data)
    
    # Perform voice activity detection on the new audio
    is_silence = detect_silence(audio_data, SILENCE_THRESHOLD, sample_width)
    
    # Update speech/silence tracking in session
    if is_silence:
        session['silence_frames'] += 1
        session['speech_frames'] = 0
    else:
        session['speech_frames'] += 1
        if session['speech_frames'] >= MIN_SPEECH_FRAMES:
            session['speech_detected'] = True
            session['silence_frames'] = 0
            
    # Get current buffer size
    buffer_size = len(session['audio_buffer'])
    print(f"Audio buffer size now: {buffer_size} bytes, Silence: {is_silence}, Speech detected: {session['speech_detected']}")
    
    # Determine if we should process the audio based on:  
    # 1. Natural pause detected after speech
    # 2. Buffer getting too large
    # 3. Buffer has minimum required size
    should_process = False
    
    # Case 1: Natural pause detected after active speech
    if session['speech_detected'] and session['silence_frames'] >= MIN_SILENCE_FRAMES and buffer_size >= MIN_BUFFER_SIZE:
        print(f"Natural pause detected after speech, processing audio chunk ({buffer_size} bytes)")
        should_process = True
    
    # Case 2: Buffer getting too large
    elif buffer_size >= MAX_BUFFER_SIZE:
        print(f"Buffer reached maximum size ({buffer_size} bytes), processing audio")
        should_process = True
    
    # Skip processing if conditions aren't met
    if not should_process:
        if buffer_size < MIN_BUFFER_SIZE:
            print(f"Buffer too small ({buffer_size} bytes), waiting for more audio")
        return {'text': '', 'session_id': session_id, 'is_final': False, 'history': session.get('transcript_history', [])}
    
    # Save speech detection state before resetting
    speech_detected_before_reset = session['speech_detected']
    
    # Prepare audio for transcription
    audio_to_transcribe = bytes(session['audio_buffer'])
    format_detected = session['format_detected']
    transcription_text = None
    temp_files = []
    
    try:
        # Direct transcription path - try sending audio directly first for WebM when FFmpeg isn't available
        if format_detected == 'webm' and not _is_ffmpeg_available():
            print("FFmpeg not available. Trying direct WebM transcription.")
            # Try direct transcription with original WebM audio
            if WHISPER_API_AVAILABLE and settings.OPENAI_API_KEY:
                print("Using OpenAI Whisper API for direct WebM transcription")
                transcription_text = _transcribe_with_whisper_api(audio_to_transcribe, language)
                if transcription_text:
                    print("Direct WebM transcription successful")
            
        # FFmpeg conversion path (if available and direct didn't work) 
        if (transcription_text is None and _is_ffmpeg_available()):
            # Ensure we have a valid format for the file extension
            file_extension = format_detected if format_detected and format_detected != 'unknown' else 'webm'
            print(f"Using file extension: .{file_extension} for temporary file")
            
            # Create a temporary file for the audio
            with tempfile.NamedTemporaryFile(suffix=f".{file_extension}", delete=False) as temp_file:
                input_path = temp_file.name
                temp_file.write(audio_to_transcribe)
                temp_files.append(input_path)
            
            # Convert to WAV using FFmpeg (better compatibility than MP3)
            output_path = f"{input_path}.wav"
            temp_files.append(output_path)
            
            print(f"Converting audio from {format_detected} to WAV using FFmpeg")
            # For browser audio (WebRTC), use 48kHz as source rate for better quality
            input_sample_rate = '48000' if format_detected in ['webm', 'browser_pcm'] else '16000'
            
            ffmpeg_cmd = [
                'ffmpeg', 
                '-i', input_path,
                '-ar', '16000',  # Set output to 16kHz for Whisper
                '-ac', '1',      # Convert to mono
                '-c:a', 'pcm_s16le',  # 16-bit PCM
                '-y',            # Overwrite output file if exists
                output_path
            ]
            
            # Make sure we have a valid format for processing
            safe_format = format_detected if format_detected else 'webm'
            
            # If dealing with raw PCM data, specify input format parameters
            if safe_format == 'browser_pcm':
                ffmpeg_cmd = [
                    'ffmpeg',
                    '-f', 's16le',  # 16-bit signed little endian format
                    '-ar', input_sample_rate,  # 48kHz for browser WebRTC
                    '-ac', '1',    # Assume mono
                    '-i', input_path,
                    '-ar', '16000', # Convert to 16kHz for Whisper
                    '-c:a', 'pcm_s16le',
                    '-y', output_path
                ]
            
            try:
                subprocess.run(ffmpeg_cmd, check=True, capture_output=True)
                    
                # Read the converted audio
                if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
                    with open(output_path, 'rb') as f:
                        converted_audio = f.read()
                        print(f"Successfully converted to {len(converted_audio)} bytes of WAV")
                        
                        # Choose transcription method
                        if WHISPER_API_AVAILABLE and settings.OPENAI_API_KEY:
                            print("Using OpenAI Whisper API for transcription")
                            transcription_text = _transcribe_with_whisper_api(converted_audio, language)
                        elif WHISPER_LOCAL_AVAILABLE and whisper_local:
                            print("Using local Whisper model for transcription")
                            transcription_text = await asyncio.to_thread(whisper_local.transcribe, converted_audio)
                        else:
                            print("Using SpeechRecognition library for transcription")
                            transcription_text = await asyncio.to_thread(_transcribe_with_sr, converted_audio, language)
                else:
                    print("FFmpeg conversion produced no output")
                        
            except subprocess.CalledProcessError as e:
                print(f"FFmpeg conversion error: {e.stderr if hasattr(e, 'stderr') else str(e)}")
                # We'll handle this with the fallback below
        
        # Fallback path if the above methods failed
        if transcription_text is None:
            print("Falling back to direct audio transcription")
            if WHISPER_API_AVAILABLE and settings.OPENAI_API_KEY:
                transcription_text = _transcribe_with_whisper_api(audio_to_transcribe, language)
            elif WHISPER_LOCAL_AVAILABLE and whisper_local:
                transcription_text = await asyncio.to_thread(whisper_local.transcribe, audio_to_transcribe)
            else:
                transcription_text = await asyncio.to_thread(_transcribe_with_sr, audio_to_transcribe, language)
                
    except Exception as e:
        print(f"Error in audio transcription pipeline: {e}")
        traceback.print_exc()
        # Last resort attempt
        try:
            if WHISPER_API_AVAILABLE and settings.OPENAI_API_KEY:
                transcription_text = _transcribe_with_whisper_api(audio_to_transcribe, language)
        except Exception as final_e:
            print(f"Final transcription attempt failed: {final_e}")
    finally:
        # Clean up temp files
        for file_path in temp_files:
            try:
                if os.path.exists(file_path):
                    os.unlink(file_path)
                    print(f"Removed temporary file: {file_path}")
            except Exception as e:
                print(f"Error cleaning up temp file {file_path}: {e}")
    
    if transcription_text:
        # Add to transcript history with timestamp - use float timestamp for consistency
        transcript_entry = {
            'text': transcription_text,
            'timestamp': time.time(),  # Use float timestamp consistently
            'formatted_time': datetime.now().isoformat(),  # Keep formatted time for display purposes
        }
        session['transcript_history'].append(transcript_entry)
        
        # Limit history size
        if len(session['transcript_history']) > MAX_HISTORY_LENGTH:
            session['transcript_history'] = session['transcript_history'][-MAX_HISTORY_LENGTH:]
        
        # COMPLETELY reset buffer for next utterance when we have a successful final transcription
        print(f"Successfully transcribed audio, clearing buffer of {len(session['audio_buffer'])} bytes")
        session['audio_buffer'] = bytearray()
        # Reset speech detection state too since we've completed this utterance
        session['speech_detected'] = False
        session['speech_frames'] = 0
        session['silence_frames'] = 0
        # Reset the session timestamp to prevent timeout/expiration during active conversation
        session['last_activity'] = time.time()  # Fix: last_activity, not last_active
        
        return {
            'text': transcription_text,
            'session_id': session_id,
            'is_final': True,
            'history': session['transcript_history'],
            'speech_detected': session['speech_detected']
        }
    else:
        # Keep buffer for next attempt if no transcription
        # But trim if it's getting too large to prevent memory issues
        if len(session['audio_buffer']) > MAX_BUFFER_SIZE * 1.5:
            print(f"Trimming oversized buffer ({len(session['audio_buffer'])} bytes)")
            session['audio_buffer'] = session['audio_buffer'][-MAX_BUFFER_SIZE:]
            
        return {
            'text': '',
            'session_id': session_id,
            'is_final': False,
            'history': session['transcript_history'],
            'speech_detected': session['speech_detected']
        }

def _has_valid_header(audio_data: bytes) -> bool:
    """
    Check if audio data contains valid header information.
    This function checks for common audio format headers to determine
    if the chunk has proper container information.
    
    Args:
        audio_data: Audio bytes to check for headers
        
    Returns:
        True if valid header detected, False otherwise
    """
    if not audio_data or len(audio_data) < 12:
        return False
        
    # Check for WAV header (RIFF....WAVE)
    if audio_data[:4] == b'RIFF' and audio_data[8:12] == b'WAVE':
        return True
    
    # Check for MP3 header (ID3)
    if audio_data[:3] == b'ID3':
        return True
    
    # Check for OGG format
    if audio_data[:4] == b'OggS':
        return True
    
    # EBML header check for WebM or MKV
    if len(audio_data) >= 4 and audio_data[0] == 0x1A and audio_data[1] == 0x45 and audio_data[2] == 0xDF and audio_data[3] == 0xA3:
        return True
    
    # Check for FLAC header
    if audio_data[:4] == b'fLaC':
        return True
        
    # Check for specific codec markers
    if b'OpusHead' in audio_data[:100] or b'OpusTags' in audio_data[:100]:
        return True
    
    # No valid header detected
    return False

def _detect_audio_format(audio_data: bytes) -> str:
    """
    Detect the audio format from raw bytes by examining magic bytes/headers.
    Returns a string indicating the detected format ('wav', 'mp3', 'webm', etc.)
    Never returns None - defaults to 'browser_pcm' for browser chunks if detection fails
    """
    if not audio_data:
        print("Warning: Empty audio data, defaulting to webm format")
        return 'webm'  # Default to webm instead of unknown
        
    # Check for WAV header (RIFF....WAVE)
    if len(audio_data) > 12 and audio_data[:4] == b'RIFF' and audio_data[8:12] == b'WAVE':
        print("Detected WAV format from header")
        return 'wav'
    
    # Check for MP3 header (ID3)
    if len(audio_data) > 3 and audio_data[:3] == b'ID3':
        print("Detected MP3 format from ID3 header")
        return 'mp3'
    
    # Check for MP3 without ID3 header (directly starts with frame sync)
    if len(audio_data) >= 2 and (audio_data[0] == 0xFF and (audio_data[1] & 0xE0) == 0xE0):
        print("Detected MP3 format from frame sync pattern")
        return 'mp3'
    
    # EBML header check for WebM or MKV
    if len(audio_data) >= 4 and audio_data[0] == 0x1A and audio_data[1] == 0x45 and audio_data[2] == 0xDF and audio_data[3] == 0xA3:
        print("Detected WebM/MKV format from EBML header")
        return 'webm'
        
    # Check for OGG format (better handling for streaming OGG/Opus format from browser)
    if len(audio_data) > 4 and audio_data[:4] == b'OggS':
        print(f"Detected OGG format ({len(audio_data)} bytes)")
        return 'ogg'
    
    # Check for FLAC header
    if len(audio_data) > 4 and audio_data[:4] == b'fLaC':
        print("Detected FLAC format from header")
        return 'flac'
    
    # If no header detected, try to analyze content statistically
    try:
        import numpy as np
        import struct
        
        # Size-based heuristics first for browser audio chunks
        # WebRTC audio chunks typically come in consistent sizes around 14-18KB
        if 12000 <= len(audio_data) <= 20000:
            print(f"Chunk size {len(audio_data)} bytes matches typical browser WebRTC chunk")
            # This is almost certainly browser PCM from WebRTC
            return 'browser_pcm'
            
        # Check for Float32Array from the browser (first 1000 samples)
        if len(audio_data) >= 400:  # At least 100 float32 values (4 bytes each)
            sample_count = min(250, len(audio_data) // 4)  # 4 bytes per float32
            try:
                float_values = struct.unpack(f'{sample_count}f', audio_data[:sample_count*4])
                
                # Float32 PCM typically has values between -1.0 and 1.0
                if all(-1.5 < val < 1.5 for val in float_values):
                    print("Detected Float32Array audio from browser")
                    return 'browser_float32'
            except struct.error:
                # Not valid float32 data, continue with other detection methods
                pass
        
        # Check for 16-bit PCM data if it's not float32
        if len(audio_data) >= 1000:
            values_array = np.frombuffer(audio_data[:1000], dtype=np.int16)
            # Use statistical properties to identify PCM (has certain variance characteristics)
            if np.std(values_array) > 100 and np.std(values_array) < 15000:
                print("Detected 16-bit PCM audio data")
                return 'browser_pcm'
    except Exception as e:
        print(f"Error during audio statistical analysis: {e}")
        # Fall through to size-based detection
        if 12000 <= len(audio_data) <= 20000:
            return 'browser_pcm'    # Attempt more aggressive detection for OGG format - some OGG files don't start with 'OggS'
    # but still contain Opus codec data or have OGG structures
    if len(audio_data) > 100:
        try:
            if b'OpusHead' in audio_data[:1000] or b'OpusTags' in audio_data[:1000]:
                print(f"Detected OGG/Opus codec markers ({len(audio_data)} bytes)")
                return 'ogg'
        except Exception as e:
            print(f"Error in Opus marker detection: {e}")
    
    # If all detection methods fail, analyze the data size to make a better guess
    if 12000 <= len(audio_data) <= 50000:
        # These are likely browser audio chunks - we should treat as raw PCM for better results
        print(f"Unidentified audio format of typical browser chunk size ({len(audio_data)} bytes), treating as raw PCM")
        return 'browser_pcm'
    else:
        # Larger chunks with no identifiable format - try as OGG since that's our preferred format now
        print(f"No identifiable audio format ({len(audio_data)} bytes), trying as OGG/Opus first")
        return 'ogg'

def _extract_pcm_data(audio_data: bytes) -> bytes:
    """
    Extract PCM data from audio bytes for buffering.
    """
    if not audio_data:
        return b''
    
    # For simplicity in continuous speech, just return the raw bytes
    # We'll handle format conversion properly when sending to Whisper
    return audio_data

def _create_wav_from_pcm(pcm_data: bytes, sample_rate: int = 48000, sample_width: int = 2) -> bytes:
    """
    Create a proper WAV file from raw audio data for Whisper API.
    Supports conversion from raw PCM, Float32Array from browser, and other formats.
    """
    try:
        if not pcm_data:
            print("No audio data provided")
            return b''
        
        # Check audio format to determine proper conversion method
        format_type = _detect_audio_format(pcm_data)
        print(f"Creating WAV from {len(pcm_data)} bytes of {format_type} data")
        
        # Default to 48kHz for browser audio (WebRTC standard) but allow override
        if format_type in ['browser_float32', 'browser_pcm']:
            sample_rate = 48000  # WebRTC standard for browser audio
                
        # For browser Float32 data (common from Web Audio API)
        if format_type == 'browser_float32':
            import struct
            import numpy as np
            
            # Convert Float32Array to 16-bit PCM
            print("Converting Float32 browser audio to 16-bit PCM for WAV")
            try:
                # Parse float32 values
                float_count = len(pcm_data) // 4
                float_values = struct.unpack(f'{float_count}f', pcm_data)
                
                # Convert to 16-bit PCM range (-32768 to 32767)
                pcm_values = [int(max(-32768, min(32767, v * 32767.0))) for v in float_values]
                
                # Pack as 16-bit PCM
                pcm_data = struct.pack(f'{len(pcm_values)}h', *pcm_values)
                
                print(f"Successfully converted {float_count} Float32 samples to 16-bit PCM")
            except Exception as e:
                print(f"Float32 conversion failed: {e}, will try to use as-is")
        
        # Direct in-memory conversion (most reliable approach)
        try:
            wav_io = io.BytesIO()
            with wave.open(wav_io, 'wb') as wav_file:
                wav_file.setnchannels(1)  # Mono
                wav_file.setsampwidth(sample_width)  # Sample width (2 bytes = 16-bit)
                wav_file.setframerate(sample_rate)  # Sample rate (48kHz for browser audio, 16kHz for others)
                
                # Make sure pcm_data length is compatible with sample width
                usable_length = (len(pcm_data) // sample_width) * sample_width
                if usable_length < len(pcm_data):
                    print(f"Truncating {len(pcm_data) - usable_length} bytes for proper PCM alignment")
                
                wav_file.writeframes(pcm_data[:usable_length])
            
            wav_io.seek(0)
            wav_bytes = wav_io.read()
            
            if len(wav_bytes) > 0:
                print(f"Successfully created {len(wav_bytes)} bytes of WAV data in memory")
                return wav_bytes
            else:
                print("In-memory WAV creation resulted in 0 bytes, trying file-based approach")
        except Exception as e:
            print(f"In-memory WAV creation failed: {e}, trying file-based approach")
        
        # File-based approach as fallback
        # Create temporary files with .raw and .wav extensions
        raw_file = tempfile.NamedTemporaryFile(suffix=".raw", delete=False)
        wav_file = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        
        raw_path = raw_file.name
        wav_path = wav_file.name
        
        # Close files so they can be accessed by subprocess
        raw_file.close()
        wav_file.close()
        
        print(f"Created temporary files: raw={raw_path}, wav={wav_path}")
        
        # Write PCM data to raw file
        with open(raw_path, 'wb') as f:
            f.write(pcm_data)
            print(f"Wrote {len(pcm_data)} bytes to raw file")
        
        if not os.path.exists(raw_path) or os.path.getsize(raw_path) == 0:
            print("Raw file doesn't exist or is empty after writing")
            return b''
        
        # Try FFmpeg conversion
        try:
            print("Converting with FFmpeg")
            cmd = [
                'ffmpeg',
                '-f', 's16le',           # Format is signed 16-bit little endian
                '-ar', str(sample_rate),  # Sample rate
                '-ac', '1',              # Mono channel
                '-i', raw_path,          # Input file
                '-y',                    # Overwrite output
                wav_path                 # Output file
            ]
            print(f"FFmpeg command: {' '.join(cmd)}")
            
            process = subprocess.run(
                cmd,
                capture_output=True, text=True, timeout=2
            )
            
            if process.returncode != 0:
                print(f"FFmpeg error (code {process.returncode}): {process.stderr if hasattr(process, 'stderr') else str(process)}")
                raise Exception(f"FFmpeg conversion failed with code {process.returncode}")
                
            # Check if WAV file was created successfully
            if os.path.exists(wav_path) and os.path.getsize(wav_path) > 0:
                with open(wav_path, 'rb') as f:
                    wav_bytes = f.read()
                    print(f"FFmpeg created {len(wav_bytes)} bytes of WAV data")
                    return wav_bytes
            else:
                print("FFmpeg did not create a valid WAV file")
                raise Exception("FFmpeg produced an empty WAV file")
                
        except Exception as e:
            print(f"FFmpeg conversion error: {str(e)}")
            
            # Alternative method - use pydub if available
            try:
                print("Attempting conversion with pydub")
                # Create raw AudioSegment
                segment = AudioSegment(
                    data=pcm_data,
                    sample_width=sample_width,
                    frame_rate=sample_rate,
                    channels=1
                )
                
                # Export to WAV format
                segment.export(wav_path, format="wav")
                
                # Check if WAV file was created successfully
                if os.path.exists(wav_path) and os.path.getsize(wav_path) > 0:
                    with open(wav_path, 'rb') as f:
                        wav_bytes = f.read()
                        print(f"pydub created {len(wav_bytes)} bytes of WAV data")
                        return wav_bytes
                else:
                    print("pydub did not create a valid WAV file")
                    raise Exception("pydub produced an empty WAV file")
            except Exception as pydub_error:
                print(f"pydub conversion failed: {pydub_error}")
                return b''
                
    except Exception as e:
        print(f"Error creating WAV from raw audio: {e}")
        return b''
    finally:
        # Clean up temporary files
        try:
            if 'raw_path' in locals() and os.path.exists(raw_path):
                os.unlink(raw_path)
                print(f"Removed temporary raw file")
            if 'wav_path' in locals() and os.path.exists(wav_path):
                os.unlink(wav_path)
                print(f"Removed temporary WAV file")
        except Exception as cleanup_error:
            print(f"Error cleaning up temp files: {cleanup_error}")

def _cleanup_old_sessions():
    """
    Remove conversation sessions that are older than 5 minutes to prevent memory leaks.
    """
    current_time = time.time()
    to_remove = []
    
    for session_id, session in conversation_sessions.items():
        # Check if session is older than 5 minutes
        if current_time - session.get('last_activity', 0) > 300:  # 300 seconds = 5 minutes
            to_remove.append(session_id)
    
    # Remove old sessions
    for session_id in to_remove:
        print(f"Removing old session: {session_id}")
        del conversation_sessions[session_id]

        
def _is_ffmpeg_available():
    """
    Check if FFmpeg is available on the system.
    Returns True if FFmpeg is available, False otherwise.
    """
    try:
        # Try to run ffmpeg -version and capture output
        result = subprocess.run(['ffmpeg', '-version'], 
            capture_output=True, text=True, timeout=2)
        if result.returncode == 0:
            print("FFmpeg is available")
            return True
        else:
            print("FFmpeg returned non-zero exit code")
            return False
    except (FileNotFoundError, subprocess.SubprocessError) as e:
        print(f"FFmpeg not available: {e}")
        return False

def _debug_audio_format(audio_data: bytes) -> None:
    """
    Print detailed diagnostic information about the audio data for debugging purposes.
    """
    try:
        print(f"Audio data length: {len(audio_data)} bytes")
        if len(audio_data) >= 20:
            # Print first 20 bytes in hex to help identify the format
            hex_bytes = ' '.join([f'{b:02x}' for b in audio_data[:20]])
            print(f"First 20 bytes: {hex_bytes}")
        
            # Check common audio format signatures
            if audio_data[:4] == b'RIFF' and audio_data[8:12] == b'WAVE':
                print("Format appears to be WAV (RIFF header detected)")
                # Extract WAV details
                channels = int.from_bytes(audio_data[22:24], byteorder='little')
                sample_rate = int.from_bytes(audio_data[24:28], byteorder='little')
                bits_per_sample = int.from_bytes(audio_data[34:36], byteorder='little')
                print(f"WAV details: {channels} channels, {sample_rate} Hz, {bits_per_sample} bits per sample")
            elif audio_data[:2] == b'ID3' or audio_data[:3] in [b'\xff\xfb', b'\xff\xf3', b'\xff\xf2']:
                print("Format appears to be MP3")
            elif audio_data[:4] == b'OggS':
                print("Format appears to be OGG")
            elif len(audio_data) > 4 and audio_data[:4] == b'\x1a\x45\xdf\xa3':
                print("Format appears to be WebM")
            elif audio_data[:4] == b'fLaC':
                print("Format appears to be FLAC")
            else:
                print("Format signature not recognized, might be raw PCM or proprietary format")
    except Exception as e:
        print(f"Error analyzing audio format: {e}")


def _transcribe_with_whisper_api(audio_data: bytes, language: str) -> Optional[str]:
    """Transcribe audio data using OpenAI's Whisper API with simplified direct approach."""
    # Check if API key is configured
    if not settings.OPENAI_API_KEY:
        print("OpenAI API key not found. Cannot use Whisper API.")
        return None
    
    # Initialize variables that will be used in finally block
    transcript = None
    temp_path = None
    api_file_path = None
    converted_path = None
    
    import openai
    from openai import OpenAI
    
    start_time = time.time()
    
    try:
        # Initialize OpenAI client
        client = OpenAI(api_key=settings.OPENAI_API_KEY)
        print("Successfully initialized OpenAI client")
        
        # Validate audio data
        if not audio_data or len(audio_data) == 0:
            print("No audio data provided for transcription")
            return None
        
        # Detect audio format
        audio_format = _detect_audio_format(audio_data)
        print(f"Whisper API detected audio format: {audio_format}")
        
        # Map detected format to file extension
        format_to_ext = {
            'mp3': '.mp3',
            'mp4': '.mp4',
            'wav': '.wav',
            'webm': '.webm',
            'ogg': '.ogg',  # Ensure OGG files get the correct extension
            'oga': '.ogg',  # Variant of OGG - use standard .ogg extension
            'opus': '.ogg',  # Opus codec in OGG container - use .ogg extension
            'flac': '.flac',
            'browser_float32': '.raw',
            'browser_pcm': '.raw',
            'raw': '.raw'
        }
        
        # Valid formats for Whisper API
        valid_formats = ['flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm']
        
        file_ext = format_to_ext.get(audio_format, '.webm')  # Default to .webm if format not in map
        
        # Convert browser audio to WAV format if needed
        if audio_format == 'browser_pcm' or audio_format == 'browser_float32' or audio_format not in valid_formats:
            print(f"Converting {audio_format} to WAV format for Whisper API")
            sample_rate = 48000  # WebRTC audio is typically 48kHz
            wav_data = _create_wav_from_pcm(audio_data, sample_rate=sample_rate)
            
            if wav_data:
                audio_format = 'wav'
                audio_data = wav_data
                file_ext = '.wav'
                print(f"Successfully converted to WAV format ({len(wav_data)} bytes)")
            else:
                print("WAV conversion failed, attempting FFmpeg conversion later")
        
        # Create temporary file with appropriate extension
        # Log the raw bytes to help debug format issues
        if len(audio_data) >= 10:
            print(f"First 10 bytes of audio data: {audio_data[:10].hex()}")
            
        # For browser audio formats, we need to be careful with extensions and format detection
        if audio_format == 'ogg':
            # Always use .ogg extension for OGG/Opus audio from browser
            file_ext = '.ogg'
            print(f"Using .ogg extension for OGG/Opus audio ({len(audio_data)} bytes)")
        elif (12000 <= len(audio_data) <= 30000 and audio_format not in ['wav', 'mp3', 'ogg']) or audio_format == 'browser_pcm':
            # Typical WebRTC browser chunk size - use raw format for PCM audio
            file_ext = '.raw'
            audio_format = 'browser_pcm'
            print(f"Using .raw extension for browser PCM audio ({len(audio_data)} bytes)")
        elif audio_format == 'webm':
            # For chunks identified as WebM, verify the format
            print(f"Checking WebM format validity ({len(audio_data)} bytes)...")
            # Check if this looks like a valid WebM file by checking for EBML header
            if audio_data[:4] == b'\x1a\x45\xdf\xa3' or b'webm' in audio_data[:50]:
                print("Valid WebM header found")
                file_ext = '.webm'
            else:
                print("No valid WebM header found, trying as browser PCM")
                # Try as browser PCM instead since WebM without proper headers is typically raw audio
                file_ext = '.raw'
                audio_format = 'browser_pcm'
                
        # Double check audio format and update if needed
        if audio_format == 'ogg' and file_ext != '.ogg':
            file_ext = '.ogg'
            
        print(f"Using file extension: {file_ext} for temporary file")
        with tempfile.NamedTemporaryFile(suffix=file_ext, delete=False) as temp_file:
            temp_path = temp_file.name
            temp_file.write(audio_data)
            api_file_path = temp_path
            print(f"Created temporary file: {temp_path} with {len(audio_data)} bytes")
        
        # Check if file was created successfully
        if not os.path.exists(api_file_path) or os.path.getsize(api_file_path) == 0:
            print("Error: Temporary file creation failed or file is empty")
            return None
        
        try:
            # Check if we need to convert the audio format
            # OGG/Opus is now the preferred format (switched from WebM) for better handling of small chunks
            whisper_compatible_formats = ['mp3', 'mp4', 'm4a', 'wav', 'webm', 'ogg', 'oga', 'opus', 'flac']
            
            # OGG/Opus from browsers often needs conversion to be properly handled by Whisper API
            # Convert to WAV for maximum compatibility
            if audio_format in ['ogg', 'oga', 'opus']:
                print(f"Converting OGG/Opus to WAV for better Whisper API compatibility ({len(audio_data)} bytes)")
                converted_path = f"{temp_path}.wav"
                
                # Use FFmpeg to convert OGG to WAV (ensures proper format)
                try:
                    result = subprocess.run([
                        'ffmpeg',
                        '-y',
                        '-i', temp_path,
                        '-ar', '16000',  # 16kHz sample rate for Whisper
                        '-ac', '1',      # Mono audio
                        '-c:a', 'pcm_s16le',
                        converted_path
                    ], capture_output=True, text=True, check=False)
                    
                    if os.path.exists(converted_path) and os.path.getsize(converted_path) > 0:
                        print(f"Successfully converted OGG to {os.path.getsize(converted_path)} bytes of WAV")
                        api_file_path = converted_path
                        audio_format = 'wav'  # Update format after conversion
                    else:
                        print(f"OGG to WAV conversion failed: {result.stderr}")
                        # Fall back to sending original file
                        print("Falling back to direct OGG transcription")
                        api_file_path = temp_path
                except Exception as e:
                    print(f"Error during OGG conversion: {e}")
                    # Fall back to sending original file
                    api_file_path = temp_path
            
            # Convert browser_pcm to WAV first because we know it's not WebM
            if audio_format == 'browser_pcm' or file_ext == '.raw':
                converted_path = f"{temp_path}.wav"
                print(f"Converting raw PCM to WAV using FFmpeg")
                result = subprocess.run([
                    'ffmpeg',
                    '-y',
                    '-f', 's16le',
                    '-ar', '48000',  # WebRTC uses 48kHz sample rate
                    '-ac', '2',      # WebRTC typically uses stereo
                    '-i', temp_path,
                    '-ar', '16000',  # Convert to 16kHz for Whisper
                    '-ac', '1',      # Convert to mono
                    '-c:a', 'pcm_s16le',
                    converted_path
                ], capture_output=True, text=True, check=False)
                
                if os.path.exists(converted_path) and os.path.getsize(converted_path) > 0:
                    print(f"Successfully converted to {os.path.getsize(converted_path)} bytes of WAV")
                    api_file_path = converted_path
                    audio_format = 'wav'  # Update format after conversion
                else:
                    print(f"PCM to WAV conversion failed: {result.stderr}")
            
            # Direct transcription with Whisper API when format is compatible
            if audio_format in whisper_compatible_formats:
                print(f"Format {audio_format} is compatible with Whisper API")
                # Will use this path for transcription below
                api_file_path = temp_path
            elif _is_ffmpeg_available():
                # Use FFmpeg to convert the file if needed
                if audio_format not in whisper_compatible_formats:
                    converted_path = f"{temp_path}.wav"
                    print(f"Converting audio from {audio_format} to WAV using FFmpeg")
                    
                    try:
                        if audio_format == 'raw' or audio_format == 'browser_pcm':
                            result = subprocess.run([
                                'ffmpeg',
                                '-y',
                                '-f', 's16le',
                                '-ar', '48000',  # WebRTC uses 48kHz sample rate
                                '-ac', '2',      # WebRTC typically uses stereo
                                '-i', temp_path,
                                '-ar', '16000',  # Convert to 16kHz for Whisper
                                '-ac', '1',      # Convert to mono
                                '-c:a', 'pcm_s16le',
                                converted_path
                            ], capture_output=True, text=True, check=False)
                        elif audio_format == 'webm':
                            # Special handling for WebM/Opus from browser
                            # Double-check if it's really WebM by examining the file header
                            is_valid_webm = False
                            try:
                                with open(temp_path, 'rb') as f:
                                    header = f.read(50)
                                    # Valid WebM files start with EBML header (0x1A 0x45 0xDF 0xA3)
                                    if header[:4] == b'\x1a\x45\xdf\xa3' or b'webm' in header:
                                        is_valid_webm = True
                                        print("Valid WebM header detected")
                            except Exception as e:
                                print(f"Error checking WebM header: {e}")
                            
                            if is_valid_webm:
                                # For WebM format from browser with valid header, try converting directly to WAV
                                print("Using WebM format conversion")
                                result = subprocess.run([
                                    'ffmpeg',
                                    '-y',
                                    '-f', 'webm', # Explicitly specify WebM format
                                    '-i', temp_path,
                                    '-ar', '16000',  # Set sample rate
                                    '-ac', '1',       # Set to mono
                                    '-c:a', 'pcm_s16le',
                                    converted_path
                                ], capture_output=True, text=True, check=False)
                            else:
                                # If not valid WebM, try as raw PCM data instead
                                print("No valid WebM header found, trying as raw PCM data")
                                result = subprocess.run([
                                    'ffmpeg',
                                    '-y',
                                    '-f', 's16le',     # Raw PCM
                                    '-ar', '48000',    # 48kHz for WebRTC
                                    '-ac', '2',        # Stereo
                                    '-i', temp_path,
                                    '-ar', '16000',    # 16kHz for Whisper
                                    '-ac', '1',        # Mono
                                    '-c:a', 'pcm_s16le',
                                    converted_path
                                ], capture_output=True, text=True, check=False)
                                
                            # If both attempts fail, try one more time with generic options
                            if result.returncode != 0:
                                print("WebM/PCM conversion failed, trying generic conversion")
                                result = subprocess.run([
                                    'ffmpeg',
                                    '-y',
                                    '-i', temp_path,   # Let FFmpeg auto-detect
                                    '-ar', '16000',    # 16kHz for Whisper
                                    '-ac', '1',        # Mono
                                    '-c:a', 'pcm_s16le',
                                    converted_path
                                ], capture_output=True, text=True, check=False)
                        else:
                            result = subprocess.run([
                                'ffmpeg',
                                '-y',
                                '-i', temp_path,
                                '-ar', '16000',      # 16kHz sample rate (Whisper's preferred rate)
                                '-ac', '1',          # Mono audio
                                '-c:a', 'pcm_s16le', # Output codec
                                converted_path       # Output file
                            ], capture_output=True, text=True, check=False)
                        
                        if os.path.exists(converted_path) and os.path.getsize(converted_path) > 0:
                            print(f"Successfully converted to {os.path.getsize(converted_path)} bytes of WAV")
                            api_file_path = converted_path
                        else:
                            print(f"FFmpeg conversion error: {result.stderr}")
                            print("Falling back to direct audio transcription")
                            # Try direct transcription as fallback
                            api_file_path = temp_path
                    except Exception as e:
                        print(f"Error during audio conversion: {e}")
                        # Try direct transcription as fallback
                        api_file_path = temp_path
            else:
                # No conversion available, try direct transcription
                print("FFmpeg not available, trying direct transcription")
                api_file_path = temp_path
                
            # Final check before sending to API
            if api_file_path and os.path.exists(api_file_path) and os.path.getsize(api_file_path) > 0:
                with open(api_file_path, "rb") as audio_file:
                    file_size = os.path.getsize(api_file_path)
                    print(f"Sending {file_size} bytes to Whisper API")
                    
                    # Whisper API transcription
                    response = client.audio.transcriptions.create(
                        model="whisper-1", 
                        file=audio_file,
                        language=language if language != 'auto' else None,
                    )
                    
                    # Extract and return transcript
                    transcript = response.text.strip()
                    duration_ms = int((time.time() - start_time) * 1000)
                    print(f"Whisper API transcribed in {duration_ms}ms: {transcript}")
                    return transcript
            else:
                print(f"Error: Invalid audio file for API {api_file_path}")
                return None
        finally:
            # Clean up temporary files safely
            temp_files_to_remove = []
            
            # Add temp_path to cleanup list if it exists
            if temp_path and os.path.exists(temp_path):
                temp_files_to_remove.append(temp_path)
                
            # Add converted_path to cleanup list if it exists and is different from temp_path and api_file_path
            if converted_path and os.path.exists(converted_path) and converted_path != temp_path and converted_path != api_file_path:
                temp_files_to_remove.append(converted_path)
                
            # Add api_file_path to cleanup list if it exists and is different from temp_path and converted_path
            if api_file_path and api_file_path != temp_path and api_file_path != converted_path and os.path.exists(api_file_path):
                temp_files_to_remove.append(api_file_path)
                
            # Delete all temp files
            for file_path in temp_files_to_remove:
                try:
                    os.unlink(file_path)
                    print(f"Removed temporary file: {file_path}")
                except Exception as e:
                    print(f"Error removing file {file_path}: {e}")
                
            # Log overall process metrics for debugging
            processing_time = time.time() - start_time
            print(f"Audio processing metrics: format={audio_format}, size={len(audio_data)}, processing_time={processing_time:.2f}s, success={transcript is not None}")
            if transcript:
                print(f"Transcription: {transcript[:100]}{'...' if len(transcript) > 100 else ''}")
            else:
                print("Transcription failed or returned no text")
    except Exception as e:
        print(f"Unexpected error in Whisper API transcription: {e}")
        return None

def _transcribe_with_sr(audio_data: bytes, language: str) -> Optional[str]:
    """Use SpeechRecognition library for transcription with multiple fallback options."""
    # Check if SpeechRecognition is available
    if not SPEECH_RECOGNITION_AVAILABLE or recognizer is None:
        print("SpeechRecognition not available for fallback transcription")
        return None
        
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
