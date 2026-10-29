import type {
  LedgerCommandReceipt,
  LedgerContainer,
  LedgerOwnerCandidate,
} from '@canopy/protocol/canopy-core';
import {
  LEDGER_ELIGIBILITY_TOKEN_LIFETIME_MS,
  LedgerOwnerEligibility,
  getLedgerOwnerEligibility,
  invalidateLedgerOwnerEligibility,
  withLedgerOwnerAdmission,
  type LedgerEligibilityClaim,
} from '../actor-directory';
import type { LedgerLiveDelegate } from '../delegate-owners';
import {
  TEST_CONTAINER,
  createLedgerServiceHarness,
  createTestClock,
  type LedgerServiceHarness,
} from './fixtures/in-process-ledger-store-client';

const LEDGER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_LEDGER_ID = '00000000-0000-4000-8000-000000000002';
const CHAT_ACTOR_ID = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ACTOR_ID = '00000000-0000-4000-8000-0000000000a2';
const OTHER_CONTAINER: LedgerContainer = {
  kind: 'code_worktree',
  workspaceId: 'workspace-1',
  worktreeId: 'worktree-2',
};

function claim(
  overrides: Partial<LedgerEligibilityClaim> = {},
): LedgerEligibilityClaim {
  return {
    ledgerId: LEDGER_ID,
    actorId: CHAT_ACTOR_ID,
    container: TEST_CONTAINER,
    originKey: 'chat:chat-1',
    ...overrides,
  };
}

describe('LedgerOwnerEligibility tokens', () => {
  it('accepts a fresh token for the claim it was issued for', () => {
    const eligibility = new LedgerOwnerEligibility();

    const token = eligibility.issueToken(claim());

    expect(token.length).toBeLessThanOrEqual(512);
    expect(eligibility.checkToken(claim(), token)).toBe(true);
  });

  it('rejects a token presented for another actor or ledger', () => {
    const eligibility = new LedgerOwnerEligibility();
    const token = eligibility.issueToken(claim());

    expect(
      eligibility.checkToken(claim({ actorId: OTHER_ACTOR_ID }), token),
    ).toBe(false);
    expect(
      eligibility.checkToken(claim({ ledgerId: OTHER_LEDGER_ID }), token),
    ).toBe(false);
  });

  it('rejects forged and malformed tokens', () => {
    const eligibility = new LedgerOwnerEligibility();
    const token = eligibility.issueToken(claim());
    const [version, expiresAt, containerRevision, actorRevision, mac] =
      token.split('.');
    const extended = [
      version,
      String(Number(expiresAt) + 60_000),
      containerRevision,
      actorRevision,
      mac,
    ].join('.');

    for (const forged of [
      extended,
      `${token}x`,
      token.slice(0, -1),
      [version, expiresAt, containerRevision, actorRevision].join('.'),
      'v1.1.0.0.x',
      '',
      'not a token',
    ]) {
      expect(eligibility.checkToken(claim(), forged)).toBe(false);
    }
    // Another instance (a restarted app) has another secret.
    expect(new LedgerOwnerEligibility().checkToken(claim(), token)).toBe(false);
  });

  it('expires a token after its lifetime', () => {
    const clock = createTestClock();
    const eligibility = new LedgerOwnerEligibility({ now: clock.now });
    const token = eligibility.issueToken(claim());

    clock.advance(LEDGER_ELIGIBILITY_TOKEN_LIFETIME_MS - 1);
    expect(eligibility.checkToken(claim(), token)).toBe(true);
    clock.advance(1);
    expect(eligibility.checkToken(claim(), token)).toBe(false);
  });

  it('invalidates one actor without touching the others', () => {
    const eligibility = new LedgerOwnerEligibility();
    const chatToken = eligibility.issueToken(claim());
    const otherClaim = claim({
      actorId: OTHER_ACTOR_ID,
      originKey: 'chat:chat-2',
    });
    const otherToken = eligibility.issueToken(otherClaim);

    eligibility.invalidate({
      container: TEST_CONTAINER,
      actor: { kind: 'chat', originKey: 'chat-1' },
    });

    expect(eligibility.checkToken(claim(), chatToken)).toBe(false);
    expect(eligibility.checkToken(otherClaim, otherToken)).toBe(true);
    // A token issued after the change carries the new revision.
    expect(
      eligibility.checkToken(claim(), eligibility.issueToken(claim())),
    ).toBe(true);
  });

  it('invalidates every actor of a container, and only that container', () => {
    const eligibility = new LedgerOwnerEligibility();
    const userClaim = claim({
      actorId: OTHER_ACTOR_ID,
      originKey: 'user:local',
    });
    const elsewhere = claim({
      ledgerId: OTHER_LEDGER_ID,
      container: OTHER_CONTAINER,
    });
    const chatToken = eligibility.issueToken(claim());
    const userToken = eligibility.issueToken(userClaim);
    const elsewhereToken = eligibility.issueToken(elsewhere);

    eligibility.invalidate({ container: TEST_CONTAINER });

    expect(eligibility.checkToken(claim(), chatToken)).toBe(false);
    expect(eligibility.checkToken(userClaim, userToken)).toBe(false);
    expect(eligibility.checkToken(elsewhere, elsewhereToken)).toBe(true);
  });

  it('exposes the app-wide invalidation for lifecycle hooks', () => {
    const eligibility = getLedgerOwnerEligibility();
    const token = eligibility.issueToken(claim());

    invalidateLedgerOwnerEligibility({
      container: TEST_CONTAINER,
      actor: { kind: 'chat', originKey: 'chat-1' },
    });

    expect(eligibility.checkToken(claim(), token)).toBe(false);
  });
});

