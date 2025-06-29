export default {
  namespaced: true,
  
  state: {
    isRecording: false,
    audioStream: null,
    audioContext: null,
    mediaRecorder: null,
    websocket: null,
    websocketConnected: false,
    inputAudioLevel: 0,
    outputAudioLevel: 0,
    audioBufferSize: 4096,
    transcription: '',
    isMuted: false
  },
  
  getters: {
    isRecording: state => state.isRecording,
    audioStream: state => state.audioStream,
    websocketConnected: state => state.websocketConnected,
    inputAudioLevel: state => state.inputAudioLevel,
    outputAudioLevel: state => state.outputAudioLevel,
    transcription: state => state.transcription,
    isMuted: state => state.isMuted
  },
  
  mutations: {
    SET_RECORDING_STATE(state, isRecording) {
      state.isRecording = isRecording
    },
    
    SET_AUDIO_STREAM(state, stream) {
      state.audioStream = stream
    },
    
    SET_AUDIO_CONTEXT(state, context) {
      state.audioContext = context
    },
    
    SET_MEDIA_RECORDER(state, recorder) {
      state.mediaRecorder = recorder
    },
    
    SET_WEBSOCKET(state, websocket) {
      state.websocket = websocket
    },
    
    SET_WEBSOCKET_CONNECTED(state, connected) {
      state.websocketConnected = connected
    },
    
    SET_INPUT_AUDIO_LEVEL(state, level) {
      state.inputAudioLevel = level
    },
    
    SET_OUTPUT_AUDIO_LEVEL(state, level) {
      state.outputAudioLevel = level
    },
    
    SET_TRANSCRIPTION(state, text) {
      state.transcription = text
    },
    
    SET_MUTED(state, muted) {
      state.isMuted = muted
    },
    
    CLEAR_AUDIO_STATE(state) {
      if (state.mediaRecorder) {
        if (state.mediaRecorder.state !== 'inactive') {
          state.mediaRecorder.stop()
        }
        state.mediaRecorder = null
      }
      
      if (state.audioStream) {
        state.audioStream.getTracks().forEach(track => track.stop())
      }
      
      if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
        state.websocket.close()
      }
      
      state.isRecording = false
      state.audioStream = null
      state.audioContext = null
      state.websocket = null
      state.websocketConnected = false
      state.transcription = ''
      state.inputAudioLevel = 0
      state.outputAudioLevel = 0
    }
  },
  
  actions: {
    async initializeAudio({ commit, state, rootState, dispatch }) {
      try {
        if (state.audioStream) {
          return state.audioStream
        }
        
        // Request microphone access
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        commit('SET_AUDIO_STREAM', stream)
        
        // Initialize Web Audio API context
        const audioContext = new (window.AudioContext || window.webkitAudioContext)()
        commit('SET_AUDIO_CONTEXT', audioContext)
        
        // Set up audio analyzer for visualization
        const analyser = audioContext.createAnalyser()
        const microphone = audioContext.createMediaStreamSource(stream)
        microphone.connect(analyser)
        
        // Monitor input levels
        const dataArray = new Uint8Array(analyser.frequencyBinCount)
        const monitorAudioLevel = () => {
          if (!state.audioContext) return
          
          analyser.getByteFrequencyData(dataArray)
          let sum = 0
          for (const value of dataArray) {
            sum += value
          }
          const average = sum / dataArray.length
          commit('SET_INPUT_AUDIO_LEVEL', average / 255) // Normalize to 0-1
          
          requestAnimationFrame(monitorAudioLevel)
        }
        monitorAudioLevel()
        
        return stream
      } catch (error) {
        console.error('Error initializing audio:', error)
        throw error
      }
    },
    
    async startRecording({ commit, state, rootState, dispatch }) {
      try {
        if (state.isRecording) return
        
        // Initialize audio if not already done
        await dispatch('initializeAudio')
        
        // Setup WebSocket connection if needed
        if (!state.websocket || state.websocket.readyState !== WebSocket.OPEN) {
          await dispatch('setupWebSocket')
        }
        
        // Create a MediaRecorder with optimized audio settings for speech recognition
        const options = {
          mimeType: 'audio/webm;codecs=opus',
          audioBitsPerSecond: 16000,  // Optimized for voice
          bitsPerSecond: 25000       // Low bitrate for faster transmission
        }
        
        let mediaRecorder;
        // Fallback if the preferred format is not supported
        try {
          mediaRecorder = new MediaRecorder(state.audioStream, options)
          console.log('Using optimized audio recording settings')
        } catch (e) {
          console.warn('Optimized recording format not supported, using default:', e)
          mediaRecorder = new MediaRecorder(state.audioStream)
        }
        
        // Store the recorder in state
        commit('SET_MEDIA_RECORDER', mediaRecorder)
        
        // Setup recording behavior with voice activity detection
        let speechDetected = false;
        let silenceCounter = 0;
        // Increase threshold slightly for more stable speech detection
        const VAD_THRESHOLD = 0.015;    // Adjusted based on testing
        const SILENCE_LIMIT = 5;        // Increased to reduce fragmentation
        
        // Buffer to collect audio chunks before sending
        const audioBuffer = [];
        const MIN_BUFFER_SIZE = 2;      // Min number of chunks to collect before sending
        const MAX_BUFFER_SIZE = 5;      // Max buffer size to prevent latency
        let bufferTimer = null;
        
        // Audio analyzer for VAD
        const analyserNode = state.audioContext.createAnalyser();
        const source = state.audioContext.createMediaStreamSource(state.audioStream);
        source.connect(analyserNode);
        analyserNode.fftSize = 256;
        const bufferLength = analyserNode.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        
        // Function to detect speech based on audio energy
        const detectSpeech = () => {
          analyserNode.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < bufferLength; i++) {
            sum += dataArray[i];
          }
          const average = sum / bufferLength / 255; // Normalize to 0-1
          
          // Update input level for UI
          commit('SET_INPUT_AUDIO_LEVEL', average);
          
          // Speech detection logic with smoother transition
          const isSpeaking = average > VAD_THRESHOLD;
          
          if (isSpeaking) {
            speechDetected = true;
            silenceCounter = 0;
          } else if (speechDetected) {
            silenceCounter++;
            if (silenceCounter > SILENCE_LIMIT) {
              speechDetected = false;
              // When speech ends, flush buffer after a short delay
              if (audioBuffer.length > 0) {
                if (bufferTimer) clearTimeout(bufferTimer);
                bufferTimer = setTimeout(() => sendBufferedAudio(), 300);
              }
            }
          }
          
          return speechDetected;
        };
        
        // Function to send buffered audio chunks as a single blob
        const sendBufferedAudio = () => {
          if (audioBuffer.length === 0) return;
          
          console.log(`Sending buffered audio: ${audioBuffer.length} chunks`);
          
          // Combine all blobs in buffer
          const combinedBlob = new Blob(audioBuffer, { type: 'audio/webm;codecs=opus' });
          
          // Only send if we have enough audio data (to avoid "audio too short" errors)
          if (combinedBlob.size > 1000) { // Ensure minimum viable size
            if (state.websocketConnected && !state.isMuted) {
              state.websocket.send(combinedBlob);
            }
          } else {
            console.log('Discarded audio buffer - too small');
          }
          
          // Clear the buffer
          audioBuffer.length = 0;
        };
        
        // Start periodic analysis
        const analysisInterval = setInterval(detectSpeech, 100); // Check every 100ms
        
        mediaRecorder.ondataavailable = async (event) => {
          if (event.data.size > 0 && !state.isMuted) {
            const hasSpeech = detectSpeech();
            
            // Add to buffer when speech is detected
            if (hasSpeech) {
              console.log('Speech detected, buffering audio chunk');
              audioBuffer.push(event.data);
              
              // If buffer is full, send it
              if (audioBuffer.length >= MAX_BUFFER_SIZE) {
                if (bufferTimer) clearTimeout(bufferTimer);
                sendBufferedAudio();
              } else if (audioBuffer.length === MIN_BUFFER_SIZE) {
                // Start timer when we have minimum viable buffer
                if (!bufferTimer) {
                  bufferTimer = setTimeout(() => sendBufferedAudio(), 300);
                }
              }
            }
          }
        };
        
        // Clean up analyzer when recording stops
        mediaRecorder.onstop = () => {
          clearInterval(analysisInterval);
          source.disconnect();
        }
        
        // Set recording interval - 1000ms is optimal for speech recognition
        // - Long enough to contain meaningful speech segments
        // - Short enough for responsive real-time experience
        const timeSlice = 1000 // 1000ms (1 second) chunks
        mediaRecorder.start(timeSlice)
        commit('SET_RECORDING_STATE', true)
      } catch (error) {
        console.error('Error starting recording:', error)
        throw error
      }
    },
    
    stopRecording({ commit, state }) {
      if (!state.isRecording || !state.mediaRecorder) return
      
      state.mediaRecorder.stop()
      commit('SET_RECORDING_STATE', false)
    },
    
    async setupWebSocket({ commit, state, rootGetters }, params = {}) {
      // Use params if provided, otherwise fallback to getters
      const callId = params.callId || rootGetters['call/currentCall']?.id
      const userId = params.userId || rootGetters['user/currentUser']?.id
      
      console.log('Setting up WebSocket with:', { callId, userId })
      
      if (!callId || !userId) {
        console.error('Missing callId or userId for WebSocket setup:', { callId, userId })
        throw new Error('Cannot setup WebSocket: missing call ID or user ID')
      }
      
      // Close existing connection if any
      if (state.websocket) {
        state.websocket.close()
      }
      
      // Create new WebSocket connection
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const wsUrl = `${protocol}//${window.location.hostname}:8000/api/calls/ws/${callId}/${userId}`
      
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl)
        
        ws.onopen = () => {
          commit('SET_WEBSOCKET', ws)
          commit('SET_WEBSOCKET_CONNECTED', true)
          resolve(ws)
        }
        
        ws.onclose = () => {
          commit('SET_WEBSOCKET_CONNECTED', false)
        }
        
        ws.onerror = (error) => {
          console.error('WebSocket error:', error)
          commit('SET_WEBSOCKET_CONNECTED', false)
          reject(error)
        }
        
        ws.onmessage = (event) => {
          try {
            // Handle text messages (JSON)
            if (typeof event.data === 'string') {
              const message = JSON.parse(event.data)
              
              switch (message.type) {
                case 'transcription':
                  commit('SET_TRANSCRIPTION', message.text)
                  break
                  
                case 'translation':
                  // Handle translated text
                  commit('call/ADD_MESSAGE', {
                    id: Date.now(),
                    sender: message.sender_id,
                    originalText: message.original_text,
                    originalLanguage: message.original_language,
                    translatedText: message.translated_text,
                    timestamp: new Date().toISOString()
                  }, { root: true })
                  break
                  
                case 'user_joined':
                  // Handle user joining the call
                  break
                  
                case 'error':
                  console.error('WebSocket error message:', message.message)
                  break
              }
            } 
            // Handle binary messages (audio)
            else if (event.data instanceof Blob) {
              dispatch('playReceivedAudio', event.data)
            }
          } catch (error) {
            console.error('Error processing WebSocket message:', error)
          }
        }
      })
    },
    
    async playReceivedAudio({ commit, state }, audioBlob) {
      try {
        if (!state.audioContext) {
          const audioContext = new (window.AudioContext || window.webkitAudioContext)()
          commit('SET_AUDIO_CONTEXT', audioContext)
        }
        
        const arrayBuffer = await audioBlob.arrayBuffer()
        const audioBuffer = await state.audioContext.decodeAudioData(arrayBuffer)
        
        const source = state.audioContext.createBufferSource()
        source.buffer = audioBuffer
        source.connect(state.audioContext.destination)
        source.start(0)
        
        // Update output audio level (for visualization)
        const analyser = state.audioContext.createAnalyser()
        source.connect(analyser)
        analyser.connect(state.audioContext.destination)
        
        const dataArray = new Uint8Array(analyser.frequencyBinCount)
        const monitorOutputLevel = () => {
          if (!source.buffer) return
          
          analyser.getByteFrequencyData(dataArray)
          let sum = 0
          for (const value of dataArray) {
            sum += value
          }
          const average = sum / dataArray.length
          commit('SET_OUTPUT_AUDIO_LEVEL', average / 255) // Normalize to 0-1
          
          requestAnimationFrame(monitorOutputLevel)
        }
        monitorOutputLevel()
      } catch (error) {
        console.error('Error playing received audio:', error)
      }
    },
    
    toggleMute({ commit, state }) {
      commit('SET_MUTED', !state.isMuted)
    },
    
    cleanupAudio({ commit }) {
      commit('CLEAR_AUDIO_STATE')
    }
  }
}
