import type { TerminalClient } from '@canopy/app-core';

export interface TerminalClientLifetime {
  client: TerminalClient;
  /** False after this acquisition is released, disposed, or replaced. */
  isCurrent: () => boolean;
}

interface Binding {
  client: TerminalClient;
}
interface Consumer {
  start: (binding: Binding) => void;
  stop: () => void;
}
let binding: Binding | undefined;
const consumers = new Set<Consumer>();
const resetCallbacks = new Set<() => void>();

/** Internal store reset registration. Registration never accesses the host. */
export function registerTerminalClientReset(reset: () => void): () => void {
  resetCallbacks.add(reset);
  return (): void => {
    resetCallbacks.delete(reset);
  };
}

/**
 * Acquire a feed for the current host, reconnect it on replacement, and release
 * it on disposal. Unregister on consumer unmount. Use isCurrent after awaits or
 * inside retained callbacks so an obsolete acquisition cannot publish state.
 */
export function registerTerminalClientLifecycle(
  acquire: (lifetime: TerminalClientLifetime) => () => void,
): () => void {
  let stop: (() => void) | undefined;
  const consumer: Consumer = {
    start: (current): void => {
      let active = true;
      try {
        const release = acquire({
          client: current.client,
          isCurrent: (): boolean => active && binding === current,
        });
        stop = (): void => {
          active = false;
          release();
        };
      } catch (error: unknown) {
        active = false;
        throw error;
      }
    },
    stop: (): void => {
      const release = stop;
      stop = undefined;
      release?.();
    },
  };
  consumers.add(consumer);
  try {
    if (binding) consumer.start(binding);
  } catch (error: unknown) {
    // No unregister handle reached the caller, so this registration must not
    // survive its failed first acquisition.
    consumers.delete(consumer);
    throw error;
  }
  return (): void => {
    if (!consumers.delete(consumer)) return;
    consumer.stop();
  };
}

function clearBinding(): void {
  binding = undefined;
  const errors: unknown[] = [];
  for (const dispose of [
    ...Array.from(consumers, (consumer) => consumer.stop),
    ...Array.from(resetCallbacks),
  ]) {
    try {
      dispose();
    } catch (error: unknown) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw errors[0];
}

/**
 * Terminal stores are an approved app-state singleton exception. Hosts must
 * dispose on sign-out/unmount. Initial binding is inert; only an explicitly
 * acquired consumer may query/subscribe, preserving lazy desktop preload access.
 */
export function bindTerminalClient(client: TerminalClient): () => void {
  clearBinding();
  const current: Binding = { client };
  binding = current;
  try {
    for (const consumer of Array.from(consumers)) consumer.start(current);
  } catch (error: unknown) {
    try {
      clearBinding();
    } catch {
      // clearBinding finishes all cleanup/reset callbacks before throwing.
      // The acquisition failure is the reason this host could not be bound.
    }
    throw error;
  }
  return (): void => {
    if (binding === current) clearBinding();
  };
}

export function requireTerminalClient(): TerminalClient {
  if (!binding)
    throw new Error(
      'Terminal host is not bound. Call bindTerminalClient(client) before using terminal state.',
    );
  return binding.client;
}

/** Capture one binding for async work; even rebinding the same client invalidates it. */
export function requireTerminalClientLifetime(): TerminalClientLifetime {
  const client = requireTerminalClient();
  const current = binding;
  return { client, isCurrent: (): boolean => binding === current };
}
