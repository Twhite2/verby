// notification.js - Vuex module for handling notifications

const state = {
  notifications: [],
  notificationId: 0
};

const mutations = {
  ADD_NOTIFICATION(state, notification) {
    state.notifications.push({
      ...notification,
      id: state.notificationId++
    });
  },
  
  REMOVE_NOTIFICATION(state, id) {
    const index = state.notifications.findIndex(n => n.id === id);
    if (index !== -1) {
      state.notifications.splice(index, 1);
    }
  }
};

const actions = {
  show({ commit, dispatch }, { message, type = 'info', duration = 5000 }) {
    const id = state.notificationId;
    
    commit('ADD_NOTIFICATION', { message, type });
    
    if (duration > 0) {
      setTimeout(() => {
        dispatch('dismiss', id);
      }, duration);
    }
    
    return id;
  },
  
  dismiss({ commit }, id) {
    commit('REMOVE_NOTIFICATION', id);
  }
};

const getters = {
  activeNotifications(state) {
    return state.notifications;
  }
};

export default {
  namespaced: true,
  state,
  mutations,
  actions,
  getters
};
