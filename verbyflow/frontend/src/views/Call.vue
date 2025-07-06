<template>
  <div class="call-container">
    <div v-if="callStatus !== 'connected'" class="connecting-overlay">
      <div class="spinner"></div>
      <p>{{ callStatus === 'connecting' ? 'Connecting to call...' : 'Connection error' }}</p>
      <button v-if="callStatus === 'error'" @click="handleRetryConnection" class="btn btn-primary">Retry</button>
    </div>
    
    <div class="call-header">
      <div class="call-info">
        <h2>Call: {{ callId }}</h2>
        <button class="btn-copy" @click="copyCallLink">
          <span class="icon">📋</span> Copy invite link
        </button>
      </div>
      <div class="call-actions">
        <button @click="leaveCall" class="btn btn-danger">End Call</button>
      </div>
    </div>
    
    <div class="call-content">
      <div class="participants-panel">
        <h3>Participants ({{ participants.length }})</h3>
        <div class="participants-list">
          <div 
            v-for="participant in participants" 
            :key="participant.id" 
            class="participant-item"
            :class="{ 'speaking': participant.isSpeaking }"
          >
            <div class="participant-avatar">
              {{ participant.name.charAt(0).toUpperCase() }}
              <div v-if="participant.isSpeaking" class="speaking-indicator"></div>
            </div>
            <div class="participant-info">
              <div class="participant-name">{{ participant.name }} {{ participant.isLocal ? '(You)' : '' }}</div>
              <div class="participant-language">{{ getLanguageName(participant.language) }}</div>
            </div>
          </div>
        </div>
      </div>
      
      <div class="conversation-panel">
        <div class="messages-container" ref="messagesContainer">
          <div 
            v-for="message in messages" 
            :key="message.id" 
            class="message"
            :class="{ 
              'transcription': message.type === 'transcription',
              'translation': message.type === 'translation',
              'local': isLocalMessage(message)
            }"
          >
            <div class="message-sender">{{ getSenderName(message.senderId) }}</div>
            
            <div class="message-content">
              <template v-if="message.type === 'transcription'">
                {{ message.content }}
              </template>
              <template v-else-if="message.type === 'translation'">
                <div class="original-text">{{ message.originalText }}</div>
                <div class="translation-arrow">↓</div>
                <div class="translated-text">{{ message.translatedText }}</div>
              </template>
            </div>
            
            <div class="message-time">
              {{ formatMessageTime(message.timestamp) }}
            </div>
          </div>
          
          <div v-if="messages.length === 0" class="empty-messages">
            <p>No messages yet. Start talking to see transcriptions and translations appear here.</p>
          </div>
        </div>
        
        <div class="audio-controls">
          <div class="audio-visualizer">
            <div 
              class="audio-level-indicator"
              :style="{ height: `${isRecording ? inputAudioLevel * 100 : outputAudioLevel * 100}%` }"
            ></div>
          </div>
          
          <div class="controls">
            <button 
              @click="toggleRecording" 
              class="btn control-btn"
              :class="{ 'recording': isRecording }"
            >
              <span class="icon">{{ isRecording ? '⏹' : '🎙' }}</span>
              {{ isRecording ? 'Stop' : 'Start' }} Recording
            </button>
            
            <button 
              @click="toggleMute" 
              class="btn control-btn"
              :class="{ 'muted': isMuted }"
            >
              <span class="icon">{{ isMuted ? '🔇' : '🔊' }}</span>
              {{ isMuted ? 'Unmute' : 'Mute' }}
            </button>
            
            <div class="language-selector">
              <label for="language-select">Your language:</label>
              <select 
                id="language-select" 
                v-model="selectedLanguage"
                @change="changeLanguage"
              >
                <option 
                  v-for="language in availableLanguages" 
                  :key="language.code" 
                  :value="language.code"
                >
                  {{ language.name }}
                </option>
              </select>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { mapGetters } from 'vuex';

