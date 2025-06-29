import axios from 'axios'

const API_URL = 'http://localhost:8000/api'

export default {
  namespaced: true,
  
  state: {
    currentCall: null,
    isInCall: false,
    participants: [],
    messages: [],
    loading: false,
    error: null
  },
  
  getters: {
    currentCall: state => state.currentCall,
    isInCall: state => state.isInCall,
    participants: state => state.participants,
    messages: state => state.messages,
    loading: state => state.loading,
    error: state => state.error
  },
  
  mutations: {
    SET_CURRENT_CALL(state, call) {
      state.currentCall = call
      state.isInCall = !!call
    },
    
    SET_PARTICIPANTS(state, participants) {
      state.participants = participants
    },
    
    ADD_PARTICIPANT(state, participant) {
      if (!state.participants.find(p => p.id === participant.id)) {
        state.participants.push(participant)
      }
    },
    
    REMOVE_PARTICIPANT(state, participantId) {
      state.participants = state.participants.filter(p => p.id !== participantId)
    },
    
    ADD_MESSAGE(state, message) {
      state.messages.push(message)
    },
    
    SET_LOADING(state, loading) {
      state.loading = loading
    },
    
    SET_ERROR(state, error) {
      state.error = error
    },
    
    CLEAR_CALL_STATE(state) {
      state.currentCall = null
      state.isInCall = false
      state.participants = []
      state.messages = []
      state.error = null
    }
  },
  
  actions: {
    async createCall({ commit, rootState }) {
      try {
        commit('SET_LOADING', true)
        
        const userId = rootState.user.currentUser?.id
        if (!userId) {
          throw new Error('User not authenticated')
        }
        
        const response = await axios.post(`${API_URL}/calls/`, { creator_id: userId })
        commit('SET_CURRENT_CALL', response.data)
        return response.data
      } catch (error) {
        commit('SET_ERROR', error.message || 'Failed to create call')
        throw error
      } finally {
        commit('SET_LOADING', false)
      }
    },
    
    async joinCall({ commit, rootState }, callId) {
      try {
        commit('SET_LOADING', true)
        
        const userId = rootState.user.currentUser?.id
        if (!userId) {
          throw new Error('User not authenticated')
        }
        
        const response = await axios.get(`${API_URL}/calls/${callId}`)
        commit('SET_CURRENT_CALL', response.data)
        return response.data
      } catch (error) {
        commit('SET_ERROR', error.message || 'Failed to join call')
        throw error
      } finally {
        commit('SET_LOADING', false)
      }
    },
    
    addMessage({ commit }, message) {
      commit('ADD_MESSAGE', message)
    },
    
    addParticipant({ commit }, participant) {
      commit('ADD_PARTICIPANT', participant)
    },
    
    removeParticipant({ commit }, participantId) {
      commit('REMOVE_PARTICIPANT', participantId)
    },
    
    leaveCall({ commit }) {
      commit('CLEAR_CALL_STATE')
    }
  }
}
