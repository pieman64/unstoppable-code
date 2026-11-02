import {
  initialChatTurnState,
  serializeChatTurnState,
} from '@canopy/agent-transcript/turn';
import {
  ChatDispatchAuthorizationRegistry,
  getChatDispatchOutcomeAction,
  type ChatDispatchAuthorizationHost,
  type ChatDispatchOutcome,
} from '../chat-dispatch-authorization';
import {
  createChatTurnOwnershipSource,
  type ChatTurnOwnershipSnapshot,
  type ChatTurnStateSource,
} from '../chat-turn-ownership';
import type { TurnOwnershipRecord } from '../chat-turn-phase';

const scope = { projectId: 'p', worktreeId: 'w', chatId: 'c' };
const idle = serializeChatTurnState(initialChatTurnState());
interface AuthorizationFixture {
  owner: TurnOwnershipRecord & { kind: 'dispatch'; userMessageId: string };
  registry: ChatDispatchAuthorizationRegistry;
  get: () => ChatTurnOwnershipSnapshot;
  update: (patch: Partial<ChatTurnOwnershipSnapshot>) => void;
}
function setup(): AuthorizationFixture {
  const owner: TurnOwnershipRecord & {
    kind: 'dispatch';
    userMessageId: string;
  } = {
    kind: 'dispatch',
    token: Symbol('D'),
    userMessageId: 'A',
    operationEpoch: 1,
    reason: 'awaiting-start',
  };
  let snapshot: ChatTurnOwnershipSnapshot = {
    scope,
    serviceEpoch: Symbol('service'),
    operationEpoch: 1,
    knowledge: 'known',
    receipt: { generation: 0, state: idle },
    committed: { generation: 0, state: idle },
    unacknowledgedLifecycle: [],
    dispatchOwners: [owner],
    stopOwners: [],
    backgroundFreshness: 'fresh',
    hostQueuedInputCount: 0,
    removalAwaitingSettle: false,
  };
  const host: ChatDispatchAuthorizationHost = {
    getSnapshot: () => snapshot,
  };
  const registry = new ChatDispatchAuthorizationRegistry(host);
  return {
    owner,
    registry,
    get: (): ChatTurnOwnershipSnapshot => snapshot,
    update: (patch: Partial<ChatTurnOwnershipSnapshot>): void => {
      snapshot = { ...snapshot, ...patch };
    },
  };
}
const target = { ...scope, userMessageId: 'A' };

describe('ChatDispatchAuthorizationRegistry', () => {
  it('issues only installed admitted D, consumes once and retains ownership', () => {
    const f = setup();
    expect(() =>
      f.registry.issue(scope, { ...f.owner, token: Symbol('foreign') }),
    ).toThrow();
    const auth = f.registry.issue(scope, f.owner);
    expect(f.registry.consume(auth, target)).toEqual({
      kind: 'authorized',
      ownership: f.owner,
    });
    expect(f.registry.consume(auth, target)).toEqual({
      kind: 'refused',
      reason: 'consumed',
    });
    expect(f.get().dispatchOwners).toEqual([f.owner]);
  });
  it('refuses issuance while unknown or another canonical T owns admission', () => {
    const f = setup();
    f.update({ knowledge: 'unknown' });
    expect(() => f.registry.issue(scope, f.owner)).toThrow();
    f.update({
      knowledge: 'known',
      receipt: {
        generation: 2,
        state: {
          ...idle,
          current: {
            id: 'wake',
            origin: 'autonomous',
            startedAtMs: 1,
            pauses: [],
          },
        },
      },
    });
    expect(() => f.registry.issue(scope, f.owner)).toThrow();
  });
  it('refuses unknown, structural copies and JSON round trips without consuming the original', () => {
    const f = setup();
    const auth = f.registry.issue(scope, f.owner);
    const jsonCopy: unknown = JSON.parse(JSON.stringify(auth));
    for (const copy of [
      { ...auth },
      { ...auth, userMessageId: 'other' },
      { ...auth, authorizationToken: Symbol() },
    ]) {
      expect(f.registry.consume(copy, target)).toEqual({
        kind: 'refused',
        reason: 'unknown-token',
      });
    }
    // @ts-expect-error JSON is intentionally not a host capability.
    expect(f.registry.consume(jsonCopy, target)).toEqual({
      kind: 'refused',
      reason: 'unknown-token',
    });
    expect(f.registry.consume(auth, target).kind).toBe('authorized');
  });
  it.each(['projectId', 'worktreeId', 'chatId', 'userMessageId'] as const)(
    'rejects %s mismatch without spending the token',
    (key) => {
      const f = setup();
      const auth = f.registry.issue(scope, f.owner);
      expect(
        f.registry.consume(auth, { ...target, [key]: 'different' }),
      ).toEqual({ kind: 'refused', reason: 'scope-mismatch' });
      expect(f.registry.consume(auth, target).kind).toBe('authorized');
    },
  );
  it.each(['owner', 'epoch', 'service', 'anchor', 'kind', 'turn'] as const)(
    'rejects stale %s',
    (change) => {
      const f = setup();
      const auth = f.registry.issue(scope, f.owner);
      if (change === 'owner') f.update({ dispatchOwners: [] });
      if (change === 'epoch') f.update({ operationEpoch: 2 });
      if (change === 'service')
        f.update({ serviceEpoch: Symbol('replacement') });
      if (change === 'anchor')
        f.update({ dispatchOwners: [{ ...f.owner, userMessageId: 'other' }] });
      if (change === 'kind')
        f.update({
          dispatchOwners: [],
          stopOwners: [{ ...f.owner, kind: 'stop' }],
        });
      // Binding T after issuance is legitimate ownership progression, not a new attempt.
      if (change === 'turn')
        f.update({
          dispatchOwners: [
            { ...f.owner, turnId: 'T', reason: 'awaiting-commit' },
          ],
        });
      expect(f.registry.consume(auth, target)).toEqual(
        change === 'turn'
          ? { kind: 'authorized', ownership: f.get().dispatchOwners[0] }
          : { kind: 'refused', reason: 'stale-owner' },
      );
    },
  );
  it('revokes idempotently; a copied token cannot revoke the original', () => {
    const f = setup();
    const auth = f.registry.issue(scope, f.owner);
    f.registry.revoke({ ...auth });
    expect(f.registry.consume(auth, target).kind).toBe('authorized');
    f.registry.revoke(auth);
    f.registry.revoke(auth);
    expect(f.registry.consume(auth, target)).toEqual({
      kind: 'refused',
      reason: 'unknown-token',
    });
  });
});

