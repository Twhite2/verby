import axios from 'axios'
import { v4 as uuidv4 } from 'uuid'

const API_URL = 'http://localhost:8000/api'

// Load user from local storage if available
const loadStoredUser = () => {
  try {
    const storedUser = localStorage.getItem('verbyflow_user')
    return storedUser ? JSON.parse(storedUser) : null
  } catch (error) {
    console.error('Failed to load user from localStorage:', error)
    return null
  }
}

export default {
  namespaced: true,
  
  state: {
    currentUser: loadStoredUser(),
    availableLanguages: {},
    loading: false,
    error: null
  },
  
  getters: {
    currentUser: state => state.currentUser,
    userLanguage: state => state.currentUser?.preferred_language || 'en',
    availableLanguages: state => state.availableLanguages,
    isAuthenticated: state => !!state.currentUser,
    loading: state => state.loading,
    error: state => state.error
  },
  
  mutations: {
    SET_CURRENT_USER(state, user) {
      state.currentUser = user
      // Save to localStorage
      if (user) {
        localStorage.setItem('verbyflow_user', JSON.stringify(user))
      } else {
        localStorage.removeItem('verbyflow_user')
      }
    },
    
    UPDATE_USER_LANGUAGE(state, language) {
      if (state.currentUser) {
        state.currentUser.preferred_language = language
        localStorage.setItem('verbyflow_user', JSON.stringify(state.currentUser))
      }
    },
    
    SET_AVAILABLE_LANGUAGES(state, languages) {
      state.availableLanguages = languages
    },
    
    SET_LOADING(state, loading) {
      state.loading = loading
    },
    
    SET_ERROR(state, error) {
      state.error = error
    }
  },
  
  actions: {
    async fetchAvailableLanguages({ commit }) {
      try {
        commit('SET_LOADING', true)
        const response = await axios.get(`${API_URL}/languages`)
        commit('SET_AVAILABLE_LANGUAGES', response.data.languages)
      } catch (error) {
        commit('SET_ERROR', error.message || 'Failed to fetch languages')
      } finally {
        commit('SET_LOADING', false)
      }
    },
    
    async createUser({ commit }, { name, preferredLanguage }) {
      try {
        commit('SET_LOADING', true)
        
        const userData = {
          id: uuidv4(),
          name,
          preferred_language: preferredLanguage
        }
        
        const response = await axios.post(`${API_URL}/users/`, userData)
        commit('SET_CURRENT_USER', response.data)
        return response.data
      } catch (error) {
        commit('SET_ERROR', error.message || 'Failed to create user')
        throw error
      } finally {
        commit('SET_LOADING', false)
      }
    },
    
    async updateUserLanguage({ commit, state, dispatch }, language) {
      try {
        if (!state.currentUser) {
          throw new Error('No user logged in')
        }
        
        commit('SET_LOADING', true)
        
        try {
          // Try to update the user in the backend
          const response = await axios.put(`${API_URL}/users/${state.currentUser.id}`, {
            preferred_language: language
          })
          
          // Update locally
          commit('UPDATE_USER_LANGUAGE', language)
          return response.data
        } catch (error) {
          // If user not found (404), create the user first, then update
          if (error.response && error.response.status === 404) {
            console.log('User not found in backend, creating user first...')
            const userData = {
              id: state.currentUser.id,
              name: state.currentUser.name,
              preferred_language: language
            }
            
            // Create the user
            await axios.post(`${API_URL}/users/`, userData)
            
            // Update locally
            commit('UPDATE_USER_LANGUAGE', language)
            return state.currentUser
          }
          // Re-throw other errors
          throw error
        }
      } catch (error) {
        commit('SET_ERROR', error.message || 'Failed to update language')
        throw error
      } finally {
        commit('SET_LOADING', false)
      }
    },
    
    logout({ commit }) {
      commit('SET_CURRENT_USER', null)
    }
  }
}
