import { createStore } from 'vuex'
import audio from './modules/audio'
import call from './modules/call'
import user from './modules/user'

export default createStore({
  state: {
    appLoaded: false,
    error: null,
    notification: null
  },
  getters: {
    isAppLoaded: state => state.appLoaded,
    getError: state => state.error,
    getNotification: state => state.notification
  },
  mutations: {
    SET_APP_LOADED(state, loaded) {
      state.appLoaded = loaded;
    },
    SET_ERROR(state, error) {
      state.error = error;
    },
    CLEAR_ERROR(state) {
      state.error = null;
    },
    SET_NOTIFICATION(state, notification) {
      state.notification = notification;
    },
    CLEAR_NOTIFICATION(state) {
      state.notification = null;
    }
  },
  actions: {
    initializeApp({ commit }) {
      // Any app initialization logic
      commit('SET_APP_LOADED', true);
    },
    showError({ commit }, message) {
      commit('SET_ERROR', message);
      setTimeout(() => {
        commit('CLEAR_ERROR');
      }, 5000);
    },
    showNotification({ commit }, message) {
      commit('SET_NOTIFICATION', message);
      setTimeout(() => {
        commit('CLEAR_NOTIFICATION');
      }, 5000);
    }
  },
  modules: {
    audio,
    call,
    user
  }
})
