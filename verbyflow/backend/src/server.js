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
    
    // Send a confirmation message after connection
    try {
      ws.send(JSON.stringify({
        type: 'connection_established',
        data: { timestamp: Date.now(), userId, callId }
      }));
    } catch (sendError) {
      logger.error('Error sending welcome message:', sendError);
    }
  
  // Store connection info
  ws.callId = callId;
  ws.userId = userId;
  
  // Track metadata for incoming binary messages using a map with message IDs
  // This allows us to handle out-of-order message delivery
  const pendingMetadataMap = new Map();
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
      // Check if the message is binary (audio data) or string (metadata)
      if (message instanceof Buffer) {
        logger.info(`[TRACE] Received binary WebSocket message: ${message.length} bytes from user ${userId} in call ${callId}`);
        
        // Find the newest pending metadata - we're now using a map to handle out-of-order messages
        // For binary messages without message IDs, we'll use the most recent metadata
        let latestMetadata = null;
        let latestTimestamp = 0;
        
        logger.info(`[TRACE] Current pending metadata count: ${pendingMetadataMap.size}`);
        
        // Find the most recent pending metadata if we have multiple
        for (const [id, metadata] of pendingMetadataMap.entries()) {
          logger.info(`[TRACE] Found pending metadata with ID ${id}, type ${metadata.type}, timestamp ${metadata.timestamp}`);
          if (metadata.timestamp > latestTimestamp) {
            latestMetadata = metadata;
            latestTimestamp = metadata.timestamp;
          }
        }
        
        // If we have metadata, process the binary data
        if (latestMetadata) {
          logger.info(`[TRACE] Found matching metadata (type: ${latestMetadata.type}) for binary data of ${message.length} bytes`);
          
          // Process the audio data based on the type
          switch (latestMetadata.type) {
            case 'audio_chunk':
              logger.info(`[TRACE] Processing as audio_chunk`);
              // Process as streaming audio chunk
              try {
                processAudioChunk(message, { id: `ws-${userId}` }, callId, userId);
              } catch (processingError) {
                logger.error(`[TRACE] Error processing audio chunk: ${processingError.message}`, { error: processingError });
              }
              break;
              
            case 'audio_data':
              logger.info(`[TRACE] Processing as audio_data (complete utterance)`);
              // Process as complete utterance
              try {
                processCompleteUtterance(message, callId, userId);
              } catch (processingError) {
                logger.error(`[TRACE] Error processing complete utterance: ${processingError.message}`, { error: processingError });
              }
              break;
              
            default:
              logger.warn(`[TRACE] Unknown audio message type: ${latestMetadata.type}`);
          }
          
          // Clear this metadata from the map
          if (latestMetadata.messageId) {
            logger.info(`[TRACE] Removing used metadata with ID ${latestMetadata.messageId} from map`);
            pendingMetadataMap.delete(latestMetadata.messageId);
          }
          
          // Also clear any old metadata (older than 10 seconds) to prevent memory leaks
          const now = Date.now();
          let clearedCount = 0;
          for (const [id, metadata] of pendingMetadataMap.entries()) {
            if (now - metadata.timestamp > 10000) {
              pendingMetadataMap.delete(id);
              clearedCount++;
            }
          }
          if (clearedCount > 0) {
            logger.info(`[TRACE] Cleared ${clearedCount} stale metadata entries`);
          }
        } else {
          logger.warn(`[TRACE] Received binary data (${message.length} bytes) without metadata, ignoring`);
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
          if (data.type === 'join') {
            logger.info(`[TRACE] Processing join message for user ${data.data?.userId} in call ${data.data?.callId}`);
          } else if (data.type === 'audio_chunk' || data.type === 'audio_data') {
            logger.info(`[TRACE] Received ${data.type} metadata, awaiting binary data...`);
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
    logger.info(`[TRACE] WebSocket connection closed for user ${userId} with code ${code}: ${reason || 'No reason provided'}`);
    
    // Log statistics about remaining connections
    logger.info(`[TRACE] Active WebSocket connections remaining: ${wss.clients.size - 1}`);
    
    // Remove from active connections
    wss.clients.forEach((client) => {
      if (client.callId === callId && client.userId === userId) {
        client.terminate();
      }
    });
    
    // Clear any pending metadata for this connection
    logger.info(`[TRACE] Clearing any pending metadata entries for closed connection`);
    let clearedEntries = 0;
    for (const [id, metadata] of pendingMetadataMap.entries()) {
      // If we had user-specific metadata, we could clear it here
      // For now, we'll just log the count of remaining entries
      clearedEntries++;
    }
    logger.info(`[TRACE] WebSocket connection cleanup complete`);
  });

  // Error handling for WebSocket
  ws.on('error', (error) => {
    logger.error(`[TRACE] WebSocket error for user ${userId}: ${error.message}`, { 
      error,
      stack: error.stack,
      callId,
      userId,
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
      
      // Send transcription result to the client
      logger.info(`[TRACE] Emitting transcription to socket.io client: ${socket.id}`);
      try {
        socket.emit('transcription', {
          text: transcription.text,
          isFinal: false
        });
        logger.info(`[TRACE] Successfully emitted transcription to socket`);
      } catch (socketError) {
        logger.error(`[TRACE] Error sending transcription to socket: ${socketError.message}`, { error: socketError });
      }
      
      // Optionally also broadcast to all users in the call
      logger.info(`[TRACE] Broadcasting transcription to all users in call: ${callId}`);
      try {
        socket.to(`call:${callId}`).emit('transcription', {
          text: transcription.text,
          userId: userId,
          isFinal: false
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
require('dotenv').config();
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
