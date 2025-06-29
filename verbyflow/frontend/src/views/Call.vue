<template>
  <div class="call-container">
    <!-- Call Setup Section (before joining a call) -->
    <div v-if="!isCallActive" class="call-setup">
      <h1>VerbyFlow Call</h1>
      
      <div class="card setup-card">
        <h2>Start or Join a Call</h2>
        
        <div v-if="error" class="error-banner">
          {{ error }}
        </div>
        
        <div class="call-options">
          <button 
            @click="createNewCall" 
            class="btn btn-primary"
            :disabled="loading"
          >
            {{ loading ? 'Creating...' : 'Start New Call' }}
          </button>
          
          <div class="separator">OR</div>
          
          <div class="join-form">
            <input 
              type="text" 
              v-model="callId" 
              placeholder="Enter call ID"
              class="call-id-input"
            />
            <button 
              @click="joinCall(callId)" 
              class="btn btn-secondary"
              :disabled="!callId || loading"
            >
              {{ loading ? 'Joining...' : 'Join Call' }}
            </button>
          </div>
        </div>
      </div>
    </div>
    
    <!-- Active Call Interface -->
    <div v-else class="active-call">
      <!-- Call Header -->
      <div class="call-header">
        <div class="call-info">
          <h2>Active Call</h2>
          <div v-if="currentCall" class="call-id-display">
            ID: <span class="monospace">{{ currentCall?.id || '' }}</span>
            <button 
              @click="copyCallId" 
              class="btn-icon"
              title="Copy call ID"
            >
              📋
            </button>
          </div>
        </div>
        
        <div class="user-controls">
          <div class="language-control">
            <label for="language-select">Your language:</label>
            <select 
              id="language-select" 
              v-model="selectedLanguage"
              @change="changeLanguage($event)"
            >
              <option 
                v-for="(name, code) in availableLanguages" 
                :key="code" 
                :value="code"
              >
                {{ name }}
              </option>
            </select>
          </div>
          
          <button @click="leaveCall" class="btn btn-danger">
            End Call
          </button>
        </div>
      </div>
      
      <!-- Main Call Area -->
      <div class="call-content">
        <!-- Participants Section -->
        <div class="participants-panel">
          <h3>Participants</h3>
          
          <div class="participants-list">
            <!-- Current User -->
            <div class="participant current-user">
              <div class="avatar">
                {{ currentUser?.name?.charAt(0).toUpperCase() || '?' }}
              </div>
              <div class="details">
                <div class="name">{{ currentUser?.name }} (You)</div>
                <div class="language">
                  {{ getLanguageName(currentUser?.preferred_language) }}
                </div>
              </div>
            </div>
            
            <!-- Other Participants -->
            <div 
              v-for="(participant, index) in participants || []" 
              :key="participant?.id || index"
              class="participant"
              v-if="participant?.id && currentUser?.id && participant.id !== currentUser.id"
            >
              <div class="avatar">
                {{ (participant?.name || '?').charAt(0).toUpperCase() }}
              </div>
              <div class="details">
                <div class="name">{{ participant?.name || 'Unknown User' }}</div>
                <div class="language">
                  {{ getLanguageName(participant?.preferred_language || 'en') }}
                </div>
              </div>
            </div>
            
            <div v-if="participants.length <= 1" class="empty-state">
              No other participants yet. Share the call ID to invite others.
            </div>
          </div>
        </div>
        
        <!-- Communication Area -->
        <div class="communication-panel">
          <!-- Transcript History -->
          <div class="transcript-history">
            <div 
              v-for="message in messages" 
              :key="message.id"
              class="message"
              :class="{'own-message': message.sender === currentUser?.id}"
            >
              <div class="message-header">
                <span class="sender-name">{{ getSenderName(message.sender) }}</span>
                <span class="timestamp">{{ formatTime(message.timestamp) }}</span>
              </div>
              
              <div class="message-content">
                <div class="original-text">{{ message.originalText }}</div>
                <div class="translated-text">{{ message.translatedText }}</div>
              </div>
            </div>
            
            <div v-if="messages.length === 0" class="empty-state">
              No messages yet. Start speaking to begin the conversation.
            </div>
          </div>
          
          <!-- Voice Controls -->
          <div class="voice-controls">
            <!-- Live Transcription -->
            <div v-if="transcription" class="live-transcription">
              <div class="transcription-label">Currently speaking:</div>
              <div class="transcription-text">"{{ transcription }}"</div>
            </div>
            
            <!-- Audio Visualization -->
            <div class="audio-meter">
              <div 
                class="audio-level" 
                :style="{ width: `${audioLevels.input * 100}%` }"
              ></div>
            </div>
            
            <!-- Control Buttons -->
            <div class="control-buttons">
              <button 
                @click="toggleRecording" 
                class="btn btn-speak"
                :class="{'active': isRecording}"
              >
                {{ isRecording ? 'Stop Speaking' : 'Start Speaking' }}
              </button>
              
              <button 
                @click="toggleMute" 
                class="btn btn-mute"
                :class="{'muted': isMuted}"
              >
                {{ isMuted ? 'Unmute' : 'Mute' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  name: 'Call',
  
  data() {
    return {
      callId: null,
      isCallActive: false,
      showJoinScreen: true,
      selectedLanguage: '',
      targetLanguages: {},
      transcription: '',
      translations: [],
      audioLevels: {
        input: 0,
        output: 0
      },
      error: null,
      loading: false
    }
  },
  
  computed: {
    currentUser() {
      return this.$store.getters['user/currentUser']
    },
    
    availableLanguages() {
      return this.$store.getters['user/availableLanguages']
    },
    
    currentCall() {
      return this.$store.getters['call/currentCall']
    },
    
    participants() {
      return this.$store.getters['call/participants']
    },
    
    messages() {
      return this.$store.getters['call/messages']
    },
    
    isAuthenticated() {
      return this.$store.getters['user/isAuthenticated']
    },
    
    isRecording() {
      return this.$store.getters['audio/isRecording']
    },
    
    isMuted() {
      return this.$store.getters['audio/isMuted']
    }
  },
  
  created() {
    // Load available languages if not already loaded
    if (!Object.keys(this.availableLanguages || {}).length) {
      this.$store.dispatch('user/fetchAvailableLanguages')
    }
    
    // Create a user if none exists
    this.ensureUserExists()
    
    // Set initial language to user's preferred language
    if (this.currentUser) {
      this.selectedLanguage = this.currentUser.preferred_language || 'en'
    }
    
    // Check if we have a call ID in the route params
    const { id } = this.$route.params
    if (id) {
      this.callId = id
      this.joinCall(id)
    }
  },
  
  methods: {
    /**
     * Ensures a user exists before creating/joining a call
     */
    async ensureUserExists() {
      if (!this.isAuthenticated) {
        try {
          console.log('Creating new user...')
          // Create a default user
          await this.$store.dispatch('user/createUser', { 
            name: 'User_' + Math.floor(Math.random() * 1000), 
            preferredLanguage: 'en'
          })
          // Make sure the user was created before trying to access properties
          if (this.currentUser) {
            console.log('User created successfully:', this.currentUser)
            this.selectedLanguage = this.currentUser.preferred_language || 'en'
          } else {
            console.warn('User creation seemed to succeed but no user object is available')
          }
        } catch (error) {
          console.error('Error creating user:', error)
          this.$store.dispatch('notification/add', {
            type: 'error',
            message: 'Failed to create user profile: ' + (error.message || 'Unknown error')
          })
        }
      } else {
        console.log('User already exists:', this.currentUser)
      }
    },
    async createNewCall() {
      try {
        this.error = null
        this.loading = true
        
        // Ensure user is created before proceeding
        await this.ensureUserExists()
        
        // Create a new call via store
        const call = await this.$store.dispatch('call/createCall')
        this.callId = call.id
        
        // Redirect to the call page with ID if not already there
        if (this.$route.params.id !== call.id) {
          this.$router.push(`/call/${call.id}`)
        }
        
        // Set up audio for the call
        this.isCallActive = true
        this.$store.dispatch('audio/setupWebSocket', {
          callId: call?.id,
          userId: this.currentUser?.id
        })
        
        // Show success notification
        this.$store.dispatch('notification/add', {
          type: 'success',
          message: 'Call created successfully! Share the Call ID with others.'
        })
      } catch (error) {
        console.error('Error creating call:', error)
        this.error = 'Failed to create call. Please try again.'
        this.$store.dispatch('notification/add', {
          type: 'error',
          message: 'Failed to create call: ' + (error.message || 'Unknown error')
        })
      } finally {
        this.loading = false
      }
    },
    
    async joinCall(id) {
      try {
        this.error = null
        this.loading = true
        const callId = id || this.callId
        
        if (!callId) {
          this.error = 'Please enter a valid Call ID'
          return
        }
        
        // Ensure user is created before proceeding
        await this.ensureUserExists()
        
        // Join the call via store
        await this.$store.dispatch('call/joinCall', callId)
        
        // Set up audio for the call
        this.isCallActive = true
        this.$store.dispatch('audio/setupWebSocket', {
          callId: callId,
          userId: this.currentUser?.id
        })
        
        // Show success notification
        this.$store.dispatch('notification/add', {
          type: 'success',
          message: 'Joined call successfully!'
        })
      } catch (error) {
        console.error('Error joining call:', error)
        this.error = 'Failed to join call. Please check the Call ID and try again.'
        this.$store.dispatch('notification/add', {
          type: 'error',
          message: 'Failed to join call: ' + (error.message || 'Unknown error')
        })
      } finally {
        this.loading = false
      }
    },
    
    leaveCall() {
      // Clean up audio resources
      this.$store.dispatch('audio/cleanupAudio')
      
      // Clear call state
      this.$store.dispatch('call/leaveCall')
      
      // Reset local state
      this.isCallActive = false
      this.showJoinScreen = true
      
      // Go back to home page
      this.$router.push('/')
    },
    
    toggleRecording() {
      if (this.isRecording) {
        this.$store.dispatch('audio/stopRecording')
      } else {
        this.$store.dispatch('audio/startRecording')
      }
    },
    
    toggleMute() {
      this.$store.dispatch('audio/toggleMute')
    },
    
    changeLanguage(event) {
      const language = event.target.value
      this.$store.dispatch('user/updateUserLanguage', language)
    },
    
    getLanguageName(code) {
      return this.availableLanguages[code] || code
    },
    
    getSenderName(senderId) {
      if (senderId === this.currentUser?.id) {
        return 'You'
      }
      
      const participant = this.participants.find(p => p.id === senderId)
      return participant ? participant.name : 'Unknown User'
    },
    
    formatTime(timestamp) {
      const date = new Date(timestamp)
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    },
    
    copyCallId() {
      if (this.currentCall || this.callId) {
        navigator.clipboard.writeText(this.currentCall?.id || this.callId || '')
          .then(() => {
            // Show temporary notification
            this.$store.dispatch('notification/add', {
              type: 'success',
              message: 'Call ID copied to clipboard!'
            })
          })
          .catch(error => {
            console.error('Error copying to clipboard:', error)
            this.$store.dispatch('notification/add', {
              type: 'error',
              message: 'Failed to copy Call ID'
            })
          })
      }
    }
  }
}
</script>

<style scoped>
.call-container {
  width: 100%;
  min-height: 80vh;
  display: flex;
  flex-direction: column;
}

/* Call Setup Styles */
.call-setup {
  max-width: 800px;
  margin: 2rem auto;
  text-align: center;
  padding: 0 1rem;
}

.call-setup h1 {
  margin-bottom: 2rem;
  color: var(--primary-color);
}

.setup-card {
  background-color: white;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  padding: 2rem;
}

.call-options {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.5rem;
}

.separator {
  width: 100%;
  text-align: center;
  margin: 0.5rem 0;
  position: relative;
  color: #888;
  font-size: 0.9rem;
}

.separator::before,
.separator::after {
  content: '';
  position: absolute;
  top: 50%;
  width: 45%;
  height: 1px;
  background-color: #ddd;
}

.separator::before {
  left: 0;
}

.separator::after {
  right: 0;
}

.join-form {
  display: flex;
  width: 100%;
  gap: 1rem;
}

.call-id-input {
  flex: 1;
  padding: 0.8rem 1rem;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 1rem;
}

.btn {
  border: none;
  padding: 0.8rem 1.5rem;
  border-radius: 4px;
  font-size: 1rem;
  cursor: pointer;
  transition: all 0.3s;
  font-weight: 500;
}

.btn-primary {
  background-color: var(--accent-color);
  color: white;
}

.btn-primary:hover:not(:disabled) {
  background-color: #25b478;
}

.btn-secondary {
  background-color: var(--primary-color);
  color: white;
}

.btn-secondary:hover:not(:disabled) {
  background-color: #3a5b8c;
}

.btn:disabled {
  background-color: #cccccc;
  cursor: not-allowed;
}

.error-banner {
  background-color: var(--error-color);
  color: white;
  padding: 0.8rem;
  border-radius: 4px;
  margin-bottom: 1.5rem;
}

/* Active Call Styles */
.active-call {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.call-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 2rem;
  background-color: var(--primary-color);
  color: white;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.call-info h2 {
  margin: 0;
  font-size: 1.5rem;
}

.call-id-display {
  font-size: 0.9rem;
  margin-top: 0.25rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.monospace {
  font-family: monospace;
  background-color: rgba(255, 255, 255, 0.2);
  padding: 0.2rem 0.4rem;
  border-radius: 4px;
}

.btn-icon {
  background: none;
  border: none;
  color: white;
  cursor: pointer;
  font-size: 1rem;
}

.user-controls {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.language-control {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.language-control select {
  padding: 0.4rem;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.3);
  background-color: rgba(255, 255, 255, 0.1);
  color: white;
  min-width: 150px;
}

.btn-danger {
  background-color: var(--error-color);
  color: white;
}

.btn-danger:hover {
  background-color: #bd2130;
}

/* Main Call Content */
.call-content {
  flex: 1;
  display: flex;
  padding: 1rem;
  gap: 1rem;
  background-color: #f9f9f9;
  overflow: hidden;
}

/* Participants Panel */
.participants-panel {
  width: 300px;
  background-color: white;
  border-radius: 8px;
  padding: 1rem;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
  overflow-y: auto;
}

.participants-panel h3 {
  margin-top: 0;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid #eee;
  color: var(--primary-color);
}

.participants-list {
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
  margin-top: 1rem;
}

.participant {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  padding: 0.8rem;
  background-color: #f5f7fa;
  border-radius: 8px;
}

.participant.current-user {
  background-color: #e3f2fd;
}

.avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background-color: var(--primary-color);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: bold;
  font-size: 1.2rem;
}

.details {
  flex: 1;
}

.name {
  font-weight: 500;
  margin-bottom: 0.2rem;
}

.language {
  font-size: 0.8rem;
  color: #666;
}

/* Communication Panel */
.communication-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  background-color: white;
  border-radius: 8px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
  overflow: hidden;
}

.transcript-history {
  flex: 1;
  overflow-y: auto;
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.message {
  max-width: 70%;
  background-color: #f0f2f5;
  padding: 1rem;
  border-radius: 12px 12px 12px 0;
  align-self: flex-start;
}

.message.own-message {
  background-color: #e3f2fd;
  border-radius: 12px 12px 0 12px;
  align-self: flex-end;
}

.message-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 0.5rem;
}

.sender-name {
  font-weight: 500;
  color: var(--primary-color);
}

.timestamp {
  font-size: 0.8rem;
  color: #888;
}

.message-content {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.original-text {
  font-weight: 500;
}

.translated-text {
  font-style: italic;
  color: #666;
}

.empty-state {
  text-align: center;
  color: #888;
  padding: 2rem;
  font-style: italic;
}

/* Voice Controls */
.voice-controls {
  padding: 1rem;
  border-top: 1px solid #eee;
  background-color: #f9f9f9;
}

.live-transcription {
  background-color: #f0f2f5;
  padding: 1rem;
  border-radius: 8px;
  margin-bottom: 1rem;
}

.transcription-label {
  font-size: 0.8rem;
  color: #666;
  margin-bottom: 0.3rem;
}

.transcription-text {
  font-style: italic;
}

.audio-meter {
  height: 6px;
  background-color: #ddd;
  border-radius: 3px;
  margin-bottom: 1rem;
  overflow: hidden;
}

.audio-level {
  height: 100%;
  background-color: var(--accent-color);
  transition: width 0.1s;
}

.control-buttons {
  display: flex;
  gap: 1rem;
}

.btn-speak {
  flex: 1;
  background-color: var(--accent-color);
  color: white;
}

.btn-speak:hover {
  background-color: #25b478;
}

.btn-speak.active {
  background-color: var(--error-color);
  animation: pulse 1.5s infinite;
}

.btn-mute {
  flex: 1;
  background-color: #eaeaea;
}

.btn-mute:hover {
  background-color: #d8d8d8;
}

.btn-mute.muted {
  background-color: #ffeaea;
  color: var(--error-color);
}

@keyframes pulse {
  0% { opacity: 1; }
  50% { opacity: 0.7; }
  100% { opacity: 1; }
}

@media (max-width: 900px) {
  .call-content {
    flex-direction: column;
  }
  
  .participants-panel {
    width: 100%;
    max-height: 200px;
  }
}

@media (max-width: 600px) {
  .call-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 1rem;
  }
  
  .user-controls {
    width: 100%;
    flex-direction: column;
    align-items: flex-start;
  }
  
  .join-form {
    flex-direction: column;
  }
  
  .control-buttons {
    flex-direction: column;
  }
}
</style>
