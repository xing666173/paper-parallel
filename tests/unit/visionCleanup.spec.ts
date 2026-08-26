import { describe, expect, it, vi } from 'vitest';
import { releasePdfDocument } from '../../src/core/vision/cleanup';

describe('vision PDF cleanup', () => {
  it('defers PDF.js destruction until page unload instead of starting it on the critical path', () => {
    const destroy = vi.fn(() => new Promise(() => undefined));
    let deferred: (() => void) | undefined;

    expect(releasePdfDocument({ destroy }, (cleanup) => { deferred = cleanup; })).toBeUndefined();
    expect(destroy).not.toHaveBeenCalled();
    deferred?.();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('does not let synchronous cleanup failures replace a completed review', () => {
    let deferred: (() => void) | undefined;
    releasePdfDocument(
      { destroy: () => { throw new Error('worker already closed'); } },
      (cleanup) => { deferred = cleanup; },
    );
    expect(() => deferred?.()).not.toThrow();
  });
});
