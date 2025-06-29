import asyncio
import os
import time
import tempfile
import speech_recognition as sr
from typing import Optional
import io
import base64
import soundfile as sf
import numpy as np
from pydub import AudioSegment
from app.config import settings
from pydub.utils import mediainfo

# Try to import optional dependencies
try:
    import openai
    from openai import OpenAI
    WHISPER_API_AVAILABLE = settings.OPENAI_API_KEY is not None
    if WHISPER_API_AVAILABLE:
        client = OpenAI(api_key=settings.OPENAI_API_KEY)
except ImportError:
    WHISPER_API_AVAILABLE = False

# Initialize speech recognizer
recognizer = sr.Recognizer()


async def transcribe_audio(audio_data: bytes, language: str = "en") -> Optional[str]:
    """
    Transcribe audio data to text.
    
    Args:
        audio_data: Raw audio bytes
        language: ISO language code
    
    Returns:
        Transcribed text or None if no speech detected
    """
    # Check if OpenAI API key is available
    openai_available = WHISPER_API_AVAILABLE and settings.OPENAI_API_KEY
    
    if openai_available:
        print("Using OpenAI Whisper API for transcription")
        transcription_func = _transcribe_with_whisper_api
    else:
        print("OpenAI API key not available, falling back to local speech recognition")
        transcription_func = _transcribe_with_sr
    
    # Run the CPU-intensive task in a separate thread pool
    return await asyncio.to_thread(transcription_func, audio_data, language)