describe('getChatDispatchOutcomeAction', () => {
  const owner = { dispatchOwner: Symbol('D'), operationEpoch: 2 };
  it('ignores another attempt without releasing any owner', () => {
    expect(
      getChatDispatchOutcomeAction(
        { ...owner, kind: 'accepted' },
        { token: Symbol('new'), operationEpoch: 3 },
      ),
    ).toEqual({ kind: 'ignore-stale' });
  });
  it('ignores a stale operation epoch even with the same D token', () => {
    expect(
      getChatDispatchOutcomeAction(
        { ...owner, kind: 'accepted' },
        { token: owner.dispatchOwner, operationEpoch: 3 },
      ),
    ).toEqual({ kind: 'ignore-stale' });
  });
  it('retains accepted D until acknowledged start', () => {
    expect(
      getChatDispatchOutcomeAction({ ...owner, kind: 'accepted' }),
    ).toEqual({ kind: 'retain-accepted-start', ...owner });
  });
  it.each([true, false])(
    'parks durable FIFO without duplicating visible prompt (already committed=%s)',
    (promptCommitted) => {
      const outcome: ChatDispatchOutcome = {
        ...owner,
        kind: 'parked',
        blockedByTurnId: 'wake',
        receiptGeneration: 4,
        promptCommitted,
      };
      expect(getChatDispatchOutcomeAction(outcome)).toEqual({
        kind: 'durable-hand-back',
        ...owner,
        blockedByTurnId: 'wake',
        receiptGeneration: 4,
        promptCommitted,
        preserveOriginalRow: true,
        emitVisiblePrompt: false,
        revokeAuthorization: true,
        releaseOwnerAfter: 'hand-back-commit',
      });
    },
  );
  it.each([
    'cancelled',
    'authorization',
    'deleted',
    'policy',
    'provider-refused',
  ] as const)('retires proven %s refusal only after persistence', (reason) => {
    expect(
      getChatDispatchOutcomeAction({
        ...owner,
        kind: 'refused',
        reason,
      }),
    ).toEqual({
      kind: 'retire-after-refusal-commit',
      ...owner,
      reason,
      revokeAuthorization: true,
    });
  });
  it.each(['not-started', 'uncertain', 'started'] as const)(
    'handles failed %s conservatively',
    (providerStart) => {
      const error = new Error('failed');
      expect(
        getChatDispatchOutcomeAction({
          ...owner,
          kind: 'failed',
          providerStart,
          error,
        }),
      ).toEqual({
        kind:
          providerStart === 'not-started'
            ? 'recover-undispatched'
            : providerStart === 'uncertain'
              ? 'retain-for-reconciliation'
              : 'settle-captured-turn',
        ...owner,
        error,
        revokeAuthorization: true,
      });
    },
  );
});

describe('authorization with the real ownership aggregate', () => {
  async function realHost(
    state = idle,
  ): Promise<ReturnType<typeof createChatTurnOwnershipSource>> {
    const ownership = createChatTurnOwnershipSource();
    const source: ChatTurnStateSource = {
      getTurnState: () => state,
      onTurnStateChange: () => () => undefined,
      onTurnStateCommitted: () => () => undefined,
    };
    ownership.bind(source, () => Promise.resolve(state));
    await ownership.hydrate(scope);
    return ownership;
  }
  it('keeps D authorization valid across FIFO and background bookkeeping', async () => {
    const host = await realHost();
    const registry = new ChatDispatchAuthorizationRegistry(host);
    const owner = host.registerDispatchOwner(scope, {
      token: Symbol('D'),
      userMessageId: 'A',
    });
    if (owner.kind !== 'dispatch' || !owner.userMessageId)
      throw new Error('invalid fixture');
    const auth = registry.issue(scope, {
      ...owner,
      kind: owner.kind,
      userMessageId: owner.userMessageId,
    });
    host.setHostQueuedInputCount(scope, 3);
    host.markBackgroundFresh(scope);
    host.bindDispatchOwner(scope, owner.token, owner.operationEpoch, 'T');
    expect(registry.consume(auth, target).kind).toBe('authorized');
  });
});
