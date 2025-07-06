import axios from 'axios';

const call = {
  namespaced: true,
  
  state: {
    activeCall: null,
    callId: null,
    callStatus: null, // 'connecting', 'connected', 'disconnected', 'error'
    participants: [],
    messages: [],
    activeLanguage: 'en', // Default to English
  },
  
  getters: {
    isInCall: state => !!state.callId,
    getCallId: state => state.callId,
    getCallStatus: state => state.callStatus,
    getParticipants: state => state.participants,
    getMessages: state => state.messages,
    getActiveLanguage: state => state.activeLanguage,
    getActiveCall: state => state.activeCall
  },
  
  mutations: {
    SET_CALL_ID(state, callId) {
      state.callId = callId;
    },
    SET_CALL_STATUS(state, status) {
      state.callStatus = status;
    },
    SET_ACTIVE_CALL(state, callData) {
      state.activeCall = callData;
    },
    ADD_PARTICIPANT(state, participant) {
      const existingIndex = state.participants.findIndex(p => p.id === participant.id);
      if (existingIndex >= 0) {
        // Update existing participant
        state.participants.splice(existingIndex, 1, {
          ...state.participants[existingIndex],
          ...participant
        });
      } else {
        // Add new participant
        state.participants.push(participant);
      }
    },
    REMOVE_PARTICIPANT(state, participantId) {
      state.participants = state.participants.filter(p => p.id !== participantId);
    },
    UPDATE_PARTICIPANT(state, { participantId, updates }) {
      const index = state.participants.findIndex(p => p.id === participantId);
      if (index !== -1) {
        state.participants[index] = {
          ...state.participants[index],
          ...updates
        };
      }
    },
    ADD_MESSAGE(state, message) {
      state.messages.push(message);
      
      // Limit message history to 100 items
      if (state.messages.length > 100) {
        state.messages.shift();
      }
    },
    CLEAR_MESSAGES(state) {
      state.messages = [];
    },
    SET_ACTIVE_LANGUAGE(state, language) {
      state.activeLanguage = language;
    },
    RESET_CALL_STATE(state) {
      state.callId = null;
      state.callStatus = null;
      state.participants = [];
      state.messages = [];
      state.activeCall = null;
    }
  },
  
  actions: {
    // Create a new call
    async createCall({ commit, dispatch, rootState }) {
      try {
        commit('SET_CALL_STATUS', 'connecting');
        
        // Get user ID from state or generate a temporary one
        const userId = rootState.user?.id || `user_${Date.now()}`;
        const userName = rootState.user?.name || 'Anonymous';
        
        // Include creator_id in the request body
        const response = await axios.post('/api/calls', {
          creator_id: userId
        });
        const callData = response.data;
        
        console.log('[TRACE] Call created:', callData);
        
        commit('SET_CALL_ID', callData.id);
        commit('SET_ACTIVE_CALL', callData);
        
        // Add self as participant
        
        const selfParticipant = {
          id: userId,
          name: userName,
          isLocal: true,
          isSpeaking: false,
          language: rootState.call?.activeLanguage || 'en'
        };
        
        commit('ADD_PARTICIPANT', selfParticipant);
        
        // Setup WebSocket for real-time communication
        await dispatch('audio/setupWebSocket', {
          callId: callData.id,
          userId
        }, { root: true });
        
        commit('SET_CALL_STATUS', 'connected');
        return callData;
      } catch (error) {
        console.error('[ERROR] Failed to create call:', error);
        commit('SET_CALL_STATUS', 'error');
        dispatch('showError', 'Failed to create call', { root: true });
        throw error;
      }
    },
    
    // Join an existing call
    async joinCall({ commit, dispatch, rootState }, callId) {
      try {
        commit('SET_CALL_STATUS', 'connecting');
        
        // Verify call exists and is active
        const response = await axios.get(`/api/calls/${callId}`);
        const callData = response.data;
        
        console.log('[TRACE] Joining call:', callData);
        
        commit('SET_CALL_ID', callData.id);
        commit('SET_ACTIVE_CALL', callData);
        
        // Add self as participant
        const userId = rootState.user?.id || `user_${Date.now()}`;
        const userName = rootState.user?.name || 'Anonymous';
        
        const selfParticipant = {
          id: userId,
          name: userName,
          isLocal: true,
          isSpeaking: false,
          language: rootState.call?.activeLanguage || 'en'
        };
        
        commit('ADD_PARTICIPANT', selfParticipant);
        
        // Setup WebSocket for real-time communication
        await dispatch('audio/setupWebSocket', {
          callId: callData.id,
          userId
        }, { root: true });
        
        commit('SET_CALL_STATUS', 'connected');
        return callData;
      } catch (error) {
        console.error('[ERROR] Failed to join call:', error);
        commit('SET_CALL_STATUS', 'error');
        dispatch('showError', `Failed to join call: ${error.message}`, { root: true });
        throw error;
      }
    },
    
    // Leave the current call
    async leaveCall({ commit, dispatch, state }) {
      try {
        if (!state.callId) {
          return;
        }
        
        console.log('[TRACE] Leaving call');
        
        // Cleanup audio resources
        await dispatch('audio/cleanupAudio', null, { root: true });
        
        commit('RESET_CALL_STATE');
        return true;
      } catch (error) {
        console.error('[ERROR] Error leaving call:', error);
        throw error;
      }
    },
    
    // Add a chat/transcription message
    addMessage({ commit }, message) {
      // Ensure message has required properties
      const completeMessage = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        timestamp: new Date().toISOString(),
        ...message
      };
      
      commit('ADD_MESSAGE', completeMessage);
    },
    
    // Change active language
    changeLanguage({ commit }, language) {
      console.log(`[TRACE] Changing language to ${language}`);
      commit('SET_ACTIVE_LANGUAGE', language);
    },
    
    // Update participant status (e.g. speaking state)
    updateParticipant({ commit }, { participantId, updates }) {
      commit('UPDATE_PARTICIPANT', { participantId, updates });
    }
  }
};

export default call;
