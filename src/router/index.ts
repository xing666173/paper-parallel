import { createRouter, createWebHashHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'upload', component: () => import('../views/UploadView.vue') },
    { path: '/task/:projectId/process', name: 'process', component: () => import('../views/ProcessingView.vue') },
    { path: '/task/:projectId/read', name: 'reader', component: () => import('../views/ReaderTaskView.vue') },
  ],
});
