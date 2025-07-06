require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const cors = require('cors');
const morgan = require('morgan');
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { transcribeAudio } = require('./services/whisper');
const { translateText } = require('./services/translate');
const { synthesizeSpeech } = require('./services/tts');
const { setupLogger } = require('./utils/logger');
const { detectAudioFormat, convertAudioFormatIfNeeded } = require('./utils/audio');
const apiRoutes = require('./routes/api');

// Initialize logger
const logger = setupLogger();

// Create temp directory if it doesn't exist
const tempDir = path.join(__dirname, '../temp');
fs.ensureDirSync(tempDir);

// Express app setup
const app = express();
const server = http.createServer(app);

// Socket.IO setup
const io = new Server(server, {
  cors: {
    origin: ['http://localhost:8080', 'http://127.0.0.1:8080'],
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

// Map to store audio metadata by userId
const audioMetadataMap = new Map();

// Map to track audio chunks received from users
// This helps us know which chunks are first chunks (with headers)
const userAudioChunks = new Map();
const pendingMetadataMap = new Map();

// Audio buffering for continuous streaming with VAD
const userAudioBuffers = new Map();
const userLastVoiceActivity = new Map();
const userSilenceDetected = new Map();

// Store WebM headers for each user to maintain format integrity
const userWebMHeaders = new Map();
const WEBM_HEADER_SIZE = 4096; // Generous estimate for WebM header size

/**
 * Broadcasts a message to all participants in a call except the sender
 * 
 * @param {string} callId - The call ID to broadcast to
 * @param {string} senderId - The sender's user ID to exclude from broadcast
 * @param {string|Buffer} message - The message to broadcast
 * @param {Object} [options] - Optional configuration
 * @param {boolean} [options.isAudio=false] - Whether this is an audio message
 * @param {string} [options.format='mp4'] - Audio format (e.g., 'mp4', 'webm')
 * @param {boolean} [options.sendMetadata=false] - Whether to send metadata before audio
 * @returns {number} - Number of clients the message was sent to
 */
function broadcastToCall(callId, senderId, message, options = {}) {
  let sentCount = 0;
  const isAudio = options.isAudio || false;
  const audioFormat = options.format || 'mp4';
  const mimeType = options.mimeType || (audioFormat === 'mp4' ? 'audio/mp4' : 'audio/webm');
  
  // If this is audio and we need to send metadata with it
  if (isAudio && options.sendMetadata) {
    try {
      // Send metadata before audio to all clients in the call
      const metadata = {
        type: 'audio-metadata',
        format: audioFormat,
        mimeType: mimeType,
        senderId: senderId,
        timestamp: Date.now()
      };
      
      // Broadcast the metadata as JSON
      broadcastToCall(callId, senderId, JSON.stringify(metadata));
      logger.info(`[TRACE] Sent audio metadata (format: ${audioFormat}) to call ${callId}`);
    } catch (metaError) {
      logger.error(`[TRACE] Error sending audio metadata:`, metaError);
    }
  }
  
  // Try to find all clients in this call
  const callClients = activeCallMap.get(callId) || [];
  
  try {
    // First try to send using the callClients map (most efficient)
    const clients = Array.from(callClients.entries());

    // Loop through each client and send message
    for (const [clientId, clientWs] of clients) {
      // Don't send the audio back to the sender
      if (clientId === senderId) {
        continue;
      }

      // Make sure the connection is still open
      if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        try {
          // If it's audio and we have binary format info, set it
          if (isAudio && clientWs.binaryType !== 'arraybuffer') {
            clientWs.binaryType = 'arraybuffer';
          }
          
          clientWs.send(message);
          sentCount++;
        } catch (sendError) {
          logger.error(`[TRACE] Error sending message to client ${clientId}:`, sendError);
          // Don't break the loop, continue trying other clients
        }
      }
    }
  } catch (error) {
    logger.error(`Error broadcasting to call ${callId}: ${error.message}`);
  }
  
  // Also try using wss.clients as fallback
  wss.clients.forEach((client) => {
    const clientCallId = client.callId || client.callIdData;
    const clientUserId = client.userId || client.userIdData;
    
    if (client.readyState === WebSocket.OPEN && 
        clientCallId === callId && 
        clientUserId !== senderId) {
      try {
        client.send(message);
        sentCount++;
        logger.debug(`Broadcast to ${clientUserId} in call ${callId} via wss.clients`);
      } catch (sendError) {
        logger.error(`Error broadcasting to client: ${sendError.message}`);
      }
    }
  });
  
  return sentCount;
}

// Voice Activity Detection constants
const SILENCE_THRESHOLD = 1800; // ms of silence to consider an utterance complete
const MIN_BUFFER_SIZE = 8000; // minimum buffer size in bytes to consider for transcription
const ENERGY_THRESHOLD = 500; // threshold for considering audio as voice vs silence

/**
 * Simple Voice Activity Detection (VAD) to detect if audio chunk contains voice
 * This implementation uses a basic energy threshold to detect voice activity
 * 
 * @param {Buffer} audioChunk - Raw audio buffer to check for voice activity
 * @returns {boolean} - True if voice activity is detected, false otherwise
 */
function hasVoiceActivity(audioChunk) {
  if (!audioChunk || audioChunk.length < 100) {
    return false;
  }
  
  // Calculate average energy (amplitude) in the chunk
  let sum = 0;
  let count = 0;
  
  // Sample the buffer to avoid too much computation
  // For WebM and most audio formats, we can look at every 2nd byte for amplitude
  for (let i = 0; i < Math.min(audioChunk.length, 2000); i += 2) {
    if (i < audioChunk.length) {
      sum += Math.abs(audioChunk[i]);
      count++;
    }
  }
  
  const avgEnergy = count > 0 ? (sum / count) : 0;
  
  // Log for debugging
  if (avgEnergy > ENERGY_THRESHOLD) {
    logger.debug(`Voice activity detected: energy=${avgEnergy.toFixed(2)}`);
  }
  
  return avgEnergy > ENERGY_THRESHOLD;
}

// Raw WebSocket server setup
const wss = new WebSocket.Server({ 
  noServer: true,
  // Disable compression completely
  perMessageDeflate: false,
  // Be very permissive with frames
  maxPayload: 100 * 1024 * 1024, // 100MB max message size
  skipUTF8Validation: true, // Skip UTF-8 validation
  handleProtocols: () => false // Don't handle protocols
});

// Setup ping interval to keep connections alive
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      logger.info(`Terminating stale connection for user ${ws.userId || ws.userIdData}`);
      return ws.terminate();
    }
    
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (pingError) {
      logger.error(`Error sending ping: ${pingError.message}`);
    }
  });
}, 30000); // Ping every 30 seconds

