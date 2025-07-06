<template>
  <div class="home-container">
    <div class="hero-section">
      <div class="hero-content">
        <h1>VerbyFlow</h1>
        <p class="tagline">Real-time multilingual voice communication platform</p>
        <div class="action-buttons">
          <button @click="createNewCall" class="btn btn-primary">Start New Call</button>
          <div class="join-call">
            <input 
              v-model="joinCallId" 
              placeholder="Enter Call ID" 
              class="call-id-input" 
              @keyup.enter="joinExistingCall"
            />
            <button @click="joinExistingCall" class="btn btn-secondary">Join Call</button>
          </div>
        </div>
      </div>
    </div>

    <div class="features-section card">
      <h2>Features</h2>
      <div class="features-grid">
        <div class="feature">
          <div class="feature-icon">🎤</div>
          <h3>Voice Recording</h3>
          <p>High-quality audio capture with noise cancellation</p>
        </div>
        <div class="feature">
          <div class="feature-icon">🔊</div>
          <h3>Audio Playback</h3>
          <p>Clear audio playback of translated content</p>
        </div>
        <div class="feature">
          <div class="feature-icon">📝</div>
          <h3>Real-time Transcription</h3>
          <p>Powered by OpenAI Whisper API</p>
        </div>
        <div class="feature">
          <div class="feature-icon">🌐</div>
          <h3>Automatic Translation</h3>
          <p>Support for multiple languages</p>
        </div>
        <div class="feature">
          <div class="feature-icon">🔄</div>
          <h3>Text-to-Speech</h3>
          <p>Natural-sounding voice synthesis</p>
        </div>
        <div class="feature">
          <div class="feature-icon">⚡</div>
          <h3>Low Latency</h3>
          <p>Fast communication with minimal delay</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  name: 'HomeView',
  data() {
    return {
      joinCallId: ''
    }
  },
  methods: {
    async createNewCall() {
      try {
        await this.$store.dispatch('user/initializeUser');
        const callData = await this.$store.dispatch('call/createCall');
        this.$router.push(`/call/${callData.id}`);
      } catch (error) {
        console.error('Failed to create call:', error);
      }
    },
    async joinExistingCall() {
      if (!this.joinCallId) return;
      
      try {
        await this.$store.dispatch('user/initializeUser');
        await this.$store.dispatch('call/joinCall', this.joinCallId);
        this.$router.push(`/call/${this.joinCallId}`);
      } catch (error) {
        console.error('Failed to join call:', error);
      }
    }
  }
}
</script>

<style scoped>
.home-container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 2rem 1rem;
}

.hero-section {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  text-align: center;
  padding: 3rem 1rem;
  margin-bottom: 2rem;
  background-color: var(--light-bg);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.hero-content h1 {
  font-size: 3.5rem;
  margin-bottom: 1rem;
  background: linear-gradient(45deg, var(--primary-color), var(--accent-color));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.tagline {
  font-size: 1.5rem;
  color: #555;
  margin-bottom: 2rem;
}

.action-buttons {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  width: 100%;
  max-width: 500px;
}

.join-call {
  display: flex;
  width: 100%;
}

.call-id-input {
  flex: 1;
  padding: 0.8rem;
  border: 1px solid var(--border-color);
  border-top-left-radius: 4px;
  border-bottom-left-radius: 4px;
  font-size: 1rem;
  outline: none;
}

.join-call .btn {
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}

.features-section {
  margin-top: 3rem;
}

.features-section h2 {
  text-align: center;
  margin-bottom: 2rem;
  font-size: 2rem;
}

.features-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 2rem;
}

.feature {
  text-align: center;
  padding: 1.5rem;
  border-radius: 8px;
  background-color: rgba(255, 255, 255, 0.7);
  transition: transform 0.3s, box-shadow 0.3s;
}

.feature:hover {
  transform: translateY(-5px);
  box-shadow: 0 10px 20px rgba(0, 0, 0, 0.1);
}

.feature-icon {
  font-size: 2.5rem;
  margin-bottom: 1rem;
}

.feature h3 {
  margin-bottom: 0.5rem;
  color: var(--primary-color);
}

@media (max-width: 768px) {
  .hero-content h1 {
    font-size: 2.5rem;
  }
  
  .tagline {
    font-size: 1.2rem;
  }
  
  .action-buttons {
    flex-direction: column;
  }
}
</style>
