const mockReadChatTabsFile = jest.fn();

jest.mock('../../lib/chat-tabs-reader', () => ({
  readChatTabsFile: (...args: unknown[]): unknown =>
    mockReadChatTabsFile(...args),
}));

import type { LedgerContainer } from '@canopy/protocol/canopy-core';
import type { ChatTabsFile } from '@canopy/desktop-shared/types';
import {
  LEDGER_USER_ACTOR_ORIGIN_KEY,
  LedgerActorDirectory,
  LedgerOwnerEligibility,
  ledgerActorOriginKey,
  readLedgerContainerLiveChats,
  toLedgerDisplayName,
  type LedgerLiveChat,
} from '../actor-directory';
import type { LedgerLiveDelegate } from '../delegate-owners';
import type { LedgerStoreClient } from '../ledger-store-client';
import { LedgerPipelineAgentOwners } from '../pipeline-agent-owners';
import { LedgerScopeBindings, type LedgerBoundScope } from '../scope-bindings';
import {
  TEST_CONTAINER,
  TEST_CONTAINER_CREATED_AT,
  createLedgerStoreFixture,
  createTestClock,
  type LedgerStoreFixture,
  type TestClock,
} from './fixtures/in-process-ledger-store-client';

interface DirectoryUnderTest {
  readonly directory: LedgerActorDirectory;
  readonly scope: LedgerBoundScope;
  readonly clock: TestClock;
  readonly setChats: (chats: LedgerLiveChat[]) => void;
  readonly setDelegates: (delegates: LedgerLiveDelegate[]) => void;
  readonly pipelineAgents: LedgerPipelineAgentOwners;
}

const ANY_STRING: unknown = expect.any(String);

function chat(
  chatId: string,
  title: string,
  createdAt: string | null = '2026-09-01T10:00:00.000Z',
): LedgerLiveChat {
  return { chatId, title, createdAt };
}

function delegate(
  delegationId: string,
  description: string,
  runGeneration = 1,
  rootChatId = 'chat-1',
  createdAt: string | null = '2026-09-01T12:00:00.000Z',
): LedgerLiveDelegate {
  return { delegationId, description, runGeneration, rootChatId, createdAt };
}