describe('owner admission fence', () => {
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve: () => void = (): void => undefined;
    const promise = new Promise<void>((settle) => {
      resolve = settle;
    });
    return { promise, resolve };
  }

  it('runs one holder at a time per ledger, in arrival order', async () => {
    const eligibility = new LedgerOwnerEligibility();
    const events: string[] = [];
    const firstGate = deferred();

    const first = eligibility.withAdmission(LEDGER_ID, async () => {
      events.push('first:start');
      await firstGate.promise;
      events.push('first:end');
      return 1;
    });
    const second = eligibility.withAdmission(LEDGER_ID, () => {
      events.push('second');
      return Promise.resolve(2);
    });
    const elsewhere = eligibility.withAdmission(OTHER_LEDGER_ID, () => {
      events.push('elsewhere');
      return Promise.resolve(3);
    });

    await elsewhere;
    expect(events).toEqual(['first:start', 'elsewhere']);
    firstGate.resolve();

    await expect(Promise.all([first, second, elsewhere])).resolves.toEqual([
      1, 2, 3,
    ]);
    expect(events).toEqual(['first:start', 'elsewhere', 'first:end', 'second']);
  });

  it('releases the fence when a holder fails', async () => {
    const eligibility = new LedgerOwnerEligibility();

    await expect(
      eligibility.withAdmission(LEDGER_ID, () =>
        Promise.reject(new Error('commit failed')),
      ),
    ).rejects.toThrow('commit failed');
    await expect(
      eligibility.withAdmission(LEDGER_ID, () => Promise.resolve('next')),
    ).resolves.toBe('next');
  });

  it('is shared with lifecycle hooks through the app-wide fence', async () => {
    const events: string[] = [];
    const gate = deferred();

    const command = withLedgerOwnerAdmission(LEDGER_ID, async () => {
      events.push('command:verify');
      await gate.promise;
      events.push('command:commit');
    });
    const hook = withLedgerOwnerAdmission(LEDGER_ID, () => {
      events.push('hook:invalidate');
      return Promise.resolve();
    });
    gate.resolve();
    await Promise.all([command, hook]);

    expect(events).toEqual([
      'command:verify',
      'command:commit',
      'hook:invalidate',
    ]);
  });
});

