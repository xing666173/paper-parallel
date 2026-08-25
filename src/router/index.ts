import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  { path: '/', name: 'upload', component: () => import('../views/UploadView.vue') },
  { path: '/task/:projectId/process', name: 'process', component: () => import('../views/ProcessingView.vue') },
  { path: '/task/:projectId/read', name: 'reader', component: () => import('../views/ReaderTaskView.vue') },
];

if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
  routes.push({
    path: '/__typst-smoke', name: 'typst-smoke',
    component: () => import('../views/dev/TypstSmokeView.vue'),
  });
}

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
