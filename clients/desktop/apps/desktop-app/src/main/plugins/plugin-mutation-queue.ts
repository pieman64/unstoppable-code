import { AsyncLocalStorage } from 'node:async_hooks';

let tail: Promise<unknown> = Promise.resolve();
const active = new AsyncLocalStorage<boolean>();

/** One cache document, one mutation queue. A composed operation holds one slot. */
export function runSerializedPluginMutation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  if (active.getStore()) return operation();
  const result = tail.then(
    () => active.run(true, operation),
    () => active.run(true, operation),
  );
  tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function resetPluginMutationQueueForTests(): void {
  tail = Promise.resolve();
}
