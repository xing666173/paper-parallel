// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { createPinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectRepository } from '../../src/core/project/repository';
import UploadView from '../../src/views/UploadView.vue';

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

async function waitForCondition(condition: () => boolean, description: string): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > 2000) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'upload', component: UploadView },
      { path: '/task/:projectId/process', name: 'process', component: { template: '<div>processing</div>' } },
    ],
  });
}

describe('upload workflow', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMemoryStorage());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows current DeepSeek choices and omits probe and explanation panels', async () => {
    const router = createTestRouter();
    await router.push('/');
    await router.isReady();
    const wrapper = mount(UploadView, { global: { plugins: [createPinia(), router] } });

    expect(wrapper.text()).toContain('上传英文论文');
    expect(wrapper.text()).toContain('DeepSeek V4 Flash');
    expect(wrapper.text()).toContain('DeepSeek V4 Pro');
    expect(wrapper.text()).not.toContain('deepseek-chat');
    expect(wrapper.text()).not.toContain('无文件合成演示');
    expect(wrapper.text()).not.toContain('版式继承');
    expect(wrapper.text()).not.toContain('所有文件仅在浏览器中处理');
  });

  it('requires a PDF and successful connection before persisting and navigating', async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/models')) {
        return new Response(JSON.stringify({
          data: [
            { id: 'deepseek-v4-flash', object: 'model', owned_by: 'deepseek' },
            { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' },
          ],
        }), { status: 200 });
      }
      throw new Error(`测试连接不应发起收费的生成请求：${url}`);
    });
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

    const router = createTestRouter();
    await router.push('/');
    await router.isReady();
    const wrapper = mount(UploadView, { global: { plugins: [createPinia(), router] } });
    const start = wrapper.get<HTMLButtonElement>('[data-action="start"]');
    expect(start.element.disabled).toBe(true);

    await wrapper.get('[data-field="api-key"]').setValue('sk-browser-test');
    await wrapper.findAll('select')[1]!.setValue('enabled');
    const file = new File(['%PDF-test'], 'paper.pdf', { type: 'application/pdf' });
    const input = wrapper.get<HTMLInputElement>('[data-field="pdf"]');
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] });
    await input.trigger('change');
    await wrapper.get('[data-action="test-connection"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('连接成功');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(start.element.disabled).toBe(false);

    await wrapper.get('form').trigger('submit');
    await waitForCondition(() => {
      const currentAlert = wrapper.find('[role="alert"]');
      return router.currentRoute.value.name === 'process'
        || (currentAlert.exists() && currentAlert.text().length > 0);
    }, 'task creation');
    await flushPromises();

    const alert = wrapper.find('[role="alert"]');
    expect(alert.exists() ? alert.text() : '').toBe('');
    expect(router.currentRoute.value.name).toBe('process');
    const projectId = String(router.currentRoute.value.params.projectId);
    expect(projectId).toBe('pp-3c87d37f1dbea6909f917ce437c390fb8e655a774387d9e69301c0b2283d5b63');
    const artifact = await createProjectRepository().findArtifact(`${projectId}:english-pdf`);
    expect(artifact).toMatchObject({
      key: `${projectId}:english-pdf`, projectId, kind: 'english-pdf',
    });
    expect(JSON.stringify(artifact)).not.toContain('sk-browser-test');
    const task = await createProjectRepository().loadTask(projectId);
    expect(task?.settings).toMatchObject({
      modelId: 'deepseek-v4-flash', thinkingMode: 'enabled', sourceFileName: 'paper.pdf',
    });
    expect(JSON.stringify(task)).not.toContain('sk-browser-test');
    expect(sessionStorage.getItem('paper-parallel.deepseek-key-session')).toBe('sk-browser-test');
  });
});