def _transcribe_with_whisper_api(audio_data: bytes, language: str) -> Optional[str]:
    """Transcribe audio data using OpenAI's Whisper API with improved handling for browser audio."""
    # Check if API key is configured
    if not settings.OPENAI_API_KEY:
        print("WARNING: OPENAI_API_KEY is not set. Whisper API transcription will not work.")
        print("Set your OpenAI API key in the environment variable OPENAI_API_KEY")
        return None
        
    try:
        client = OpenAI(api_key=settings.OPENAI_API_KEY)
    except Exception as e:
        print(f"Error initializing OpenAI client: {str(e)}")
        return None
    
    # Performance tracking
    start_time = time.time()
    
    # Import buffer and file conversion utilities from OpenAI
    try:
        from openai.types.audio.transcription import Transcription
        from openai.uploaders import File as OpenAIFile
        from openai.uploads import toFile
        use_tofile = True
        print("Using OpenAI's toFile utility for improved file handling")
    except ImportError:
        use_tofile = False
        print("OpenAI toFile utility not available, using standard file handling")
    
    # Create a temporary directory to store files
    temp_dir = tempfile.mkdtemp()
    audio_path = os.path.join(temp_dir, "original_audio")
    mp3_path = os.path.join(temp_dir, "audio.mp3")
    
    try:
        print(f"Received audio data size: {len(audio_data)} bytes")

        # Write audio data to file for processing
        with open(audio_path, 'wb') as f:
            f.write(audio_data)

        # Detect audio format from header bytes
        format_hint = "unknown"
        if len(audio_data) > 12:
            header = audio_data[:12]
            if audio_data[:4] == b"RIFF" and audio_data[8:12] == b"WAVE":
                format_hint = "wav"
            elif audio_data[:4] == b"OggS":
                format_hint = "ogg"
            elif audio_data[:4] == b"\x1a\x45\xdf\xa3":
                format_hint = "webm"
            elif b'ID3' in header:
                format_hint = "mp3"
        
        print(f"Audio format detection: {format_hint}")
        
        # Debug the first bytes of the audio data
        import binascii
        print(f"First 32 bytes: {binascii.hexlify(audio_data[:32]).decode()}")
        
        # Calculate audio variability to help detect PCM data - useful for browser audio
        if len(audio_data) > 100:
            # Check byte-to-byte differences which are typically higher in PCM audio
            diffs = [abs(audio_data[i] - audio_data[i+1]) for i in range(min(1000, len(audio_data)-1))]
            avg_diff = sum(diffs) / len(diffs)
            print(f"Audio byte variability: {avg_diff:.2f} (higher values suggest PCM data)")
            has_pcm_characteristics = avg_diff > 5  # PCM audio typically has higher variability
        else:
            has_pcm_characteristics = False 
        # Method 1: Try to extract raw PCM data directly and create WAV file (Most successful with browser audio)
        if has_pcm_characteristics:
            print("Attempt 1: Extracting PCM data and creating WAV file (prioritized due to audio characteristics)")
            try:
                # Create a WAV file with standard parameters for voice
                wav_path = os.path.join(temp_dir, "audio.wav")
                
                import struct
                
                # Try various methods to handle browser WebM audio with corrupted headers
                
                # Method 1: Try converting with FFmpeg first (preferred approach)
                try:
                    print("Trying FFmpeg direct WebM to WAV conversion first")
                    wav_file_path = os.path.join(temp_dir, "direct_ffmpeg.wav")
                    
                    subprocess.check_output([
                        'ffmpeg', '-y',
                        '-i', audio_path,
                        '-acodec', 'pcm_s16le',
                        '-ar', '16000',
                        '-ac', '1',
                        wav_file_path
                    ], stderr=subprocess.PIPE)
                    
                    # Try whisper API with FFmpeg converted audio
                    with open(wav_file_path, 'rb') as audio_file:
                        response = client.audio.transcriptions.create(
                            file=audio_file,
                            model="whisper-1",
                            language=language
                        )
                        result_text = response.text
                        
                        # Check for suspicious single-word results like "You"
                        # If we have a reasonable amount of audio, we should get more than a single word
                        if len(audio_data) > 10000 and len(result_text.split()) <= 1 and result_text.lower() == "you":
                            print(f"⚠️ Rejected suspicious transcription: '{result_text}' - likely incorrect due to audio conversion issue")
                        else:
                            print(f"✓ TRANSCRIPTION SUCCESS (FFmpeg-WAV): '{result_text}'")
                            return result_text
                except Exception as e:
                    print(f"FFmpeg conversion failed: {str(e)}")
                
                # Method 2: Try various offsets to skip malformed headers as fallback
                print("Trying PCM extraction with various offsets")
                # Using different offset to avoid the exact same processing that led to incorrect "You" transcription
                for offset in [48, 96, 128, 256, 0]:
                    if offset >= len(audio_data):
                        continue
                        
                    # Extract PCM data, skip potential header
                    pcm_data = audio_data[offset:]
                    
                    # Create WAV with proper header
                    wav_file_path = os.path.join(temp_dir, f"pcm_extract_{offset}.wav")
                    
                    # For WebM from browsers, we generally want 16kHz, 16-bit mono
                    sample_rate = 16000
                    channels = 1
                    bits_per_sample = 16
                    bytes_per_sample = bits_per_sample // 8
                    
                    # Generate WAV header
                    header = bytearray()
                    
                    # RIFF chunk
                    header.extend(b'RIFF')
                    header.extend(struct.pack('<I', 36 + len(pcm_data)))
                    header.extend(b'WAVE')
                    
                    # fmt subchunk
                    header.extend(b'fmt ')
                    header.extend(struct.pack('<I', 16))
                    header.extend(struct.pack('<H', 1))  # PCM format
                    header.extend(struct.pack('<H', channels))
                    header.extend(struct.pack('<I', sample_rate))
                    header.extend(struct.pack('<I', sample_rate * channels * bytes_per_sample))
                    header.extend(struct.pack('<H', channels * bytes_per_sample))
                    header.extend(struct.pack('<H', bits_per_sample))
                    
                    # data subchunk
                    header.extend(b'data')
                    header.extend(struct.pack('<I', len(pcm_data)))
                    
                    # Write WAV file
                    with open(wav_file_path, 'wb') as f:
                        f.write(header + pcm_data)
                    
                    # Try whisper API with this PCM extraction
                    try:
                        with open(wav_file_path, 'rb') as audio_file:
                            response = client.audio.transcriptions.create(
                                file=audio_file,
                                model="whisper-1",
                                language=language
                            )
                            result_text = response.text
                            
                            # Reject suspicious single-word transcriptions for large audio chunks
                            if len(audio_data) > 10000 and len(result_text.split()) <= 1 and result_text.lower() == "you":
                                print(f"⚠️ Skipping suspicious transcription at offset {offset}: '{result_text}' - likely incorrect")
                                continue
                            
                            print(f"✓ TRANSCRIPTION SUCCESS (PCM-WAV offset={offset}): '{result_text}'")
                            return result_text
                    except Exception as e:
                        print(f"Whisper API transcription failed for offset {offset}: {str(e)}")
            except Exception as e:
                print(f"Error during PCM extraction: {str(e)}")
        
        # Method 2: Use OpenAI's toFile utility (reliable for standard audio)
        if use_tofile:
            try:
                print("Attempt 2: Using OpenAI's toFile utility for direct conversion")
                # Create a proper file object using OpenAI's utility
                file_obj = toFile(audio_data, "audio.mp3")
                response = client.audio.transcriptions.create(
                    file=file_obj,
                    model="whisper-1",
                    language=language
                )
                print(f"✓ TRANSCRIPTION SUCCESS (toFile): '{response.text}'")
                return response.text
            except Exception as e:
                print(f"toFile approach failed: {str(e)}")
        
        # Method 3: Try direct upload with proper MIME type
        direct_error = None
        try:
            print("Attempt 3: Direct upload with explicit MIME type")
            # Read back and upload
            with open(audio_path, 'rb') as f:
                response = client.audio.transcriptions.create(
                    file=f,
                    model="whisper-1",
                    language=language
                )
                print(f"✓ TRANSCRIPTION SUCCESS (direct file): '{response.text}'")
                return response.text
        except Exception as e:
            direct_error = str(e)
            print(f"Direct file upload failed: {direct_error}")
        
        # Method 3: Try converting with pydub to MP3
        print("Attempt 3: Converting audio with pydub to MP3 format")
        pydub_error = None
        try:
            print("Attempt 4: Converting audio with pydub to MP3 format")
            from pydub import AudioSegment
            
            # Try a variety of loading methods
            loaded = False
            
            # 1. First, try loading directly as WebM since that's what browser MediaRecorder typically sends
            if not loaded:
                try:
                    print("Trying to load as WebM (browser default)")
                    audio = AudioSegment.from_file(audio_path, format="webm")
                    loaded = True
                    print("Successfully loaded as WebM")
                except Exception as e:
                    print(f"Failed to load as WebM: {str(e)}")
            
            # 2. Then try loading as raw PCM with optimal speech parameters
            if not loaded:
                # These are the settings optimized for speech
                try:
                    print("Trying to load as raw PCM with speech-optimized settings (16kHz, mono, 16-bit)")
                    audio = AudioSegment.from_raw(audio_path, sample_width=2, frame_rate=16000, channels=1)
                    loaded = True
                    print("Successfully loaded as raw PCM with speech settings")
                except Exception as e:
                    print(f"Failed with speech-optimized settings: {str(e)}")
            
            # 3. Try other common raw PCM configurations
            if not loaded:
                for sample_rate in [48000, 44100, 22050]:
                    for channels in [1, 2]:
                        try:
                            print(f"Loading audio as raw PCM: {sample_rate}Hz, {channels} channels")
                            audio = AudioSegment.from_raw(audio_path, sample_width=2, frame_rate=sample_rate, channels=channels)
                            loaded = True
                            print(f"Successfully loaded as raw PCM ({sample_rate}Hz, {channels} channels)")
                            break
                        except Exception as e:
                            print(f"Failed with {sample_rate}Hz, {channels} channels: {str(e)}")
                    if loaded:
                        break

            # 4. Try other common audio formats
            if not loaded:
                for format_name in ['wav', 'mp3', 'ogg']:
                    try:
                        print(f"Trying to load as {format_name}")
                        if format_name == 'wav':
                            audio = AudioSegment.from_wav(audio_path)
                        elif format_name == 'mp3':
                            audio = AudioSegment.from_mp3(audio_path)
                        elif format_name == 'ogg':
                            audio = AudioSegment.from_ogg(audio_path)
                        loaded = True
                        print(f"Successfully loaded as {format_name}")
                        break
                    except Exception as e:
                        print(f"Failed to load as {format_name}: {str(e)}")
            
            # 5. Last resort - try loading as raw data
            if not loaded:
                print("Trying to load as raw bytes (last resort)")
                try:
                    audio = AudioSegment(data=audio_data)
                    loaded = True
                    print("Successfully loaded as raw bytes")
                except Exception as e:
                    print(f"Failed to load as raw bytes: {str(e)}")

            # If loading succeeded, export to MP3 optimized for speech
            if loaded:
                # Export as MP3 with speech-optimized settings
                # - Mono (1 channel) - speech doesn't need stereo
                # - 16kHz - sufficient for speech recognition
                # - 32kbps - good quality for speech while keeping file small
                audio = audio.set_channels(1).set_frame_rate(16000)
                audio.export(mp3_path, format="mp3", bitrate="32k", 
                          parameters=["-ar", "16000", "-ac", "1", "-q:a", "0"])
                print(f"Exported optimized MP3 to {mp3_path}")
                
                # Transcribe with MP3
                with open(mp3_path, 'rb') as f:
                    response = client.audio.transcriptions.create(
                        file=f,
                        model="whisper-1",
                        language=language
                    )
                print(f"✓ TRANSCRIPTION SUCCESS (pydub MP3): '{response.text}'")
                return response.text
            else:
                print("All pydub loading methods failed")
        except Exception as e:
            print(f"Error during pydub conversion: {str(e)}")
                
        # Method 5: Try manual raw PCM data extraction as last resort
        print("Attempt 5: Trying manual PCM data extraction as last resort")
        pcm_error = None
        try:
            # Create a WAV file with standard parameters for voice
            wav_path = os.path.join(temp_dir, "audio.wav")
            try:
                import subprocess
                import struct
                
                # Generate raw PCM headers manually
                # Simple WAV header for 16-bit PCM, 16kHz, Mono
                def create_wav_file(pcm_data, sample_rate=16000, channels=1, bits_per_sample=16):
                    byte_rate = sample_rate * channels * bits_per_sample // 8
                    block_align = channels * bits_per_sample // 8
                    
                    # WAV header
                    header = bytearray()
                    header.extend(b'RIFF')  # ChunkID
                    header.extend(struct.pack('<I', 36 + len(pcm_data)))  # ChunkSize
                    header.extend(b'WAVE')  # Format
                    
                    # fmt subchunk
                    header.extend(b'fmt ')  # Subchunk1ID
                    header.extend(struct.pack('<I', 16))  # Subchunk1Size (16 for PCM)
                    header.extend(struct.pack('<H', 1))  # AudioFormat (1 for PCM)
                    header.extend(struct.pack('<H', channels))  # NumChannels
                    header.extend(struct.pack('<I', sample_rate))  # SampleRate
                    header.extend(struct.pack('<I', byte_rate))  # ByteRate
                    header.extend(struct.pack('<H', block_align))  # BlockAlign
                    header.extend(struct.pack('<H', bits_per_sample))  # BitsPerSample
                    
                    # data subchunk
                    header.extend(b'data')  # Subchunk2ID
                    header.extend(struct.pack('<I', len(pcm_data)))  # Subchunk2Size
                    
                    # Combine header with PCM data
                    wav_data = header + pcm_data
                    return wav_data
                
                # Try to identify if we have raw PCM data or need to extract it
                # Extract PCM - even from invalid WebM by trying to skip headers
                # This is a last-resort approach for malformed browser audio
                pcm_data = None
                
                # If the file is very small, it might be just PCM data
                if len(audio_data) > 44:  # Minimum size for WAV header + some data
                    # Check for possible WebM header and try to skip it
                    # WebM typically has a header, followed by audio data
                    # For malformed WebM, try various offsets
                    for offset in [64, 128, 256, 512]:  # Common header sizes
                        if offset < len(audio_data):
                            # Try this chunk of data as PCM
                            pcm_chunk = audio_data[offset:]
                            wav_data = create_wav_file(pcm_chunk)
                            
                            # Write WAV file
                            with open(wav_path, 'wb') as f:
                                f.write(wav_data)
                            
                            # Try to use the WAV file with Whisper
                            try:
                                with open(wav_path, 'rb') as audio_file:
                                    response = client.audio.transcriptions.create(
                                        file=audio_file,
                                        model="whisper-1",
                                        language=language
                                    )
                                    print(f"✓ TRANSCRIPTION SUCCESS (PCM-WAV offset={offset}): '{response.text}'")
                                    return response.text
                            except Exception as wav_err:
                                print(f"WAV transcription failed with offset {offset}: {str(wav_err)}")
                    
            except Exception as pcm_err:
                pcm_error = str(pcm_err)
                print(f"PCM extraction failed: {pcm_error}")
                
            # Last resort - try ffmpeg with different input format assumptions
            for fmt in ['webm', 's16le', 'f32le', 'u8', 'alaw', 'mulaw']:
                try:
                    print(f"Trying ffmpeg with input format: {fmt}")
                    mp3_fallback = os.path.join(temp_dir, f"fallback_{fmt}.mp3")
                    
                    # Force input format and attempt conversion
                    subprocess.check_output([
                        'ffmpeg', '-y', '-f', fmt, '-i', audio_path,
                        '-ac', '1', '-ar', '16000', '-codec:a', 'libmp3lame', 
                        '-qscale:a', '2', mp3_fallback
                    ], stderr=subprocess.STDOUT)
                    
                    with open(mp3_fallback, "rb") as audio_file:
                        response = client.audio.transcriptions.create(
                            file=audio_file,
                            model="whisper-1",
                            language=language
                        )
                        print(f"✓ TRANSCRIPTION SUCCESS (ffmpeg {fmt}->MP3): '{response.text}'")
                        return response.text
                except Exception as fmt_error:
                    print(f"FFmpeg with {fmt} failed: {str(fmt_error)}")
                
        except Exception as e:
            print(f"PCM/WAV extraction failed: {str(e)}")
        
        # All attempts failed - provide detailed diagnostics
        print("All transcription attempts failed")
        
        # Output binary analysis of the audio data to help debug
        if len(audio_data) > 64:
            import binascii
            print(f"First 64 bytes: {binascii.hexlify(audio_data[:64]).decode()}")
            print(f"Last 64 bytes: {binascii.hexlify(audio_data[-64:]).decode()}")
            
            # Try to detect if this might be raw PCM data
            variation = sum(abs(audio_data[i] - audio_data[i+1]) for i in range(min(100, len(audio_data)-1)))
            avg_variation = variation / min(100, len(audio_data)-1)
            print(f"Average byte variation: {avg_variation:.2f} (high values suggest PCM data)")
        
        # Provide hints for frontend improvement
        print("SUGGESTION: Consider modifying frontend audio capture:")
        print("1. Use higher quality MediaRecorder settings (audio/wav or audio/webm;codecs=pcm)")
        print("2. Ensure complete audio chunks are being sent")
        print("3. Consider client-side conversion to WAV before sending")
        
        raise Exception("Failed to transcribe audio after multiple attempts")
    except Exception as e:
        print(f"Error in Whisper API transcription: {e}")
        return None
    finally:
        # Clean up temporary directory and all files inside it
        try:
            import shutil
            shutil.rmtree(temp_dir, ignore_errors=True)
        except Exception as cleanup_error:
            print(f"Error cleaning up temp directory: {cleanup_error}")
            pass


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
