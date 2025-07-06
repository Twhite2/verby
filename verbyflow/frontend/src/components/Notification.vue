<template>
  <transition name="fade">
    <div 
      v-if="notification || error"
      class="notification"
      :class="{ 'error': error }"
    >
      {{ error || notification }}
    </div>
  </transition>
</template>

<script>
import { mapGetters } from 'vuex';

export default {
  name: 'AppNotification',
  computed: {
    ...mapGetters({
      notification: 'getNotification',
      error: 'getError'
    })
  }
}
</script>

<style scoped>
.notification {
  position: fixed;
  top: 20px;
  right: 20px;
  padding: 1rem 1.5rem;
  border-radius: 4px;
  background-color: #2ecc71;
  color: white;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 100;
}

.notification.error {
  background-color: #e74c3c;
}

.fade-enter-active, .fade-leave-active {
  transition: opacity 0.3s, transform 0.3s;
}

.fade-enter-from, .fade-leave-to {
  opacity: 0;
  transform: translateY(-20px);
}
</style>
