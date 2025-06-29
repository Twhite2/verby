from fastapi import WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState
from typing import Dict, List, Set, Any
import json
import asyncio

from app.services.stt import transcribe_audio
from app.services.translation import translate_text
from app.services.tts import synthesize_speech


class ConnectionManager:
    """Manager for WebSocket connections."""
    
    def __init__(self):
        # Map of call_id -> set of connected WebSockets
        self.active_connections: Dict[str, Dict[str, WebSocket]] = {}
        # Map of call_id -> map of user_id -> language preference
        self.language_preferences: Dict[str, Dict[str, str]] = {}
        
    async def connect(self, websocket: WebSocket, call_id: str, user_id: str):
        """Connect a user to a call."""
        # Note: WebSocket should already be accepted in the router
        
        try:
            # Verify the WebSocket is in a connected state
            if websocket.client_state != WebSocketState.CONNECTED:
                print(f"WebSocket for user {user_id} in call {call_id} is not properly connected, current state: {websocket.client_state}")
                try:
                    # Try accepting again, which might be needed in some cases
                    if websocket.client_state == WebSocketState.CONNECTING:
                        print(f"Attempting to accept WebSocket for {user_id} in connecting state")
                        await websocket.accept()
                except Exception as e:
                    print(f"Error accepting WebSocket: {e}")
            
            # Initialize dictionaries if they don't exist
            if call_id not in self.active_connections:
                self.active_connections[call_id] = {}
                self.language_preferences[call_id] = {}
            
            # Store the connection
            self.active_connections[call_id][user_id] = websocket
            print(f"User {user_id} connected to call {call_id}, WebSocket state: {websocket.client_state}")
            
            # Only send the joined message if WebSocket is properly connected
            if websocket.client_state == WebSocketState.CONNECTED:
                # Send a joined message to all participants
                message = json.dumps({
                    "type": "user_joined",
                    "user_id": user_id
                })
                await self.broadcast_text(message, call_id)
        except Exception as e:
            print(f"Error in connect method: {e}")
            # Don't re-raise, try to continue with the connection
    
    def disconnect(self, websocket: WebSocket, call_id: str, user_id: str):
        """Disconnect a user from a call."""
        # Remove the user from the connections
        if call_id in self.active_connections and user_id in self.active_connections[call_id]:
            del self.active_connections[call_id][user_id]
            
            # Clean up if no users are left
            if not self.active_connections[call_id]:
                del self.active_connections[call_id]
                
            # Remove language preference
            if call_id in self.language_preferences and user_id in self.language_preferences[call_id]:
                del self.language_preferences[call_id][user_id]
                if not self.language_preferences[call_id]:
                    del self.language_preferences[call_id]
    
    async def broadcast_text(self, message: str, call_id: str):
        """Broadcast a text message to all participants in a call."""
        if call_id not in self.active_connections:
            return
        
        for user_id, connection in self.active_connections[call_id].items():
            try:
                await connection.send_text(message)
            except Exception:
                # Handle connection errors
                pass
    
    async def broadcast_bytes(self, data: bytes, call_id: str, exclude_user_id: str = None):
        """Broadcast binary data to all participants in a call except the sender."""
        if call_id not in self.active_connections:
            return
        
        for user_id, connection in self.active_connections[call_id].items():
            if exclude_user_id and user_id == exclude_user_id:
                continue  # Skip the sender
                
            try:
                await connection.send_bytes(data)
            except Exception:
                # Handle connection errors
                pass
    
    async def send_audio(self, audio_data: bytes, call_id: str, target_user_id: str):
        """Send audio data to a specific user."""
        if call_id not in self.active_connections or target_user_id not in self.active_connections[call_id]:
            return False
            
        try:
            await self.active_connections[call_id][target_user_id].send_bytes(audio_data)
            return True
        except Exception:
            return False
    
    def has_connections(self, call_id: str) -> bool:
        """Check if a call has any active connections."""
        return call_id in self.active_connections and bool(self.active_connections[call_id])
    
    def set_language_preference(self, call_id: str, user_id: str, language: str):
        """Set a user's language preference."""
        if call_id not in self.language_preferences:
            self.language_preferences[call_id] = {}
            
        self.language_preferences[call_id][user_id] = language
    
    def get_language_preference(self, call_id: str, user_id: str) -> str:
        """Get a user's language preference."""
        if call_id in self.language_preferences and user_id in self.language_preferences[call_id]:
            return self.language_preferences[call_id][user_id]
        return "en"  # Default to English
    
    async def process_audio(self, audio_data: bytes, call_id: str, sender_id: str):
        """
        Process incoming audio:
        1. Transcribe speech to text
        2. Translate the text to target languages
        3. Synthesize speech in target languages
        4. Send synthesized speech to recipients
        """
        if call_id not in self.active_connections:
            print(f"Call {call_id} not found in active_connections")
            return
            
        # Check if sender is still connected before processing
        if sender_id not in self.active_connections[call_id]:
            print(f"Sender {sender_id} no longer connected, skipping audio processing")
            return
            
        print(f"Processing audio from user {sender_id}, size: {len(audio_data)} bytes")
        
        # Get the sender's language
        sender_language = self.get_language_preference(call_id, sender_id)
        print(f"Sender language: {sender_language}")
        
        # Create a snapshot of active connections to avoid iteration issues if connections change
        active_recipients = {}
        try:
            # Copy only the connections that are still active
            for user_id, conn in self.active_connections[call_id].items():
                # Skip disconnected websockets
                if conn.client_state == WebSocketState.DISCONNECTED:
                    print(f"Skipping disconnected client {user_id}")
                    continue
                active_recipients[user_id] = conn
                
            # Transcribe audio
            print(f"Attempting to transcribe {len(audio_data)} bytes of audio data...")
            text = await transcribe_audio(audio_data, sender_language)
            if not text:
                print("No speech detected or transcription failed")
                return  # No speech detected
                
            print(f"Transcription successful: '{text}'")
                
            # Send transcription to sender for confirmation (if still connected)
            if sender_id in active_recipients:
                try:
                    await active_recipients[sender_id].send_text(json.dumps({
                        "type": "transcription",
                        "text": text
                    }))
                    print(f"Sent transcription to sender {sender_id}")
                except WebSocketDisconnect:
                    print(f"Sender {sender_id} disconnected while sending transcription")
                except Exception as e:
                    print(f"Error sending transcription to sender: {str(e)}")
            
            # Process for each recipient
            recipients_count = len(active_recipients)
            print(f"Processing for {recipients_count} recipients")
            
            for recipient_id, connection in list(active_recipients.items()):
                if recipient_id == sender_id:
                    continue  # Skip the sender
                
                # Double-check connection is still active before processing
                try:
                    if hasattr(connection, 'client_state') and connection.client_state == WebSocketState.DISCONNECTED:
                        print(f"Recipient {recipient_id} disconnected, skipping")
                        continue
                        
                    print(f"Processing for recipient {recipient_id}")
                    target_language = self.get_language_preference(call_id, recipient_id)
                    print(f"Recipient language: {target_language}")
                    
                    # Translate text if needed
                    translated_text = text
                    if target_language != sender_language:
                        print(f"Translating from {sender_language} to {target_language}")
                        try:
                            translated_text = await translate_text(text, sender_language, target_language)
                            print(f"Translation successful: '{translated_text}'")
                        except Exception as e:
                            print(f"Translation error: {str(e)}")
                            # Fall back to original text
                            translated_text = text
                    
                    # Synthesize speech
                    print(f"Synthesizing speech for '{translated_text}' in {target_language}")
                    try:
                        translated_audio = await synthesize_speech(translated_text, target_language)
                        print(f"Speech synthesis successful, generated {len(translated_audio)} bytes")
                        
                        # Final check if recipient is still connected before sending audio
                        if call_id in self.active_connections and recipient_id in self.active_connections[call_id]:
                            # Send the synthesized speech to the recipient
                            try:
                                success = await self.send_audio(translated_audio, call_id, recipient_id)
                                print(f"Sending audio to recipient {recipient_id}: {'success' if success else 'failed'}")
                            except WebSocketDisconnect:
                                print(f"Recipient {recipient_id} disconnected while sending audio")
                                continue
                            except Exception as e:
                                print(f"Error sending audio: {str(e)}")
                                continue
                        else:
                            print(f"Recipient {recipient_id} is no longer connected, skipping audio send")
                    except Exception as e:
                        print(f"Speech synthesis error: {str(e)}")
                        continue
                    
                    # Also send the text translation if recipient is still connected
                    if call_id in self.active_connections and recipient_id in self.active_connections[call_id]:
                        try:
                            await connection.send_text(json.dumps({
                                "type": "translation",
                                "sender_id": sender_id,
                                "original_text": text,
                                "original_language": sender_language,
                                "translated_text": translated_text,
                                "target_language": target_language
                            }))
                            print(f"Sent translation text to recipient {recipient_id}")
                        except WebSocketDisconnect:
                            print(f"Recipient {recipient_id} disconnected while sending translation")
                        except Exception as e:
                            print(f"Error sending translation text: {str(e)}")
                    else:
                        print(f"Recipient {recipient_id} is no longer connected, skipping text send")
                except Exception as e:
                    print(f"Error processing for recipient {recipient_id}: {str(e)}")
                    continue
                
        except Exception as e:
            # Log the error and notify the sender
            print(f"Error processing audio: {str(e)}")
            try:
                # Only try to notify if the sender is still connected
                if call_id in self.active_connections and sender_id in self.active_connections[call_id]:
                    await self.active_connections[call_id][sender_id].send_text(json.dumps({
                        "type": "error",
                        "message": "Failed to process audio"
                    }))
            except Exception:
                # If this fails too, just log it
                print("Failed to send error notification to sender")
