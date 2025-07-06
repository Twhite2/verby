// Audio handling module with WebSocket communication
import { createWebSocket } from '../../services/websocket';

const audio = {
  namespaced: true,
  
  state: {
    isRecording: false,
    audioContext: null,
    mediaRecorder: null,
    audioStream: null,
    websocket: null,
    websocketConnected: false,
    inputAudioLevel: 0,
    outputAudioLevel: 0,
    transcription: '',
    isMuted: false,
    
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
      state.audioBuffer = [];
      state.isSpeaking = false;
      state.silenceStart = null;
    }
  },
  
  actions: {
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
    setupWebSocket({ commit, state, dispatch }, { callId, userId }) {
      console.log('[TRACE] Setting up WebSocket connection');
      
      return new Promise((resolve, reject) => {
        try {
          // Close any existing connection
          if (state.websocket) {
            state.websocket.close();
          }
          
          // Ensure both callId and userId are provided
          if (!callId || !userId) {
            const error = new Error('Missing callId or userId for WebSocket connection');
            console.error('[ERROR]', error);
            dispatch('showError', 'Missing call or user information', { root: true });
            reject(error);
            return;
          }
          
          // Construct the WebSocket URL with parameters
          const params = new URLSearchParams({ callId, userId }).toString();
          const wsUrl = `/ws?${params}`;
          
          console.log(`[TRACE] Initializing WebSocket with params: callId=${callId}, userId=${userId}`);
          const websocket = createWebSocket(wsUrl, {
            maxReconnectAttempts: 5,
            reconnectInterval: 2000,
            binaryType: 'blob' // Use blob type for audio data
          });
          commit('SET_WEBSOCKET', websocket);
          
          // Handle WebSocket events
          websocket.onopen = () => {
            console.log('[TRACE] WebSocket connection established');
            commit('SET_WEBSOCKET_CONNECTED', true);
            resolve(websocket);
          };
          
          websocket.onerror = (error) => {
            console.error('[ERROR] WebSocket error:', error);
            commit('SET_WEBSOCKET_CONNECTED', false);
            reject(error);
          };
          
          websocket.onclose = (event) => {
            console.log(`[TRACE] WebSocket connection closed: ${event.code} - ${event.reason}`);
            commit('SET_WEBSOCKET_CONNECTED', false);
            
            // Try to reconnect if the connection was previously established and not intentionally closed
            if (state.websocketConnected && event.code !== 1000) {
              console.log('[TRACE] Attempting to reconnect...');
              setTimeout(() => {
                dispatch('setupWebSocket', { callId, userId });
              }, 3000);
            }
          };
          
          websocket.onmessage = async (event) => {
            try {
              // Handle binary audio data (for playback)
              if (event.data instanceof Blob) {
                console.log(`[TRACE] Received binary audio data: ${event.data.size} bytes`);
                dispatch('playReceivedAudio', event.data);
                return;
              }
              
              // Handle JSON messages
              const message = JSON.parse(event.data);
              console.log(`[TRACE] Received WebSocket message:`, message);
              
              switch (message.type) {
                case 'transcription':
                  commit('SET_TRANSCRIPTION', message.data.text);
                  // Forward to call module for display in chat
                  dispatch('call/addMessage', {
                    type: 'transcription',
                    senderId: message.data.userId,
                    content: message.data.text,
                    timestamp: new Date().toISOString()
                  }, { root: true });
                  break;
                  
                case 'translation':
                  // Forward to call module for display in chat
                  dispatch('call/addMessage', {
                    type: 'translation',
                    senderId: message.data.sender_id,
                    originalText: message.data.original_text,
                    originalLanguage: message.data.original_language,
                    translatedText: message.data.translated_text,
                    timestamp: new Date().toISOString()
                  }, { root: true });
                  break;
                  
                case 'error':
                  console.error('[ERROR] Server error:', message.data);
                  dispatch('showError', message.data.message, { root: true });
                  break;
                  
                default:
                  console.log('[TRACE] Unhandled message type:', message.type);
              }
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
          const mimeTypes = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/ogg;codecs=opus',
            'audio/ogg',
            'audio/mp4'
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
          
          console.log(`[TRACE] Using MIME type: ${mimeType} for recording`);
          
          const mediaRecorder = new MediaRecorder(state.audioStream, {
            mimeType: mimeType,
            audioBitsPerSecond: 128000
          });
          
          // Set up MediaRecorder event handlers
          mediaRecorder.ondataavailable = async (event) => {
            if (event.data.size > 0 && state.websocketConnected && !state.isMuted) {
              console.log(`[TRACE] Audio data available: ${event.data.size} bytes`);
              
              // Send the audio chunk to the server
              if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
                // First send metadata
                const metadata = {
                  type: 'audio_chunk',
                  timestamp: Date.now(),
                  messageId: `audio_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
                };
                
                state.websocket.send(JSON.stringify(metadata));
                
                // Wait a small amount of time to ensure order
                setTimeout(() => {
                  state.websocket.send(event.data);
                  console.log(`[TRACE] Audio chunk sent: ${event.data.size} bytes`);
                }, 10);
              } else {
                console.warn('[WARN] WebSocket not connected, cannot send audio');
              }
              
              // Add to buffer for pause detection
              commit('ADD_AUDIO_BUFFER', event.data);
              
              // Check for natural pause to send complete utterance
              if (state.silenceStart && (Date.now() - state.silenceStart > state.pauseThreshold) && state.audioBuffer.length > 0) {
                console.log(`[TRACE] Natural pause detected after ${Date.now() - state.silenceStart}ms, sending complete utterance`);
                
                // Combine all buffered chunks into one
                const combinedBlob = new Blob(state.audioBuffer, { type: mediaRecorder.mimeType });
                
                // Send the complete utterance
                if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
                  // First send metadata
                  const metadata = {
                    type: 'audio_data',
                    timestamp: Date.now(),
                    messageId: `audio_complete_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
                  };
                  
                  state.websocket.send(JSON.stringify(metadata));
                  
                  // Wait a small amount of time to ensure order
                  setTimeout(() => {
                    state.websocket.send(combinedBlob);
                    console.log(`[TRACE] Complete utterance sent: ${combinedBlob.size} bytes`);
                  }, 10);
                }
                
                // Clear the audio buffer after sending
                commit('CLEAR_AUDIO_BUFFER');
              }
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
    
    // Play received audio
    async playReceivedAudio({ commit, state }, audioBlob) {
      try {
        console.log('[TRACE] Playing received audio, size:', audioBlob.size);
        
        // Create audio element
        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);
        
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
