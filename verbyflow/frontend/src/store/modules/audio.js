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
    isMuted: false,
    vadSensitivity: 2, // 1-5, higher = more sensitive to speech
    pauseThreshold: 800  // ms of silence to consider a natural pause
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
        // Try multiple formats in order of preference for better compatibility with Whisper API
        
        // Determine the best supported format
        const getMimeType = () => {
          const types = [
            'audio/ogg;codecs=opus',  // First choice - OGG container with Opus codec
            'audio/webm;codecs=opus', // Second choice - WebM with Opus
            'audio/wav',              // Third choice - WAV (if supported)
            'audio/mp3'               // Fourth choice - MP3 (rarely supported in browsers)
          ]
          
          for (const type of types) {
            if (MediaRecorder.isTypeSupported(type)) {
              console.log(`Using audio format: ${type}`)
              return type
            }
          }
          
          // If none of our preferred types are supported, let the browser choose
          console.warn('None of the preferred audio formats are supported')
          return ''
        }
        
        const options = {
          mimeType: getMimeType(),
          audioBitsPerSecond: 16000,  // Optimized for voice
          bitsPerSecond: 25000        // Low bitrate for faster transmission
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
        
        // Set up Audio Analyzer for speech detection
        let audioBuffer = [];
        let speechDetected = false;
        let silenceCounter = 0;
        let bufferTimer = null;
        
        // Constants for speech detection - adjusted for better natural pause detection
        const VAD_THRESHOLD = 0.05; // Base voice activity detection threshold (0-1)
        const SILENCE_LIMIT = 20; // frames of silence before completely ending speech detection
        const MIN_BUFFER_SIZE = 2; // Min number of chunks to collect before sending
        const MAX_BUFFER_SIZE = 8; // Max buffer size to prevent latency (increased for better utterances)
        
        // Audio analyzer for VAD
        const analyserNode = state.audioContext.createAnalyser();
        const source = state.audioContext.createMediaStreamSource(state.audioStream);
        source.connect(analyserNode);
        analyserNode.fftSize = 256;
        const bufferLength = analyserNode.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        
        // Function to detect speech based on audio energy with enhanced natural pause detection
        const detectSpeech = () => {
          try {
            // Get audio data
            analyserNode.getByteTimeDomainData(dataArray);
            
            // Calculate energy in the signal
            let energy = 0;
            for (let i = 0; i < dataArray.length; i++) {
              // Convert unsigned 8-bit to signed
              const amplitude = ((dataArray[i] - 128) / 128);
              energy += (amplitude * amplitude);
            }
            energy = energy / dataArray.length;
            
            // Dynamically adjust threshold based on sensitivity
            // Higher sensitivity = lower threshold = more likely to detect speech
            const dynamicThreshold = 0.01 / Math.max(1, state.vadSensitivity);
            
            // Detect speech when energy exceeds threshold
            const speechDetected = energy > dynamicThreshold;
            
            // Track speech and silence to detect natural pauses
            const currentTime = Date.now();
            
            if (speechDetected && !utteranceInProgress) {
              // Speech started
              utteranceInProgress = true;
              lastSpeechTime = currentTime;
              console.log('Speech detected - starting utterance');
            } else if (speechDetected && utteranceInProgress) {
              // Ongoing speech - update the time
              lastSpeechTime = currentTime;
            } else if (!speechDetected && utteranceInProgress) {
              // Possible natural pause - check if silence duration exceeds threshold
              const silenceDuration = currentTime - lastSpeechTime;
              if (silenceDuration > state.pauseThreshold) {
                // Natural pause detected
                if (audioBuffer.length > 0) {
                  console.log('Natural pause detected, sending buffered utterance');
                  if (bufferTimer) clearTimeout(bufferTimer);
                  sendBufferedAudio();
                }
                utteranceInProgress = false;
              }
            }
            
            return speechDetected;
          } catch (error) {
            console.error('Error in speech detection:', error);
            return false;
          }
        }
        
        // Track utterance state
        let utteranceInProgress = false;
        let lastSpeechTime = 0;
        
        // Function to send buffered audio chunks as a single blob (complete utterance)
        const sendBufferedAudio = () => {
          try {
            if (audioBuffer.length === 0) return;
            
            console.log(`Sending complete utterance: ${audioBuffer.length} chunks`);
            
            // Combine all blobs in buffer - maintaining the WebM format with headers
            const combinedBlob = new Blob(audioBuffer, { type: 'audio/webm;codecs=opus' });
            
            // Only send if we have enough audio data (to avoid "audio too short" errors)
            if (combinedBlob.size > 1000) { // Ensure minimum viable size
              if (state.websocketConnected && !state.isMuted) {
                // Add telemetry to help with debugging
                console.log(`Sending utterance of size: ${combinedBlob.size} bytes`);
                state.websocket.send(combinedBlob);
              }
            } else {
              console.log('Discarded audio buffer - too small');
            }
            
            // Clear the buffer for the next utterance
            audioBuffer.length = 0;
          } catch (error) {
            console.error('Error sending buffered audio:', error);
          }
        };
        
        // Start periodic analysis
        const analysisInterval = setInterval(detectSpeech, 100); // Check every 100ms
        
        mediaRecorder.ondataavailable = async (event) => {
          if (event.data.size > 0 && !state.isMuted) {
            // Always add the chunk to the buffer (we need the continuous audio)
            audioBuffer.push(event.data);
            console.log(`Audio chunk received: ${event.data.size} bytes`);
            
            // Check for speech in this chunk
            const hasSpeech = detectSpeech();
            
            // When not speaking and we have accumulated a lot of data, we should
            // send what we have to prevent buffer from getting too large
            if (!hasSpeech && audioBuffer.length >= MAX_BUFFER_SIZE) {
              console.log('Buffer limit reached without active speech, sending accumulated audio');
              if (bufferTimer) clearTimeout(bufferTimer);
              sendBufferedAudio();
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
        console.error('Error starting recording:', error);
        throw error;
      }
    },
    
    stopRecording({ commit, state }) {
      if (!state.isRecording || !state.mediaRecorder) return
      
      state.mediaRecorder.stop()
      commit('SET_RECORDING_STATE', false)
    },
    
    async setupWebSocket({ commit, state, rootGetters, dispatch }, params = {}) {
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
        
        // Store reference to dispatch for use in WebSocket handlers
        // This ensures the WebSocket callbacks can access dispatch
        const storeDispatch = dispatch;
        
        ws.onopen = () => {
          commit('SET_WEBSOCKET', ws)
          commit('SET_WEBSOCKET_CONNECTED', true)
          resolve(ws)
        }
        
        ws.onerror = (error) => {
          console.error('WebSocket error:', error)
          commit('SET_WEBSOCKET_CONNECTED', false)
          reject(error)
        }
        
        ws.onclose = () => {
          console.log('WebSocket disconnected')
          commit('SET_WEBSOCKET_CONNECTED', false)
        }
        
        // Handle incoming WebSocket messages
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
                  storeDispatch('call/ADD_MESSAGE', {
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
              storeDispatch('playReceivedAudio', event.data)
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
      commit('CLEAR_AUDIO_STATE');
    }
  }
};
