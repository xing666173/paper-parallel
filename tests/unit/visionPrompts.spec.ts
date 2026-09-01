import { describe, expect, it } from 'vitest';
import { buildVisionLayoutPrompt } from '../../src/core/vision/prompts';

describe('vision layout prompt', () => {
  it('requests only immutable assets and never asks the model to enumerate body text', () => {
    const prompt = buildVisionLayoutPrompt(3);
    expect(prompt).toContain('at most 32');
    expect(prompt).toContain('cross_page_hint');
    expect(prompt).toContain('Do not return body text');
    expect(prompt).not.toContain('body_text');
    expect(prompt).not.toContain('header|footer');
  });

  it('requires an exhaustive top-to-bottom scan for formulas and complete algorithms', () => {
    const prompt = buildVisionLayoutPrompt(6);
    expect(prompt).toContain('Scan the page from top to bottom');
    expect(prompt).toContain('every display formula');
    expect(prompt).toContain('complete algorithm or pseudocode environment');
  });
});