describe('owner eligibility through the Ledger service', () => {
  let harness: LedgerServiceHarness;
  let chatPrincipal: string;

  beforeEach(() => {
    // The app's eligibility state, which lifecycle hooks invalidate.
    harness = createLedgerServiceHarness({
      eligibility: getLedgerOwnerEligibility(),
    });
    harness.setLiveChats(TEST_CONTAINER, [
      { chatId: 'chat-1', title: 'Chat one', createdAt: null },
      {
        chatId: 'chat-2',
        title: 'Chat two',
        createdAt: '2026-09-01T10:00:00.000Z',
      },
    ]);
    chatPrincipal = harness.register();
  });

  afterEach(() => {
    harness.dispose();
  });

  async function candidate(displayName: string): Promise<LedgerOwnerCandidate> {
    const page = await harness.service.listOwners(
      {},
      harness.context(chatPrincipal),
    );
    const found = page.candidates.find(
      (entry) => entry.displayName === displayName,
    );
    if (found === undefined) throw new Error(`No candidate ${displayName}`);
    return found;
  }

  function addFor(
    owner: LedgerOwnerCandidate,
    key: string,
    title = 'Hand off the review',
  ): Promise<unknown> {
    return harness.service.addEntry(
      {
        type: 'TASK',
        title,
        content: 'Review the storage worker change.',
        owner: {
          actorId: owner.actor.actorId,
          eligibilityToken: owner.eligibilityToken,
        },
        _meta: { idempotencyKey: key },
      },
      harness.context(chatPrincipal, key),
    );
  }

  it('assigns a new entry to an eligible chat', async () => {
    const chatTwo = await candidate('Chat two');

    await expect(addFor(chatTwo, 'assign-1')).resolves.toMatchObject({
      changed: true,
      entry: { owner: chatTwo.actor },
    });
  });

  it('refuses a stale token but still replays the original accepted request', async () => {
    const chatTwo = await candidate('Chat two');
    const accepted = await addFor(chatTwo, 'assign-1');

    invalidateStale(harness, 'chat-2');

    await expect(
      addFor(chatTwo, 'assign-2', 'Another task'),
    ).rejects.toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.ledger.ownerUnavailable',
        details: { reason: 'OWNER_UNAVAILABLE', field: 'owner' },
        retry: { kind: 'after_refresh', resource: 'core.ledger.owners.list' },
      },
    });
    await expect(addFor(chatTwo, 'assign-1')).resolves.toEqual(accepted);
    // A fresh token from a new listing works again.
    await expect(
      addFor(await candidate('Chat two'), 'assign-3', 'Third task'),
    ).resolves.toMatchObject({ changed: true });
  });

  it('refuses an expired token', async () => {
    harness.dispose();
    // Eligibility on the harness clock, so the test can outwait a token.
    harness = createLedgerServiceHarness();
    harness.setLiveChats(TEST_CONTAINER, [
      { chatId: 'chat-2', title: 'Chat two', createdAt: null },
    ]);
    chatPrincipal = harness.register();
    const chatTwo = await candidate('Chat two');

    harness.clock.advance(LEDGER_ELIGIBILITY_TOKEN_LIFETIME_MS - 1);
    await expect(
      addFor(chatTwo, 'in-time', 'Assigned in time'),
    ).resolves.toMatchObject({ entry: { owner: chatTwo.actor } });
    harness.clock.advance(1);
    await expect(addFor(chatTwo, 'too-late')).rejects.toMatchObject({
      payload: { details: { reason: 'OWNER_UNAVAILABLE' } },
    });
  });

  it('refuses a forged token and an actor from another ledger', async () => {
    const chatTwo = await candidate('Chat two');
    const otherPrincipal = harness.register({ container: OTHER_CONTAINER });
    const otherUser = (
      await harness.service.listOwners({}, harness.context(otherPrincipal))
    ).candidates[0];

    await expect(
      addFor({ ...chatTwo, eligibilityToken: 'v1.1.0.0.forged' }, 'forged'),
    ).rejects.toMatchObject({
      payload: { details: { reason: 'OWNER_UNAVAILABLE' } },
    });
    await expect(addFor(otherUser, 'foreign')).rejects.toMatchObject({
      payload: { details: { reason: 'OWNER_UNAVAILABLE', field: 'owner' } },
    });
    expect(harness.store.repository.getStorageCounts().entries).toBe(0);
  });

  it('refuses a chat that was archived after the picker listed it', async () => {
    const chatTwo = await candidate('Chat two');
    harness.setLiveChats(TEST_CONTAINER, [
      { chatId: 'chat-1', title: 'Chat one', createdAt: null },
    ]);

    await expect(addFor(chatTwo, 'assign-1')).rejects.toMatchObject({
      payload: { details: { reason: 'OWNER_UNAVAILABLE' } },
    });
  });

  it('reassigns an owned entry to an eligible chat, and replays after the token goes stale', async () => {
    const created = await harness.service.addEntry(
      {
        type: 'TASK',
        title: 'Own it',
        content: 'Start the work.',
        _meta: { idempotencyKey: 'create' },
      },
      harness.context(chatPrincipal, 'create'),
    );
    const chatTwo = await candidate('Chat two');
    const update = (key: string): Promise<unknown> =>
      harness.service.updateEntry(
        {
          entryId: created.entry.entryId,
          expectedRevision: 1,
          owner: {
            actorId: chatTwo.actor.actorId,
            eligibilityToken: chatTwo.eligibilityToken,
          },
          _meta: { idempotencyKey: key },
        },
        harness.context(chatPrincipal, key),
      );

    const moved = await update('move');
    invalidateStale(harness, 'chat-2');

    expect(moved).toMatchObject({
      changed: true,
      entry: { revision: 2, owner: chatTwo.actor },
    });
    await expect(update('move')).resolves.toEqual(moved);
  });
});

