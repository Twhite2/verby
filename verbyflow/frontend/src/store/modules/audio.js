// Audio handling module with WebSocket communication

const audio = {
  namespaced: true,
  
  state: {
    audioContext: null,
    audioStream: null,
    mediaRecorder: null,
    isRecording: false,
    isMuted: false,
    currentOutputLevel: 0,
    currentInputLevel: 0,
    audioFormat: 'mp4',
    audioMimeType: 'audio/mp4',
    audioHeader: null,
    hasDetectedHeader: false,
    // For Web Audio API streaming
    audioSourceNodes: {}, // Store audio source nodes by userId
    audioBufferQueue: {}, // Queue of audio buffers to play by userId
    isPlayingAudio: {}, // Track if currently playing audio by userId,
    reconnectingWebSocket: false,  // Flag to indicate reconnection is in progress
    reconnectAttempts: 0,          // Count of reconnection attempts for backoff
    lastKnownUserId: null,         // Store userId for reconnection
    lastKnownCallId: null,         // Store callId for reconnection
    inputAudioLevel: 0,
    websocket: null,
    websocketConnected: false,
    outputAudioLevel: 0,
    transcription: '',
    mimeType: null,
    pingInterval: null,  // Interval for WebSocket health check pings
    
    // Voice activity detection settings
    vadSensitivity: 3,      // 1-5 sensitivity scale
    pauseThreshold: 1000,   // ms of silence to consider a natural pause
    silenceThreshold: 0.05, // amplitude threshold for silence
    
    // Audio buffer for natural pause detection
    audioBuffer: [],
    isSpeaking: false,
    silenceStart: null
  },
  
  getters: {
    isRecording: state => state.isRecording,
    websocketConnected: state => state.websocketConnected,
    inputAudioLevel: state => state.inputAudioLevel,
    outputAudioLevel: state => state.outputAudioLevel,
    transcription: state => state.transcription,
    isMuted: state => state.isMuted,
    isSpeaking: state => state.isSpeaking
  },
  
  mutations: {
    SET_RECORDING_STATE(state, isRecording) {
      state.isRecording = isRecording;
    },
    SET_AUDIO_CONTEXT(state, context) {
      state.audioContext = context;
    },
    SET_MEDIA_RECORDER(state, recorder) {
      state.mediaRecorder = recorder;
    },
    SET_AUDIO_STREAM(state, stream) {
      state.audioStream = stream;
    },
    SET_WEBSOCKET(state, websocket) {
      state.websocket = websocket;
    },
    SET_WEBSOCKET_CONNECTED(state, connected) {
      state.websocketConnected = connected;
    },
    SET_INPUT_AUDIO_LEVEL(state, level) {
      state.inputAudioLevel = level;
    },
    SET_OUTPUT_AUDIO_LEVEL(state, level) {
      state.outputAudioLevel = level;
    },
    
    SET_CURRENT_AUDIO_FORMAT(state, format) {
      state.mimeType = format === 'mp4' ? 'audio/mp4' : 'audio/webm';
    },
    
    SET_AUDIO_MIME_TYPE(state, mimeType) {
      state.mimeType = mimeType;
    },
    SET_TRANSCRIPTION(state, text) {
      state.transcription = text;
    },
    SET_MUTED(state, muted) {
      state.isMuted = muted;
    },
    SET_SPEAKING(state, isSpeaking) {
      state.isSpeaking = isSpeaking;
      if (isSpeaking) {
        state.silenceStart = null;
      } else {
        state.silenceStart = Date.now();
      }
    },
    
    SET_RECONNECTING_WEBSOCKET(state, isReconnecting) {
      state.reconnectingWebSocket = isReconnecting;
      // Reset or increment reconnect attempts counter
      if (!isReconnecting) {
        state.reconnectAttempts = 0;
      } else {
        state.reconnectAttempts++;
      }
    },
    
    SET_LAST_KNOWN_USER_ID(state, userId) {
      state.lastKnownUserId = userId;
    },
    
    SET_LAST_KNOWN_CALL_ID(state, callId) {
      state.lastKnownCallId = callId;
    },
    ADD_AUDIO_BUFFER(state, chunk) {
      state.audioBuffer.push(chunk);
    },
    CLEAR_AUDIO_BUFFER(state) {
      state.audioBuffer = [];
    },
    CLEAR_AUDIO_STATE(state) {
      // Stop any active recording
      if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
        state.mediaRecorder.stop();
      }
      
      // Stop all audio tracks
      if (state.audioStream) {
        state.audioStream.getTracks().forEach(track => track.stop());
      }
      
      // Clear any existing ping interval
      if (state.pingInterval) {
        clearInterval(state.pingInterval);
        state.pingInterval = null;
      }
      
      // Close WebSocket connection
      if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
        state.websocket.close();
      }
      
      // Reset state values
      state.isRecording = false;
      state.audioContext = null;
      state.mediaRecorder = null;
      state.audioStream = null;
      state.websocket = null;
      state.websocketConnected = false;
      state.reconnectingWebSocket = false;
      // Don't clear lastKnownUserId and lastKnownCallId to allow reconnection
      state.audioBuffer = [];
      state.isSpeaking = false;
      state.silenceStart = null;
    }
  },
  
  actions: {
    // Play audio using Web Audio API - this works better for streaming audio chunks
    async playAudioWithWebAudio({ commit, state }, { audioData, userId }) {
      try {
        // Make sure we have an audio context
        if (!state.audioContext) {
          const AudioContext = window.AudioContext || window.webkitAudioContext;
          commit('SET_AUDIO_CONTEXT', new AudioContext());
        }
        
        // Create a simple beep sound as notification if needed
        const playBeep = () => {
          try {
            // Create oscillator for simple notification tone
            const oscillator = state.audioContext.createOscillator();
            const gainNode = state.audioContext.createGain();
            
            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(440, state.audioContext.currentTime); // A4 note
            gainNode.gain.setValueAtTime(0.1, state.audioContext.currentTime);
            
            oscillator.connect(gainNode);
            gainNode.connect(state.audioContext.destination);
            
            oscillator.start();
            oscillator.stop(state.audioContext.currentTime + 0.15); // Short beep
            
            // Show brief audio indicator in UI
            commit('SET_OUTPUT_AUDIO_LEVEL', 0.3);
            setTimeout(() => commit('SET_OUTPUT_AUDIO_LEVEL', 0), 150);
            
            console.log('[TRACE] Playing notification beep sound');
            return true;
          } catch (error) {
            console.error('[ERROR] Failed to play notification beep:', error);
            return false;
          }
        };
        
        // Convert the audio data to an ArrayBuffer if it's not already
        let arrayBuffer;
        if (audioData instanceof ArrayBuffer) {
          arrayBuffer = audioData;
        } else if (audioData instanceof Uint8Array) {
          arrayBuffer = audioData.buffer;
        } else {
          // For Blob or other formats
          arrayBuffer = await new Response(audioData).arrayBuffer();
        }
        
        // If buffer is too small, just play a notification
        if (arrayBuffer.byteLength < 10) {
          console.warn('[WARN] Audio data too small, playing notification instead');
          return playBeep();
        }
        
        // Try to decode the audio data
        try {
          const audioBuffer = await state.audioContext.decodeAudioData(arrayBuffer).catch(e => {
            console.warn('[WARN] Could not decode audio data:', e);
            throw e; // Rethrow to trigger fallbacks
          });
          
          // Create buffer source
          const source = state.audioContext.createBufferSource();
          source.buffer = audioBuffer;
          
          // Add analyzer for level monitoring
          const analyser = state.audioContext.createAnalyser();
          analyser.fftSize = 256;
          const dataArray = new Uint8Array(analyser.frequencyBinCount);
          
          // Connect nodes
          source.connect(analyser);
          analyser.connect(state.audioContext.destination);
          
          // Monitor levels during playback
          const monitorLevel = () => {
            if (!state.isPlayingAudio[userId]) return;
            
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (const value of dataArray) {
              sum += value;
            }
            
            const average = sum / dataArray.length;
            const normalizedLevel = average / 255; // 0-1 range
            commit('SET_OUTPUT_AUDIO_LEVEL', normalizedLevel);
            
            requestAnimationFrame(monitorLevel);
          };
          
          // Start audio playback
          state.isPlayingAudio = state.isPlayingAudio || {};
          state.isPlayingAudio[userId] = true;
          source.start();
          monitorLevel();
          
          // Set up completion handler
          source.onended = () => {
            state.isPlayingAudio[userId] = false;
            commit('SET_OUTPUT_AUDIO_LEVEL', 0);
            console.log('[TRACE] Audio chunk playback finished');
          };
          
          console.log('[TRACE] Successfully playing decoded audio chunk');
          return true;
        } catch (decodeError) {
          // If we can't decode the audio, try playing a notification
          console.warn('[WARN] Failed to decode audio chunk, playing notification instead:', decodeError);
          return playBeep();
        }
      } catch (error) {
        console.error('[ERROR] Failed to play audio chunk with Web Audio API:', error);
        return false;
      }
    },
    // Initialize audio context and get microphone access
    async initializeAudio({ commit, state }) {
      console.log('[TRACE] Initializing audio subsystem');
      
      try {
        if (!state.audioContext) {
          const audioContext = new (window.AudioContext || window.webkitAudioContext)();
          commit('SET_AUDIO_CONTEXT', audioContext);
        }
        
        if (!state.audioStream) {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true
            },
            video: false
          });
          
          commit('SET_AUDIO_STREAM', stream);
          console.log('[TRACE] Audio stream initialized');
          
          // Set up audio level monitoring
          const audioContext = state.audioContext;
          const source = audioContext.createMediaStreamSource(stream);
          const analyser = audioContext.createAnalyser();
          analyser.fftSize = 256;
          
          source.connect(analyser);
          
          const dataArray = new Uint8Array(analyser.frequencyBinCount);
          
          const monitorAudioLevel = () => {
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (const value of dataArray) {
              sum += value;
            }
            
            const average = sum / dataArray.length;
            const normalizedLevel = average / 255; // Normalize to 0-1
            commit('SET_INPUT_AUDIO_LEVEL', normalizedLevel);
            
            // Voice activity detection
            if (state.isRecording && !state.isMuted) {
              if (normalizedLevel > state.silenceThreshold) {
                if (!state.isSpeaking) {
                  commit('SET_SPEAKING', true);
                  console.log('[TRACE] Speech detected');
                }
              } else if (state.isSpeaking && state.silenceStart === null) {
                commit('SET_SPEAKING', false);
                console.log('[TRACE] Silence detected');
              }
            }
            
            requestAnimationFrame(monitorAudioLevel);
          };
          
          monitorAudioLevel();
        }
        
        return true;
      } catch (error) {
        console.error('[ERROR] Audio initialization failed:', error);
        return false;
      }
    },
    
    // Setup WebSocket connection
    setupWebSocket({ commit, state, rootState, dispatch }, params) {
      console.log('[TRACE] Setting up WebSocket connection');
      
      return new Promise((resolve, reject) => {
        try {
          // Check if params has userId and callId, otherwise fall back to rootState or last known values
          // This handles both direct parameter passing and rootState access
          const userId = params?.userId || rootState.user?.id || state.lastKnownUserId;
          const callId = params?.callId || rootState.call?.callId || state.lastKnownCallId;
          const token = rootState.auth?.token || '';
          
          // Ensure required data is available
          if (!userId || !callId) {
            const error = new Error('Missing required data for WebSocket connection');
            console.error('[ERROR]', error);
            dispatch('showError', 'Missing call or user information', { root: true });
            reject(error);
            return;
          }
          
          // Store user and call IDs for reconnection
          commit('SET_LAST_KNOWN_USER_ID', userId);
          commit('SET_LAST_KNOWN_CALL_ID', callId);
          
          // Clean up existing connection and interval
          if (state.websocket) {
            try {
              state.websocket.close(1000, 'Normal closure - setting up new connection');
            } catch (e) {
              console.warn('[WARN] Error closing existing WebSocket:', e);
            }
          }
          
          if (state.pingInterval) {
            clearInterval(state.pingInterval);
            commit('SET_PING_INTERVAL', null);
          }
          
          // Generate WebSocket URL
          const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
          const baseUrl = process.env.VUE_APP_API_URL || window.location.origin;
          
          // Parse hostname from baseUrl without port
          let hostname = baseUrl;
          // Remove protocol if present
          hostname = hostname.replace(/^https?:\/\//i, '');
          // Remove port if present by splitting on colon and taking first part
          hostname = hostname.split(':')[0];
          
          // Explicitly use port 3000 for WebSocket connections to match the backend server
          let wsUrl = `${protocol}//${hostname}:3000/ws?userId=${userId}&callId=${callId}`;
          
          // Add token only if available
          if (token) {
            wsUrl += `&token=${token}`;
          }
          
          console.log(`[TRACE] Connecting to WebSocket: ${wsUrl}`);
          const socket = new WebSocket(wsUrl);
          socket.binaryType = 'blob'; // For binary audio data
          
          // Set up WebSocket event handlers
          socket.onopen = () => {
            console.log('[TRACE] WebSocket connection established');
            commit('SET_WEBSOCKET_CONNECTED', true);
            commit('SET_WEBSOCKET', socket);
            
            // Ensure user and call IDs are saved for reconnection
            commit('SET_LAST_KNOWN_USER_ID', userId);
            commit('SET_LAST_KNOWN_CALL_ID', callId);
            
            const pingInterval = setInterval(() => {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
                console.log('[TRACE] Sent WebSocket ping');
              } else {
                console.warn('[WARN] WebSocket health check found closed connection');
                dispatch('reconnectWebSocket');
              }
            }, 30000);
            commit('SET_PING_INTERVAL', pingInterval);
            resolve(socket);
          };
          
          socket.onclose = (event) => {
            console.warn(`[WARN] WebSocket connection closed: code=${event.code}, reason=${event.reason}`);
            commit('SET_WEBSOCKET_CONNECTED', false);
            
            // Clear ping interval
            if (state.pingInterval) {
              clearInterval(state.pingInterval);
              commit('SET_PING_INTERVAL', null);
            }
            
            // If not a normal closure, try to reconnect
            if (event.code !== 1000) {
              setTimeout(() => {
                dispatch('reconnectWebSocket');
              }, 3000);
            }
          };
          
          socket.onerror = (error) => {
            console.error('[ERROR] WebSocket error:', error);
            commit('SET_WEBSOCKET_CONNECTED', false);
          };
          
          // Store audio headers for different formats so we can reuse them
          // This implements the user's suggestion to cache the first chunk's header
          const audioHeaderCache = {
            // Predefined minimal MP4 header (ftyp + free atom) that works with most browsers
            mp4: new Uint8Array([
              // ftyp atom
              0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6D, 0x70, 0x34, 0x32, 
              0x00, 0x00, 0x00, 0x00, 0x6D, 0x70, 0x34, 0x32, 0x69, 0x73, 0x6F, 0x6D,
              // free atom
              0x00, 0x00, 0x00, 0x08, 0x66, 0x72, 0x65, 0x65,
              // mdat atom header (beginning)
              0x00, 0x00, 0x00, 0x08, 0x6D, 0x64, 0x61, 0x74
            ]),
            
            // Predefined minimal WebM header
            webm: null, // We'll detect this from actual chunks
            
            initialized: true, // We're providing a default MP4 header
            currentFormat: 'mp4' // Default format if not specified
          };
          
          console.log('[TRACE] Initialized audio header cache with default MP4 header');
          
          // Create audio context for processing
          const audioContext = new (window.AudioContext || window.webkitAudioContext)();
          commit('SET_AUDIO_CONTEXT', audioContext);
          
          // Helper function to play audio with the cached header
          // NOTE: This function is now deprecated - use playAudioWithWebAudio instead
          // It's kept here for backward compatibility
          /* eslint-disable no-unused-vars */
          const playWithCachedHeader = async (audioData, format) => {
            try {
              // Use the specified format or default to the current format
              /* eslint-disable no-unused-vars */
              const audioFormat = format || state.audioFormat || 'mp4';
              /* eslint-enable no-unused-vars */
              
              // Convert the audio data to an ArrayBuffer if it's not already
              const arrayBuffer = audioData instanceof ArrayBuffer ? audioData : await new Response(audioData).arrayBuffer();
              
              // Check if the buffer has enough data to be meaningful
              if (arrayBuffer.byteLength < 2) {
                console.warn('[WARN] Received audio chunk is too small to process:', arrayBuffer.byteLength, 'bytes');
                return false;
              }

              // Try to play directly with a beep sound if decoding fails
              const playBeep = () => {
                // Create a simple beep sound as notification
                const oscillator = state.audioContext.createOscillator();
                const gainNode = state.audioContext.createGain();
                
                oscillator.type = 'sine';
                oscillator.frequency.setValueAtTime(440, state.audioContext.currentTime); // A4 note
                gainNode.gain.setValueAtTime(0.1, state.audioContext.currentTime);
                
                oscillator.connect(gainNode);
                gainNode.connect(state.audioContext.destination);
                
                oscillator.start();
                oscillator.stop(state.audioContext.currentTime + 0.15); // Short beep
                
                commit('SET_OUTPUT_AUDIO_LEVEL', 0.3);
                setTimeout(() => commit('SET_OUTPUT_AUDIO_LEVEL', 0), 150);
                
                console.log('[TRACE] Playing notification beep sound');
                return true;
              };

              // Create a sound source directly from PCM data
              const createAndPlayRawPCM = async () => {
                try {
                  // Create a smaller buffer for the incoming data (assuming 44.1kHz, 16-bit, mono audio)
                  const audioBuffer = state.audioContext.createBuffer(1, arrayBuffer.byteLength / 2, 44100);
                  const channelData = audioBuffer.getChannelData(0);
                  
                  // Convert the raw bytes to float32 samples between -1.0 and 1.0
                  const int16Array = new Int16Array(arrayBuffer);
                  for (let i = 0; i < int16Array.length; i++) {
                    channelData[i] = int16Array[i] / 32768.0; // Convert Int16 to Float32
                  }
                  
                  // Create and play the source
                  const source = state.audioContext.createBufferSource();
                  source.buffer = audioBuffer;
                  
                  // Add a gain node for level control
                  const gainNode = state.audioContext.createGain();
                  gainNode.gain.value = 1.0;
                  
                  // Add an analyzer for level monitoring
                  const analyser = state.audioContext.createAnalyser();
                  analyser.fftSize = 256;
                  const dataArray = new Uint8Array(analyser.frequencyBinCount);
                  
                  // Connect the nodes
                  source.connect(gainNode);
                  gainNode.connect(analyser);
                  analyser.connect(state.audioContext.destination);
                  
                  // Monitor audio level during playback
                  const monitorLevel = () => {
                    if (!source.buffer) return;
                    
                    analyser.getByteFrequencyData(dataArray);
                    let sum = 0;
                    for (const value of dataArray) {
                      sum += value;
                    }
                    
                    const average = sum / dataArray.length;
                    const normalizedLevel = average / 255; // 0-1 range
                    
                    commit('SET_OUTPUT_AUDIO_LEVEL', normalizedLevel);
                    
                    // Continue monitoring if still playing
                    if (state.isPlayingAudio[userId]) {
                      requestAnimationFrame(monitorLevel);
                    } else {
                      commit('SET_OUTPUT_AUDIO_LEVEL', 0);
                    }
                  };
                  
                  // Start monitoring
                  state.isPlayingAudio[userId] = true;
                  monitorLevel();
                  
                  // Start playback
                  source.start();
                  source.onended = () => {
                    state.isPlayingAudio[userId] = false;
                    console.log('[TRACE] Audio chunk playback ended');
                    commit('SET_OUTPUT_AUDIO_LEVEL', 0);
                  };
                  
                  console.log('[TRACE] Playing audio chunk as raw PCM data');
                  return true;
                } catch (pcmError) {
                  console.error('[ERROR] Failed to play as raw PCM:', pcmError);
                  return false;
                }
              };
              
              // Try to decode the audio chunk properly first
              try {
                // Try to decode the audio data
                const audioBuffer = await state.audioContext.decodeAudioData(arrayBuffer)
                  .catch(err => {
                    console.warn('[WARN] Could not decode audio data:', err);
                    throw err; // Rethrow to trigger the fallbacks
                  });
                
                // If decoding succeeded, play the audio
                const source = state.audioContext.createBufferSource();
                source.buffer = audioBuffer;
                
                // Add a gain node for level control
                const gainNode = state.audioContext.createGain();
                gainNode.gain.value = 1.0;
                
                // Add an analyzer for level monitoring
                const analyser = state.audioContext.createAnalyser();
                analyser.fftSize = 256;
                const dataArray = new Uint8Array(analyser.frequencyBinCount);
                
                // Connect the nodes
                source.connect(gainNode);
                gainNode.connect(analyser);
                analyser.connect(state.audioContext.destination);
                
                // Monitor audio level during playback
                const monitorLevel = () => {
                  analyser.getByteFrequencyData(dataArray);
                  let sum = 0;
                  for (const value of dataArray) {
                    sum += value;
                  }
                  
                  const average = sum / dataArray.length;
                  const normalizedLevel = average / 255; // 0-1 range
                  
                  commit('SET_OUTPUT_AUDIO_LEVEL', normalizedLevel);
                  
                  // Continue monitoring if still playing
                  if (state.isPlayingAudio[userId]) {
                    requestAnimationFrame(monitorLevel);
                  }
                };
                
                // Start monitoring
                state.isPlayingAudio[userId] = true;
                monitorLevel();
                
                // Start playback
                source.start();
                source.onended = () => {
                  state.isPlayingAudio[userId] = false;
                  console.log('[TRACE] Audio chunk playback ended');
                  commit('SET_OUTPUT_AUDIO_LEVEL', 0);
                };
                
                console.log('[TRACE] Successfully decoded and playing audio chunk');
                return true;
              } catch (decodeError) {
                console.warn('[WARN] Failed to decode audio chunk, trying raw PCM playback:', decodeError);
                
                // Try raw PCM playback approach
                const pcmSuccess = await createAndPlayRawPCM();
                if (pcmSuccess) return true;
                
                // If all else fails, play a beep sound as notification
                console.log('[TRACE] Could not play with decoded audio, falling back to notification sound');
                return playBeep();
              }
            } catch (error) {
              console.error('[ERROR] Error in playWithCachedHeader:', error);
              return false;
            }
          };
          
          socket.onmessage = async (event) => {
            try {
              // Handle string messages (JSON)
              if (typeof event.data === 'string') {
                try {
                  const data = JSON.parse(event.data);
                  
                  // Handle audio metadata messages
                  if (data.type === 'audio-metadata') {
                    console.log(`[TRACE] Received audio metadata: format=${data.format}, mimeType=${data.mimeType}`);
                    
                    // Update our current audio format based on metadata
                    commit('SET_CURRENT_AUDIO_FORMAT', data.format);
                    
                    // Also store the MIME type
                    commit('SET_AUDIO_MIME_TYPE', data.mimeType);
                    
                    // If we don't have any cached headers yet, we should expect the next chunk to have one
                    if (!audioHeaderCache.initialized) {
                      console.log(`[TRACE] Expecting header in next audio chunk`);
                    }
                    
                    return;
                  }
                  
                  // Handle other JSON messages...
                  // Process other message types (transcriptions, etc.)
                  if (data.type === 'transcription') {
                    commit('SET_TRANSCRIPTION', data.text);
                  } else if (data.type === 'message') {
                    console.log(`[TRACE] Received message: ${data.text}`);
                  } else {
                    console.log('[TRACE] Received unknown WebSocket message type:', data.type);
                  }
                  
                } catch (jsonError) {
                  console.error('[ERROR] Failed to parse WebSocket message:', jsonError);
                }
                return;
              }
              
              // Handle binary audio data
              if (event.data instanceof Blob) {
                console.log(`[TRACE] Received binary audio data: ${event.data.size} bytes`);
                
                try {
                  // Extract metadata if provided by the server
                  const userId = event.userId || 'unknown';
                  
                  // Get the arrayBuffer from the blob
                  const arrayBuffer = await event.data.arrayBuffer();
                  
                  // Check if this is an empty chunk
                  if (arrayBuffer.byteLength === 0) {
                    console.warn('[WARN] Received empty audio chunk, ignoring');
                    return;
                  }
                  
                  // Create a Uint8Array for easier manipulation
                  const audioData = new Uint8Array(arrayBuffer);
                  
                  // Still detect headers for format detection
                  if (arrayBuffer.byteLength > 20) {
                    try {
                      // Use DataView to read header markers
                      const dataView = new DataView(arrayBuffer);
                      
                      // Check for MP4 ftyp signature
                      if (arrayBuffer.byteLength > 8 && 
                          dataView.getUint32(4) === 0x66747970) { // 'ftyp' in ASCII
                        console.log('[TRACE] Detected MP4 header in chunk!');
                        commit('SET_CURRENT_AUDIO_FORMAT', 'mp4');
                      }
                      // Check for WebM EBML signature
                      else if (arrayBuffer.byteLength > 4 && 
                               dataView.getUint32(0) === 0x1A45DFA3) { // WebM starts with this marker
                        console.log('[TRACE] Detected WebM header in chunk!');
                        commit('SET_CURRENT_AUDIO_FORMAT', 'webm');
                      }
                    } catch (headerError) {
                      console.error('[ERROR] Error detecting audio header:', headerError);
                    }
                  }
                  
                  // Use our new Web Audio API playback method - robust against missing headers
                  console.log('[TRACE] Playing audio with Web Audio API');
                  const success = await dispatch('playAudioWithWebAudio', {
                    audioData: audioData,
                    userId: userId
                  });
                  
                  if (!success) {
                    console.warn('[WARN] Failed to play audio with Web Audio API');
                  }
                } catch (error) {
                  console.error('[ERROR] Error processing binary audio data:', error);
                }
                return;
              }
              
              // Handle any other message types (should not occur)
              console.warn('[WARN] Received unknown message type:', event.data);
            } catch (error) {
              console.error('[ERROR] Error processing WebSocket message:', error);
            }
          };
        } catch (error) {
          console.error('[ERROR] Error setting up WebSocket:', error);
          reject(error);
        }
      });
    },
    
    // Start audio recording and streaming
    async startRecording({ commit, state, dispatch }) {
      console.log('[TRACE] Starting audio recording');
      
      if (state.isRecording) {
        console.log('[TRACE] Already recording, ignoring request');
        return;
      }
      
      try {
        // Initialize audio if not already done
        if (!state.audioStream) {
          const success = await dispatch('initializeAudio');
          if (!success) {
            throw new Error('Failed to initialize audio');
          }
        }
        
        // Create MediaRecorder if needed
        if (!state.mediaRecorder) {
          // Determine the best supported mime type
          // Prioritize formats known to work well with Whisper API
          const mimeTypes = [
            'audio/wav',
            'audio/mp4',
            'audio/ogg;codecs=opus',
            'audio/ogg',
            'audio/webm;codecs=opus',
            'audio/webm'
          ];
          
          let mimeType = '';
          for (const type of mimeTypes) {
            if (MediaRecorder.isTypeSupported(type)) {
              mimeType = type;
              break;
            }
          }
          
          if (!mimeType) {
            throw new Error('No supported audio recording mime type found');
          }
          
          state.mimeType = mimeType;
          console.log(`[TRACE] Using MIME type: ${mimeType} for recording`);
          
          const mediaRecorder = new MediaRecorder(state.audioStream, {
            mimeType: mimeType,
            audioBitsPerSecond: 128000
          });
          
          // Set up MediaRecorder event handlers
          mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0 && !state.isMuted) {
              console.log(`[TRACE] Audio data available: ${event.data.size} bytes`);
              
              // Create audio blob from buffer
              const audioBlob = new Blob([event.data], { type: mimeType });
              
              // Check WebSocket connection before attempting to send
              if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
                // Send metadata first with enhanced information
                const metadata = {
                  type: 'audio_data',
                  timestamp: Date.now(),
                  mimeType: mimeType,
                  format: mimeType.split('/')[1].split(';')[0], // Extract format (e.g., 'wav', 'webm')
                  messageId: `audio-${Date.now()}-${Math.floor(Math.random() * 1000)}` // Unique ID
                };
                
                try {
                  console.log(`[TRACE] Sending audio metadata: ${JSON.stringify(metadata)}`);
                  state.websocket.send(JSON.stringify(metadata));
                  
                  // Add a small delay to ensure metadata is received before audio blob
                  setTimeout(() => {
                    try {
                      // Check again before sending audio blob as WebSocket state may have changed
                      if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
                        console.log(`[TRACE] Sending audio blob: ${audioBlob.size} bytes, type: ${audioBlob.type}`);
                        state.websocket.send(audioBlob);
                      } else {
                        console.warn('[WARN] WebSocket not in OPEN state, cannot send audio blob');
                        dispatch('reconnectWebSocket');
                      }
                    } catch (error) {
                      console.error('[ERROR] Failed to send audio blob:', error);
                      dispatch('reconnectWebSocket');
                    }
                  }, 50);
                } catch (error) {
                  console.error('[ERROR] Failed to send metadata:', error);
                  dispatch('reconnectWebSocket');
                }
              } else {
                console.warn('[WARN] WebSocket not in OPEN state, attempting to reconnect');
                dispatch('reconnectWebSocket');
              }
              
              // Add to buffer for pause detection
              commit('ADD_AUDIO_BUFFER', event.data);
              
              // Check for natural pause to send complete utterance
              if (state.silenceStart && (Date.now() - state.silenceStart > state.pauseThreshold) && state.audioBuffer.length > 0) {
                console.log(`[TRACE] Natural pause detected after ${Date.now() - state.silenceStart}ms, sending complete utterance`);
                
                // Combine all buffered chunks into one
                const combinedBlob = new Blob(state.audioBuffer, { type: mimeType });
                
                // Send the complete utterance
                if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
                  // First send metadata
                  const completeMetadata = {
                    type: 'audio_data',
                    timestamp: Date.now(),
                    mimeType: mimeType,
                    isComplete: true,
                    messageId: `audio_complete_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
                  };
                  
                  try {
                    state.websocket.send(JSON.stringify(completeMetadata));
                    
                    // Wait a small amount of time to ensure order
                    setTimeout(() => {
                      try {
                        if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
                          state.websocket.send(combinedBlob);
                          console.log(`[TRACE] Complete utterance sent: ${combinedBlob.size} bytes`);
                        } else {
                          console.warn('[WARN] WebSocket not in OPEN state, cannot send complete utterance');
                          dispatch('reconnectWebSocket');
                        }
                      } catch (error) {
                        console.error('[ERROR] Failed to send complete utterance:', error);
                        dispatch('reconnectWebSocket');
                      }
                    }, 50);
                  } catch (error) {
                    console.error('[ERROR] Failed to send complete utterance metadata:', error);
                    dispatch('reconnectWebSocket');
                  }
                } else {
                  console.warn('[WARN] WebSocket not in OPEN state, cannot send complete utterance');
                  dispatch('reconnectWebSocket');
                }
                
                // Clear the audio buffer after sending
                commit('CLEAR_AUDIO_BUFFER');
              }
            } else {
              console.warn('[WARN] WebSocket not connected or muted, cannot send audio');
            }
          };
          
          // When recording stops, clean up resources
          mediaRecorder.onstop = () => {
            console.log('[TRACE] Recording stopped');
            commit('SET_SPEAKING', false);
            commit('CLEAR_AUDIO_BUFFER');
          };
          
          commit('SET_MEDIA_RECORDER', mediaRecorder);
        }
        
        // Start recording
        commit('SET_RECORDING_STATE', true);
        commit('CLEAR_AUDIO_BUFFER');
        
        const timeslice = 500; // Record in 500ms chunks
        state.mediaRecorder.start(timeslice);
        console.log(`[TRACE] Recording started with timeslice=${timeslice}ms`);
        
        return true;
      } catch (error) {
        console.error('[ERROR] Failed to start recording:', error);
        commit('SET_RECORDING_STATE', false);
        dispatch('showError', `Failed to start recording: ${error.message}`, { root: true });
        return false;
      }
    },
    
    // Stop recording
    stopRecording({ commit, state }) {
      console.log('[TRACE] Stopping recording');
      
      if (!state.isRecording) {
        console.log('[TRACE] Not recording, ignoring stop request');
        return;
      }
      
      if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
        state.mediaRecorder.stop();
        console.log('[TRACE] MediaRecorder stopped');
      }
      
      commit('SET_RECORDING_STATE', false);
      commit('SET_SPEAKING', false);
    },

// Reconnect WebSocket if connection was lost
async reconnectWebSocket({ commit, state, rootState, dispatch }) {
  console.log('[TRACE] Attempting to reconnect WebSocket');
  
  // First make sure we're not already trying to reconnect
  if (state.reconnectingWebSocket) {
    console.log('[TRACE] Already reconnecting, skipping');
    return;
  }
  
  // Get necessary connection data with safe access patterns
  // First try rootState, then fall back to our saved values
  const userId = rootState.user?.userId || rootState.user?.id || state.lastKnownUserId;
  const callId = rootState.call?.callId || state.lastKnownCallId;
  const token = rootState.auth?.token || '';
  
  if (!userId || !callId) {
    console.error('[ERROR] Missing required data for WebSocket reconnection');
    console.log('[DEBUG] userId:', userId, 'callId:', callId, 'lastKnown:', state.lastKnownUserId, state.lastKnownCallId);
    commit('SET_WEBSOCKET_CONNECTED', false);
    return;
  }
  
  // Mark that we're in the process of reconnecting
  commit('SET_RECONNECTING_WEBSOCKET', true);
  
  // Only attempt reconnect if websocket is not already connected or connecting
  if (!state.websocket || state.websocket.readyState === WebSocket.CLOSED || state.websocket.readyState === WebSocket.CLOSING) {
    // Close existing socket if it exists
    if (state.websocket) {
      try {
        state.websocket.close(1000, 'Normal closure - reconnecting');
      } catch (e) {
        console.warn('[WARN] Error closing existing WebSocket:', e);
      }
    }
    
    try {
      // Generate WebSocket URL - use same logic as setupWebSocket
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const baseUrl = process.env.VUE_APP_API_URL || window.location.origin;
      
      // Parse hostname from baseUrl without port
      let hostname = baseUrl;
      // Remove protocol if present
      hostname = hostname.replace(/^https?:\/\//i, '');
      // Remove port if present by splitting on colon and taking first part
      hostname = hostname.split(':')[0];
      
      // Explicitly use port 3000 for WebSocket connections to match the backend server
      let wsUrl = `${protocol}//${hostname}:3000/ws?userId=${userId}&callId=${callId}`;
      
      // Add token only if available
      if (token) {
        wsUrl += `&token=${token}`;
      }
      
      console.log(`[TRACE] Reconnecting to WebSocket: ${wsUrl}`);
      const socket = new WebSocket(wsUrl);
      socket.binaryType = 'blob';
      
      socket.onopen = () => {
        console.log('[TRACE] WebSocket reconnection successful');
        commit('SET_WEBSOCKET_CONNECTED', true);
        commit('SET_WEBSOCKET', socket);
        commit('SET_RECONNECTING_WEBSOCKET', false);
      };
      
      socket.onclose = (event) => {
        console.warn(`[WARN] WebSocket reconnection closed: code=${event.code}, reason=${event.reason}`);
        commit('SET_WEBSOCKET_CONNECTED', false);
        commit('SET_RECONNECTING_WEBSOCKET', false);
        
        // Clear ping interval if it exists
        if (state.pingInterval) {
          clearInterval(state.pingInterval);
          commit('SET_PING_INTERVAL', null);
        }
        
        // Schedule another reconnect after a delay with exponential backoff
        if (event.code !== 1000) { // Not a normal closure
          const backoffDelay = state.reconnectAttempts ? Math.min(3000 * Math.pow(1.5, state.reconnectAttempts), 30000) : 3000;
          console.log(`[TRACE] Will attempt reconnect in ${backoffDelay}ms`);
          
          setTimeout(() => {
            if (!state.websocketConnected) {
              dispatch('reconnectWebSocket');
            }
          }, backoffDelay);
        }
      };
      
      socket.onerror = (error) => {
        console.error('[ERROR] WebSocket reconnection error:', error);
        commit('SET_WEBSOCKET_CONNECTED', false);
        commit('SET_RECONNECTING_WEBSOCKET', false);
      };
      
      // Set up message handler
      socket.onmessage = (event) => {
        // Handle incoming messages
        if (event.data instanceof Blob) {
          console.log('[TRACE] Received binary message, size:', event.data.size);
          // Handle audio blob
          dispatch('playReceivedAudio', event.data);
        } else {
          try {
            const message = JSON.parse(event.data);
            console.log('[TRACE] Received JSON message:', message);
            
            if (message.type === 'transcription') {
              dispatch('call/receiveTranscription', message, { root: true });
            } else if (message.type === 'translation') {
              dispatch('call/receiveTranslation', message, { root: true });
            } else if (message.type === 'pong') {
              console.log('[TRACE] Received pong from server, latency:', Date.now() - message.originalTimestamp, 'ms');
            }
          } catch (e) {
            console.error('[ERROR] Failed to parse WebSocket message:', e);
          }
        }
      };
    } catch (error) {
      console.error('[ERROR] Failed to reconnect WebSocket:', error);
      commit('SET_WEBSOCKET_CONNECTED', false);
      
      // Schedule another reconnect attempt
      setTimeout(() => {
        dispatch('reconnectWebSocket');
      }, 5000);
    }
  } else if (state.websocket.readyState === WebSocket.CONNECTING) {
    console.log('[TRACE] WebSocket is already trying to connect');
  } else if (state.websocket.readyState === WebSocket.OPEN) {
    console.log('[TRACE] WebSocket is already connected');
    commit('SET_WEBSOCKET_CONNECTED', true);
  }
  
  // The reconnecting flag is cleared in the socket handlers (onopen/onerror/onclose)
  // or when a new attempt is scheduled
},
    
    // Play received audio
    async playReceivedAudio({ commit, state }, audioBlob) {
      try {
        console.log('[TRACE] Playing received audio, size:', audioBlob.size);
        
        // Format the received audio blob with the correct MIME type
        // Since we know the frontend is sending audio/mp4, we'll create a properly typed blob
        const formattedBlob = new Blob([audioBlob], { type: 'audio/mp4' });
        
        // Create audio element with the properly formatted blob
        const audioUrl = URL.createObjectURL(formattedBlob);
        const audio = new Audio(audioUrl);
        
        // Log the audio format for debugging
        console.log('[TRACE] Created audio URL with MIME type:', formattedBlob.type);
        
        // Set up audio visualization
        const audioContext = state.audioContext || new (window.AudioContext || window.webkitAudioContext)();
        if (!state.audioContext) {
          commit('SET_AUDIO_CONTEXT', audioContext);
        }
        
        const source = audioContext.createMediaElementSource(audio);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        
        source.connect(analyser);
        analyser.connect(audioContext.destination);
        
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        
        // Add event listeners for audio playback events
        audio.addEventListener('playing', () => {
          console.log('[TRACE] Audio playback started');
          
          // Start monitoring audio levels
          const monitorOutputLevel = () => {
            if (audio.ended || audio.paused) {
              commit('SET_OUTPUT_AUDIO_LEVEL', 0);
              return;
            }
            
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (const value of dataArray) {
              sum += value;
            }
            
            const average = sum / dataArray.length;
            const normalizedLevel = average / 255; // Normalize to 0-1
            commit('SET_OUTPUT_AUDIO_LEVEL', normalizedLevel);
            
            requestAnimationFrame(monitorOutputLevel);
          };
          
          monitorOutputLevel();
        });
        
        audio.addEventListener('ended', () => {
          console.log('[TRACE] Audio playback ended');
          commit('SET_OUTPUT_AUDIO_LEVEL', 0);
          
          // Clean up resources
          URL.revokeObjectURL(audioUrl);
        });
        
        audio.addEventListener('error', () => {
          console.error('[ERROR] Audio playback error occurred');
          commit('SET_OUTPUT_AUDIO_LEVEL', 0);
          URL.revokeObjectURL(audioUrl);
        });
        
        // Start playback
        console.log('[TRACE] Starting audio playback');
        await audio.play();
        
      } catch (error) {
        console.error('[ERROR] Failed to play received audio:', error);
      }
    },
    
    // Toggle mute state
    toggleMute({ commit, state }) {
      const newMuteState = !state.isMuted;
      console.log(`[TRACE] ${newMuteState ? 'Muting' : 'Unmuting'} microphone`);
      
      // Mute/unmute the actual audio tracks
      if (state.audioStream) {
        state.audioStream.getAudioTracks().forEach(track => {
          track.enabled = !newMuteState;
        });
      }
      
      commit('SET_MUTED', newMuteState);
    },
    
    // Clean up audio resources
    cleanupAudio({ commit }) {
      console.log('[TRACE] Cleaning up audio resources');
      commit('CLEAR_AUDIO_STATE');
    }
  }
};

export default audio;