export default {
  name: 'CallView',
  data() {
    return {
      selectedLanguage: 'en',
      retryCount: 0,
      maxRetries: 3
    }
  },
  computed: {
    ...mapGetters({
      callId: 'call/getCallId',
      callStatus: 'call/getCallStatus',
      participants: 'call/getParticipants',
      messages: 'call/getMessages',
      isRecording: 'audio/isRecording',
      inputAudioLevel: 'audio/inputAudioLevel',
      outputAudioLevel: 'audio/outputAudioLevel',
      isMuted: 'audio/isMuted',
      availableLanguages: 'user/getAvailableLanguages',
      userId: 'user/getUserId'
    }),
    routeCallId() {
      return this.$route.params.id;
    }
  },
  async created() {
    await this.initializeCall();
    
    // Set initial language from user preferences
    this.selectedLanguage = this.$store.getters['user/getPreferredLanguage'];
  },
  mounted() {
    // Add unload handler to leave call when navigating away
    window.addEventListener('beforeunload', this.handleBeforeUnload);
  },
  beforeUnmount() {
    window.removeEventListener('beforeunload', this.handleBeforeUnload);
    this.leaveCall();
  },
  watch: {
    messages() {
      this.$nextTick(() => {
        this.scrollToBottom();
      });
    }
  },
  methods: {
    async initializeCall() {
      try {
        // Initialize user if not already done
        await this.$store.dispatch('user/initializeUser');
        
        // Join or create call
        if (this.routeCallId) {
          await this.$store.dispatch('call/joinCall', this.routeCallId);
        } else {
          const callData = await this.$store.dispatch('call/createCall');
          // Update URL with the new call ID
          this.$router.replace(`/call/${callData.id}`);
        }
        
        // Initialize audio components
        await this.$store.dispatch('audio/initializeAudio');
      } catch (error) {
        console.error('Failed to initialize call:', error);
      }
    },
    
    async handleRetryConnection() {
      if (this.retryCount < this.maxRetries) {
        this.retryCount++;
        await this.initializeCall();
      } else {
        // Max retries reached, redirect to home
        this.$router.push('/');
      }
    },
    
    async toggleRecording() {
      if (this.isRecording) {
        await this.$store.dispatch('audio/stopRecording');
      } else {
        await this.$store.dispatch('audio/startRecording');
      }
    },
    
    toggleMute() {
      this.$store.dispatch('audio/toggleMute');
    },
    
    changeLanguage() {
      // Update both user preference and active call language
      this.$store.dispatch('user/updateLanguagePreference', this.selectedLanguage);
      this.$store.dispatch('call/changeLanguage', this.selectedLanguage);
      
      // Update current participant
      this.$store.dispatch('call/updateParticipant', {
        participantId: this.userId,
        updates: {
          language: this.selectedLanguage
        }
      });
    },
    
    async leaveCall() {
      await this.$store.dispatch('call/leaveCall');
      this.$router.push('/');
    },
    
    copyCallLink() {
      const link = `${window.location.origin}/call/${this.callId}`;
      navigator.clipboard.writeText(link)
        .then(() => {
          this.$store.dispatch('showNotification', 'Call link copied to clipboard!', { root: true });
        })
        .catch(error => {
          console.error('Failed to copy call link:', error);
        });
    },
    
    getLanguageName(code) {
      const language = this.availableLanguages.find(lang => lang.code === code);
      return language ? language.name : code;
    },
    
    getSenderName(senderId) {
      const participant = this.participants.find(p => p.id === senderId);
      return participant ? participant.name : 'Unknown';
    },
    
    isLocalMessage(message) {
      return message.senderId === this.userId;
    },
    
    formatMessageTime(timestamp) {
      const date = new Date(timestamp);
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    },
    
    scrollToBottom() {
      if (this.$refs.messagesContainer) {
        this.$refs.messagesContainer.scrollTop = this.$refs.messagesContainer.scrollHeight;
      }
    },
    
    handleBeforeUnload(event) {
      // This will prompt the user before leaving the page
      event.preventDefault();
      event.returnValue = '';
    }
  }
}
</script>

<style scoped>
.call-container {
  height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
}

.connecting-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(255, 255, 255, 0.9);
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  z-index: 10;
}