describe('retained delegates as owners through the Ledger service', () => {
  let harness: LedgerServiceHarness;
  let chatPrincipal: string;

  function retained(runGeneration: number): LedgerLiveDelegate {
    return {
      delegationId: 'delegation-1',
      description: 'Review delegate',
      runGeneration,
      rootChatId: 'chat-1',
      createdAt: '2026-09-01T12:00:00.000Z',
    };
  }

  beforeEach(() => {
    harness = createLedgerServiceHarness();
    harness.setLiveChats(TEST_CONTAINER, [
      { chatId: 'chat-1', title: 'Chat one', createdAt: null },
    ]);
    harness.setLiveDelegates(TEST_CONTAINER, [retained(1)]);
    chatPrincipal = harness.register();
  });

  afterEach(() => {
    harness.dispose();
  });

  async function owners(): Promise<LedgerOwnerCandidate[]> {
    return (
      await harness.service.listOwners({}, harness.context(chatPrincipal))
    ).candidates;
  }

  async function delegateCandidate(): Promise<LedgerOwnerCandidate> {
    const found = (await owners()).find(
      (candidate) => candidate.actor.kind === 'managed_delegation',
    );
    if (found === undefined) throw new Error('Expected a delegate candidate');
    return found;
  }

  function assign(
    owner: LedgerOwnerCandidate,
    key: string,
  ): Promise<LedgerCommandReceipt> {
    return harness.service.addEntry(
      {
        type: 'TASK',
        title: 'Finish the review',
        content: 'Review the storage worker change.',
        owner: {
          actorId: owner.actor.actorId,
          eligibilityToken: owner.eligibilityToken,
        },
        _meta: { idempotencyKey: key },
      },
      harness.context(chatPrincipal, key),
    );
  }

  it('offers a retained delegate, and the delegate finds the assignment as its own', async () => {
    const delegate = await delegateCandidate();
    expect(delegate).toMatchObject({
      actor: { kind: 'managed_delegation' },
      displayName: 'Review delegate',
      isSelf: false,
    });

    const { entry } = await assign(delegate, 'assign-delegate');
    const delegatePrincipal = harness.register({
      role: 'managed_delegation',
      actor: {
        kind: 'managed_delegation',
        originKey: 'delegation-1',
        displayName: 'Review delegate',
      },
      runtimeGeneration: 2,
      origin: {
        kind: 'managed_delegation',
        delegationId: 'delegation-1',
        parent: { kind: 'chat', originKey: 'chat-1', displayName: 'Chat one' },
        root: { kind: 'chat', chatId: 'chat-1' },
        runGeneration: 2,
      },
    });

    await expect(
      harness.service.searchEntries(
        { owner: 'self' },
        harness.context(delegatePrincipal),
      ),
    ).resolves.toMatchObject({ entries: [{ entryId: entry.entryId }] });
  });

  it('does not offer a released delegate, but keeps it as a historical owner', async () => {
    const delegate = await delegateCandidate();
    const { entry } = await assign(delegate, 'assign-delegate');

    harness.setLiveDelegates(TEST_CONTAINER, []);

    expect((await owners()).map((candidate) => candidate.actor.kind)).toEqual([
      'user',
      'chat',
    ]);
    await expect(
      harness.service.getEntry(
        { entryId: entry.entryId },
        harness.context(chatPrincipal),
      ),
    ).resolves.toMatchObject({ entry: { owner: delegate.actor } });
  });

  it('refuses a token from before the delegate was continued', async () => {
    const delegate = await delegateCandidate();

    harness.setLiveDelegates(TEST_CONTAINER, [retained(2)]);

    await expect(assign(delegate, 'stale')).rejects.toMatchObject({
      payload: {
        kind: 'failed_precondition',
        details: { reason: 'OWNER_UNAVAILABLE', field: 'owner' },
        retry: { kind: 'after_refresh', resource: 'core.ledger.owners.list' },
      },
    });
    // A fresh listing carries a token for the new generation.
    await expect(
      assign(await delegateCandidate(), 'fresh'),
    ).resolves.toMatchObject({ entry: { owner: delegate.actor } });
  });

  it('refuses a token after the delegate was released', async () => {
    const delegate = await delegateCandidate();

    harness.setLiveDelegates(TEST_CONTAINER, []);

    await expect(assign(delegate, 'released')).rejects.toMatchObject({
      payload: { details: { reason: 'OWNER_UNAVAILABLE', field: 'owner' } },
    });
    expect(harness.store.repository.getStorageCounts().entries).toBe(0);
  });
});

