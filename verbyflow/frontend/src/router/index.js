import { createRouter, createWebHistory } from 'vue-router'
import Home from '../views/Home.vue'
import Call from '../views/Call.vue'

const routes = [
  {
    path: '/',
    name: 'Home',
    component: Home
  },
  {
    path: '/call',
    name: 'Call',
    component: Call
  },
  {
    path: '/call/:id',
    name: 'JoinCall',
    component: Call
  }
]

const router = createRouter({
  history: createWebHistory(process.env.BASE_URL),
  routes
})

export default router