// Clear interval when server closes
wss.on('close', () => {
  clearInterval(pingInterval);
  logger.info('WebSocket server closed, cleared ping interval');
});

// Handle upgrade for raw WebSocket connections
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  
  if (pathname === '/ws') {
    // Add proper error handling for the upgrade process
    try {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } catch (error) {
      logger.error(`WebSocket upgrade error: ${error.message}`, { error });
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    }
  } else {
    socket.destroy();
  }
});

// Track active calls and their participants
const activeCallMap = new Map();

// Handle raw WebSocket connections
wss.on('connection', (ws, request) => {
  try {
    // Use a try-catch block to handle any URL parsing errors
    const url = new URL(request.url, 'http://localhost');
    const callId = url.searchParams.get('callId');
    const userId = url.searchParams.get('userId');
    
    logger.info(`Raw WebSocket client connected: ${userId} to call ${callId}`);
    
    if (!callId || !userId) {
      logger.warn(`Missing callId or userId, closing raw WebSocket connection`);
      try {
        ws.close(1000, 'Missing required parameters');
      } catch (closeError) {
        logger.error('Error closing websocket:', closeError);
      }
      return;
    }
    
    // Attach userId and callId directly to the WebSocket object for easy access
    ws.userId = userId;
    ws.callId = callId;
    
    // Also store as data attributes for browsers that might not support custom properties
    ws.userIdData = userId;
    ws.callIdData = callId;
    
    // Track this client in the active calls map
    if (!activeCallMap.has(callId)) {
      activeCallMap.set(callId, new Map());
    }
    
    const callParticipants = activeCallMap.get(callId);
    callParticipants.set(userId, { ws, lastSeen: Date.now() });
    
    logger.info(`Added user ${userId} to call ${callId}. Total participants: ${callParticipants.size}`);
    
    // Log all current connections for debugging
    const allClients = [];
    wss.clients.forEach(client => {
      if (client.callId === callId || client.callIdData === callId) {
        allClients.push(client.userId || client.userIdData);
      }
    });
    logger.info(`Current clients in call ${callId} via wss.clients: ${allClients.join(', ')}`);
    
    // Send a confirmation message after connection
    try {
      ws.send(JSON.stringify({
        type: 'connection_established',
        data: { 
          timestamp: Date.now(), 
          userId, 
          callId,
          participants: Array.from(callParticipants.keys())
        }
      }));
      
      // Notify other participants about new user
      broadcastToCall(callId, userId, JSON.stringify({
        type: 'participant_joined',
        data: { timestamp: Date.now(), userId, callId }
      }));
      
    } catch (sendError) {
      logger.error('Error sending welcome message:', sendError);
    }
  
    // Store connection info as properties of the ws object
    ws.callId = callId;
    ws.userId = userId;
    
    // Also store as data attributes to ensure they're not lost
    ws.callIdData = callId;
    ws.userIdData = userId;
    
    // Setup heartbeat mechanism to ensure connection stays alive
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
      if (activeCallMap.has(callId) && activeCallMap.get(callId).has(userId)) {
        activeCallMap.get(callId).get(userId).lastSeen = Date.now();
      }
    });
    
    // Handle WebSocket close event
    ws.on('close', () => {
      logger.info(`WebSocket closed for user ${userId} in call ${callId}`);
      // Remove user from active call tracking
      if (activeCallMap.has(callId)) {
        const callParticipants = activeCallMap.get(callId);
        callParticipants.delete(userId);
        logger.info(`Removed user ${userId} from call ${callId}. Remaining participants: ${callParticipants.size}`);
        
        // Notify others about user leaving
        broadcastToCall(callId, userId, JSON.stringify({
          type: 'participant_left',
          data: { timestamp: Date.now(), userId, callId }
        }));
        
        // If call is empty, clean it up
        if (callParticipants.size === 0) {
          activeCallMap.delete(callId);
          logger.info(`Call ${callId} has no more participants, removing tracking`);
        }
      }
    });
  
  // Using global pendingMetadataMap to track metadata for incoming binary messages
  }  catch (connectionError) {
    logger.error(`WebSocket connection error: ${connectionError.message}`, { error: connectionError });
    try {
      ws.close(1011, 'Internal server error');
    } catch (closeError) {
      // Just log, can't do much more
      logger.error('Error during error handling close:', closeError);
    }
    return;
  }
  
  // Handle messages from client with better error handling
  ws.on('message', async (message) => {
    // Wrap everything in a try-catch to prevent server crashes
    try {
      // Get current timestamp once for the entire message handler
      const now = Date.now();
      
      // Check if the message is binary (audio data) or string (metadata)
      if (message instanceof Buffer) {
        // Get the userId and callId from the WebSocket object
        const userId = ws.userId || ws.userIdData;
        const callId = ws.callId || ws.callIdData;
        
        logger.info(`[TRACE] Received binary WebSocket message: ${message.length} bytes from user ${userId} in call ${callId}`);
        
        // Ensure we have a valid userId and callId
        if (!userId || !callId) {
          logger.warn(`[TRACE] Missing userId or callId for binary message, cannot process`);  
          return;
        }
        
        // First broadcast the raw audio to all clients in the same call using our utility function
        // This ensures others can hear it even if transcription fails
        logger.info(`[TRACE] Broadcasting raw audio data to all clients in call ${callId}, from user ${userId}`);
        
        // Get metadata for this audio chunk
        const audioMetadata = audioMetadataMap.get(userId) || { format: 'mp4', mimeType: 'audio/mp4' };
        const format = audioMetadata.format || 'mp4';
        const mimeType = audioMetadata.mimeType || (format === 'mp4' ? 'audio/mp4' : 'audio/webm');
        
        // Track if this is the first chunk from this user (for sending headers)
        const isFirstChunk = !userAudioChunks.has(userId);
        if (isFirstChunk) {
          userAudioChunks.set(userId, {
            count: 1,
            lastChunkTime: Date.now()
          });
        } else {
          // Update the chunk counter
          const userChunks = userAudioChunks.get(userId);
          userChunks.count += 1;
          userChunks.lastChunkTime = Date.now();
          userAudioChunks.set(userId, userChunks);
        }
        
        // Use our more efficient broadcast function that tries both methods
        // Pass audio format information to help clients properly decode the audio
        // Send metadata with the first chunk to ensure clients know the format
        const recipientCount = broadcastToCall(callId, userId, message, {
          isAudio: true,
          format: format,
          mimeType: mimeType,
          sendMetadata: isFirstChunk // Only send metadata with first chunk
        });
        
        logger.info(`[TRACE] Broadcast raw audio to ${recipientCount} recipients in call ${callId} (format: ${format}, chunk: ${isFirstChunk ? 'first' : 'subsequent'})`);
        
        
        // If no recipients, log a warning as this might indicate connection issues
        if (recipientCount === 0) {
          logger.warn(`[WARNING] No recipients found for audio broadcast in call ${callId}`);
          
          // Debug: log all current connections for troubleshooting
          let clientsInCall = [];
          wss.clients.forEach((client) => {
            const clientCallId = client.callId || client.callIdData;
            const clientUserId = client.userId || client.userIdData;
            if (clientCallId === callId) {
              clientsInCall.push(`${clientUserId}(state:${client.readyState})`);
            }
          });
          
          // Also log participants from our active call map
          const mapParticipants = activeCallMap.has(callId) ? 
            Array.from(activeCallMap.get(callId).keys()).join(', ') : 
            'none';
            
          logger.info(`[DEBUG] Clients in call via wss.clients: [${clientsInCall.join(', ')}], via activeCallMap: [${mapParticipants}]`);
        }
        
        // Get metadata for this binary message
        let metadata = audioMetadataMap.get(userId);
        if (!metadata) {
          logger.info(`[TRACE] No metadata found for binary message from user ${userId}, using defaults`);
          metadata = {
            type: 'audio_data',
            timestamp: Date.now(),
            format: 'webm', // Default format assumption
            mimeType: 'audio/webm'
          };
        }

        // --- VAD-based buffering approach ---
        // Initialize buffer for this user if it doesn't exist
        if (!userAudioBuffers.has(userId)) {
          userAudioBuffers.set(userId, []);
          userLastVoiceActivity.set(userId, Date.now());
          userSilenceDetected.set(userId, false);
          logger.info(`[TRACE] Initialized new audio buffer for user ${userId}`);
        }
        
        // Add the chunk to the buffer
        const userBuffer = userAudioBuffers.get(userId);
        userBuffer.push(message);
        
        // Check for voice activity in this chunk
        const hasVoice = hasVoiceActivity(message);
        
        if (hasVoice) {
          // Voice detected - reset silence flags
          userLastVoiceActivity.set(userId, now);
          userSilenceDetected.set(userId, false);
          logger.debug(`[TRACE] Voice activity detected for user ${userId}`);
        } else {
          // Check if we've been silent for long enough to consider this a natural pause
          const lastActivity = userLastVoiceActivity.get(userId);
          const silenceDuration = now - lastActivity;
          
          if (silenceDuration > SILENCE_THRESHOLD) {
            // We've detected enough silence to consider this a natural pause
            if (!userSilenceDetected.get(userId)) {
              userSilenceDetected.set(userId, true);
              logger.info(`[TRACE] Silence detected for user ${userId} after ${silenceDuration}ms`);
              
              // Calculate total buffer size
              let totalSize = 0;
              userBuffer.forEach(chunk => totalSize += chunk.length);
              
              // Only process if we have enough audio data
              if (totalSize >= MIN_BUFFER_SIZE) {
                logger.info(`[TRACE] Processing buffered audio (${totalSize} bytes) after natural pause`);
                
                try {
                  // Combine all chunks into a single buffer
                  const combinedBuffer = Buffer.concat(userBuffer);
                  
                  // Process the combined audio
                  logger.info(`[TRACE] Processing combined audio of ${combinedBuffer.length} bytes for transcription`);
                  processAudioForTranscription(combinedBuffer, metadata, userId, callId, true);
                  
                  // Clear the buffer after processing
                  userAudioBuffers.set(userId, []);
                } catch (processingError) {
                  logger.error(`[ERROR] Error processing buffered audio: ${processingError.message}`, { error: processingError });
                }
              } else {
                logger.info(`[TRACE] Buffer too small (${totalSize} bytes < ${MIN_BUFFER_SIZE} bytes), skipping transcription`);
                // Clear small buffer to avoid accumulating noise
                userAudioBuffers.set(userId, []);
              }
            }
          }
        }
        
        // Periodically trim buffer if it gets too large without pauses
        const MAX_BUFFER_SIZE = 500000; // ~500KB
        let currentBufferSize = 0;
        userBuffer.forEach(chunk => currentBufferSize += chunk.length);
        
        if (currentBufferSize > MAX_BUFFER_SIZE) {
          logger.info(`[TRACE] Buffer too large (${currentBufferSize} bytes), processing and resetting`);
          
          try {
            // Process current buffer before it gets too large
            const combinedBuffer = Buffer.concat(userBuffer);
            processAudioForTranscription(combinedBuffer, metadata, userId, callId, true);
            
            // Reset the buffer
            userAudioBuffers.set(userId, []);
            userLastVoiceActivity.set(userId, now); // Using the 'now' variable from above
            userSilenceDetected.set(userId, false);
          } catch (processingError) {
            logger.error(`[ERROR] Error processing oversized buffer: ${processingError.message}`, { error: processingError });
          }
        }
        
        // Clean up old metadata entries periodically
        if (now % 10 === 0) { // Only do cleanup every ~10 messages to save CPU
          for (const [id, meta] of audioMetadataMap.entries()) {
            if (now - meta.timestamp > 30000) { // 30 seconds old
              audioMetadataMap.delete(id);
              logger.debug(`[DEBUG] Cleaned up old audio metadata for user ${id}`);
            }
          }
        }
      } else {
        // Handle JSON metadata that precedes binary data
        try {
          const data = JSON.parse(message.toString());
          logger.info(`[TRACE] Received WebSocket metadata: ${JSON.stringify(data)}`);
          
          // Store metadata in our map, using the messageId as the key if available
          const messageId = data.messageId || `default_${Date.now()}`;
          logger.info(`[TRACE] Storing metadata with key ${messageId} for type ${data.type}`);
          pendingMetadataMap.set(messageId, data);
          
          // Handle non-binary message types immediately
          if (data.type === 'ping') {
            // Respond to ping with pong to keep connection alive
            logger.debug(`[DEBUG] Received ping from client ${userId}, sending pong`);
            try {
              ws.send(JSON.stringify({
                type: 'pong',
                timestamp: Date.now(),
                originalTimestamp: data.timestamp
              }));
            } catch (pongError) {
              logger.error(`[ERROR] Failed to send pong: ${pongError.message}`);
            }
          } else if (data.type === 'join') {
            logger.info(`[TRACE] Processing join message for user ${data.data?.userId} in call ${data.data?.callId}`);
          } else if (data.type === 'audio_chunk' || data.type === 'audio_data') {
            // Get userId from the WebSocket object
            const userId = ws.userId || ws.userIdData;
            
            logger.info(`[TRACE] Received ${data.type} metadata from user ${userId || 'unknown'}, awaiting binary data...`);
            // Store metadata for the user to associate with incoming audio
            if (userId) {
              audioMetadataMap.set(userId, data);
            } else {
              logger.warn('[TRACE] Cannot store audio metadata: userId is undefined');
            }
          } else {
            logger.info(`[TRACE] Received metadata with unknown type: ${data.type}`);
          }
          
          // Log the number of pending metadata entries for debugging
          logger.info(`[TRACE] Pending metadata map now has ${pendingMetadataMap.size} entries`);
        } catch (jsonError) {
          logger.error(`[TRACE] Error parsing JSON metadata: ${jsonError.message}`, { error: jsonError, rawData: message.toString().substring(0, 200) });
        }
      }
    } catch (error) {
      logger.error('Error handling raw WebSocket message:', error);
      // Don't clear the entire metadata map on error, but we can remove stale entries
      const now = Date.now();
      for (const [id, metadata] of pendingMetadataMap.entries()) {
        if (now - metadata.timestamp > 10000) {
          pendingMetadataMap.delete(id);
        }
      }
    }
  });

  // Handle WebSocket connection close
  ws.on('close', (code, reason) => {
    try {
      // Use a safe default for userId if not defined
      const userIdSafe = ws.userId || 'anonymous-user';
      const callIdSafe = ws.callId || 'unknown-call';
      
      logger.info(`[TRACE] WebSocket connection closed for user ${userIdSafe} in call ${callIdSafe} with code ${code}: ${reason || 'No reason provided'}`);
      
      // Log statistics about remaining connections
      const activeConnections = wss.clients.size;
      logger.info(`[TRACE] Active WebSocket connections remaining: ${activeConnections}`);
      
      // Only try to close related connections if we have identifiers
      if (ws.callId && ws.userId) {
        // Remove any other connections for this user/call
        wss.clients.forEach((client) => {
          if (client !== ws && client.callId === ws.callId && client.userId === ws.userId) {
            logger.info(`[TRACE] Closing duplicate connection for user ${ws.userId} in call ${ws.callId}`);
            client.terminate();
          }
        });
      }
      
      // We're not using pendingMetadataMap so we'll remove that code
      logger.info(`[TRACE] WebSocket connection cleanup complete`);
    } catch (error) {
      logger.error(`Error in WebSocket close handler: ${error.message}`, { error });
    }
  });

  // Error handling for WebSocket
  ws.on('error', (error) => {
    // Get userId and callId from the WebSocket object
    const userId = ws.userId || ws.userIdData;
    const callId = ws.callId || ws.callIdData;
    
    logger.error(`[TRACE] WebSocket error for user ${userId || 'unknown'}: ${error.message}`, { 
      error,
      stack: error.stack,
      callId: callId || 'unknown',
      userId: userId || 'unknown',
      readyState: ws.readyState
    });
  });
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));
app.use(express.static('public'));

