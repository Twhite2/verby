<template>
  <div class="app-container">
    <header>
      <div class="logo">
        <h1>VerbyFlow</h1>
      </div>
      <nav>
        <router-link to="/">Home</router-link>
        <router-link to="/call">Start Call</router-link>
      </nav>
    </header>
    <main>
      <router-view />
    </main>
    <AppNotification />
  </div>
</template>

<script>
import AppNotification from './components/Notification.vue';

export default {
  name: 'App',
  components: {
    AppNotification
  },
  mounted() {
    // Initialize app on mount
    this.$store.dispatch('initializeApp');
    this.$store.dispatch('user/initializeUser');
  }
}
</script>

<style>
:root {
  --primary-color: #3498db;
  --secondary-color: #2980b9;
  --accent-color: #2ecc71;
  --error-color: #e74c3c;
  --text-color: #333;
  --bg-color: #f5f7fa;
  --light-bg: #ffffff;
  --border-color: #e1e4e8;
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html, body {
  font-family: 'Roboto', sans-serif;
  font-size: 16px;
  color: var(--text-color);
  background-color: var(--bg-color);
  height: 100%;
}

#app {
  height: 100vh;
  display: flex;
  flex-direction: column;
}

.app-container {
  display: flex;
  flex-direction: column;
  height: 100%;
}

header {
  background-color: var(--light-bg);
  padding: 1rem 2rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--border-color);
}

.logo h1 {
  color: var(--primary-color);
  font-size: 1.8rem;
}

nav {
  display: flex;
  gap: 1.5rem;
}

nav a {
  color: var(--text-color);
  text-decoration: none;
  font-weight: 500;
  padding: 0.5rem 0.8rem;
  border-radius: 4px;
}

nav a:hover, nav a.router-link-active {
  color: var(--primary-color);
  background-color: rgba(52, 152, 219, 0.1);
}

main {
  flex: 1;
  overflow: auto;
  padding: 1rem;
}

button, .btn {
  border: none;
  padding: 0.8rem 1.5rem;
  border-radius: 4px;
  font-size: 1rem;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.3s;
}

.btn-primary {
  background-color: var(--primary-color);
  color: white;
}

.btn-primary:hover {
  background-color: var(--secondary-color);
}

.btn-secondary {
  background-color: #ecf0f1;
  color: var(--text-color);
}

.btn-secondary:hover {
  background-color: #bdc3c7;
}

.btn-danger {
  background-color: var(--error-color);
  color: white;
}

.btn-danger:hover {
  background-color: #c0392b;
}

.card {
  background-color: var(--light-bg);
  border-radius: 8px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
  padding: 1.5rem;
}
</style>
