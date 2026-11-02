import type {
  ManagedDelegationLifetimeStatus,
  ManagedDelegationLifetimeChangedEvent,
} from '@canopy/protocol/delegation';
import type { AgentDelegationBroker } from '@canopy/desktop-shared/node/delegation/broker';

export type LifetimeScope = ManagedDelegationLifetimeChangedEvent;
export type LifetimeSnapshot =
  | ReturnType<AgentDelegationBroker['lifetimeSnapshot']>
  | {
      readonly kind: 'error';
      readonly reason: 'invalid_request' | 'scope_unavailable' | 'read_failed';
    };

/** Session memory and one invalidation-fenced cached read per worktree. */
export class ManagedDelegationLifetimeStatusService {
  private readonly scopes = new Map<string, LifetimeScope>();
  private readonly cache = new Map<
    string,
    Promise<ManagedDelegationLifetimeStatus>
  >();
  private readonly refusals = new Map<string, Set<string>>();
  private readonly observations = new Map<string, string>();
  private readonly dirty = new Map<string, LifetimeScope>();
  private readonly listeners = new Set<(scope: LifetimeScope) => void>();
  private scheduled = false;

  constructor(
    private readonly read: (scope: LifetimeScope) => Promise<LifetimeSnapshot>,
  ) {}

  private key(scope: LifetimeScope): string {
    return JSON.stringify([scope.projectId, scope.worktreeId]);
  }

  getLifetimeStatus(
    scope: LifetimeScope,
  ): Promise<ManagedDelegationLifetimeStatus> {
    const key = this.key(scope);
    this.scopes.set(key, { ...scope });
    const prior = this.cache.get(key);
    if (prior) return prior;
    const pending: Promise<ManagedDelegationLifetimeStatus> =
      Promise.resolve().then(
        async (): Promise<ManagedDelegationLifetimeStatus> => {
          let snapshot: LifetimeSnapshot;
          try {
            snapshot = await this.read(scope);
          } catch {
            snapshot = { kind: 'error', reason: 'read_failed' };
          }
          // A count/refusal/policy event during I/O supersedes this result.
          if (this.cache.get(key) !== pending)
            return this.getLifetimeStatus(scope);
          if (snapshot.kind !== 'available') return snapshot;
          if (!snapshot.atLimit) this.refusals.delete(key);
          return {
            kind: 'available',
            occupied: snapshot.occupied,
            retained: snapshot.retained,
            limit: snapshot.limit,
            cap: snapshot.cap,
            atLimit: snapshot.atLimit,
            canExtend: snapshot.extension === 'possible',
            atCap: snapshot.extension === 'at_cap',
            refusedChatIds: Array.from(this.refusals.get(key) ?? []),
          };
        },
      );
    this.cache.set(key, pending);
    return pending;
  }

  refuse(
    scope: LifetimeScope & { readonly chatId: string },
    reason: 'capacity' | 'policy_unavailable',
  ): void {
    const key = this.key(scope);
    if (reason === 'capacity') {
      const chats = this.refusals.get(key) ?? new Set<string>();
      chats.add(scope.chatId);
      this.refusals.set(key, chats);
    }
    this.changed(scope);
  }

  observe(scope: LifetimeScope, snapshot: LifetimeSnapshot): void {
    const key = this.key(scope);
    const value = JSON.stringify(snapshot);
    if (this.observations.get(key) === value) return;
    this.observations.set(key, value);
    // Restoration is observed even if no UI is currently mounted.
    if (snapshot.kind === 'available' && !snapshot.atLimit)
      this.refusals.delete(key);
    this.changed(scope);
  }

  changed(scope: LifetimeScope): void {
    const key = this.key(scope);
    const target = { projectId: scope.projectId, worktreeId: scope.worktreeId };
    this.scopes.set(key, target);
    this.cache.delete(key);
    this.dirty.set(key, target);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask((): void => {
      this.scheduled = false;
      const dirty = Array.from(this.dirty.values());
      this.dirty.clear();
      for (const target of dirty)
        for (const listener of Array.from(this.listeners)) {
          try {
            listener(target);
          } catch {
            /* An observer cannot affect admission. */
          }
        }
    });
  }

  changedAll(): void {
    for (const scope of Array.from(this.scopes.values())) this.changed(scope);
  }

  subscribe(listener: (scope: LifetimeScope) => void): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }
}

export const managedDelegationLifetimeStatus =
  new ManagedDelegationLifetimeStatusService(
    async (scope): Promise<LifetimeSnapshot> => {
      const service = await import('./service');
      return service.readManagedDelegationLifetimeSnapshot(scope);
    },
  );

export function notifyManagedDelegationLifetimePreferencesChanged(): void {
  managedDelegationLifetimeStatus.changedAll();
}
