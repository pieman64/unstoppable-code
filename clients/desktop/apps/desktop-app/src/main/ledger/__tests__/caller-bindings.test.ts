import {
  getLedgerCallerBindingRegistry,
  LedgerCallerBindingRegistry,
  type LedgerCallerBindingRegistration,
} from '../caller-bindings';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1_000;

function registration(
  overrides: Partial<LedgerCallerBindingRegistration> = {},
): LedgerCallerBindingRegistration {
  return {
    container: {
      kind: 'code_worktree',
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
    },
    containerCreatedAt: '2026-09-28T10:00:00.000Z',
    actor: { kind: 'chat', originKey: 'chat-1', displayName: 'Refactor chat' },
    role: 'interactive_chat',
    authorDetails: {
      harness: 'claude',
      model: 'opus',
      thinkingEffort: 'high',
      mode: 'auto',
      pipelineExecutionId: null,
      settingsRevision: null,
      unavailableReason: null,
    },
    runtimeGeneration: 2,
    ...overrides,
  };
}

interface ManualClock {
  now: () => number;
  advance: (ms: number) => void;
  set: (time: number) => void;
}

function manualClock(start: number): ManualClock {
  let time = start;
  return {
    now: (): number => time,
    advance: (ms: number): void => {
      time += ms;
    },
    set: (next: number): void => {
      time = next;
    },
  };
}

