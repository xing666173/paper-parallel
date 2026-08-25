export interface DestroyablePdfDocument {
  destroy(): Promise<unknown> | unknown;
}

export function releasePdfDocument(document: DestroyablePdfDocument): void {
  try {
    void Promise.resolve(document.destroy()).catch(() => undefined);
  } catch {
    // Resource cleanup must not overwrite an already completed quality result.
  }
}
