import { AsyncLocalStorage } from 'node:async_hooks';

/** One operation's hold on the local watcher scope fences it raises. */
export class LocalFenceHolder {
  active = true;
}

const UNSCOPED_HOLDER = new LocalFenceHolder();
const holderContext = new AsyncLocalStorage<LocalFenceHolder>();

/**
 * Runs `operation` as one scope fence holder (CAN-4989): its own nested
 * fences, releases and commits share the holder, and a release by another
 * holder of the same scope key leaves its cancellations in place. Nested
 * calls join the enclosing holder while it runs; work it leaves behind, such
 * as a timer or listener, starts a holder of its own.
 */
export async function runAsLocalFenceHolder<T>(
  operation: () => Promise<T>,
): Promise<T> {
  if (holderContext.getStore()?.active) return operation();
  const holder = new LocalFenceHolder();
  try {
    return await holderContext.run(holder, operation);
  } finally {
    holder.active = false;
  }
}

/**
 * The running operation's holder, which its leftover work keeps so a late
 * release still matches its fence. Callers outside any holder share one, as
 * every fence did before CAN-4989.
 */
export function currentLocalFenceHolder(): LocalFenceHolder {
  return holderContext.getStore() ?? UNSCOPED_HOLDER;
}
