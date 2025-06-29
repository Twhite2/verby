<template>
  <div class="notifications-container">
    <transition-group name="notification">
      <div 
        v-for="notification in notifications" 
        :key="notification.id"
        class="notification"
        :class="notification.type"
      >
        <div class="notification-content">{{ notification.message }}</div>
        <button @click="dismiss(notification.id)" class="close-button">&times;</button>
      </div>
    </transition-group>
  </div>
</template>

<script>
import { mapGetters, mapActions } from 'vuex'

export default {
  name: 'Notifications',
  
  computed: {
    ...mapGetters('notification', ['activeNotifications']),
    
    notifications() {
      return this.activeNotifications
    }
  },
  
  methods: {
    ...mapActions('notification', ['dismiss'])
  }
}
</script>

<style scoped>
.notifications-container {
  position: fixed;
  top: 20px;
  right: 20px;
  z-index: 9999;
  max-width: 350px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.notification {
  padding: 12px 16px;
  border-radius: 6px;
  box-shadow: 0 3px 8px rgba(0, 0, 0, 0.15);
  display: flex;
  align-items: center;
  background-color: #f8f9fa;
  border-left: 4px solid #adb5bd;
}

.notification.success {
  background-color: #d4edda;
  border-left-color: var(--accent-color);
}

.notification.error {
  background-color: #f8d7da;
  border-left-color: var(--error-color);
}

.notification.info {
  background-color: #cce5ff;
  border-left-color: var(--primary-color);
}

.notification.warning {
  background-color: #fff3cd;
  border-left-color: #ffc107;
}

.notification-content {
  flex: 1;
}

.close-button {
  background: none;
  border: none;
  font-size: 1.25rem;
  cursor: pointer;
  opacity: 0.5;
  transition: opacity 0.2s;
  padding: 0 0 0 8px;
}

.close-button:hover {
  opacity: 1;
}

.notification-enter-active, .notification-leave-active {
  transition: all 0.3s ease;
}

.notification-enter-from {
  transform: translateX(50px);
  opacity: 0;
}

.notification-leave-to {
  transform: translateX(50px);
  opacity: 0;
}
</style>