.spinner {
  width: 50px;
  height: 50px;
  border: 5px solid rgba(0, 0, 0, 0.1);
  border-left-color: var(--primary-color);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 1rem;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.call-header {
  display: flex;
  justify-content: space-between;
  padding: 1rem;
  background-color: var(--light-bg);
  border-bottom: 1px solid var(--border-color);
}

.call-info {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.call-info h2 {
  margin: 0;
  font-size: 1.5rem;
}

.btn-copy {
  background: none;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 0.4rem 0.8rem;
  font-size: 0.9rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.btn-copy:hover {
  background-color: #f5f5f5;
}

.call-content {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.participants-panel {
  width: 250px;
  padding: 1rem;
  border-right: 1px solid var(--border-color);
  background-color: var(--light-bg);
  overflow-y: auto;
}

.participants-panel h3 {
  margin-top: 0;
  margin-bottom: 1rem;
  font-size: 1.2rem;
}

.participant-item {
  display: flex;
  align-items: center;
  padding: 0.8rem;
  border-radius: 8px;
  margin-bottom: 0.5rem;
  background-color: #f9f9f9;
  transition: background-color 0.3s;
}

.participant-item.speaking {
  background-color: rgba(46, 204, 113, 0.2);
}

.participant-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background-color: var(--primary-color);
  color: white;
  display: flex;
  justify-content: center;
  align-items: center;
  font-weight: bold;
  margin-right: 1rem;
  position: relative;
}

.speaking-indicator {
  position: absolute;
  width: 12px;
  height: 12px;
  background-color: #2ecc71;
  border-radius: 50%;
  bottom: 0;
  right: 0;
  border: 2px solid white;
}

.participant-info {
  flex: 1;
}

.participant-name {
  font-weight: 500;
}

.participant-language {
  font-size: 0.8rem;
  color: #666;
}

.conversation-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.messages-container {
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
  background-color: #f5f5f5;
}

.message {
  margin-bottom: 1rem;
  max-width: 70%;
  padding: 1rem;
  border-radius: 8px;
  background-color: white;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.message.local {
  margin-left: auto;
  background-color: #e1f5fe;
}

.message-sender {
  font-weight: 500;
  margin-bottom: 0.3rem;
}

.message-content {
  margin-bottom: 0.5rem;
}

.message.transcription {
  border-left: 4px solid #3498db;
}

.message.translation {
  border-left: 4px solid #9b59b6;
}

.original-text {
  font-style: italic;
  color: #666;
}

.translation-arrow {
  margin: 0.3rem 0;
  color: #9b59b6;
}

.translated-text {
  font-weight: 500;
}

.message-time {
  font-size: 0.8rem;
  color: #999;
  text-align: right;
}

.empty-messages {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100%;
  color: #999;
  text-align: center;
  padding: 2rem;
}

.audio-controls {
  padding: 1rem;
  background-color: var(--light-bg);
  border-top: 1px solid var(--border-color);
  display: flex;
  align-items: center;
}

.audio-visualizer {
  width: 60px;
  height: 60px;
  background-color: #f0f0f0;
  border-radius: 8px;
  margin-right: 1rem;
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: flex-end;
}

.audio-level-indicator {
  width: 100%;
  background: linear-gradient(to top, #3498db, #2ecc71);
  transition: height 0.1s ease-out;
}

.controls {
  flex: 1;
  display: flex;
  gap: 1rem;
  align-items: center;
  flex-wrap: wrap;
}

.control-btn {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.control-btn.recording {
  background-color: #e74c3c;
  color: white;
}

.control-btn.muted {
  background-color: #f0f0f0;
  color: #666;
}

.icon {
  font-size: 1.2rem;
}

.language-selector {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.language-selector select {
  padding: 0.5rem;
  border-radius: 4px;
  border: 1px solid var(--border-color);
}

@media (max-width: 768px) {
  .call-content {
    flex-direction: column;
  }
  
  .participants-panel {
    width: 100%;
    max-height: 200px;
    border-right: none;
    border-bottom: 1px solid var(--border-color);
  }
  
  .message {
    max-width: 90%;
  }
}
</style>