describe('LedgerCallerBindingRegistry', () => {
  it('registers a binding and resolves a frozen snapshot of it', () => {
    const registry = new LedgerCallerBindingRegistry({
      now: manualClock(1_000).now,
    });
    const input = registration({ ttlMs: 60_000 });

    const bindingId = registry.register(input);
    const binding = registry.resolve(bindingId);

    expect(binding).toEqual({
      bindingId,
      container: input.container,
      containerCreatedAt: input.containerCreatedAt,
      actor: input.actor,
      role: 'interactive_chat',
      authorDetails: input.authorDetails,
      runtimeGeneration: 2,
      registeredAt: 1_000,
      expiresAt: 61_000,
    });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding?.container)).toBe(true);
    expect(Object.isFrozen(binding?.actor)).toBe(true);
    expect(Object.isFrozen(binding?.authorDetails)).toBe(true);
  });

  it('freezes a delegate lineage with its parent and root', () => {
    const registry = new LedgerCallerBindingRegistry();
    const bindingId = registry.register(
      registration({
        role: 'managed_delegation',
        actor: {
          kind: 'managed_delegation',
          originKey: 'delegation-1',
          displayName: 'Review delegate',
        },
        origin: {
          kind: 'managed_delegation',
          delegationId: 'delegation-1',
          parent: { kind: 'chat', originKey: 'chat-1', displayName: 'Chat' },
          root: { kind: 'chat', chatId: 'chat-1' },
          runGeneration: 2,
        },
      }),
    );

    const origin = registry.resolve(bindingId)?.origin;

    if (origin?.kind !== 'managed_delegation') {
      throw new Error('Expected a delegate lineage');
    }
    expect(origin.parent).toEqual({
      kind: 'chat',
      originKey: 'chat-1',
      displayName: 'Chat',
    });
    expect(Object.isFrozen(origin)).toBe(true);
    expect(Object.isFrozen(origin.parent)).toBe(true);
    expect(Object.isFrozen(origin.root)).toBe(true);
  });

  it('keeps its snapshot when the registering code changes its input', () => {
    const registry = new LedgerCallerBindingRegistry();
    const input = registration();
    const bindingId = registry.register(input);

    input.actor.displayName = 'Renamed chat';
    input.authorDetails.model = 'another-model';
    if (input.container.kind === 'code_worktree') {
      input.container.worktreeId = 'worktree-2';
    }

    expect(registry.resolve(bindingId)).toMatchObject({
      container: { worktreeId: 'worktree-1' },
      actor: { displayName: 'Refactor chat' },
      authorDetails: { model: 'opus' },
    });
  });

  it('issues unique random IDs that carry nothing from the registration', () => {
    const registry = new LedgerCallerBindingRegistry({ now: (): number => 0 });
    const otherRegistry = new LedgerCallerBindingRegistry({
      now: (): number => 0,
    });

    const ids = Array.from({ length: 200 }, () =>
      registry.register(registration()),
    );
    const otherId = otherRegistry.register(registration());

    expect(new Set([...ids, otherId]).size).toBe(ids.length + 1);
    for (const id of [...ids, otherId]) {
      expect(id).toMatch(UUID_V4);
      for (const fragment of ['workspace', 'worktree', 'chat', 'interactive']) {
        expect(id).not.toContain(fragment);
      }
    }
    // An ID means nothing outside the registry that issued it.
    expect(otherRegistry.resolve(ids[0])).toBeUndefined();
    expect(registry.resolve(otherId)).toBeUndefined();
  });

  it.each([
    '',
    'unknown',
    '__proto__',
    'constructor',
    'toString',
    '00000000-0000-4000-8000-000000000000',
  ])('does not resolve the unknown ID %p', (bindingId) => {
    const registry = new LedgerCallerBindingRegistry();
    registry.register(registration());

    expect(registry.resolve(bindingId)).toBeUndefined();
  });

  it('stops resolving a binding when its lifetime ends', () => {
    const clock = manualClock(5_000);
    const registry = new LedgerCallerBindingRegistry({ now: clock.now });
    const bindingId = registry.register(registration({ ttlMs: 1_000 }));

    clock.advance(999);
    expect(registry.resolve(bindingId)).toBeDefined();

    clock.advance(1);
    expect(registry.resolve(bindingId)).toBeUndefined();

    // An expired binding is gone, even if the clock moves back.
    clock.set(5_000);
    expect(registry.resolve(bindingId)).toBeUndefined();
    expect(registry.revoke(bindingId)).toBe(false);
  });

  it('keeps a binding without a lifetime until it is revoked', () => {
    const clock = manualClock(0);
    const registry = new LedgerCallerBindingRegistry({ now: clock.now });
    const bindingId = registry.register(registration());

    clock.advance(TEN_YEARS_MS);
    expect(registry.resolve(bindingId)?.expiresAt).toBeNull();

    expect(registry.revoke(bindingId)).toBe(true);
    expect(registry.resolve(bindingId)).toBeUndefined();
    expect(registry.revoke(bindingId)).toBe(false);
  });

  it('revokes every live binding a predicate matches', () => {
    const clock = manualClock(0);
    const registry = new LedgerCallerBindingRegistry({ now: clock.now });
    const staleGeneration = registry.register(
      registration({ runtimeGeneration: 1 }),
    );
    const liveGeneration = registry.register(
      registration({ runtimeGeneration: 2 }),
    );
    const otherWorktree = registry.register(
      registration({
        container: {
          kind: 'code_worktree',
          workspaceId: 'workspace-1',
          worktreeId: 'worktree-2',
        },
        runtimeGeneration: 1,
      }),
    );
    const expired = registry.register(
      registration({ runtimeGeneration: 1, ttlMs: 10 }),
    );
    clock.advance(10);

    const offered: string[] = [];
    const revoked = registry.revokeWhere((binding) => {
      offered.push(binding.bindingId);
      return (
        binding.container.kind === 'code_worktree' &&
        binding.container.worktreeId === 'worktree-1' &&
        binding.runtimeGeneration < 2
      );
    });

    expect(revoked).toBe(1);
    expect(offered).not.toContain(expired);
    expect(registry.resolve(staleGeneration)).toBeUndefined();
    expect(registry.resolve(liveGeneration)).toBeDefined();
    expect(registry.resolve(otherWorktree)).toBeDefined();
    expect(registry.resolve(expired)).toBeUndefined();
  });

  it.each<[string, Partial<LedgerCallerBindingRegistration>]>([
    ['a negative runtime generation', { runtimeGeneration: -1 }],
    ['a fractional runtime generation', { runtimeGeneration: 1.5 }],
    ['a NaN runtime generation', { runtimeGeneration: Number.NaN }],
    ['a zero lifetime', { ttlMs: 0 }],
    ['a negative lifetime', { ttlMs: -5 }],
    ['an infinite lifetime', { ttlMs: Number.POSITIVE_INFINITY }],
    ['a NaN lifetime', { ttlMs: Number.NaN }],
  ])('refuses to register %s', (_label, overrides) => {
    const registry = new LedgerCallerBindingRegistry();

    expect(() => registry.register(registration(overrides))).toThrow(
      RangeError,
    );
  });
});

describe('getLedgerCallerBindingRegistry', () => {
  it('returns one shared registry', () => {
    const registry = getLedgerCallerBindingRegistry();

    expect(registry).toBeInstanceOf(LedgerCallerBindingRegistry);
    expect(getLedgerCallerBindingRegistry()).toBe(registry);
  });
});