// Basic route
app.get('/', (req, res) => {
  res.send('VerbyFlow Audio Transcription API');
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api', apiRoutes);

// Socket.IO connection handling
io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id}`);
  
  // Get callId and userId from query parameters
  const { callId, userId } = socket.handshake.query;
  
  if (!callId || !userId) {
    logger.warn(`Missing callId or userId, disconnecting client: ${socket.id}`);
    socket.disconnect();
    return;
  }
  
  logger.info(`User ${userId} joined call ${callId}`);
  
  // Create a room based on callId to group users in the same call
  socket.join(`call:${callId}`);
  
  // Store audio chunks per socket
  const audioChunks = [];
  
  // Handle individual audio chunks (real-time streaming)
  socket.on('audio_chunk', async (chunk) => {
    try {
      // Store the chunk
      audioChunks.push(chunk);
      
      // Log chunk size for debugging
      logger.debug(`Received audio chunk: ${chunk.size} bytes from ${userId}`);
      
      // For simplicity, we'll process each chunk separately
      // In production, you might want to buffer and only process after silence detection
      processAudioChunk(chunk, socket, callId, userId);
      
    } catch (error) {
      logger.error('Error handling audio chunk:', error);
      socket.emit('error', { message: 'Error processing audio chunk' });
    }
  });
  
  // Handle complete audio utterances (when client sends after speech pause)
  socket.on('audio_data', async (audioBlob) => {
    try {
      logger.info(`Received complete audio utterance: ${audioBlob.size} bytes from ${userId}`);
      processAudioUtterance(audioBlob, socket, callId, userId);
    } catch (error) {
      logger.error('Error handling audio utterance:', error);
      socket.emit('error', { message: 'Error processing audio utterance' });
    }
  });
  
  // Handle disconnections
  socket.on('disconnect', () => {
    logger.info(`Client disconnected: ${socket.id}, user: ${userId}`);
    
    // Clean up any pending files for this user
    cleanupUserTempFiles(userId);
  });
});

/**
 * Process audio data for transcription
 * This is the main entry point for handling raw WebSocket binary audio data
 * 
 * @param {Buffer} audioData - Raw audio buffer received from WebSocket
 * @param {Object} metadata - Metadata for the audio (type, format, etc)
 * @param {string} userId - User ID associated with the audio
 * @param {string} callId - Call ID associated with the audio
 * @param {boolean} useStoredHeader - Whether to use a stored WebM header for this user
 */
async function processAudioForTranscription(audioData, metadata, userId, callId, useStoredHeader = true) {
  try {
    logger.info(`[TRACE] processAudioForTranscription started for user ${userId} in call ${callId}`);
    logger.info(`[TRACE] Audio data size: ${audioData.length} bytes, metadata: ${JSON.stringify(metadata)}`);

    // Skip processing if the audio data is too small (likely just noise)
    if (audioData.length < 1000) {
      logger.warn(`[TRACE] Audio data too small (${audioData.length} bytes), skipping processing`);
      return;
    }
    
    // Create a properly formatted audio buffer by combining stored header with audio data if needed
    let processedAudioData = audioData;
    
    // Handle different audio formats - WebM, MP4, etc.
    const format = metadata.format?.toLowerCase() || 'unknown';
    logger.info(`[TRACE] Processing audio format: ${format} (${metadata.mimeType || 'unknown mime'})`); 
    
    if (useStoredHeader) {
      const headerKey = `${format}-${userId}`;
      const storedHeader = userWebMHeaders.get(headerKey);
      
      if (storedHeader) {
        logger.info(`[TRACE] Using stored ${format} header for user ${userId} (${storedHeader.length} bytes)`);
        // Combine stored header with the current audio data (minus any partial header it might have)
        // Skip first few bytes to avoid duplicate header fragments
        const skipBytes = format === 'mp4' ? 8 : (format === 'webm' ? 16 : 0);
        processedAudioData = Buffer.concat([storedHeader, audioData.slice(Math.min(audioData.length, skipBytes))]);
        logger.info(`[TRACE] Combined audio size: ${processedAudioData.length} bytes`);
      } else {
        // This might be the first chunk - store its header for future use
        // Different header sizes for different formats
        const headerSize = format === 'mp4' ? 8192 : (format === 'webm' ? WEBM_HEADER_SIZE : 4096);
        
        if (audioData.length >= headerSize) {
          const headerPortion = audioData.slice(0, headerSize);
          userWebMHeaders.set(headerKey, headerPortion);
          logger.info(`[TRACE] Stored ${format} header (${headerPortion.length} bytes) for user ${userId}`);
        }
      }
    }
    
    // Save the processed audio data to a temporary file
    const tempFilePath = path.join(tempDir, `${userId}-${uuidv4()}.${metadata.format || 'webm'}`);
    logger.info(`[TRACE] Saving audio data to temp file: ${tempFilePath}`);
    
    try {
      // Write the buffer directly to file
      await fs.writeFile(tempFilePath, processedAudioData);
      logger.info(`[TRACE] Successfully wrote ${processedAudioData.length} bytes to ${tempFilePath}`);
      
      // Verify file exists and has correct size
      const stats = await fs.stat(tempFilePath);
      logger.info(`[TRACE] File stats: exists=${stats.isFile()}, size=${stats.size} bytes`);
      
      if (!stats.isFile() || stats.size === 0) {
        throw new Error(`File write failed or empty file: ${tempFilePath}`);
      }
    } catch (fileError) {
      logger.error(`[TRACE] Error writing audio file: ${fileError.message}`, { error: fileError });
      throw fileError;
    }
    
    // Detect audio format and convert if needed
    logger.info(`[TRACE] Detecting audio format for ${tempFilePath}`);
    let audioFormat;
    try {
      audioFormat = await detectAudioFormat(tempFilePath);
      logger.info(`[TRACE] Detected audio format: ${audioFormat}`);
    } catch (formatError) {
      logger.error(`[TRACE] Error detecting audio format: ${formatError.message}`, { error: formatError });
      throw formatError;
    }
    
    // Get a path to an audio file ready for transcription (may be converted)
    logger.info(`[TRACE] Converting audio format if needed`);
    let processedFilePath;
    try {
      processedFilePath = await convertAudioFormatIfNeeded(tempFilePath, audioFormat);
      logger.info(`[TRACE] Processed file path: ${processedFilePath}, is converted=${processedFilePath !== tempFilePath}`);
    } catch (conversionError) {
      logger.error(`[TRACE] Error converting audio format: ${conversionError.message}`, { error: conversionError });
      throw conversionError;
    }
    
    // Call Whisper API for transcription
    logger.info(`[TRACE] Calling Whisper API for transcription with file: ${processedFilePath}`);
    let transcription;
    try {
      transcription = await transcribeAudio(processedFilePath);
      logger.info(`[TRACE] Whisper API response received: ${JSON.stringify(transcription)}`);
    } catch (transcriptionError) {
      logger.error(`[TRACE] Error calling Whisper API: ${transcriptionError.message}`, { error: transcriptionError });
      throw transcriptionError;
    }
    
    if (transcription && transcription.text) {
      logger.info(`[TRACE] Successfully transcribed audio: "${transcription.text}"`);
      
      // Broadcast transcription to all clients in the call
      logger.info(`[TRACE] Broadcasting transcription to all WebSocket clients in call: ${callId}`);
      try {
        // Find all clients connected to this call
        wss.clients.forEach((client) => {
          // Send to all clients in the same call
          if (client.callId === callId && client.readyState === WebSocket.OPEN) {
            // Send transcription result
            client.send(JSON.stringify({
              type: 'transcription',
              data: {
                text: transcription.text,
                userId: userId,
                isFinal: true,
                timestamp: Date.now()
              }
            }));
            
            // Optionally handle translation if enabled
            if (process.env.ENABLE_TRANSLATION === 'true') {
              translateText(transcription.text, 'auto', 'en')
                .then(translatedText => {
                  // Send translation
                  client.send(JSON.stringify({
                    type: 'translation',
                    data: {
                      sender_id: userId,
                      original_text: transcription.text,
                      original_language: 'auto',
                      translated_text: translatedText,
                      target_language: 'en'
                    }
                  }));
                  
                  // Optionally synthesize speech from translated text
                  if (process.env.ENABLE_TTS === 'true') {
                    synthesizeSpeech(translatedText, 'en')
                      .then(audioBuffer => {
                        // First send metadata
                        client.send(JSON.stringify({
                          type: 'audio',
                          data: {
                            size: audioBuffer.length,
                            userId: userId,
                            format: 'audio/wav'
                          }
                        }));
                        
                        // Then send binary audio data
                        client.send(audioBuffer);
                      })
                      .catch(ttsError => {
                        logger.error('Error in text-to-speech:', ttsError);
                      });
                  }
                })
                .catch(translationError => {
                  logger.error('Error in translation:', translationError);
                });
            }
          }
        });
      } catch (broadcastError) {
        logger.error(`[TRACE] Error broadcasting transcription: ${broadcastError.message}`, { error: broadcastError });
      }
    } else {
      logger.warn(`[TRACE] No transcription text returned from Whisper API`);
    }
    
    // Cleanup temp files
    logger.info(`[TRACE] Cleaning up temporary files`);
    try {
      await fs.remove(tempFilePath);
      logger.info(`[TRACE] Removed temp file: ${tempFilePath}`);
      
      if (processedFilePath !== tempFilePath) {
        await fs.remove(processedFilePath);
        logger.info(`[TRACE] Removed processed file: ${processedFilePath}`);
      }
    } catch (cleanupError) {
      logger.error(`[TRACE] Error cleaning up temp files: ${cleanupError.message}`, { error: cleanupError });
    }
  } catch (error) {
    logger.error(`[TRACE] Error in processAudioForTranscription: ${error.message}`, { 
      error,
      stack: error.stack,
      callId,
      userId
    });
    
    // Re-throw to be handled by the caller
    throw error;
  }
}

/**
 * Process individual audio chunks
 * For real-time low-latency transcription
 */
async function processAudioChunk(audioData, socket, callId, userId) {
  try {
    logger.info(`[TRACE] processAudioChunk started for user ${userId} in call ${callId}`);
    logger.info(`[TRACE] Audio chunk size: ${audioData.length} bytes`);
    
    // For real chunks, we would typically buffer until we have enough for transcription
    // This is a simplified version for demonstration
    // If audio chunks are too small, Whisper API may not work well
    
    // Skip processing chunks that are too small (likely not enough speech data)
    if (audioData.length < 10000) { // Adjust threshold as needed
      logger.debug(`Audio chunk too small (${audioData.length} bytes), skipping processing`);
      return;
    }
    
    // Log that we're continuing with processing
    logger.info(`[TRACE] Audio chunk size sufficient, continuing with processing`);
    
    // Save the chunk to a temporary file
    const tempFilePath = path.join(tempDir, `${userId}-${uuidv4()}.webm`);
    logger.info(`[TRACE] Saving audio chunk to temp file: ${tempFilePath}`);
    
    try {
      // Write the buffer directly to file
      await fs.writeFile(tempFilePath, audioData);
      logger.info(`[TRACE] Successfully wrote ${audioData.length} bytes to ${tempFilePath}`);
      
      // Verify file exists and has correct size
      const stats = await fs.stat(tempFilePath);
      logger.info(`[TRACE] File stats: exists=${stats.isFile()}, size=${stats.size} bytes`);
      
      if (!stats.isFile() || stats.size === 0) {
        throw new Error(`File write failed or empty file: ${tempFilePath}`);
      }
    } catch (fileError) {
      logger.error(`[TRACE] Error writing audio file: ${fileError.message}`, { error: fileError });
      throw fileError; // Re-throw to be caught by the outer try-catch
    }
    
    // Detect audio format and convert if needed
    logger.info(`[TRACE] Detecting audio format for ${tempFilePath}`);
    let audioFormat;
    try {
      audioFormat = await detectAudioFormat(tempFilePath);
      logger.info(`[TRACE] Detected audio format: ${audioFormat}`);
    } catch (formatError) {
      logger.error(`[TRACE] Error detecting audio format: ${formatError.message}`, { error: formatError });
      throw formatError;
    }
    
    // Get a path to an audio file ready for transcription (may be converted)
    logger.info(`[TRACE] Converting audio format if needed`);
    let processedFilePath;
    try {
      processedFilePath = await convertAudioFormatIfNeeded(tempFilePath, audioFormat);
      logger.info(`[TRACE] Processed file path: ${processedFilePath}, is converted=${processedFilePath !== tempFilePath}`);
    } catch (conversionError) {
      logger.error(`[TRACE] Error converting audio format: ${conversionError.message}`, { error: conversionError });
      throw conversionError;
    }
    
    // Call Whisper API for transcription
    logger.info(`[TRACE] Calling Whisper API for transcription with file: ${processedFilePath}`);
    let transcription;
    try {
      transcription = await transcribeAudio(processedFilePath);
      logger.info(`[TRACE] Whisper API response received: ${JSON.stringify(transcription)}`);
    } catch (transcriptionError) {
      logger.error(`[TRACE] Error calling Whisper API: ${transcriptionError.message}`, { error: transcriptionError });
      throw transcriptionError;
    }
    
    if (transcription && transcription.text) {
      logger.info(`[TRACE] Successfully transcribed audio: "${transcription.text}"`);
      
      // Send transcription result to all WebSocket clients in this call
      logger.info(`[TRACE] Broadcasting transcription to all WebSocket clients in call: ${callId}`);
      try {
        // Create the transcription message
        const transcriptionMessage = JSON.stringify({
          type: 'transcription',
          data: {
            text: transcription.text,
            userId: userId,
            isFinal: false,
            timestamp: Date.now()
          }
        });
        
        // Broadcast to all connected WebSocket clients in the same call
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN && client.callId === callId) {
            try {
              client.send(transcriptionMessage);
              logger.info(`[TRACE] Sent transcription to client ${client.userId}`);
            } catch (clientError) {
              logger.error(`[TRACE] Error sending to specific client: ${clientError.message}`);
            }
          }
        });
        
        logger.info(`[TRACE] Successfully broadcasted transcription to call`);
      } catch (broadcastError) {
        logger.error(`[TRACE] Error broadcasting transcription: ${broadcastError.message}`, { error: broadcastError });
      }
      
      // Cleanup temp files
      logger.info(`[TRACE] Cleaning up temporary files`);
      try {
        await fs.remove(tempFilePath);
        logger.info(`[TRACE] Removed temp file: ${tempFilePath}`);
        
        if (processedFilePath !== tempFilePath) {
          await fs.remove(processedFilePath);
          logger.info(`[TRACE] Removed processed file: ${processedFilePath}`);
        }
      } catch (cleanupError) {
        logger.error(`[TRACE] Error cleaning up temp files: ${cleanupError.message}`, { error: cleanupError });
      }
    } else {
      logger.warn(`[TRACE] No transcription text returned from Whisper API`);
    }
  } catch (error) {
    logger.error('Error processing audio chunk:', error);
    socket.emit('error', { message: 'Failed to transcribe audio chunk' });
  }
}

/**
 * Process complete audio utterances
 * For higher quality transcription of full sentences
 */
async function processAudioUtterance(audioBlob, socket, callId, userId) {
  try {
    // Save the audio blob to a temporary file
    const tempFilePath = path.join(tempDir, `${userId}-${uuidv4()}.webm`);
    
    // Write audio buffer directly to file
    await fs.writeFile(tempFilePath, Buffer.from(await audioBlob.arrayBuffer()));
    
    // Detect audio format and convert if needed
    const audioFormat = await detectAudioFormat(tempFilePath);
    logger.debug(`Detected audio format for utterance: ${audioFormat}`);
    
    // Convert audio if needed
    const processedFilePath = await convertAudioFormatIfNeeded(tempFilePath, audioFormat);
    
    // Call Whisper API for transcription
    const transcription = await transcribeAudio(processedFilePath);
    
    if (transcription && transcription.text) {
      logger.info(`Transcription for utterance: "${transcription.text}"`);
      
      // Send transcription result to the client
      socket.emit('transcription', {
        text: transcription.text,
        isFinal: true
      });
      
      // Also broadcast to all users in the call
      socket.to(`call:${callId}`).emit('transcription', {
        text: transcription.text,
        userId: userId,
        isFinal: true
      });
      
      // Optionally handle translation if enabled
      if (process.env.ENABLE_TRANSLATION === 'true') {
        try {
          const translatedText = await translateText(transcription.text, 'auto', 'en');
          
          socket.emit('translation', {
            originalText: transcription.text,
            translatedText: translatedText,
            targetLanguage: 'en'
          });
          
          // Also broadcast to all users in the call
          socket.to(`call:${callId}`).emit('translation', {
            originalText: transcription.text,
            translatedText: translatedText,
            targetLanguage: 'en',
            userId: userId
          });
          
          // Optionally synthesize speech from translated text
          if (process.env.ENABLE_TTS === 'true') {
            const audioBuffer = await synthesizeSpeech(translatedText, 'en');
            
            socket.emit('audio', audioBuffer);
            // Also broadcast to all users in the call
            socket.to(`call:${callId}`).emit('audio', audioBuffer);
          }
        } catch (translationError) {
          logger.error('Error in translation:', translationError);
        }
      }
      
      // Cleanup temp files
      await fs.remove(tempFilePath);
      if (processedFilePath !== tempFilePath) {
        await fs.remove(processedFilePath);
      }
    }
  } catch (error) {
    logger.error('Error processing audio utterance:', error);
    socket.emit('error', { message: 'Failed to transcribe audio utterance' });
  }
}

/**
 * Process complete audio utterances from WebSocket connections
 * For higher quality transcription of full sentences
 */
async function processCompleteUtterance(audioData, callId, userId) {
  try {
    logger.info(`[TRACE] processCompleteUtterance started for user ${userId} in call ${callId}`);
    logger.info(`[TRACE] Complete utterance size: ${audioData.length} bytes`);
    
    // Skip processing if the audio data is too small
    if (audioData.length < 1000) { // Adjust threshold as needed
      logger.warn(`[TRACE] Audio too small (${audioData.length} bytes), skipping processing`);
      return;
    }
    
    logger.info(`[TRACE] Audio size sufficient for processing`);
    
    // Log that we're continuing with processing
    logger.info(`[TRACE] Audio chunk size sufficient, continuing with processing`);
    
    // Save the chunk to a temporary file
    const tempFilePath = path.join(tempDir, `${userId}-${uuidv4()}.webm`);
    logger.info(`[TRACE] Saving complete utterance to temp file: ${tempFilePath}`);
    
    try {
      // Write the buffer directly to file
      await fs.writeFile(tempFilePath, audioData);
      logger.info(`[TRACE] Successfully wrote ${audioData.length} bytes to ${tempFilePath}`);
      
      // Verify file exists and has correct size
      const stats = await fs.stat(tempFilePath);
      logger.info(`[TRACE] File stats: exists=${stats.isFile()}, size=${stats.size} bytes`);
      
      if (!stats.isFile() || stats.size === 0) {
        throw new Error(`File write failed or empty file: ${tempFilePath}`);
      }
    } catch (fileError) {
      logger.error(`[TRACE] Error writing audio file: ${fileError.message}`, { error: fileError });
      throw fileError; // Re-throw to be caught by the outer try-catch
    }
    
    // Detect audio format and convert if needed
    logger.info(`[TRACE] Detecting audio format for ${tempFilePath}`);
    let audioFormat;
    try {
      audioFormat = await detectAudioFormat(tempFilePath);
      logger.info(`[TRACE] Detected audio format: ${audioFormat}`);
    } catch (formatError) {
      logger.error(`[TRACE] Error detecting audio format: ${formatError.message}`, { error: formatError });
      throw formatError;
    }
    
    // Get a path to an audio file ready for transcription (may be converted)
    logger.info(`[TRACE] Converting audio format if needed`);
    let processedFilePath;
    try {
      processedFilePath = await convertAudioFormatIfNeeded(tempFilePath, audioFormat);
      logger.info(`[TRACE] Processed file path: ${processedFilePath}, is converted=${processedFilePath !== tempFilePath}`);
    } catch (conversionError) {
      logger.error(`[TRACE] Error converting audio format: ${conversionError.message}`, { error: conversionError });
      throw conversionError;
    }
    
    // Call Whisper API for transcription
    logger.info(`[TRACE] Calling Whisper API for transcription with file: ${processedFilePath}`);
    let transcription;
    try {
      transcription = await transcribeAudio(processedFilePath);
      logger.info(`[TRACE] Whisper API response received: ${JSON.stringify(transcription)}`);
    } catch (transcriptionError) {
      logger.error(`[TRACE] Error calling Whisper API: ${transcriptionError.message}`, { error: transcriptionError });
      throw transcriptionError;
    }
    
    if (transcription && transcription.text) {
      logger.info(`[TRACE] Successfully transcribed audio: "${transcription.text}"`);
      
      // Find all clients connected to this call
      wss.clients.forEach((client) => {
        // Send to all clients in the same call
        if (client.callId === callId && client.readyState === WebSocket.OPEN) {
          // Send transcription result
          client.send(JSON.stringify({
            type: 'transcription',
            data: {
              text: transcription.text,
              userId: userId,
              isFinal: true
            }
          }));
          
          // Optionally handle translation if enabled
          if (process.env.ENABLE_TRANSLATION === 'true') {
            translateText(transcription.text, 'auto', 'en')
              .then(translatedText => {
                // Send translation
                client.send(JSON.stringify({
                  type: 'translation',
                  data: {
                    sender_id: userId,
                    original_text: transcription.text,
                    original_language: 'auto',
                    translated_text: translatedText,
                    target_language: 'en'
                  }
                }));
                
                // Optionally synthesize speech from translated text
                if (process.env.ENABLE_TTS === 'true') {
                  synthesizeSpeech(translatedText, 'en')
                    .then(audioBuffer => {
                      // First send metadata
                      client.send(JSON.stringify({
                        type: 'audio',
                        data: {
                          size: audioBuffer.length,
                          userId: userId,
                          format: 'audio/wav'
                        }
                      }));
                      
                      // Then send binary audio data
                      client.send(audioBuffer);
                    })
                    .catch(ttsError => {
                      logger.error('Error in text-to-speech:', ttsError);
                    });
                }
              })
              .catch(translationError => {
                logger.error('Error in translation:', translationError);
              });
          }
        }
      });
      
      // Cleanup temp files
      await fs.remove(tempFilePath);
      if (processedFilePath !== tempFilePath) {
        await fs.remove(processedFilePath);
      }
    }
  } catch (error) {
    logger.error(`[TRACE] Error processing audio: ${error.message}`, { 
      error,
      stack: error.stack,
      callId,
      userId
    });
    
    // Attempt to clean up any temporary files
    if (tempFilePath) {
      try {
        logger.info(`[TRACE] Cleaning up temp file after error: ${tempFilePath}`);
        await fs.remove(tempFilePath);
        logger.info(`[TRACE] Successfully removed temp file after error`);
      } catch (cleanupError) {
        logger.error(`[TRACE] Error cleaning up temp file: ${cleanupError.message}`, { error: cleanupError });
      }
    }
  }
}

/**
 * Clean up any temporary files associated with a user
 */
function cleanupUserTempFiles(userId) {
  try {
    const userFiles = fs.readdirSync(tempDir)
      .filter(file => file.startsWith(userId));
    
    userFiles.forEach(file => {
      fs.removeSync(path.join(tempDir, file));
    });
    
    if (userFiles.length > 0) {
      logger.info(`Cleaned up ${userFiles.length} temporary files for user ${userId}`);
    }
  } catch (error) {
    logger.error(`Error cleaning up files for user ${userId}:`, error);
  }
}

// Environment variables
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  logger.info(`VerbyFlow backend server running on port ${PORT}`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down server...');
  io.close();
  server.close(() => {
    logger.info('Server has been shut down');
    process.exit(0);
  });
});
