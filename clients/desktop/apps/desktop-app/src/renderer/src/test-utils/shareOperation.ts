/**
 * Main resolves share create/update/commit calls as a `ShareOperationResult`.
 * Wrap a detail-returning test double in the success envelope; rejections
 * still propagate unchanged so existing failure assertions keep their meaning.
 */
export function shareEnvelope<TArgs extends unknown[]>(
  mock: (...args: TArgs) => Promise<unknown>,
): (...args: TArgs) => Promise<{ ok: true; value: unknown }> {
  return async (...args) => ({ ok: true, value: await mock(...args) });
}
