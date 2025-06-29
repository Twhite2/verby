<template>
  <div id="app">
    <header class="app-header">
      <div class="logo">
        <h1>VerbyFlow</h1>
      </div>
      <nav class="main-nav">
        <router-link to="/">Home</router-link>
        <router-link to="/call">Start Call</router-link>
      </nav>
    </header>

    <main class="app-content">
      <router-view/>
    </main>

    <footer class="app-footer">
      <p>&copy; {{ currentYear }} VerbyFlow - Real-Time Multilingual Voice Communication</p>
    </footer>
    
    <!-- Notifications component for displaying alerts -->
    <Notifications />
  </div>
</template>

<script>
import Notifications from './components/Notifications.vue'

export default {
  name: 'App',
  components: {
    Notifications
  },
  computed: {
    currentYear() {
      return new Date().getFullYear();
    }
  }
}
</script>

<style>
:root {
  --primary-color: #4a6fa5;
  --secondary-color: #166e7a;
  --accent-color: #2dd18c;
  --dark-color: #333333;
  --light-color: #f5f5f5;
  --success-color: #28a745;
  --warning-color: #ffc107;
  --error-color: #dc3545;
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  line-height: 1.6;
  color: var(--dark-color);
  background-color: var(--light-color);
}

#app {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.app-header {
  background-color: var(--primary-color);
  color: white;
  padding: 1rem 2rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.logo h1 {
  font-size: 1.8rem;
  margin: 0;
}

.main-nav {
  display: flex;
  gap: 1.5rem;
}

.main-nav a {
  color: white;
  text-decoration: none;
  font-weight: 500;
  padding: 0.5rem 0;
  position: relative;
}

.main-nav a::after {
  content: '';
  position: absolute;
  width: 0;
  height: 2px;
  bottom: 0;
  left: 0;
  background-color: var(--accent-color);
  transition: width 0.3s ease;
}

.main-nav a:hover::after, .main-nav a.router-link-active::after {
  width: 100%;
}

.app-content {
  flex: 1;
  padding: 2rem;
  max-width: 1200px;
  margin: 0 auto;
  width: 100%;
}

.app-footer {
  background-color: var(--primary-color);
  color: white;
  text-align: center;
  padding: 1rem;
  margin-top: auto;
}

button {
  background-color: var(--accent-color);
  color: white;
  border: none;
  padding: 0.5rem 1.5rem;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 500;
  transition: background-color 0.3s ease;
}

button:hover {
  background-color: #25b478;
}

button:disabled {
  background-color: #cccccc;
  cursor: not-allowed;
}

.card {
  background-color: white;
  border-radius: 8px;
  padding: 1.5rem;
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
}

@media (max-width: 768px) {
  .app-header {
    flex-direction: column;
    padding: 1rem;
  }
  
  .main-nav {
    margin-top: 1rem;
  }
  
  .app-content {
    padding: 1rem;
  }
}
</style>
