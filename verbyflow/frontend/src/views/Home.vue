<template>
  <div class="home">
    <section class="hero">
      <div class="hero-content">
        <h1>VerbyFlow</h1>
        <h2>Real-Time Multilingual Voice Communication</h2>
        <p>Speak in your language, be understood in theirs. Breaking language barriers, one call at a time.</p>
        
        <div class="cta" v-if="!isAuthenticated">
          <button class="btn-large" @click="showUserForm = true">Get Started</button>
        </div>
        <div class="cta" v-else>
          <button class="btn-large" @click="startCall">Start a Call</button>
        </div>
      </div>
      
      <div class="hero-visual">
        <div class="globe-visual">
          <!-- Placeholder for globe visual or animation -->
          <div class="globe-circle"></div>
          <div class="connection-lines"></div>
        </div>
      </div>
    </section>
    
    <section class="features">
      <h2>Breaking Language Barriers</h2>
      
      <div class="feature-grid">
        <div class="feature-card">
          <div class="feature-icon">🎙️</div>
          <h3>Real-Time Voice Translation</h3>
          <p>Speak naturally in your own language while others hear you in theirs.</p>
        </div>
        
        <div class="feature-card">
          <div class="feature-icon">🌍</div>
          <h3>Multilingual Support</h3>
          <p>Supporting global languages with special focus on African languages like Yoruba, Hausa, Igbo, and Ijaw.</p>
        </div>
        
        <div class="feature-card">
          <div class="feature-icon">💡</div>
          <h3>Live Language Switching</h3>
          <p>Change your target language on the fly during conversations.</p>
        </div>
        
        <div class="feature-card">
          <div class="feature-icon">🔊</div>
          <h3>Voice-Based Interface</h3>
          <p>Natural voice conversations with no typing required.</p>
        </div>
      </div>
    </section>
    
    <section class="use-cases">
      <h2>Connect Across Cultures</h2>
      
      <div class="use-case-grid">
        <div class="use-case-card">
          <h3>Business</h3>
          <p>Seamless global team collaboration without language barriers.</p>
        </div>
        
        <div class="use-case-card">
          <h3>Education</h3>
          <p>Learn from teachers worldwide regardless of your native language.</p>
        </div>
        
        <div class="use-case-card">
          <h3>Healthcare</h3>
          <p>Speak with healthcare providers in your preferred language.</p>
        </div>
        
        <div class="use-case-card">
          <h3>Public Services</h3>
          <p>Access government and community services in any language.</p>
        </div>
      </div>
    </section>
    
    <!-- User Registration Modal -->
    <div v-if="showUserForm" class="modal">
      <div class="modal-content">
        <span class="close-btn" @click="showUserForm = false">&times;</span>
        <h2>Get Started with VerbyFlow</h2>
        
        <form @submit.prevent="createUser">
          <div class="form-group">
            <label for="name">Your Name</label>
            <input 
              type="text" 
              id="name" 
              v-model="userForm.name" 
              required 
              placeholder="Enter your name"
            >
          </div>
          
          <div class="form-group">
            <label for="language">Preferred Language</label>
            <select id="language" v-model="userForm.language" required>
              <option value="" disabled>Select your language</option>
              <option 
                v-for="(langName, langCode) in availableLanguages" 
                :key="langCode" 
                :value="langCode"
              >
                {{ langName }}
              </option>
            </select>
          </div>
          
          <button 
            type="submit" 
            class="btn-primary" 
            :disabled="loading"
          >
            {{ loading ? 'Creating Profile...' : 'Create Profile' }}
          </button>
        </form>
      </div>
    </div>
  </div>
</template>

<script>
import { mapGetters, mapActions } from 'vuex'
import { useRouter } from 'vue-router'

export default {
  name: 'Home',
  
  setup() {
    const router = useRouter()
    return { router }
  },
  
  data() {
    return {
      showUserForm: false,
      userForm: {
        name: '',
        language: 'en'
      }
    }
  },
  
  computed: {
    ...mapGetters({
      isAuthenticated: 'user/isAuthenticated',
      availableLanguages: 'user/availableLanguages',
      loading: 'user/loading',
      error: 'user/error'
    })
  },
  
  methods: {
    ...mapActions({
      fetchLanguages: 'user/fetchAvailableLanguages',
      createUserAction: 'user/createUser',
      createCallAction: 'call/createCall'
    }),
    
    async createUser() {
      try {
        await this.createUserAction({
          name: this.userForm.name,
          preferredLanguage: this.userForm.language
        })
        
        this.showUserForm = false
        this.$router.push('/call')
      } catch (error) {
        console.error('Failed to create user:', error)
      }
    },
    
    async startCall() {
      try {
        const call = await this.createCallAction()
        this.$router.push(`/call/${call.id}`)
      } catch (error) {
        console.error('Failed to start call:', error)
      }
    }
  },
  
  async created() {
    // Fetch available languages when component is created
    await this.fetchLanguages()
  }
}
</script>

