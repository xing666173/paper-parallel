import { describe, expect, it, vi } from 'vitest';
import { releasePdfDocument } from '../../src/core/vision/cleanup';

describe('vision PDF cleanup', () => {
  it('starts cleanup without waiting for a PDF.js destroy promise that never settles', () => {
    const destroy = vi.fn(() => new Promise(() => undefined));

    expect(releasePdfDocument({ destroy })).toBeUndefined();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('does not let synchronous cleanup failures replace a completed review', () => {
    expect(() => releasePdfDocument({ destroy: () => { throw new Error('worker already closed'); } })).not.toThrow();
  });
});
