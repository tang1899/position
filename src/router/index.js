import { createRouter, createWebHistory } from 'vue-router'
import MapHome from '@/views/MapHome.vue'
import MonitorForm from '@/views/MonitorForm.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'map-home',
      component: MapHome,
    },
    {
      path: '/monitor/new',
      name: 'monitor-new',
      component: MonitorForm,
    },
    {
      path: '/monitor/:id/edit',
      name: 'monitor-edit',
      component: MonitorForm,
    },
  ],
})

export default router
