import type {
  LedgerActorRecord,
  LedgerBindScopeInput,
  LedgerBindScopeResult,
  LedgerRegisterActorInput,
  LedgerRegisterActorResult,
} from '@canopy/desktop-shared/node/ledger';
import type { LedgerContainer } from '@canopy/protocol/canopy-core';
import {
  LedgerActorDirectory,
  LedgerOwnerEligibility,
} from '../actor-directory';
import type { LedgerStoreClient } from '../ledger-store-client';
import {
  LedgerScopeBindings,
  type LedgerBoundScope,
  type LedgerScopeBindingsOptions,
} from '../scope-bindings';

const AUTHORITY_ID = '11111111-1111-4111-8111-111111111111';
const T0 = '2026-09-20T10:00:00.000Z';
const T1 = '2026-09-26T08:30:00.000Z';

function worktree(worktreeId: string): LedgerContainer {
  return { kind: 'code_worktree', workspaceId: 'workspace-1', worktreeId };
}

function uuid(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

function unused(method: string): Promise<never> {
  return Promise.reject(new Error(`${method} is not used here`));
}

/** Mints a scope per bind and an actor per registration, counting calls. */
class CountingStore implements LedgerStoreClient {
  readonly bindScopeCalls: LedgerBindScopeInput[] = [];
  readonly registerActorCalls: LedgerRegisterActorInput[] = [];
  listActorsCalls = 0;
  private nextId = 1;
  private readonly actors: LedgerActorRecord[] = [];
  /** When set, binds wait for it before answering. */
  bindGate: Promise<void> | undefined;

  getAuthorityId(): Promise<string> {
    return Promise.resolve(AUTHORITY_ID);
  }

  async bindScope(input: LedgerBindScopeInput): Promise<LedgerBindScopeResult> {
    this.bindScopeCalls.push(input);
    if (this.bindGate !== undefined) await this.bindGate;
    const ledgerId = uuid(this.nextId);
    this.nextId += 1;
    return {
      scope: {
        scope: {
          ledgerId,
          authorityId: input.authorityId,
          container: input.container,
        },
        containerCreatedAt: input.containerCreatedAt,
        accountId: input.accountId,
        lifecycleState: 'active',
        sequence: '1',
        createdAt: T1,
      },
      created: true,
    };
  }

  registerActor(
    input: LedgerRegisterActorInput,
  ): Promise<LedgerRegisterActorResult> {
    this.registerActorCalls.push(input);
    const actor: LedgerActorRecord = {
      actor: {
        actorId: uuid(1_000 + this.registerActorCalls.length),
        kind: input.kind,
        authorityId: input.authorityId,
      },
      ledgerId: input.ledgerId,
      originKey: input.originKey,
      displayName: input.displayName,
      createdAt: T1,
    };
    this.actors.push(actor);
    return Promise.resolve({ actor, created: true });
  }

  listActors(ledgerId: string): Promise<LedgerActorRecord[]> {
    this.listActorsCalls += 1;
    return Promise.resolve(
      this.actors.filter((actor) => actor.ledgerId === ledgerId),
    );
  }

  findScope(): Promise<never> {
    return unused('findScope');
  }

  bindGlobalScope(): Promise<never> {
    return unused('bindGlobalScope');
  }

  findGlobalScope(): Promise<never> {
    return unused('findGlobalScope');
  }

  getScope(): Promise<never> {
    return unused('getScope');
  }

  addEntry(): Promise<never> {
    return unused('addEntry');
  }

  updateEntry(): Promise<never> {
    return unused('updateEntry');
  }

  publishSummary(): Promise<never> {
    return unused('publishSummary');
  }

  listReceiptKeys(): Promise<never> {
    return unused('listReceiptKeys');
  }

  getEntry(): Promise<never> {
    return unused('getEntry');
  }

  listPendingTitles(): Promise<never> {
    return unused('listPendingTitles');
  }

  recordPendingTitleAttempt(): Promise<never> {
    return unused('recordPendingTitleAttempt');
  }

  resolvePendingTitle(): Promise<never> {
    return unused('resolvePendingTitle');
  }

  searchEntries(): Promise<never> {
    return unused('searchEntries');
  }

  listChanges(): Promise<never> {
    return unused('listChanges');
  }

  getStorageCounts(): Promise<never> {
    return unused('getStorageCounts');
  }

  listScopes(): Promise<never> {
    return unused('listScopes');
  }

  findContainerScopes(): Promise<never> {
    return unused('findContainerScopes');
  }

  setScopeLifecycle(): Promise<never> {
    return unused('setScopeLifecycle');
  }

  rebindScope(): Promise<never> {
    return unused('rebindScope');
  }

  purgeScope(): Promise<never> {
    return unused('purgeScope');
  }
}

function bindingsOptions(store: CountingStore): LedgerScopeBindingsOptions {
  return {
    store: (): LedgerStoreClient => store,
    getAccountId: (): null => null,
  };
}

describe('LedgerScopeBindings.forgetContainer', () => {
  it('forgets every incarnation of that container and nothing else', async () => {
    const store = new CountingStore();
    const scopes = new LedgerScopeBindings(bindingsOptions(store));
    const first = await scopes.resolve(worktree('wt-1'), T0);
    await scopes.resolve(worktree('wt-1'), T1);
    const other = await scopes.resolve(worktree('wt-2'), T0);
    expect(store.bindScopeCalls).toHaveLength(3);

    scopes.forgetContainer(worktree('wt-1'));

    const again = await scopes.resolve(worktree('wt-1'), T0);
    await scopes.resolve(worktree('wt-1'), T1);
    expect(await scopes.resolve(worktree('wt-2'), T0)).toBe(other);
    expect(again).not.toBe(first);
    expect(store.bindScopeCalls).toHaveLength(5);
  });

  it('lets a bind already in flight finish for its caller without caching it', async () => {
    const store = new CountingStore();
    const scopes = new LedgerScopeBindings(bindingsOptions(store));
    let open: () => void = (): void => undefined;
    store.bindGate = new Promise<void>((resolve) => {
      open = resolve;
    });

    const pending = scopes.resolve(worktree('wt-1'), T0);
    scopes.forgetContainer(worktree('wt-1'));
    open();
    const settled: LedgerBoundScope = await pending;
    store.bindGate = undefined;

    expect(settled.container).toEqual(worktree('wt-1'));
    await scopes.resolve(worktree('wt-1'), T0);
    expect(store.bindScopeCalls).toHaveLength(2);
  });
});

describe('LedgerActorDirectory.forgetLedger', () => {
  it('forgets every cached actor of that ledger and nothing else', async () => {
    const store = new CountingStore();
    const scopes = new LedgerScopeBindings(bindingsOptions(store));
    const directory = new LedgerActorDirectory({
      store: (): LedgerStoreClient => store,
      liveChats: (): Promise<[]> => Promise.resolve([]),
      eligibility: new LedgerOwnerEligibility(),
    });
    const forgotten = await scopes.resolve(worktree('wt-1'), T0);
    const kept = await scopes.resolve(worktree('wt-2'), T0);
    const user = await directory.ensureUser(forgotten);
    await directory.ensureUser(kept);
    expect(await directory.findActor(forgotten, user.actor.actorId)).toBe(user);
    expect(store.registerActorCalls).toHaveLength(2);
    expect(store.listActorsCalls).toBe(0);

    directory.forgetLedger(forgotten.ledgerId);

    await directory.ensureUser(kept);
    expect(store.registerActorCalls).toHaveLength(2);
    await directory.findActor(forgotten, user.actor.actorId);
    expect(store.listActorsCalls).toBe(1);
    await directory.ensureUser(forgotten);
    expect(store.registerActorCalls).toHaveLength(3);
  });
});
