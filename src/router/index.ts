import { createRouter, createWebHashHistory } from 'vue-router';
import HomeView from '../views/HomeView.vue';
import SetupView from '../views/SetupView.vue';
import WorkbenchView from '../views/WorkbenchView.vue';
import ReaderDemoView from '../views/ReaderDemoView.vue';
import ReviewView from '../views/ReviewView.vue';

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: HomeView },
    { path: '/setup', name: 'setup', component: SetupView },
    { path: '/workbench', name: 'workbench', component: WorkbenchView },
    { path: '/reader', name: 'reader', component: ReaderDemoView },
    { path: '/review', name: 'review', component: ReviewView },
  ],
});
