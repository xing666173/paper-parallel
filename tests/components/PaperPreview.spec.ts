// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import PaperPreview from '../../src/components/processing/PaperPreview.vue';

describe('compiled paper preview', () => {
  it('renders a generated local SVG preview URL', () => {
    const wrapper = mount(PaperPreview, {
      props: { previewUrl: 'blob:https://local/preview', previewState: 'ready' },
    });
    const previews = wrapper.findAll('object');
    expect(previews).toHaveLength(1);
    expect(previews[0]?.attributes('data')).toBe('blob:https://local/preview');
    expect(previews[0]?.attributes('type')).toBe('image/svg+xml');
  });

  it('does not render an arbitrary remote preview URL', () => {
    const wrapper = mount(PaperPreview, {
      props: { previewUrl: 'https://attacker.invalid/x.svg', previewState: 'ready' },
    });
    expect(wrapper.find('object').exists()).toBe(false);
    expect(wrapper.text()).toContain('预览地址无效');
  });

  it('shows honest building and failed states', async () => {
    const wrapper = mount(PaperPreview, { props: { previewState: 'building' } });
    expect(wrapper.text()).toContain('正在生成中文排版预览');
    await wrapper.setProps({ previewState: 'failed' });
    expect(wrapper.text()).toContain('中文预览生成失败');
  });
});