describe('LedgerActorDirectory', () => {
  let fixture: LedgerStoreFixture;

  beforeEach(() => {
    fixture = createLedgerStoreFixture();
  });

  afterEach(() => {
    fixture.dispose();
  });

  async function createDirectory(
    container: LedgerContainer = TEST_CONTAINER,
  ): Promise<DirectoryUnderTest> {
    const store = (): LedgerStoreClient => fixture.client;
    const scope = await new LedgerScopeBindings({
      store,
      getAccountId: (): null => null,
    }).resolve(container, TEST_CONTAINER_CREATED_AT);
    let chats: LedgerLiveChat[] = [];
    let delegates: LedgerLiveDelegate[] = [];
    const clock = createTestClock();
    const pipelineAgents = new LedgerPipelineAgentOwners();
    return {
      directory: new LedgerActorDirectory({
        store,
        liveChats: (): Promise<LedgerLiveChat[]> => Promise.resolve(chats),
        liveDelegates: (): Promise<LedgerLiveDelegate[]> =>
          Promise.resolve(delegates),
        pipelineAgents,
        eligibility: new LedgerOwnerEligibility({ now: clock.now }),
        now: clock.now,
      }),
      pipelineAgents,
      scope,
      clock,
      setChats: (next: LedgerLiveChat[]): void => {
        chats = next;
      },
      setDelegates: (next: LedgerLiveDelegate[]): void => {
        delegates = next;
      },
    };
  }

  it('touches no storage when it is created', () => {
    const directory = new LedgerActorDirectory({
      store: (): LedgerStoreClient => {
        throw new Error('The store must not be requested');
      },
      liveChats: (): Promise<never> =>
        Promise.reject(new Error('Chats must not be read')),
    });

    expect(directory).toBeInstanceOf(LedgerActorDirectory);
    expect(fixture.client.calls).toEqual([]);
  });

  it('registers "You" once per ledger, even under concurrent use', async () => {
    const { directory, scope } = await createDirectory();

    const users = await Promise.all(
      Array.from({ length: 4 }, () => directory.ensureUser(scope)),
    );

    expect(new Set(users.map((user) => user.actor.actorId)).size).toBe(1);
    expect(users[0]).toMatchObject({
      actor: { kind: 'user', authorityId: scope.authorityId },
      ledgerId: scope.ledgerId,
      originKey: LEDGER_USER_ACTOR_ORIGIN_KEY,
      displayName: 'You',
    });
    expect(fixture.client.callCount('registerActor')).toBe(1);
  });

  it('gives each ledger its own "You"', async () => {
    const first = await createDirectory();
    const second = await createDirectory({
      kind: 'cowork_entry',
      workspaceId: 'cowork-1',
      entryId: 'entry-1',
    });

    const firstUser = await first.directory.ensureUser(first.scope);
    const secondUser = await second.directory.ensureUser(second.scope);

    expect(secondUser.actor.actorId).not.toBe(firstUser.actor.actorId);
    expect(secondUser.ledgerId).toBe(second.scope.ledgerId);
  });

  it('registers a binding actor under its namespaced origin key, with "You"', async () => {
    const { directory, scope } = await createDirectory();

    const caller = await directory.ensureCaller(scope, {
      kind: 'chat',
      originKey: 'chat-1',
      displayName: 'Refactor chat',
    });
    const sameChat = await directory.ensureChat(
      scope,
      chat('chat-1', 'Renamed later'),
    );

    expect(caller).toMatchObject({
      actor: { kind: 'chat' },
      originKey: 'chat:chat-1',
      displayName: 'Refactor chat',
    });
    expect(sameChat.actor.actorId).toBe(caller.actor.actorId);
    expect(
      fixture.repository.listActors(scope.ledgerId).map((actor) => ({
        kind: actor.actor.kind,
        originKey: actor.originKey,
      })),
    ).toEqual([
      { kind: 'user', originKey: 'user:local' },
      { kind: 'chat', originKey: 'chat:chat-1' },
    ]);
  });

  it('treats every user-kind binding as the one local user', async () => {
    const { directory, scope } = await createDirectory();

    const user = await directory.ensureUser(scope);
    const caller = await directory.ensureCaller(scope, {
      kind: 'user',
      originKey: 'someone-else',
      displayName: 'Another name',
    });

    expect(caller).toBe(user);
    expect(ledgerActorOriginKey({ kind: 'user', originKey: 'x' })).toBe(
      'user:local',
    );
  });

  it('keeps a pipeline session and a chat with the same host key apart', async () => {
    const { directory, scope } = await createDirectory();

    const chatActor = await directory.ensureCaller(scope, {
      kind: 'chat',
      originKey: 'shared-key',
      displayName: 'Chat',
    });
    const pipelineActor = await directory.ensureCaller(scope, {
      kind: 'pipeline_agent',
      originKey: 'shared-key',
      displayName: 'Pipeline agent',
    });

    expect(pipelineActor.actor.actorId).not.toBe(chatActor.actor.actorId);
    expect(pipelineActor.originKey).toBe('pipeline_agent:shared-key');
  });

  it('finds actors registered by an earlier process, and only in its own ledger', async () => {
    const first = await createDirectory();
    const other = await createDirectory({
      kind: 'code_worktree',
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-2',
    });
    const registered = await first.directory.ensureCaller(first.scope, {
      kind: 'chat',
      originKey: 'chat-1',
      displayName: 'Chat one',
    });
    const otherActor = await other.directory.ensureUser(other.scope);
    const restarted = await createDirectory();
    const listActorsBefore = fixture.client.callCount('listActors');

    await expect(
      restarted.directory.findActor(restarted.scope, registered.actor.actorId),
    ).resolves.toEqual(registered);
    await expect(
      restarted.directory.findActor(restarted.scope, otherActor.actor.actorId),
    ).resolves.toBeNull();
    expect(fixture.client.callCount('listActors')).toBe(listActorsBefore + 2);
    // A found actor is cached.
    await restarted.directory.findActor(
      restarted.scope,
      registered.actor.actorId,
    );
    expect(fixture.client.callCount('listActors')).toBe(listActorsBefore + 2);
  });

  it('lists "You" first, then live chats oldest first with their current titles', async () => {
    const { directory, scope, setChats } = await createDirectory();
    await directory.ensureChat(scope, chat('chat-b', 'Original title'));
    setChats([
      chat('chat-b', 'Current title', '2026-09-02T10:00:00.000Z'),
      chat('chat-a', 'First chat', '2026-09-01T10:00:00.000Z'),
      chat('chat-a', 'Duplicate row', '2026-09-01T10:00:00.000Z'),
      chat('chat-c', '  \u0007  ', null),
    ]);

    const candidates = await directory.listOwnerCandidates(scope);

    expect(
      candidates.map((candidate) => ({
        kind: candidate.record.actor.kind,
        originKey: candidate.record.originKey,
        displayName: candidate.displayName,
      })),
    ).toEqual([
      { kind: 'user', originKey: 'user:local', displayName: 'You' },
      { kind: 'chat', originKey: 'chat:chat-c', displayName: 'Chat' },
      { kind: 'chat', originKey: 'chat:chat-a', displayName: 'First chat' },
      { kind: 'chat', originKey: 'chat:chat-b', displayName: 'Current title' },
    ]);
    // The stored snapshot keeps the name from the first registration.
    expect(
      fixture.repository
        .listActors(scope.ledgerId)
        .find((actor) => actor.originKey === 'chat:chat-b')?.displayName,
    ).toBe('Original title');
  });

  it('labels a chat by its current name without opening the owner picker', async () => {
    const { directory, scope, setChats } = await createDirectory();
    const record = await directory.ensureChat(
      scope,
      chat('chat-b', 'Plan: auth overhaul'),
    );
    const label = async (): Promise<string | undefined> =>
      (await directory.labelsFor(scope, [record.actor.actorId]))[0]
        ?.displayName;
    // Without live metadata, reads keep the name recorded at registration.
    expect(await label()).toBe('Plan: auth overhaul');

    setChats([
      chat('chat-b', 'Fix login redirect', '2026-09-02T10:00:00.000Z'),
    ]);
    expect(await label()).toBe('Fix login redirect');

    // A later generated description replaces a previously read label too.
    await directory.listOwnerCandidates(scope);
    setChats([chat('chat-b', 'Repair authentication redirects')]);
    expect(await label()).toBe('Repair authentication redirects');
    expect(record.displayName).toBe('Plan: auth overhaul');
    expect(
      fixture.repository
        .listActors(scope.ledgerId)
        .find((actor) => actor.actor.actorId === record.actor.actorId)
        ?.displayName,
    ).toBe('Plan: auth overhaul');
  });

  it('keeps unavailable chat labels and does not register unrelated live chats during reads', async () => {
    const { directory, scope, setChats } = await createDirectory();
    const record = await directory.ensureChat(
      scope,
      chat('chat-1', 'Original label'),
    );
    setChats([
      chat('chat-1', 'Generated description'),
      chat('chat-2', 'Unrelated chat'),
    ]);
    await expect(
      directory.labelsFor(scope, [
        record.actor.actorId,
        record.actor.actorId,
        'unknown',
      ]),
    ).resolves.toEqual([
      {
        actorId: record.actor.actorId,
        kind: 'chat',
        displayName: 'Generated description',
      },
    ]);
    expect(fixture.client.callCount('registerActor')).toBe(1);
    setChats([]);
    await expect(
      directory.labelsFor(scope, [record.actor.actorId]),
    ).resolves.toEqual([
      {
        actorId: record.actor.actorId,
        kind: 'chat',
        displayName: 'Original label',
      },
    ]);
  });

  it('uses registered chat labels when live chat metadata rejects', async () => {
    const { scope } = await createDirectory();
    const liveChats = jest.fn(
      (): Promise<LedgerLiveChat[]> =>
        Promise.reject(new Error('Chat metadata recovery failed')),
    );
    const directory = new LedgerActorDirectory({
      store: (): LedgerStoreClient => fixture.client,
      liveChats,
    });
    const record = await directory.ensureChat(
      scope,
      chat('chat-1', 'Registered label'),
    );

    await expect(
      directory.labelsFor(scope, [record.actor.actorId]),
    ).resolves.toEqual([
      {
        actorId: record.actor.actorId,
        kind: 'chat',
        displayName: 'Registered label',
      },
    ]);
    expect(liveChats).toHaveBeenCalledTimes(1);
  });

  it('does not read chat metadata when none of the requested actors are chats', async () => {
    const { scope } = await createDirectory();
    const liveChats = jest.fn(
      (): Promise<LedgerLiveChat[]> => Promise.resolve([]),
    );
    const directory = new LedgerActorDirectory({
      store: (): LedgerStoreClient => fixture.client,
      liveChats,
    });
    const user = await directory.ensureUser(scope);
    const pipeline = await directory.ensureCaller(scope, {
      kind: 'pipeline_agent',
      originKey: 'pipeline-1',
      displayName: 'Review',
    });
    await expect(
      directory.labelsFor(scope, [user.actor.actorId, pipeline.actor.actorId]),
    ).resolves.toEqual([
      { actorId: user.actor.actorId, kind: 'user', displayName: 'You' },
      {
        actorId: pipeline.actor.actorId,
        kind: 'pipeline_agent',
        displayName: 'Review',
      },
    ]);
    expect(liveChats).not.toHaveBeenCalled();
  });

  it('pages owner candidates with signed cursors and fresh tokens', async () => {
    const { directory, scope, setChats } = await createDirectory();
    setChats([
      chat('chat-1', 'One', '2026-09-01T10:00:00.000Z'),
      chat('chat-2', 'Two', '2026-09-01T11:00:00.000Z'),
    ]);
    const self = await directory.ensureChat(scope, chat('chat-2', 'Two'));

    const first = await directory.pageOwnerCandidates(scope, {
      callerActorId: self.actor.actorId,
      limit: 2,
    });
    if (first.kind !== 'page') throw new Error('Expected a page');
    const nextCursor = first.page.nextCursor;
    if (nextCursor === null) throw new Error('Expected another page');
    const second = await directory.pageOwnerCandidates(scope, {
      callerActorId: self.actor.actorId,
      limit: 2,
      cursor: nextCursor,
    });
    if (second.kind !== 'page') throw new Error('Expected a page');

    expect(
      first.page.candidates.map((candidate) => [
        candidate.displayName,
        candidate.isSelf,
      ]),
    ).toEqual([
      ['You', false],
      ['One', false],
    ]);
    expect(second.page).toEqual({
      candidates: [
        {
          actor: self.actor,
          displayName: 'Two',
          eligibilityToken: ANY_STRING,
          isSelf: true,
        },
      ],
      nextCursor: null,
    });
    for (const candidate of [
      ...first.page.candidates,
      ...second.page.candidates,
    ]) {
      const record = await directory.findActor(scope, candidate.actor.actorId);
      if (record === null) throw new Error('Expected a registered candidate');
      await expect(
        directory.verifyOwnerEligibility(
          scope,
          record,
          candidate.eligibilityToken,
        ),
      ).resolves.toBe(true);
    }
  });

  it('refuses a tampered, foreign or expired owner cursor', async () => {
    const { directory, scope, setChats, clock } = await createDirectory();
    const otherScope = await new LedgerScopeBindings({
      store: (): LedgerStoreClient => fixture.client,
      getAccountId: (): null => null,
    }).resolve(
      { kind: 'cowork_entry', workspaceId: 'cowork-1', entryId: 'entry-1' },
      TEST_CONTAINER_CREATED_AT,
    );
    setChats([chat('chat-1', 'One'), chat('chat-2', 'Two')]);
    const page = await directory.pageOwnerCandidates(scope, {
      callerActorId: 'caller',
      limit: 1,
    });
    if (page.kind !== 'page' || page.page.nextCursor === null) {
      throw new Error('Expected a cursor');
    }
    const cursor = page.page.nextCursor;
    const [payload, mac] = cursor.split('.');
    const forged = `${Buffer.from(
      JSON.stringify({ v: 1, l: scope.ledgerId, k: [9, '', ''], t: 0 }),
    ).toString('base64url')}.${mac}`;

    for (const refused of [`${payload}.x${mac}`, forged, 'not-a-cursor']) {
      await expect(
        directory.pageOwnerCandidates(scope, {
          callerActorId: 'caller',
          cursor: refused,
        }),
      ).resolves.toEqual({ kind: 'cursor_expired' });
    }
    // Validly signed, but issued for another ledger.
    await expect(
      directory.pageOwnerCandidates(otherScope, {
        callerActorId: 'caller',
        cursor,
      }),
    ).resolves.toEqual({ kind: 'cursor_expired' });
    clock.advance(10 * 60 * 1_000 + 1);
    await expect(
      directory.pageOwnerCandidates(scope, { callerActorId: 'caller', cursor }),
    ).resolves.toEqual({ kind: 'cursor_expired' });
  });

  it('accepts a token only while its chat is live and nothing invalidated it', async () => {
    const { directory, scope, setChats } = await createDirectory();
    setChats([chat('chat-1', 'One')]);
    const chatActor = await directory.ensureChat(scope, chat('chat-1', 'One'));
    const user = await directory.ensureUser(scope);
    const token = directory.issueEligibilityToken(scope, chatActor);
    const userToken = directory.issueEligibilityToken(scope, user);

    await expect(
      directory.verifyOwnerEligibility(scope, chatActor, token),
    ).resolves.toBe(true);
    // Archived or deleted: no longer a live chat.
    setChats([]);
    await expect(
      directory.verifyOwnerEligibility(scope, chatActor, token),
    ).resolves.toBe(false);
    // "You" stays selectable.
    await expect(
      directory.verifyOwnerEligibility(scope, user, userToken),
    ).resolves.toBe(true);
    // A token names its actor.
    await expect(
      directory.verifyOwnerEligibility(scope, user, token),
    ).resolves.toBe(false);
  });

  it('lists retained delegates of live chats after the chats, oldest first', async () => {
    const { directory, scope, setChats, setDelegates } =
      await createDirectory();
    setChats([chat('chat-1', 'One')]);
    setDelegates([
      delegate(
        'delegation-2',
        'Second review',
        3,
        'chat-1',
        '2026-09-02T09:00:00.000Z',
      ),
      delegate('delegation-1', 'First review', 1),
      delegate('delegation-1', 'Duplicate row', 1),
      delegate('delegation-3', 'Archived chat review', 1, 'chat-gone'),
      delegate('delegation-4', 'Broken generation', 0),
    ]);

    const candidates = await directory.listOwnerCandidates(scope);

    expect(
      candidates.map((candidate) => ({
        kind: candidate.record.actor.kind,
        originKey: candidate.record.originKey,
        displayName: candidate.displayName,
        runGeneration: candidate.runGeneration,
      })),
    ).toEqual([
      {
        kind: 'user',
        originKey: 'user:local',
        displayName: 'You',
        runGeneration: undefined,
      },
      {
        kind: 'chat',
        originKey: 'chat:chat-1',
        displayName: 'One',
        runGeneration: undefined,
      },
      {
        kind: 'managed_delegation',
        originKey: 'managed_delegation:delegation-1',
        displayName: 'First review',
        runGeneration: 1,
      },
      {
        kind: 'managed_delegation',
        originKey: 'managed_delegation:delegation-2',
        displayName: 'Second review',
        runGeneration: 3,
      },
    ]);
    // The delegate's own binding speaks for the same actor.
    const own = await directory.ensureCaller(scope, {
      kind: 'managed_delegation',
      originKey: 'delegation-1',
      displayName: 'Renamed',
    });
    expect(own.actor).toEqual(candidates[2]?.record.actor);
  });

  it('binds a delegate token to the run generation it was issued at', async () => {
    const { directory, scope, setChats, setDelegates } =
      await createDirectory();
    setChats([chat('chat-1', 'One')]);
    setDelegates([delegate('delegation-1', 'Review', 1)]);
    const listed = (await directory.listOwnerCandidates(scope)).find(
      (candidate) => candidate.record.actor.kind === 'managed_delegation',
    );
    if (listed === undefined) throw new Error('Expected a delegate candidate');
    const token = directory.issueEligibilityToken(
      scope,
      listed.record,
      listed.runGeneration,
    );

    await expect(
      directory.verifyOwnerEligibility(scope, listed.record, token),
    ).resolves.toBe(true);
    // Continued: a new run generation makes the old token stale.
    setDelegates([delegate('delegation-1', 'Review', 2)]);
    await expect(
      directory.verifyOwnerEligibility(scope, listed.record, token),
    ).resolves.toBe(false);
    const fresh = directory.issueEligibilityToken(scope, listed.record, 2);
    await expect(
      directory.verifyOwnerEligibility(scope, listed.record, fresh),
    ).resolves.toBe(true);
    // Its root chat archived: not selectable while the chat is gone.
    setChats([]);
    await expect(
      directory.verifyOwnerEligibility(scope, listed.record, fresh),
    ).resolves.toBe(false);
    // Released: no longer reported by the delegation host.
    setChats([chat('chat-1', 'One')]);
    setDelegates([]);
    await expect(
      directory.verifyOwnerEligibility(scope, listed.record, fresh),
    ).resolves.toBe(false);
  });

  it('offers the exact paused pipeline agent last, bound to its checkpoint', async () => {
    const { directory, scope, setChats, setDelegates, pipelineAgents } =
      await createDirectory();
    setChats([chat('chat-1', 'One')]);
    setDelegates([delegate('delegation-1', 'Review', 1)]);
    pipelineAgents.notePaused({
      agentSessionId: 'session-paused',
      displayName: 'Implement · Release',
      executionId: 'exec-1',
      jobId: 'build',
      stepId: 'agent',
      attempt: 1,
      container: scope.container,
      checkpointId: 'checkpoint-1',
      pausedAt: '2026-09-02T00:00:00.000Z',
    });
    // A running agent and another worktree's paused agent are not offered.
    pipelineAgents.notePaused({
      agentSessionId: 'session-running',
      displayName: 'Running',
      executionId: 'exec-1',
      jobId: 'build',
      stepId: 'agent',
      attempt: 1,
      container: scope.container,
      checkpointId: 'checkpoint-2',
      pausedAt: null,
    });
    pipelineAgents.noteRunning('session-running');
    pipelineAgents.notePaused({
      agentSessionId: 'session-elsewhere',
      displayName: 'Elsewhere',
      executionId: 'exec-2',
      jobId: 'build',
      stepId: 'agent',
      attempt: 1,
      container: {
        kind: 'code_worktree',
        workspaceId: 'workspace-other',
        worktreeId: 'worktree-other',
      },
      checkpointId: 'checkpoint-3',
      pausedAt: null,
    });

    const candidates = await directory.listOwnerCandidates(scope);

    expect(
      candidates.map((candidate) => [
        candidate.record.actor.kind,
        candidate.record.originKey,
      ]),
    ).toEqual([
      ['user', 'user:local'],
      ['chat', 'chat:chat-1'],
      ['managed_delegation', 'managed_delegation:delegation-1'],
      ['pipeline_agent', 'pipeline_agent:session-paused'],
    ]);
    const paused = candidates[3];
    expect(paused?.displayName).toBe('Implement · Release');
    // A sibling's later pause bumps the execution, not this agent's claim.
    expect(paused?.checkpoint).toEqual({
      checkpointId: 'checkpoint-1',
      executionGeneration: 1,
    });
    // A page tells this pause apart from any other of the same name.
    const page = await directory.pageOwnerCandidates(scope, {
      callerActorId: 'caller',
    });
    if (page.kind !== 'page') throw new Error('Expected a page');
    expect(page.page.candidates[3]?.pipelineAgent).toEqual({
      executionId: 'exec-1',
      jobId: 'build',
      stepId: 'agent',
      attempt: 1,
      checkpointId: 'checkpoint-1',
      pausedAt: '2026-09-02T00:00:00.000Z',
    });
    expect(
      page.page.candidates
        .slice(0, 3)
        .every((candidate) => candidate.pipelineAgent === undefined),
    ).toBe(true);
    // The attempt's own binding speaks for the same actor.
    const own = await directory.ensureCaller(scope, {
      kind: 'pipeline_agent',
      originKey: 'session-paused',
      displayName: 'Implement · Release',
    });
    expect(own.actor).toEqual(paused?.record.actor);
  });

  it('makes a paused agent token stale once its execution resumes', async () => {
    const { directory, scope, pipelineAgents } = await createDirectory();
    pipelineAgents.notePaused({
      agentSessionId: 'session-a',
      displayName: 'A',
      executionId: 'exec-1',
      jobId: 'build',
      stepId: 'agent',
      attempt: 1,
      container: scope.container,
      checkpointId: 'checkpoint-a',
      pausedAt: null,
    });
    pipelineAgents.notePaused({
      agentSessionId: 'session-b',
      displayName: 'B',
      executionId: 'exec-1',
      jobId: 'build',
      stepId: 'agent',
      attempt: 1,
      container: scope.container,
      checkpointId: 'checkpoint-b',
      pausedAt: null,
    });
    const page = await directory.pageOwnerCandidates(scope, {
      callerActorId: 'caller',
    });
    if (page.kind !== 'page') throw new Error('Expected a page');
    const tokenFor = (originKey: string): string => {
      const candidate = page.page.candidates.find(
        (entry) =>
          entry.actor.kind === 'pipeline_agent' &&
          entry.displayName === originKey,
      );
      if (candidate === undefined) throw new Error(`No ${originKey}`);
      return candidate.eligibilityToken;
    };
    const recordA = await directory.ensureCaller(scope, {
      kind: 'pipeline_agent',
      originKey: 'session-a',
      displayName: 'A',
    });
    const recordB = await directory.ensureCaller(scope, {
      kind: 'pipeline_agent',
      originKey: 'session-b',
      displayName: 'B',
    });
    const tokenA = tokenFor('A');
    const tokenB = tokenFor('B');
    await expect(
      directory.verifyOwnerEligibility(scope, recordA, tokenA),
    ).resolves.toBe(true);
    // A token for one agent never vouches for another.
    await expect(
      directory.verifyOwnerEligibility(scope, recordB, tokenA),
    ).resolves.toBe(false);

    // Resuming A's checkpoint retires A and bumps the execution generation.
    pipelineAgents.retireExecution('exec-1', ['checkpoint-a']);

    await expect(
      directory.verifyOwnerEligibility(scope, recordA, tokenA),
    ).resolves.toBe(false);
    // B is still paused, but its earlier token went stale with the
    // generation; a refreshed picker issues a working one.
    await expect(
      directory.verifyOwnerEligibility(scope, recordB, tokenB),
    ).resolves.toBe(false);
    const refreshed = (await directory.listOwnerCandidates(scope)).find(
      (candidate) => candidate.record.originKey === 'pipeline_agent:session-b',
    );
    const freshB = directory.issueEligibilityToken(
      scope,
      recordB,
      undefined,
      refreshed?.checkpoint,
    );
    await expect(
      directory.verifyOwnerEligibility(scope, recordB, freshB),
    ).resolves.toBe(true);
  });

  it('holds a paused agent execution fence around an owner check', async () => {
    const { directory, scope, pipelineAgents } = await createDirectory();
    pipelineAgents.notePaused({
      agentSessionId: 'session-a',
      displayName: 'A',
      executionId: 'exec-1',
      jobId: 'build',
      stepId: 'agent',
      attempt: 1,
      container: scope.container,
      checkpointId: 'checkpoint-a',
      pausedAt: null,
    });
    const record = await directory.ensureCaller(scope, {
      kind: 'pipeline_agent',
      originKey: 'session-a',
      displayName: 'A',
    });
    const order: string[] = [];
    let releaseCheck: () => void = (): void => undefined;
    const checkHeld = new Promise<void>((resolve) => {
      releaseCheck = resolve;
    });

    const check = directory.withOwnerLifecycleAdmission(record, async () => {
      order.push('check');
      await checkHeld;
      order.push('commit');
    });
    const resume = pipelineAgents.withAdmission('exec-1', () => {
      order.push('resume');
      return Promise.resolve();
    });
    await Promise.resolve();
    releaseCheck();
    await Promise.all([check, resume]);

    expect(order).toEqual(['check', 'commit', 'resume']);
    // Other owners run without a pipeline fence.
    const user = await directory.ensureUser(scope);
    await expect(
      directory.withOwnerLifecycleAdmission(user, () => Promise.resolve(7)),
    ).resolves.toBe(7);
  });

  it('never makes a running pipeline agent or background actor assignable', async () => {
    const { directory, scope } = await createDirectory();
    const pipeline = await directory.ensureCaller(scope, {
      kind: 'pipeline_agent',
      originKey: 'session-1',
      displayName: 'Pipeline agent',
    });

    await expect(
      directory.verifyOwnerEligibility(
        scope,
        pipeline,
        directory.issueEligibilityToken(scope, pipeline),
      ),
    ).resolves.toBe(false);
  });

  it('registers again after a failed registration', async () => {
    const { directory, scope } = await createDirectory();
    fixture.client.failNext('registerActor', new Error('lost'));

    await expect(directory.ensureUser(scope)).rejects.toThrow('lost');
    await expect(directory.ensureUser(scope)).resolves.toMatchObject({
      displayName: 'You',
    });
  });
});

