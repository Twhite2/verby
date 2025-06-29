from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect, Body, Depends
from starlette.websockets import WebSocketState
from typing import List, Dict, Any, Optional
import uuid
import json
import asyncio

from app.websockets.connection import ConnectionManager
from app.models.schemas import CallSession, CallCreate

# Create router
router = APIRouter()

# Initialize the connection manager
manager = ConnectionManager()

# Mock active calls - in production, this would be in a database
active_calls: Dict[str, CallSession] = {}


@router.post("/", response_model=CallSession)
async def create_call(call: CallCreate):
    """Create a new call session."""
    call_id = str(uuid.uuid4())
    new_call = CallSession(
        id=call_id,
        creator_id=call.creator_id,
        participant_ids=[],
        active=True,
        created_at=call.created_at
    )
    active_calls[call_id] = new_call
    return new_call


@router.get("/{call_id}", response_model=CallSession)
async def get_call(call_id: str):
    """Get call details."""
    if call_id not in active_calls:
        raise HTTPException(status_code=404, detail="Call not found")
    return active_calls[call_id]


@router.websocket("/ws/{call_id}/{user_id}")
async def websocket_endpoint(websocket: WebSocket, call_id: str, user_id: str):
    """WebSocket endpoint for real-time call communication."""
    # Check if call exists
    if call_id not in active_calls:
        await websocket.close(code=4000, reason="Call not found")
        return
    
    # Init connection variables
    is_connected = False
    
    try:
        # Accept the connection and register with the manager
        await websocket.accept()
        is_connected = True
        print(f"WebSocket connection accepted for user {user_id} in call {call_id}")
        
        # Register with the connection manager
        await manager.connect(websocket, call_id, user_id)
        
        print(f"WebSocket connected: call_id={call_id}, user_id={user_id}")
        
        # Main message loop
        while True:
            # Receive message from client
            try:
                data = await websocket.receive_bytes()
                
                # Process received audio data
                if data:
                    # Check if WebSocket is still connected before processing audio
                    if websocket.client_state == WebSocketState.CONNECTED:
                        await manager.process_audio(data, call_id, user_id)
                    else:
                        print(f"Cannot process audio: WebSocket for user {user_id} is not in CONNECTED state (state: {websocket.client_state})")
                        break  # Exit the loop if websocket is not connected
            except WebSocketDisconnect:
                print(f"WebSocket disconnected during receive: user_id={user_id}")
                break
            except Exception as e:
                print(f"Error receiving data: {e}")
                if "WebSocket is not connected" in str(e):
                    print(f"WebSocket for user {user_id} is no longer connected. Exiting message loop.")
                    break
    except WebSocketDisconnect:
        print(f"WebSocket disconnected during connection: user_id={user_id}")
    except Exception as e:
        print(f"Connection error: {e}")
    finally:
        # Ensure disconnection even if errors occur
        if is_connected:
            manager.disconnect(websocket, call_id, user_id)
            print(f"User {user_id} disconnected from call {call_id}")
        
        # Broadcast disconnection message
        try:
            message = json.dumps({
                "type": "user_left",
                "user_id": user_id
            })
            await manager.broadcast_text(message, call_id)
        except Exception as e:
            print(f"Error broadcasting user_left message: {e}")
        
        # Check if call should be ended
        if call_id in active_calls and not manager.has_connections(call_id):
            active_calls[call_id].active = False
