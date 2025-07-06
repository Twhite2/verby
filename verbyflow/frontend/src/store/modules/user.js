const user = {
  namespaced: true,
  
  state: {
    userId: null,
    displayName: null,
    avatar: null,
    preferences: {
      language: 'en',
      voicePreference: null,
      darkMode: false,
      notifications: true
    },
    availableLanguages: [
      { code: 'en', name: 'English' },
      { code: 'es', name: 'Spanish' },
      { code: 'fr', name: 'French' },
      { code: 'de', name: 'German' },
      { code: 'it', name: 'Italian' },
      { code: 'ja', name: 'Japanese' },
      { code: 'ko', name: 'Korean' },
      { code: 'zh', name: 'Chinese' },
      { code: 'ru', name: 'Russian' },
      { code: 'pt', name: 'Portuguese' }
    ]
  },
  
  getters: {
    getUserId: state => state.userId,
    getDisplayName: state => state.displayName,
    getAvatar: state => state.avatar,
    getPreferredLanguage: state => state.preferences.language,
    getVoicePreference: state => state.preferences.voicePreference,
    isDarkMode: state => state.preferences.darkMode,
    getNotificationSetting: state => state.preferences.notifications,
    getAvailableLanguages: state => state.availableLanguages
  },
  
  mutations: {
    SET_USER_ID(state, userId) {
      state.userId = userId;
    },
    SET_DISPLAY_NAME(state, name) {
      state.displayName = name;
    },
    SET_AVATAR(state, avatarUrl) {
      state.avatar = avatarUrl;
    },
    SET_LANGUAGE_PREFERENCE(state, language) {
      state.preferences.language = language;
    },
    SET_VOICE_PREFERENCE(state, voice) {
      state.preferences.voicePreference = voice;
    },
    SET_DARK_MODE(state, enabled) {
      state.preferences.darkMode = enabled;
    },
    SET_NOTIFICATION_SETTING(state, enabled) {
      state.preferences.notifications = enabled;
    },
    SET_USER_PREFERENCES(state, preferences) {
      state.preferences = {
        ...state.preferences,
        ...preferences
      };
    }
  },
  
  actions: {
    // Initialize user session
    initializeUser({ commit, dispatch }) {
      // Try to load user from localStorage
      try {
        const savedUser = localStorage.getItem('verbyflow_user');
        if (savedUser) {
          const userData = JSON.parse(savedUser);
          
          if (userData.userId) {
            commit('SET_USER_ID', userData.userId);
          }
          
          if (userData.displayName) {
            commit('SET_DISPLAY_NAME', userData.displayName);
          }
          
          if (userData.preferences) {
            commit('SET_USER_PREFERENCES', userData.preferences);
          }
          
          console.log('[TRACE] Loaded user from local storage:', userData);
          return userData;
        }
      } catch (error) {
        console.error('[ERROR] Failed to load user data from localStorage:', error);
      }
      
      // Create new anonymous user if none exists
      return dispatch('createAnonymousUser');
    },
    
    // Create anonymous user
    createAnonymousUser({ commit, state }) {
      const userId = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const displayName = `Guest_${Math.floor(Math.random() * 10000)}`;
      
      commit('SET_USER_ID', userId);
      commit('SET_DISPLAY_NAME', displayName);
      
      const userData = {
        userId,
        displayName,
        preferences: state.preferences
      };
      
      // Save to localStorage
      localStorage.setItem('verbyflow_user', JSON.stringify(userData));
      
      console.log('[TRACE] Created anonymous user:', userData);
      return userData;
    },
    
    // Update user profile
    updateUserProfile({ commit, state }, { displayName }) {
      commit('SET_DISPLAY_NAME', displayName);
      
      // Update localStorage
      const userData = {
        userId: state.userId,
        displayName,
        preferences: state.preferences
      };
      
      localStorage.setItem('verbyflow_user', JSON.stringify(userData));
      
      return userData;
    },
    
    // Update language preference
    updateLanguagePreference({ commit, state }, language) {
      commit('SET_LANGUAGE_PREFERENCE', language);
      
      // Update localStorage
      const userData = {
        userId: state.userId,
        displayName: state.displayName,
        preferences: {
          ...state.preferences,
          language
        }
      };
      
      localStorage.setItem('verbyflow_user', JSON.stringify(userData));
    },
    
    // Toggle dark mode
    toggleDarkMode({ commit, state }) {
      const newDarkMode = !state.preferences.darkMode;
      commit('SET_DARK_MODE', newDarkMode);
      
      // Apply dark mode to HTML element
      if (newDarkMode) {
        document.documentElement.classList.add('dark-mode');
      } else {
        document.documentElement.classList.remove('dark-mode');
      }
      
      // Update localStorage
      const userData = {
        userId: state.userId,
        displayName: state.displayName,
        preferences: {
          ...state.preferences,
          darkMode: newDarkMode
        }
      };
      
      localStorage.setItem('verbyflow_user', JSON.stringify(userData));
    }
  }
};

export default user;