describe('toLedgerDisplayName', () => {
  it.each([
    ['Refactor chat', 'Refactor chat'],
    ['  padded  ', 'padded'],
    ['line one\nline two', 'line one line two'],
    ['tab\tand\u0000nul', 'tab and nul'],
    ['', 'Fallback'],
    ['\u0007\u0008', 'Fallback'],
  ])('turns %p into %p', (value, expected) => {
    expect(toLedgerDisplayName(value, 'Fallback')).toBe(expected);
  });

  it('bounds a long name to 256 code points', () => {
    const name = toLedgerDisplayName('😀'.repeat(300), 'Fallback');

    expect(Array.from(name)).toHaveLength(256);
  });
});

describe('readLedgerContainerLiveChats', () => {
  function tabs(): ChatTabsFile {
    return {
      version: 1,
      activeTabId: 'chat-1',
      tabs: [
        {
          id: 'chat-1',
          title: 'Idle chat',
          messages: [],
          createdAt: '2026-09-01T10:00:00.000Z',
        },
        {
          id: 'file-1',
          title: 'notes.md',
          kind: 'file',
          filePath: '/tmp/notes.md',
          messages: [],
          createdAt: '2026-09-01T11:00:00.000Z',
        },
        {
          id: 'chat-2',
          title: 'Explicit chat',
          kind: 'chat',
          messages: [],
          createdAt: '2026-09-01T12:00:00.000Z',
        },
      ],
    };
  }

  beforeEach(() => {
    mockReadChatTabsFile.mockReset();
    mockReadChatTabsFile.mockResolvedValue(tabs());
  });

  it('lists live chats and skips file tabs', async () => {
    await expect(readLedgerContainerLiveChats(TEST_CONTAINER)).resolves.toEqual(
      [
        {
          chatId: 'chat-1',
          title: 'Idle chat',
          createdAt: '2026-09-01T10:00:00.000Z',
        },
        {
          chatId: 'chat-2',
          title: 'Explicit chat',
          createdAt: '2026-09-01T12:00:00.000Z',
        },
      ],
    );
    // Metadata only: no transcript is selected.
    expect(mockReadChatTabsFile).toHaveBeenCalledWith(
      'workspace-1',
      'worktree-1',
    );
  });

  it('names each chat as its tab and the archived chat list do', async () => {
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat-1',
      tabs: [
        {
          id: 'chat-1',
          // The name the chat was created with, such as a plan's title.
          title: 'Plan: auth overhaul',
          customTitle: 'My chat',
          description: 'Fix login redirect',
          messages: [],
          createdAt: '2026-09-01T10:00:00.000Z',
        },
        {
          id: 'chat-2',
          title: 'Explicit chat',
          description: 'New Chat',
          messages: [],
          createdAt: '2026-09-01T12:00:00.000Z',
        },
      ],
    });

    const chats = await readLedgerContainerLiveChats(TEST_CONTAINER);

    // The user name wins; an unnamed chat retains its existing fallback.
    expect(chats.map((chat) => chat.title)).toEqual([
      'My chat',
      'Explicit chat',
    ]);
  });

  it('reads a Work Entry from its entry-keyed chat scope', async () => {
    await readLedgerContainerLiveChats({
      kind: 'cowork_entry',
      workspaceId: 'cowork-1',
      entryId: 'entry-1',
    });
    await readLedgerContainerLiveChats({
      kind: 'advisor_entry',
      appWorkspaceId: 'app-advisor',
      entryId: 'entry-2',
    });

    expect(mockReadChatTabsFile.mock.calls).toEqual([
      ['cowork-1', 'entry-1'],
      ['app-advisor', 'entry-2'],
    ]);
  });

  it('reads nothing for IDs that are not persisted IDs', async () => {
    await expect(
      readLedgerContainerLiveChats({
        kind: 'code_worktree',
        workspaceId: '../escape',
        worktreeId: 'worktree-1',
      }),
    ).resolves.toEqual([]);
    expect(mockReadChatTabsFile).not.toHaveBeenCalled();
  });
});
