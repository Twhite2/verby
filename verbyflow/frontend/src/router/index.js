import { createRouter, createWebHistory } from 'vue-router'

// View components
import Home from '../views/Home.vue'

const routes = [
  {
    path: '/',
    name: 'Home',
    component: Home
  },
  {
    path: '/call',
    name: 'Call',
    component: () => import(/* webpackChunkName: "call" */ '../views/Call.vue')
  },
  {
    path: '/call/:id',
    name: 'JoinCall',
    component: () => import(/* webpackChunkName: "call" */ '../views/Call.vue')
  }
]

const router = createRouter({
  history: createWebHistory(process.env.BASE_URL),
  routes
})

export default router