<style scoped>
.home {
  width: 100%;
}

.hero {
  display: flex;
  padding: 2rem 1rem 4rem;
  background: linear-gradient(135deg, var(--primary-color), var(--secondary-color));
  color: white;
  min-height: 500px;
  border-radius: 0 0 30px 30px;
}

.hero-content {
  flex: 1;
  padding: 2rem;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.hero-content h1 {
  font-size: 3rem;
  margin-bottom: 0.5rem;
  background: linear-gradient(to right, #ffffff, #2dd18c);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  display: inline-block;
}

.hero-content h2 {
  font-size: 1.8rem;
  margin-bottom: 1.5rem;
  font-weight: 400;
}

.hero-content p {
  font-size: 1.2rem;
  max-width: 600px;
  margin-bottom: 2rem;
}

.hero-visual {
  flex: 1;
  position: relative;
  min-height: 300px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.globe-visual {
  position: relative;
  width: 300px;
  height: 300px;
}

.globe-circle {
  position: absolute;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.2);
  box-shadow: 0 0 50px rgba(45, 209, 140, 0.5);
  animation: rotate 20s linear infinite;
}

.connection-lines::before,
.connection-lines::after {
  content: '';
  position: absolute;
  background: rgba(255, 255, 255, 0.3);
  height: 2px;
  border-radius: 50%;
}

.connection-lines::before {
  top: 75px;
  left: 20px;
  width: 260px;
  transform: rotate(30deg);
}

.connection-lines::after {
  top: 150px;
  left: 40px;
  width: 220px;
  transform: rotate(-20deg);
}

@keyframes rotate {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.btn-large {
  background-color: var(--accent-color);
  color: white;
  border: none;
  padding: 1rem 2.5rem;
  font-size: 1.2rem;
  border-radius: 50px;
  cursor: pointer;
  transition: all 0.3s;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}

.btn-large:hover {
  background-color: #25b478;
  transform: translateY(-2px);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.2);
}

.features, .use-cases {
  padding: 4rem 2rem;
  text-align: center;
}

.features h2, .use-cases h2 {
  font-size: 2.2rem;
  margin-bottom: 2.5rem;
  color: var(--dark-color);
}

.feature-grid, .use-case-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 2rem;
  max-width: 1200px;
  margin: 0 auto;
}

.feature-card {
  background-color: white;
  padding: 1.5rem;
  border-radius: 12px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.06);
  transition: transform 0.3s;
  text-align: center;
}

.feature-card:hover {
  transform: translateY(-5px);
}

.feature-icon {
  font-size: 2.5rem;
  margin-bottom: 1rem;
}

.feature-card h3 {
  font-size: 1.3rem;
  margin-bottom: 1rem;
  color: var(--secondary-color);
}

.use-case-card {
  background-color: var(--secondary-color);
  color: white;
  padding: 2rem;
  border-radius: 12px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.1);
  text-align: left;
  transition: transform 0.3s;
}

.use-case-card:hover {
  transform: translateY(-5px);
}

.use-case-card h3 {
  font-size: 1.3rem;
  margin-bottom: 0.7rem;
  color: var(--accent-color);
}

.modal {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.modal-content {
  background-color: white;
  width: 90%;
  max-width: 500px;
  padding: 2rem;
  border-radius: 10px;
  box-shadow: 0 4px 25px rgba(0, 0, 0, 0.25);
  position: relative;
}

.close-btn {
  position: absolute;
  top: 1rem;
  right: 1.5rem;
  font-size: 1.5rem;
  cursor: pointer;
  color: #666;
}

.form-group {
  margin-bottom: 1.5rem;
}

.form-group label {
  display: block;
  margin-bottom: 0.5rem;
  color: var(--dark-color);
}

.form-group input, 
.form-group select {
  width: 100%;
  padding: 0.7rem 1rem;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 1rem;
}

.btn-primary {
  background-color: var(--primary-color);
  color: white;
  border: none;
  padding: 0.8rem 1.5rem;
  border-radius: 4px;
  cursor: pointer;
  font-size: 1rem;
  transition: background-color 0.3s;
  width: 100%;
  margin-top: 1rem;
}

.btn-primary:hover:not(:disabled) {
  background-color: #3a5b8c;
}

.btn-primary:disabled {
  background-color: #cccccc;
  cursor: not-allowed;
}

@media (max-width: 768px) {
  .hero {
    flex-direction: column;
  }
  
  .hero-content {
    padding: 1rem 0;
    text-align: center;
  }
  
  .hero-content h1 {
    font-size: 2.5rem;
  }
  
  .hero-content h2 {
    font-size: 1.5rem;
  }
  
  .hero-visual {
    min-height: 200px;
  }
  
  .globe-visual {
    width: 200px;
    height: 200px;
  }
}
</style>