describe('paused pipeline agents as owners through the Ledger service', () => {
  let harness: LedgerServiceHarness;
  let chatPrincipal: string;

  function pauseAgent(checkpointId = 'checkpoint-1'): void {
    harness.pipelineAgents.notePaused({
      agentSessionId: 'session-1',
      displayName: 'Implement · Release',
      executionId: 'execution-1',
      jobId: 'build',
      stepId: 'agent',
      attempt: 1,
      container: TEST_CONTAINER,
      checkpointId,
      pausedAt: '2026-09-02T00:00:00.000Z',
    });
  }

  beforeEach(() => {
    harness = createLedgerServiceHarness();
    harness.setLiveChats(TEST_CONTAINER, [
      { chatId: 'chat-1', title: 'Chat one', createdAt: null },
    ]);
    chatPrincipal = harness.register();
    pauseAgent();
  });

  afterEach(() => {
    harness.dispose();
  });

  async function agentCandidate(): Promise<LedgerOwnerCandidate> {
    const found = (
      await harness.service.listOwners({}, harness.context(chatPrincipal))
    ).candidates.find((candidate) => candidate.actor.kind === 'pipeline_agent');
    if (found === undefined) throw new Error('Expected a paused agent');
    return found;
  }

  function assign(
    owner: LedgerOwnerCandidate,
    key: string,
  ): Promise<LedgerCommandReceipt> {
    return harness.service.addEntry(
      {
        type: 'TASK',
        title: 'Pick this up on resume',
        content: 'Finish the migration once usage resets.',
        owner: {
          actorId: owner.actor.actorId,
          eligibilityToken: owner.eligibilityToken,
        },
        _meta: { idempotencyKey: key },
      },
      harness.context(chatPrincipal, key),
    );
  }

  it('offers the paused agent, which finds the assignment as its own on resume', async () => {
    const agent = await agentCandidate();
    expect(agent).toMatchObject({
      actor: { kind: 'pipeline_agent' },
      displayName: 'Implement · Release',
      isSelf: false,
    });

    const { entry } = await assign(agent, 'assign-agent');
    // The resumed attempt keeps its agent session, so it is the same actor.
    harness.pipelineAgents.retireExecution('execution-1', ['checkpoint-1']);
    const resumed = harness.register({
      role: 'pipeline_agent',
      actor: {
        kind: 'pipeline_agent',
        originKey: 'session-1',
        displayName: 'Implement · Release',
      },
      origin: {
        kind: 'pipeline_agent',
        executionId: 'execution-1',
        physicalJobId: 'build',
        logicalJobId: 'build',
        stepId: 'implement',
        attempt: 1,
        iteration: 1,
        agentSessionId: 'session-1',
        checkpointId: 'checkpoint-1',
      },
    });

    await expect(
      harness.service.searchEntries(
        { owner: 'self' },
        harness.context(resumed),
      ),
    ).resolves.toMatchObject({ entries: [{ entryId: entry.entryId }] });
  });

  it('refuses a token issued before the execution resumed', async () => {
    const agent = await agentCandidate();

    harness.pipelineAgents.retireExecution('execution-1', ['checkpoint-1']);

    await expect(assign(agent, 'stale')).rejects.toMatchObject({
      payload: {
        kind: 'failed_precondition',
        details: { reason: 'OWNER_UNAVAILABLE', field: 'owner' },
        retry: { kind: 'after_refresh', resource: 'core.ledger.owners.list' },
      },
    });
    // Running again, the agent is no longer offered.
    const kinds = (
      await harness.service.listOwners({}, harness.context(chatPrincipal))
    ).candidates.map((candidate) => candidate.actor.kind);
    expect(kinds).toEqual(['user', 'chat']);
    expect(harness.store.repository.getStorageCounts().entries).toBe(0);
  });

  it('refuses a token from an earlier pause of the same agent', async () => {
    const agent = await agentCandidate();

    // Resumed, then paused again on a new checkpoint.
    harness.pipelineAgents.retireExecution('execution-1');
    pauseAgent('checkpoint-2');

    await expect(assign(agent, 'earlier-pause')).rejects.toMatchObject({
      payload: { details: { reason: 'OWNER_UNAVAILABLE', field: 'owner' } },
    });
    await expect(
      assign(await agentCandidate(), 'fresh'),
    ).resolves.toMatchObject({ entry: { owner: agent.actor } });
  });

  it('holds the execution fence from the check through the commit', async () => {
    const agent = await agentCandidate();
    const events: string[] = [];
    const resume = harness.pipelineAgents.withAdmission(
      'execution-1',
      async () => {
        events.push('resume:start');
        await Promise.resolve();
        harness.pipelineAgents.retireExecution('execution-1');
        events.push('resume:retired');
      },
    );
    const command = assign(agent, 'racing').then(
      () => events.push('command:accepted'),
      () => events.push('command:refused'),
    );

    await Promise.all([resume, command]);

    // The resume held the fence first, so the command saw the retirement.
    expect(events).toEqual([
      'resume:start',
      'resume:retired',
      'command:refused',
    ]);
  });
});

/** What a lifecycle hook does when a chat stops being assignable. */
function invalidateStale(harness: LedgerServiceHarness, chatId: string): void {
  expect(harness.eligibility).toBe(getLedgerOwnerEligibility());
  invalidateLedgerOwnerEligibility({
    container: TEST_CONTAINER,
    actor: { kind: 'chat', originKey: chatId },
  });
}
