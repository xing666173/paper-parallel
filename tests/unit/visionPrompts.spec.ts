import { describe, expect, it } from 'vitest';
import { buildVisionLayoutPrompt } from '../../src/core/vision/prompts';

describe('vision layout prompt', () => {
  it('requests only immutable assets and never asks the model to enumerate body text', () => {
    const prompt = buildVisionLayoutPrompt(3);
    expect(prompt).toContain('at most 32');
    expect(prompt).toContain('Do not return body text');
    expect(prompt).not.toContain('body_text');
    expect(prompt).not.toContain('header|footer');
  });
});
