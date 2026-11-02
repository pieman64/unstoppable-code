import { create } from 'zustand';
import type { CanopyCapabilities, CanopyClient } from '@canopy/app-core';
import type { ManagedDelegationLifetimeStatus } from '@canopy/protocol/delegation';
import {
  CLIENT_STORE_ACTIVATE,
  CLIENT_STORE_DISPOSE,
  createClientStore,
  type ClientStore,
} from '../create-client-store';

export interface LifetimeLimitTarget {
  readonly projectId: string;
  readonly worktreeId: string;
}

export type LifetimeLimitExtensionState =
  | 'idle'
  | 'pending'
  | 'failed'
  | 'uncertain';

export interface LifetimeLimitEntry {
  readonly status: ManagedDelegationLifetimeStatus | null;
  readonly loading: boolean;
  readonly extension: LifetimeLimitExtensionState;
}

export interface LifetimeLimitState {
  readonly entries: Readonly<Record<string, LifetimeLimitEntry>>;
  load: (target: LifetimeLimitTarget) => Promise<void>;
  extend: (target: LifetimeLimitTarget) => Promise<void>;
}

export function lifetimeLimitTargetKey(target: LifetimeLimitTarget): string {
  return JSON.stringify([target.projectId, target.worktreeId]);
}

export function createLifetimeLimitStore(
  client: CanopyClient,
): ClientStore<LifetimeLimitState> {
  const targets = new Map<string, LifetimeLimitTarget>();
  const generations = new Map<string, number>();
  const reads = new Map<string, Promise<void>>();
  const dirty = new Set<string>();
  let scheduled = false;
  let disposed = false;
  let unsubscribe: (() => void) | undefined;

  const capabilities = (target: LifetimeLimitTarget): CanopyCapabilities =>
    client.capabilitiesFor?.(target.worktreeId) ?? client.capabilities;

  const patch = (key: string, change: Partial<LifetimeLimitEntry>): void => {
    if (disposed) return;
    store.setState((state) => {
      const current = state.entries[key] ?? {
        status: null,
        loading: false,
        extension: 'idle',
      };
      return {
        entries: { ...state.entries, [key]: { ...current, ...change } },
      };
    });
  };

  const refresh = (target: LifetimeLimitTarget): Promise<void> => {
    const key = lifetimeLimitTargetKey(target);
    const generation = (generations.get(key) ?? 0) + 1;
    generations.set(key, generation);
    patch(key, { loading: true });
    const read = async (): Promise<void> => {
      let status: ManagedDelegationLifetimeStatus;
      try {
        status = await client.query('delegation.lifetimeStatus', target);
      } catch {
        status = { kind: 'error', reason: 'read_failed' };
      }
      if (disposed || generations.get(key) !== generation) return;
      patch(key, { status, loading: false });
    };
    const pending = read().finally(() => {
      if (reads.get(key) === pending) reads.delete(key);
    });
    reads.set(key, pending);
    return pending;
  };

  const invalidate = (target: LifetimeLimitTarget): void => {
    const key = lifetimeLimitTargetKey(target);
    if (disposed || !targets.has(key)) return;
    // Fence immediately, before the coalesced refresh starts.
    generations.set(key, (generations.get(key) ?? 0) + 1);
    dirty.add(key);
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (disposed) return;
      const keys = Array.from(dirty);
      dirty.clear();
      keys.forEach((dirtyKey) => {
        const scope = targets.get(dirtyKey);
        if (scope) void refresh(scope);
      });
    });
  };

  const store: ClientStore<LifetimeLimitState> = create<LifetimeLimitState>(
    () => ({
      entries: {},
      load(target): Promise<void> {
        if (
          disposed ||
          capabilities(target).delegationLifetimeStatusReads !== true
        )
          return Promise.resolve();
        const key = lifetimeLimitTargetKey(target);
        const pending = reads.get(key);
        if (pending) return pending;
        if (targets.has(key)) return Promise.resolve();
        targets.set(key, target);
        return refresh(target);
      },
      async extend(target): Promise<void> {
        const key = lifetimeLimitTargetKey(target);
        const entry = store.getState().entries[key];
        const flags = capabilities(target);
        if (
          disposed ||
          flags.delegationLifetimeStatusReads !== true ||
          flags.delegationLifetimeLimitExtension !== true ||
          entry?.extension === 'pending' ||
          entry?.status?.kind !== 'available' ||
          !entry.status.canExtend
        )
          return;
        patch(key, { extension: 'pending' });
        try {
          const result = await client.command(
            'delegation.extendLifetimeLimit',
            target,
          );
          if (disposed) return;
          if (result.ok) {
            // The command result is not a new admission snapshot. Read the owner.
            dirty.delete(key);
            await refresh(target);
            patch(key, { extension: 'idle' });
          } else {
            patch(key, {
              extension:
                result.reason === 'unavailable' ? 'uncertain' : 'failed',
            });
          }
        } catch {
          patch(key, { extension: 'uncertain' });
        }
      },
    }),
  );
  store[CLIENT_STORE_ACTIVATE] = (): void => {
    if (!disposed && !unsubscribe) {
      unsubscribe = client.subscribe('delegation.lifetimeChanged', invalidate);
    }
  };
  store[CLIENT_STORE_DISPOSE] = (): void => {
    disposed = true;
    unsubscribe?.();
    unsubscribe = undefined;
    dirty.clear();
    targets.clear();
    reads.clear();
  };
  return store;
}

export const useLifetimeLimitStore = createClientStore(
  createLifetimeLimitStore,
);
