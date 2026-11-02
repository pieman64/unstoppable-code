import { CanopyOperationError } from '@canopy/core-runtime';
import type {
  LedgerContainer,
  LedgerEntriesSearchResult,
  LedgerEntryGetResult,
} from '@canopy/protocol/canopy-core';
import type {
  PreferencesLoadErrorDetails,
  WorkspaceType,
} from '@canopy/desktop-shared/types';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import { createDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import type { LedgerCallerBindingRegistration } from '../../ledger/caller-bindings';
import type * as PreferencesStoreModule from '../../lib/preferences-store';
import {
  DEFAULT_PREFERENCES,
  peekPreferencesLoadError,
  readPreferencesFile,
} from '../../lib/preferences-store';
import {
  TEST_CONTAINER,
  TEST_CONTAINER_CREATED_AT,
  createLedgerServiceHarness,
  type LedgerServiceHarness,
} from '../../ledger/__tests__/fixtures/in-process-ledger-store-client';
import {
  DESKTOP_LEDGER_TOOLS_HOST,
  LedgerChatToolsSession,
  executeLedgerInjectedTool,
  ledgerChatContainerFor,
  mayExposeLedgerTools,
  openLedgerChatTools,
  openLedgerDelegateTools,
  openLedgerPipelineAgentTools,
  resolveLedgerToolExposure,
  type LedgerChatSettings,
  type LedgerChatTarget,
  type LedgerDelegateCaller,
  type LedgerHarness,
  type LedgerPipelineAgentCaller,
  type LedgerToolsDispatcher,
  type LedgerToolsHost,
} from '../ledger-tools-runtime';
import type { CanopyInjectedToolTextResult } from '../core';
import { LEDGER_PROMPT_NUDGE, type LedgerToolNames } from '../prompting';

jest.mock('../../lib/preferences-store', () => ({
  ...jest.requireActual<typeof PreferencesStoreModule>(
    '../../lib/preferences-store',
  ),
  readPreferencesFile: jest.fn(),
  peekPreferencesLoadError: jest.fn(),
}));

const filesystemServices = {
  listFileTreeRoots: (): Promise<{ roots: [] }> =>
    Promise.resolve({ roots: [] }),
  listFileTreeDirectory: (): Promise<{ entries: [] }> =>
    Promise.resolve({ entries: [] }),
};

// The harness binds TEST_CONTAINER: worktree-1 of workspace-1.
const TARGET: LedgerChatTarget = {
  projectId: 'workspace-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};

const OTHER_TEST_CONTAINER: LedgerContainer = {
  kind: 'code_worktree',
  workspaceId: 'workspace-1',
  worktreeId: 'worktree-2',
};

const SETTINGS: LedgerChatSettings = {
  model: 'claude-sonnet',
  thinkingEffort: 'medium',
  planMode: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseResult(
  result: CanopyInjectedToolTextResult,
): Record<string, unknown> {
  const parsed: unknown = JSON.parse(result.text);
  if (!isRecord(parsed)) throw new Error('Expected a JSON object result');
  return parsed;
}

function readEntryId(result: CanopyInjectedToolTextResult): string {
  const entry = parseResult(result).entry;
  if (!isRecord(entry) || typeof entry.entryId !== 'string') {
    throw new Error('Expected an entry in the result');
  }
  return entry.entryId;
}

interface TestHostState {
  flag: boolean;
  recording: boolean;
  databaseExists: boolean;
  createdAt: string | null;
  workspaceTypes: Map<string, WorkspaceType>;
  dispatcher: LedgerToolsDispatcher | null;
}

describe('ledger tools runtime', () => {
  let harness: LedgerServiceHarness;
  let dispatcher: ReturnType<typeof createDesktopRuntime>;
  let state: TestHostState;
  let host: LedgerToolsHost;
  let sessions: LedgerChatToolsSession[];

  function openSession(
    overrides: Partial<{
      chatId: string;
      harness: LedgerHarness;
      readSettings: () => LedgerChatSettings;
      selectedRepoId: string;
      toolNames: LedgerToolNames;
    }> = {},
  ): LedgerChatToolsSession {
    const session = new LedgerChatToolsSession({
      target: { ...TARGET, chatId: overrides.chatId ?? TARGET.chatId },
      scope: {
        container: TEST_CONTAINER,
        containerCreatedAt: TEST_CONTAINER_CREATED_AT,
      },
      harness: overrides.harness ?? 'claude',
      readSettings:
        overrides.readSettings ?? ((): LedgerChatSettings => SETTINGS),
      ...(overrides.selectedRepoId
        ? { selectedRepoId: overrides.selectedRepoId }
        : {}),
      ...(overrides.toolNames ? { toolNames: overrides.toolNames } : {}),
      host,
    });
    sessions.push(session);
    return session;
  }

  function addTask(
    session: LedgerChatToolsSession,
    title: string,
    invocationId?: string,
  ): Promise<CanopyInjectedToolTextResult> {
    return session.execute(
      'add_ledger_entry',
      { type: 'TASK', title, content: `${title} in detail.` },
      invocationId === undefined ? {} : { invocationId },
    );
  }

  beforeEach(() => {
    harness = createLedgerServiceHarness();
    dispatcher = createDesktopRuntime({
      services: filesystemServices,
      ledgerService: harness.service,
    });
    state = {
      flag: true,
      recording: true,
      databaseExists: true,
      createdAt: TEST_CONTAINER_CREATED_AT,
      workspaceTypes: new Map([['workspace-1', 'single-repo']]),
      dispatcher,
    };
    host = {
      dispatcher: (): LedgerToolsDispatcher | null => state.dispatcher,
      registry: (): LedgerServiceHarness['bindings'] => harness.bindings,
      isFlagEnabled: (): boolean => state.flag,
      isRecordingEnabled: (): Promise<boolean> =>
        Promise.resolve(state.recording),
      workspaceType: (projectId: string): WorkspaceType | null =>
        state.workspaceTypes.get(projectId) ?? null,
      containerCreatedAt: (): Promise<string | null> =>
        Promise.resolve(state.createdAt),
      chatTitle: (): Promise<string | null> => Promise.resolve('Chat one'),
      databaseMayExist: (): Promise<boolean> =>
        Promise.resolve(state.databaseExists),
    };
    sessions = [];
    harness.setLiveChats(TEST_CONTAINER, [
      { chatId: 'chat-1', title: 'Chat one', createdAt: null },
      { chatId: 'chat-2', title: 'Chat two', createdAt: null },
    ]);
  });

  afterEach(async () => {
    for (const session of sessions) session.dispose();
    await dispatcher.shutdown();
    harness.dispose();
  });

  describe('exposure gate', () => {
    it.each([
      [true, true, true, true],
      [false, true, true, false],
      [true, false, true, false],
      [true, true, false, false],
      [false, false, false, false],
    ])(
      'flag %s, setting %s, resolvable scope %s exposes the tools: %s',
      async (flag, recording, scopeResolvable, exposed) => {
        state.flag = flag;
        state.recording = recording;
        state.createdAt = scopeResolvable ? TEST_CONTAINER_CREATED_AT : null;

        const scope = await resolveLedgerToolExposure(TARGET, host);
        const tools = await openLedgerChatTools({
          target: TARGET,
          harness: 'codex',
          readSettings: (): LedgerChatSettings => SETTINGS,
          host,
        });

        expect(scope !== null).toBe(exposed);
        expect(tools !== null).toBe(exposed);
        if (exposed) {
          expect(scope).toEqual({
            container: TEST_CONTAINER,
            containerCreatedAt: TEST_CONTAINER_CREATED_AT,
          });
        }
        tools?.dispose();
      },
    );

    it('binds code chats to their worktree and Cowork chats to their Work Entry', () => {
      state.workspaceTypes.set('cowork-1', 'cowork');
      state.workspaceTypes.set('multi-1', 'multi-repo');

      expect(
        ledgerChatContainerFor(
          { projectId: 'cowork-1', worktreeId: 'entry-1' },
          host,
        ),
      ).toEqual({
        kind: 'cowork_entry',
        workspaceId: 'cowork-1',
        entryId: 'entry-1',
      });
      expect(
        ledgerChatContainerFor(
          { projectId: 'multi-1', worktreeId: 'wt-1' },
          host,
        ),
      ).toEqual({
        kind: 'code_worktree',
        workspaceId: 'multi-1',
        worktreeId: 'wt-1',
      });
    });

    it('binds App Advisor chats to the Work Entry their session started in', async () => {
      const target: LedgerChatTarget = {
        projectId: 'app-advisor',
        worktreeId: 'entry-1',
        chatId: 'c',
        assistantMode: 'app-advisor',
      };
      const container: LedgerContainer = {
        kind: 'advisor_entry',
        appWorkspaceId: 'app-advisor',
        entryId: 'entry-1',
      };

      expect(ledgerChatContainerFor(target, host)).toEqual(container);
      await expect(resolveLedgerToolExposure(target, host)).resolves.toEqual({
        container,
        containerCreatedAt: TEST_CONTAINER_CREATED_AT,
      });
    });

    it.each([
      [
        'App Advisor mode outside the Advisor workspace',
        { assistantMode: 'app-advisor' as const },
      ],
      [
        'the Advisor workspace outside App Advisor mode',
        { projectId: 'app-advisor' },
      ],
      [
        'an App Advisor chat with an unsafe entry ID',
        {
          projectId: 'app-advisor',
          worktreeId: '../escape',
          assistantMode: 'app-advisor' as const,
        },
      ],
      ['a Pipeline Editor chat', { assistantMode: 'pipeline-editor' as const }],
      ['a Plan Explore chat', { projectId: 'plan-explore-chat' }],
      ['a Code Review chat', { projectId: 'code-review-chat' }],
      ['a legacy standalone chat', { projectId: 'standalone-chat' }],
      ['an unknown workspace', { projectId: 'unregistered' }],
      ['an unsafe container ID', { worktreeId: '../escape' }],
    ])('gives %s no Ledger tools', async (_label, overrides) => {
      for (const id of [
        'plan-explore-chat',
        'code-review-chat',
        'standalone-chat',
      ]) {
        state.workspaceTypes.set(id, 'single-repo');
      }
      const target = { ...TARGET, ...overrides };

      expect(ledgerChatContainerFor(target, host)).toBeNull();
      expect(mayExposeLedgerTools(target, host)).toBe(false);
      await expect(resolveLedgerToolExposure(target, host)).resolves.toBeNull();
    });

    it('decides the synchronous half without reading the setting', () => {
      const isRecordingEnabled = jest.fn(() => Promise.resolve(true));
      const checkedHost = { ...host, isRecordingEnabled };

      expect(mayExposeLedgerTools(TARGET, checkedHost)).toBe(true);
      state.flag = false;
      expect(mayExposeLedgerTools(TARGET, checkedHost)).toBe(false);
      expect(isRecordingEnabled).not.toHaveBeenCalled();
    });

    it('fails closed when a host read throws', async () => {
      const failingHost: LedgerToolsHost = {
        ...host,
        isRecordingEnabled: (): Promise<boolean> =>
          Promise.reject(new Error('unreadable')),
      };

      await expect(
        resolveLedgerToolExposure(TARGET, failingHost),
      ).resolves.toBeNull();
    });
  });

  describe('execution gate', () => {
    it('refuses every tool when the flag turns off after the session started', async () => {
      const session = openSession();
      state.flag = false;

      for (const key of [
        'add_ledger_entry',
        'search_ledger_entries',
        'update_ledger_entry',
      ] as const) {
        const result = await session.execute(key, {});
        expect(result.isError).toBe(true);
        expect(parseResult(result)).toMatchObject({
          ok: false,
          error: { code: 'FEED_UNAVAILABLE', reason: 'ledger_disabled' },
        });
      }
      expect(harness.storeRequests()).toBe(0);
    });

    it('refuses when the user turns agent recording off mid-session', async () => {
      const session = openSession();
      await addTask(session, 'Before the setting changed');
      state.recording = false;

      const result = await addTask(session, 'After the setting changed');

      expect(parseResult(result)).toMatchObject({
        error: { code: 'FEED_UNAVAILABLE', reason: 'agent_recording_off' },
      });
    });

    it('refuses when the desktop runtime is not bound', async () => {
      const session = openSession();
      state.dispatcher = null;

      const result = await addTask(session, 'No runtime');

      expect(parseResult(result)).toMatchObject({
        error: { reason: 'ledger_runtime_unavailable' },
      });
    });

    it('answers a call without a session runtime as unavailable', async () => {
      const result = await executeLedgerInjectedTool(
        'search_ledger_entries',
        {},
        undefined,
      );

      expect(result.isError).toBe(true);
      expect(parseResult(result)).toMatchObject({
        error: { code: 'FEED_UNAVAILABLE', reason: 'no_ledger_scope' },
      });
    });
  });

  describe('tool calls', () => {
    it('adds, searches and updates an entry through the dispatcher', async () => {
      const session = openSession();

      const added = await addTask(session, 'Plan the release', 'call-1');
      const entryId = readEntryId(added);
      const search = await session.execute('search_ledger_entries', {
        owner: 'self',
      });
      const updated = await session.execute('update_ledger_entry', {
        entryId,
        expectedRevision: 1,
        status: 'IN_PROGRESS',
      });

      expect(added.isError).toBeUndefined();
      expect(parseResult(added)).toMatchObject({
        ok: true,
        changed: true,
        entry: {
          entryId,
          revision: 1,
          type: 'TASK',
          status: 'TODO',
          title: 'Plan the release',
          owner: { kind: 'chat', isSelf: true },
        },
      });
      expect(parseResult(added).entry).not.toHaveProperty('content');
      expect(parseResult(search)).toMatchObject({
        entries: [
          {
            entryId,
            title: 'Plan the release',
            content: 'Plan the release in detail.',
            owner: { isSelf: true },
            author: { isSelf: true },
            attribution: 'self_reported',
          },
        ],
        hasMore: false,
      });
      expect(parseResult(updated)).toMatchObject({
        ok: true,
        entry: { entryId, revision: 2, status: 'IN_PROGRESS' },
      });
    });

    it('maps an explicit requestKey to namespaced metadata and strips it from params', async () => {
      const session = openSession();
      const command = jest.spyOn(dispatcher, 'instruction');

      await session.execute('add_ledger_entry', {
        type: 'DECISION',
        title: 'Use SQLite',
        content: 'Chosen for the local store.',
        requestKey: 'decision-1',
      });

      const [name, params, options] = command.mock.calls[0] ?? [];
      expect(name).toBe('core.ledger.entry.add');
      expect(params).toEqual({
        type: 'DECISION',
        title: 'Use SQLite',
        content: 'Chosen for the local store.',
        _meta: { idempotencyKey: 'request:decision-1' },
      });
      expect(options?.metadata).toEqual({
        idempotencyKey: 'request:decision-1',
      });
    });

    it('derives the key from the provider invocation, so a replay returns the first receipt', async () => {
      const session = openSession({ harness: 'codex' });
      const command = jest.spyOn(dispatcher, 'instruction');

      const first = await addTask(session, 'Draft notes', 'codex:t1:u1:call-7');
      const replay = await addTask(
        session,
        'Draft notes',
        'codex:t1:u1:call-7',
      );
      const second = await addTask(
        session,
        'Draft notes',
        'codex:t1:u2:call-7',
      );
      const search = await session.execute('search_ledger_entries', {});

      expect(readEntryId(replay)).toBe(readEntryId(first));
      expect(readEntryId(second)).not.toBe(readEntryId(first));
      const entries = parseResult(search).entries;
      expect(Array.isArray(entries) ? entries : []).toHaveLength(2);
      const keys = command.mock.calls.map(
        ([, , options]) => options.metadata?.idempotencyKey,
      );
      expect(keys).toEqual([
        `invocation:codex:${session.runtimeGeneration}:codex:t1:u1:call-7`,
        `invocation:codex:${session.runtimeGeneration}:codex:t1:u1:call-7`,
        `invocation:codex:${session.runtimeGeneration}:codex:t1:u2:call-7`,
      ]);
    });

    it('never aliases calls that have no provider invocation identity', async () => {
      const session = openSession();

      const first = await addTask(session, 'Same text');
      const second = await addTask(session, 'Same text');

      expect(readEntryId(first)).not.toBe(readEntryId(second));
    });

    it('rejects unknown keys and host-owned fields before any Ledger call', async () => {
      const session = openSession();

      const result = await session.execute('add_ledger_entry', {
        type: 'TASK',
        title: 'Spoof',
        content: 'Tries to set the author.',
        author: 'someone-else',
        createdAt: '2020-01-01T00:00:00.000Z',
      });
      const summary = await session.execute('add_ledger_entry', {
        type: 'SUMMARY',
        title: 'Not for agents',
        content: 'Summaries are host-only.',
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain('Invalid arguments for AddFeedEntry.');
      expect(summary.isError).toBe(true);
      expect(harness.store.client.callCount('addEntry')).toBe(0);
    });

    it('returns the current entry on a revision conflict instead of overwriting', async () => {
      const session = openSession();
      const entryId = readEntryId(await addTask(session, 'Ship it'));
      await session.execute('update_ledger_entry', {
        entryId,
        expectedRevision: 1,
        status: 'IN_PROGRESS',
      });

      const stale = await session.execute('update_ledger_entry', {
        entryId,
        expectedRevision: 1,
        status: 'BLOCKED',
      });

      expect(stale.isError).toBe(true);
      expect(parseResult(stale)).toMatchObject({
        ok: false,
        error: { code: 'REVISION_CONFLICT' },
        currentEntry: { entryId, revision: 2, status: 'IN_PROGRESS' },
      });
      expect(stale.text).toContain('Reconsider the change');
    });

    it('explains terminal entries, missing entries and reused request keys', async () => {
      const session = openSession();
      const entryId = readEntryId(await addTask(session, 'Finish'));
      await session.execute('update_ledger_entry', {
        entryId,
        expectedRevision: 1,
        status: 'COMPLETED',
      });

      const terminal = await session.execute('update_ledger_entry', {
        entryId,
        expectedRevision: 2,
        status: 'IN_PROGRESS',
      });
      const missing = await session.execute('update_ledger_entry', {
        entryId: '00000000-0000-4000-8000-000000000009',
        expectedRevision: 1,
        status: 'BLOCKED',
      });
      await session.execute('add_ledger_entry', {
        type: 'OBSERVATION',
        title: 'First',
        content: 'One request.',
        requestKey: 'reused',
      });
      const reused = await session.execute('add_ledger_entry', {
        type: 'OBSERVATION',
        title: 'Second',
        content: 'A different request.',
        requestKey: 'reused',
      });

      expect(parseResult(terminal)).toMatchObject({
        error: { code: 'TERMINAL_ENTRY' },
        currentEntry: { entryId, status: 'COMPLETED' },
      });
      expect(parseResult(missing)).toMatchObject({
        error: { code: 'NOT_FOUND' },
      });
      expect(parseResult(reused)).toMatchObject({
        error: { code: 'IDEMPOTENCY_KEY_REUSED' },
      });
    });

    it('refuses to change an entry another chat owns', async () => {
      const mine = openSession();
      const theirs = openSession({ chatId: 'chat-2' });
      const entryId = readEntryId(await addTask(theirs, 'Their task'));

      const result = await mine.execute('update_ledger_entry', {
        entryId,
        expectedRevision: 1,
        status: 'BLOCKED',
      });

      expect(parseResult(result)).toMatchObject({
        error: { code: 'FORBIDDEN' },
      });
      expect(result.text).toContain('Only the current owner');
    });

    it('assigns an owner offered by the owner search and refreshes a stale token', async () => {
      const session = openSession();
      const entryId = readEntryId(await addTask(session, 'Hand over'));
      const search = parseResult(
        await session.execute('search_ledger_entries', {
          includeAssignableOwners: true,
          limit: 1,
        }),
      );
      const owners = search.owners;
      const candidates =
        isRecord(owners) && Array.isArray(owners.candidates)
          ? owners.candidates.filter(isRecord)
          : [];
      const other = candidates.find(
        (candidate) => candidate.displayName === 'Chat two',
      );
      if (
        !other ||
        typeof other.actorId !== 'string' ||
        typeof other.eligibilityToken !== 'string'
      ) {
        throw new Error('Expected Chat two as an owner candidate');
      }

      const stale = await session.execute('update_ledger_entry', {
        entryId,
        expectedRevision: 1,
        owner: { actorId: other.actorId, eligibilityToken: 'expired' },
      });
      const assigned = await session.execute('update_ledger_entry', {
        entryId,
        expectedRevision: 1,
        owner: {
          actorId: other.actorId,
          eligibilityToken: other.eligibilityToken,
        },
      });

      expect(candidates.some((candidate) => candidate.isSelf === true)).toBe(
        true,
      );
      expect(parseResult(stale)).toMatchObject({
        error: { code: 'OWNER_UNAVAILABLE' },
      });
      expect(stale.text).toContain('includeAssignableOwners');
      expect(parseResult(assigned)).toMatchObject({
        ok: true,
        entry: { owner: { actorId: other.actorId } },
      });
    });

    it('maps a Ledger that turned off in the core to unavailable', async () => {
      const session = openSession();
      harness.enabled = false;

      const result = await addTask(session, 'Core says no');

      expect(parseResult(result)).toMatchObject({
        error: { code: 'WRITER_UNAVAILABLE' },
      });
    });

    it('tells the model to search before retrying when a command outcome is unknown', async () => {
      const session = openSession();
      const failure = jest.spyOn(dispatcher, 'instruction');
      failure.mockRejectedValueOnce(new Error('connection lost'));

      const derived = await addTask(session, 'Maybe saved', 'claude:toolu_1');
      failure.mockRejectedValueOnce(
        new CanopyOperationError({
          kind: 'unavailable',
          message: 'The runtime is unavailable.',
          retry: { kind: 'same_idempotency_key' },
        }),
      );
      const explicit = await session.execute('add_ledger_entry', {
        type: 'TASK',
        title: 'Maybe saved',
        content: 'Retry key supplied.',
        requestKey: 'retry-me',
      });

      expect(derived.text).toContain(
        'Search for the entry before trying again',
      );
      expect(explicit.text).toContain('same requestKey');
    });

    it('keeps search results bounded and drops the cursor with omitted entries', async () => {
      const session = openSession();
      const content = 'x'.repeat(1_000);
      for (let index = 0; index < 60; index += 1) {
        await session.execute('add_ledger_entry', {
          type: 'OBSERVATION',
          title: `Observation ${index}`,
          content,
          requestKey: `observation-${index}`,
        });
      }

      const result = await session.execute('search_ledger_entries', {
        limit: 60,
      });
      const parsed = parseResult(result);

      expect(result.text.length).toBeLessThanOrEqual(40_000);
      expect(parsed.omittedEntries).toEqual(expect.any(Number));
      expect(parsed.nextCursor).toBeNull();
      expect(parsed.hasMore).toBe(true);
      expect(parsed).not.toHaveProperty('origin');
    });
  });

  describe('caller binding', () => {
    it('registers one interactive chat binding and reuses it', async () => {
      const register = jest.spyOn(harness.bindings, 'register');
      const query = jest.spyOn(dispatcher, 'query');
      const session = openSession({ harness: 'codex' });

      await Promise.all([
        session.execute('search_ledger_entries', {}),
        session.execute('search_ledger_entries', { owner: 'self' }),
      ]);
      await addTask(session, 'Reuse the binding');

      expect(register).toHaveBeenCalledTimes(1);
      const [registration] = register.mock.calls[0] ?? [];
      const expected: LedgerCallerBindingRegistration = {
        container: TEST_CONTAINER,
        containerCreatedAt: TEST_CONTAINER_CREATED_AT,
        actor: { kind: 'chat', originKey: 'chat-1', displayName: 'Chat one' },
        role: 'interactive_chat',
        authorDetails: {
          harness: 'codex',
          model: 'claude-sonnet',
          thinkingEffort: 'medium',
          mode: 'default',
          pipelineExecutionId: null,
          settingsRevision: null,
          unavailableReason: null,
        },
        runtimeGeneration: session.runtimeGeneration,
      };
      expect(registration).toEqual(expected);
      const [, , options] = query.mock.calls[0] ?? [];
      expect(options?.caller).toMatchObject({
        interfaceKind: 'daemon',
        grants: ['core.ledger.read', 'core.ledger.write'],
      });
    });

    it('replaces the binding when the session settings change', async () => {
      let settings: LedgerChatSettings = SETTINGS;
      const session = openSession({ readSettings: () => settings });
      const user = harness.registerUser();
      const register = jest.spyOn(harness.bindings, 'register');
      const revoke = jest.spyOn(harness.bindings, 'revoke');

      const first = readEntryId(await addTask(session, 'Before'));
      settings = {
        model: 'claude-opus',
        thinkingEffort: 'high',
        planMode: true,
      };
      const second = readEntryId(await addTask(session, 'After'));
      const detail = await dispatcher.query(
        'core.ledger.entry.get',
        { entryId: second },
        { caller: harness.caller(user) },
      );

      expect(first).not.toBe(second);
      expect(register).toHaveBeenCalledTimes(2);
      expect(revoke).toHaveBeenCalledTimes(1);
      expect(detail.entry.authorDetails).toMatchObject({
        model: 'claude-opus',
        thinkingEffort: 'high',
        mode: 'plan',
      });
    });

    it('revokes the binding on dispose and answers later calls as ended', async () => {
      const session = openSession();
      const register = jest.spyOn(harness.bindings, 'register');
      await addTask(session, 'Before dispose');
      const bindingId: unknown = register.mock.results[0]?.value;
      if (typeof bindingId !== 'string') throw new Error('Expected a binding');

      session.dispose();
      const result = await addTask(session, 'After dispose');

      expect(harness.bindings.resolve(bindingId)).toBeUndefined();
      expect(parseResult(result)).toMatchObject({
        error: { reason: 'session_ended' },
      });
    });

    it('re-registers after an outside revocation only while the container is unchanged', async () => {
      const session = openSession();
      await addTask(session, 'First');
      harness.bindings.revokeWhere(() => true);

      const again = await addTask(session, 'Same incarnation');
      harness.bindings.revokeWhere(() => true);
      state.createdAt = '2026-09-02T08:00:00.000Z';
      const moved = await addTask(session, 'New incarnation');

      expect(parseResult(again)).toMatchObject({ ok: true });
      expect(parseResult(moved)).toMatchObject({
        error: { reason: 'no_ledger_scope' },
      });
    });

    it('gives each session its own runtime generation', () => {
      const first = openSession();
      const second = openSession();

      expect(second.runtimeGeneration).toBeGreaterThan(first.runtimeGeneration);
    });
  });

  describe('assignment hint', () => {
    it('never touches Ledger storage when the database does not exist', async () => {
      const session = openSession();
      state.databaseExists = false;

      await expect(session.assignmentHint()).resolves.toBeUndefined();
      expect(harness.storeRequests()).toBe(0);
    });

    it('says nothing on a first turn without assigned entries', async () => {
      const session = openSession();

      await expect(session.assignmentHint()).resolves.toBeUndefined();
    });

    it('reports open entries assigned to the chat on its first turn', async () => {
      const earlier = openSession();
      await addTask(earlier, 'Carried over');
      const resumed = openSession();

      const hint = await resumed.assignmentHint();

      expect(hint).toContain('<feed_assignments');
      expect(hint).toContain('You have 1 open Feed entries assigned to you');
      expect(hint).toContain(
        CANOPY_INJECTED_TOOL_REGISTRY.search_ledger_entries.claudeToolName,
      );
    });

    it('ignores changes the chat made itself and reports changes made by others', async () => {
      const session = openSession({ harness: 'codex' });
      await session.assignmentHint();
      const entryId = readEntryId(await addTask(session, 'Own work'));
      const afterOwnChange = await session.assignmentHint();
      const user = harness.registerUser();
      await dispatcher.instruction(
        'core.ledger.entry.update',
        {
          entryId,
          expectedRevision: 1,
          status: 'BLOCKED',
          _meta: { idempotencyKey: 'user-block' },
        },
        {
          caller: harness.caller(user),
          metadata: { idempotencyKey: 'user-block' },
        },
      );
      const afterUserChange = await session.assignmentHint();
      const unchanged = await session.assignmentHint();
      await dispatcher.instruction(
        'core.ledger.entry.update',
        {
          entryId,
          expectedRevision: 2,
          status: 'COMPLETED',
          _meta: { idempotencyKey: 'user-complete' },
        },
        {
          caller: harness.caller(user),
          metadata: { idempotencyKey: 'user-complete' },
        },
      );
      const afterClose = await session.assignmentHint();

      expect(afterOwnChange).toBeUndefined();
      expect(afterUserChange).toContain('1 new or updated, 0 no longer open');
      expect(afterUserChange).toContain(
        CANOPY_INJECTED_TOOL_REGISTRY.search_ledger_entries.codexToolName,
      );
      expect(unchanged).toBeUndefined();
      expect(afterClose).toContain('0 new or updated, 1 no longer open');
    });

    it('stays quiet when the Ledger or recording is off', async () => {
      const earlier = openSession();
      await addTask(earlier, 'Assigned');
      const session = openSession();
      state.recording = false;

      await expect(session.assignmentHint()).resolves.toBeUndefined();
      state.recording = true;
      state.flag = false;
      await expect(session.assignmentHint()).resolves.toBeUndefined();
    });

    it('gives up at its deadline without moving the baseline', async () => {
      const earlier = openSession();
      await addTask(earlier, 'Assigned');
      const session = openSession();
      // Registers the binding first, so the stalled read below is the hint's.
      await session.execute('search_ledger_entries', { limit: 1 });
      const query = jest.spyOn(dispatcher, 'query');
      query.mockImplementationOnce(
        (): Promise<LedgerEntriesSearchResult> => new Promise(() => undefined),
      );

      await expect(session.assignmentHint(50)).resolves.toBeUndefined();
      const next = await session.assignmentHint();

      expect(next).toContain('You have 1 open Feed entries');
    });
  });

  describe('prompt', () => {
    it('carries the verbatim nudge, the tool names and the reference root', () => {
      const claude = openSession();
      const codex = openSession({ harness: 'codex' });

      const claudePrompt = claude.systemPrompt();
      const codexPrompt = codex.systemPrompt();

      expect(claudePrompt).toContain(LEDGER_PROMPT_NUDGE);
      expect(codexPrompt).toContain(LEDGER_PROMPT_NUDGE);
      expect(claudePrompt).toContain(
        CANOPY_INJECTED_TOOL_REGISTRY.add_ledger_entry.claudeToolName,
      );
      expect(codexPrompt).toContain(
        CANOPY_INJECTED_TOOL_REGISTRY.add_ledger_entry.codexToolName,
      );
      expect(claudePrompt).toContain('rootId "workspace-1"');
      // Claude carries the Plan mode exception here; Codex adds it to its
      // Plan mode developer instructions instead.
      expect(claudePrompt).toContain('Plan mode exception');
      expect(codexPrompt).not.toContain('Plan mode exception');
    });

    it('roots references at the selected repository, the Cowork folder or the App Advisor folder', () => {
      state.workspaceTypes.set('workspace-1', 'multi-repo');
      const multi = openSession({ selectedRepoId: 'api' });
      const container: LedgerContainer = {
        kind: 'cowork_entry',
        workspaceId: 'cowork-1',
        entryId: 'entry-1',
      };
      state.workspaceTypes.set('cowork-1', 'cowork');
      const cowork = new LedgerChatToolsSession({
        target: { projectId: 'cowork-1', worktreeId: 'entry-1', chatId: 'c' },
        scope: { container, containerCreatedAt: TEST_CONTAINER_CREATED_AT },
        harness: 'claude',
        readSettings: (): LedgerChatSettings => SETTINGS,
        host,
      });
      sessions.push(cowork);
      const advisor = new LedgerChatToolsSession({
        target: {
          projectId: 'app-advisor',
          worktreeId: 'entry-1',
          chatId: 'c',
          assistantMode: 'app-advisor',
        },
        scope: {
          container: {
            kind: 'advisor_entry',
            appWorkspaceId: 'app-advisor',
            entryId: 'entry-1',
          },
          containerCreatedAt: TEST_CONTAINER_CREATED_AT,
        },
        harness: 'codex',
        readSettings: (): LedgerChatSettings => SETTINGS,
        host,
      });
      sessions.push(advisor);

      expect(multi.systemPrompt()).toContain('rootId "api"');
      expect(cowork.systemPrompt()).toContain('rootId "workspace"');
      expect(advisor.systemPrompt()).toContain('rootId "app-advisor"');
    });

    it('leaves the Plan mode exception out of App Advisor prompts', () => {
      const advisor = new LedgerChatToolsSession({
        target: {
          projectId: 'app-advisor',
          worktreeId: 'entry-1',
          chatId: 'c',
          assistantMode: 'app-advisor',
        },
        scope: {
          container: {
            kind: 'advisor_entry',
            appWorkspaceId: 'app-advisor',
            entryId: 'entry-1',
          },
          containerCreatedAt: TEST_CONTAINER_CREATED_AT,
        },
        harness: 'claude',
        readSettings: (): LedgerChatSettings => SETTINGS,
        host,
      });
      sessions.push(advisor);

      expect(advisor.systemPrompt()).toContain(LEDGER_PROMPT_NUDGE);
      expect(advisor.systemPrompt()).not.toContain('Plan mode exception');
    });

    it('names the tools the way the session surface advertises them', async () => {
      const earlier = openSession();
      await addTask(earlier, 'Assigned');
      const cursor = openSession({ harness: 'cursor' });
      const renamed = openSession({
        toolNames: {
          add: 'AdvisorAdd',
          search: 'AdvisorSearch',
          update: 'AdvisorUpdate',
        },
      });
      const cursorSearch =
        CANOPY_INJECTED_TOOL_REGISTRY.search_ledger_entries.displayName;

      expect(cursor.systemPrompt()).toContain(
        `${cursorSearch} searches this chat's Feed`,
      );
      expect(cursor.systemPrompt()).not.toContain('Plan mode exception');
      expect(renamed.systemPrompt()).toContain(
        "AdvisorSearch searches this chat's Feed, AdvisorAdd records an entry, and AdvisorUpdate changes",
      );
      expect(renamed.systemPrompt()).toContain(
        'Plan mode exception: AdvisorAdd, AdvisorSearch and AdvisorUpdate',
      );
      await expect(cursor.assignmentHint()).resolves.toContain(
        `Use ${cursorSearch} with owner "self"`,
      );
      await expect(renamed.assignmentHint()).resolves.toContain(
        'Use AdvisorSearch with owner "self"',
      );
    });
  });

  describe('managed delegates', () => {
    let live: boolean;

    function delegateCaller(
      overrides: Partial<LedgerDelegateCaller> = {},
    ): LedgerDelegateCaller {
      return {
        delegationId: 'delegation-1',
        description: 'Review delegate',
        runGeneration: 1,
        parent: { kind: 'chat' },
        isLive: (): boolean => live,
        ...overrides,
      };
    }

    function openDelegate(
      overrides: Partial<LedgerDelegateCaller> = {},
      harnessName: LedgerHarness = 'claude',
    ): LedgerChatToolsSession {
      const session = new LedgerChatToolsSession({
        target: TARGET,
        scope: {
          container: TEST_CONTAINER,
          containerCreatedAt: TEST_CONTAINER_CREATED_AT,
        },
        harness: harnessName,
        readSettings: (): LedgerChatSettings => ({
          model: 'gpt-5-codex',
          thinkingEffort: 'high',
          planMode: false,
        }),
        delegate: delegateCaller(overrides),
        host,
      });
      sessions.push(session);
      return session;
    }

    async function detail(entryId: string): Promise<LedgerEntryGetResult> {
      return dispatcher.query(
        'core.ledger.entry.get',
        { entryId },
        { caller: harness.caller(harness.registerUser()) },
      );
    }

    beforeEach(() => {
      live = true;
    });

    it('registers the delegate as its own actor with its lineage, never as the parent chat', async () => {
      const register = jest.spyOn(harness.bindings, 'register');
      const chatEntryId = readEntryId(
        await addTask(openSession(), 'Parent work'),
      );
      const session = openDelegate({ runGeneration: 2 }, 'codex');

      const added = await addTask(session, 'Delegated work');

      const [registration] = register.mock.calls[1] ?? [];
      const expected: LedgerCallerBindingRegistration = {
        container: TEST_CONTAINER,
        containerCreatedAt: TEST_CONTAINER_CREATED_AT,
        actor: {
          kind: 'managed_delegation',
          originKey: 'delegation-1',
          displayName: 'Review delegate',
        },
        role: 'managed_delegation',
        authorDetails: {
          harness: 'codex',
          model: 'gpt-5-codex',
          thinkingEffort: 'high',
          mode: 'default',
          pipelineExecutionId: null,
          settingsRevision: null,
          unavailableReason: null,
        },
        runtimeGeneration: 2,
        origin: {
          kind: 'managed_delegation',
          delegationId: 'delegation-1',
          parent: {
            kind: 'chat',
            originKey: 'chat-1',
            displayName: 'Chat one',
          },
          root: { kind: 'chat', chatId: 'chat-1' },
          runGeneration: 2,
        },
      };
      expect(registration).toEqual(expected);
      expect(parseResult(added)).toMatchObject({
        ok: true,
        entry: { owner: { kind: 'managed_delegation', isSelf: true } },
      });
      const [chatEntry, delegateEntry] = await Promise.all([
        detail(chatEntryId),
        detail(readEntryId(added)),
      ]);
      expect(delegateEntry.entry.author.kind).toBe('managed_delegation');
      expect(delegateEntry.entry.origin).toEqual({
        kind: 'managed_delegation',
        ledgerId: delegateEntry.entry.scope.ledgerId,
        delegationId: 'delegation-1',
        parentActorId: chatEntry.entry.author.actorId,
        root: { kind: 'chat', chatId: 'chat-1' },
        runGeneration: 2,
      });
    });

    it('names a nested delegate by the delegate that spawned it', async () => {
      const register = jest.spyOn(harness.bindings, 'register');
      const session = openDelegate({
        delegationId: 'delegation-2',
        parent: {
          kind: 'managed_delegation',
          delegationId: 'delegation-1',
          description: 'Parent review',
        },
      });

      await addTask(session, 'Nested work');

      expect(register.mock.calls[0]?.[0].origin).toEqual({
        kind: 'managed_delegation',
        delegationId: 'delegation-2',
        parent: {
          kind: 'managed_delegation',
          originKey: 'delegation-1',
          displayName: 'Parent review',
        },
        root: { kind: 'chat', chatId: 'chat-1' },
        runGeneration: 1,
      });
    });

    it('keeps one actor across the run generations of a delegation', async () => {
      const first = openDelegate({ runGeneration: 1 });
      const firstId = readEntryId(await addTask(first, 'First run'));
      first.dispose();
      const second = openDelegate({ runGeneration: 2 });

      const secondId = readEntryId(await addTask(second, 'Second run'));
      const [one, two] = await Promise.all([detail(firstId), detail(secondId)]);

      expect(two.entry.author).toEqual(one.entry.author);
      expect(one.entry.origin).toMatchObject({ runGeneration: 1 });
      expect(two.entry.origin).toMatchObject({ runGeneration: 2 });
    });

    it('cannot change an entry its parent chat owns', async () => {
      const entryId = readEntryId(await addTask(openSession(), 'Parent task'));
      const session = openDelegate();

      const result = await session.execute('update_ledger_entry', {
        entryId,
        expectedRevision: 1,
        status: 'BLOCKED',
      });

      expect(parseResult(result)).toMatchObject({
        error: { code: 'FORBIDDEN' },
      });
      expect(result.text).toContain('Only the current owner');
    });

    it('answers every call as ended once its run is no longer live', async () => {
      const session = openDelegate();
      await addTask(session, 'While running');
      live = false;
      const requestsBefore = harness.store.client.calls.length;

      const result = await session.execute('search_ledger_entries', {});

      expect(parseResult(result)).toMatchObject({
        error: { code: 'FEED_UNAVAILABLE', reason: 'session_ended' },
      });
      expect(harness.store.client.calls.length).toBe(requestsBefore);
    });

    it('refuses a call when its run stops while the recording setting is read', async () => {
      let recordingRead = Promise.resolve(true);
      host = {
        ...host,
        isRecordingEnabled: (): Promise<boolean> => recordingRead,
      };
      const session = openDelegate();
      await addTask(session, 'While running');
      let finishRead: (enabled: boolean) => void = () => undefined;
      recordingRead = new Promise<boolean>((resolve) => {
        finishRead = resolve;
      });
      const command = jest.spyOn(dispatcher, 'instruction');

      const call = addTask(session, 'While stopping');
      live = false;
      finishRead(true);
      const result = await call;

      expect(parseResult(result)).toMatchObject({
        error: { code: 'FEED_UNAVAILABLE', reason: 'session_ended' },
      });
      expect(command).not.toHaveBeenCalled();
    });

    it('refuses a call when its run stops while its caller binding resolves', async () => {
      const session = openDelegate();
      await addTask(session, 'While running');
      const resolveBinding = harness.bindings.resolve.bind(harness.bindings);
      jest
        .spyOn(harness.bindings, 'resolve')
        .mockImplementationOnce((bindingId) => {
          live = false;
          return resolveBinding(bindingId);
        });
      const query = jest.spyOn(dispatcher, 'query');

      const result = await session.execute('search_ledger_entries', {});

      expect(parseResult(result)).toMatchObject({
        error: { code: 'FEED_UNAVAILABLE', reason: 'session_ended' },
      });
      expect(query).not.toHaveBeenCalled();
    });

    it.each([
      ['the flag is off', { flag: false }],
      ['agent recording is off', { recording: false }],
      ['the parent chat has no Ledger scope', { createdAt: null }],
    ])(
      'opens no delegate tools when %s',
      async (_label, overrides: Partial<TestHostState>) => {
        Object.assign(state, overrides);

        const tools = await openLedgerDelegateTools({
          target: TARGET,
          harness: 'claude',
          readSettings: (): LedgerChatSettings => SETTINGS,
          delegate: delegateCaller(),
          host,
        });

        expect(tools).toBeNull();
        expect(harness.storeRequests()).toBe(0);
      },
    );

    it('opens delegate tools bound to the parent chat scope', async () => {
      const tools = await openLedgerDelegateTools({
        target: TARGET,
        harness: 'claude',
        readSettings: (): LedgerChatSettings => SETTINGS,
        delegate: delegateCaller(),
        host,
      });
      if (tools === null) throw new Error('Expected delegate tools');
      sessions.push(tools);

      expect(tools.scope).toEqual({
        container: TEST_CONTAINER,
        containerCreatedAt: TEST_CONTAINER_CREATED_AT,
      });
      expect(parseResult(await addTask(tools, 'Recorded'))).toMatchObject({
        ok: true,
      });
    });

    it('tells a delegate whose Ledger it records in, without a Plan mode exception', () => {
      const prompt = openDelegate().systemPrompt();

      expect(prompt).toContain(LEDGER_PROMPT_NUDGE);
      expect(prompt).toContain('the chat that delegated your task');
      expect(prompt).toContain('rootId "workspace-1"');
      expect(prompt).not.toContain('Plan mode exception');
    });
  });

  describe('pipeline agents', () => {
    let live: boolean;
    const PIPELINE_TARGET: LedgerChatTarget = {
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'pipeline:execution-1',
    };

    function pipelineCaller(
      overrides: Partial<LedgerPipelineAgentCaller> = {},
    ): LedgerPipelineAgentCaller {
      return {
        executionId: 'execution-1',
        physicalJobId: 'build__variant_1',
        logicalJobId: 'build',
        stepId: 'implement',
        attempt: 2,
        iteration: 1,
        agentSessionId: 'session-2',
        predecessorAgentSessionId: 'session-1',
        displayName: 'Implement · Release',
        isLive: (): boolean => live,
        ...overrides,
      };
    }

    function openPipelineAgent(
      overrides: Partial<LedgerPipelineAgentCaller> = {},
    ): Promise<LedgerChatToolsSession | null> {
      return openLedgerPipelineAgentTools({
        target: PIPELINE_TARGET,
        harness: 'codex',
        readSettings: (): LedgerChatSettings => ({
          model: 'gpt-5-codex',
          thinkingEffort: 'high',
          planMode: false,
          mode: 'read_only',
        }),
        pipelineAgent: pipelineCaller(overrides),
        host,
      }).then((session) => {
        if (session !== null) sessions.push(session);
        return session;
      });
    }

    beforeEach(() => {
      live = true;
    });

    it('registers the attempt as its own actor with its execution origin', async () => {
      const register = jest.spyOn(harness.bindings, 'register');
      const session = await openPipelineAgent();
      if (session === null) throw new Error('Expected pipeline agent tools');

      const added = await addTask(session, 'Pipeline work');

      const [registration] = register.mock.calls[0] ?? [];
      const expected: LedgerCallerBindingRegistration = {
        container: TEST_CONTAINER,
        containerCreatedAt: TEST_CONTAINER_CREATED_AT,
        actor: {
          kind: 'pipeline_agent',
          originKey: 'session-2',
          displayName: 'Implement · Release',
        },
        role: 'pipeline_agent',
        authorDetails: {
          harness: 'codex',
          model: 'gpt-5-codex',
          thinkingEffort: 'high',
          mode: 'read_only',
          pipelineExecutionId: 'execution-1',
          settingsRevision: null,
          unavailableReason: null,
        },
        runtimeGeneration: session.runtimeGeneration,
        origin: {
          kind: 'pipeline_agent',
          executionId: 'execution-1',
          physicalJobId: 'build__variant_1',
          logicalJobId: 'build',
          stepId: 'implement',
          attempt: 2,
          iteration: 1,
          agentSessionId: 'session-2',
          predecessorAgentSessionId: 'session-1',
        },
      };
      expect(registration).toEqual(expected);
      expect(parseResult(added)).toMatchObject({
        ok: true,
        entry: { owner: { kind: 'pipeline_agent', isSelf: true } },
      });
    });

    it('writes only to its own execution worktree Ledger', async () => {
      const session = await openPipelineAgent();
      if (session === null) throw new Error('Expected pipeline agent tools');
      const entryId = readEntryId(await addTask(session, 'Scoped work'));

      const other = harness.register({ container: OTHER_TEST_CONTAINER });
      const detail = await dispatcher.query(
        'core.ledger.entry.get',
        { entryId },
        { caller: harness.caller(harness.registerUser()) },
      );
      expect(detail.entry.scope.container).toEqual(TEST_CONTAINER);
      await expect(
        dispatcher.query(
          'core.ledger.entry.get',
          { entryId },
          { caller: harness.caller(other) },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'not_found' } });
    });

    it('answers every call as ended once its attempt settles or pauses', async () => {
      const session = await openPipelineAgent();
      if (session === null) throw new Error('Expected pipeline agent tools');
      await addTask(session, 'While running');
      live = false;
      const requestsBefore = harness.store.client.calls.length;

      const result = await session.execute('search_ledger_entries', {});

      expect(parseResult(result)).toMatchObject({
        error: { code: 'FEED_UNAVAILABLE', reason: 'session_ended' },
      });
      expect(harness.store.client.calls.length).toBe(requestsBefore);
    });

    it.each([
      ['the flag is off', { flag: false }],
      ['agent recording is off', { recording: false }],
      ['the worktree has no Ledger scope', { createdAt: null }],
    ])(
      'opens no pipeline agent tools when %s',
      async (_label, overrides: Partial<TestHostState>) => {
        Object.assign(state, overrides);

        await expect(openPipelineAgent()).resolves.toBeNull();
        expect(harness.storeRequests()).toBe(0);
      },
    );

    it('opens none outside a code worktree', async () => {
      state.workspaceTypes.set('workspace-1', 'cowork');

      await expect(openPipelineAgent()).resolves.toBeNull();
    });

    describe("without a worktree, in its owner's global (workflow) Ledger", () => {
      /** The desktop pipeline host: it binds the signed-in account's Ledger. */
      function globalHost(): LedgerToolsHost {
        return {
          ...host,
          containerCreatedAt: async (container): Promise<string | null> =>
            container.kind === 'global'
              ? (await harness.service.scopes.resolveGlobal(container.owner))
                  .containerCreatedAt
              : host.containerCreatedAt(container),
          findContainerCreatedAt: async (container): Promise<string | null> =>
            container.kind === 'global'
              ? ((
                  await harness.service.scopes.findGlobal(
                    container.owner,
                    harness.accountId,
                  )
                )?.containerCreatedAt ?? null)
              : host.containerCreatedAt(container),
        };
      }

      function openGlobalAgent(): Promise<LedgerChatToolsSession | null> {
        return openLedgerPipelineAgentTools({
          target: {
            projectId: 'pipeline',
            worktreeId: 'execution-1',
            chatId: 'pipeline:execution-1',
          },
          globalOwner: { kind: 'personal' },
          harness: 'codex',
          readSettings: (): LedgerChatSettings => ({
            model: 'gpt-5-codex',
            thinkingEffort: 'high',
            planMode: false,
            mode: 'read_only',
          }),
          pipelineAgent: pipelineCaller(),
          host: globalHost(),
        }).then((session) => {
          if (session !== null) sessions.push(session);
          return session;
        });
      }

      it('records the agent there, and says its entries reference no files', async () => {
        const session = await openGlobalAgent();
        if (session === null) throw new Error('Expected pipeline agent tools');
        const entryId = readEntryId(await addTask(session, 'Workflow work'));

        const detail = await dispatcher
          .query(
            'core.ledger.entry.get',
            { entryId },
            { caller: harness.caller(harness.registerUser()) },
          )
          .catch((): null => null);
        // The user's binding is the task's, which never reads it.
        expect(detail).toBeNull();
        expect(session.scope.container).toEqual({
          kind: 'global',
          owner: { kind: 'personal' },
        });
        const prompt = session.systemPrompt();
        expect(prompt).toContain('workflows Feed');
        expect(prompt).toContain("can't reference files");
        expect(prompt).not.toContain('rootId');
        expect(prompt).not.toContain('Plan mode exception');
      });

      it.each([
        ['the flag is off', { flag: false }],
        ['agent recording is off', { recording: false }],
      ])(
        'opens none, binding nothing, when %s',
        async (_label, overrides: Partial<TestHostState>) => {
          Object.assign(state, overrides);

          await expect(openGlobalAgent()).resolves.toBeNull();
          expect(harness.storeRequests()).toBe(0);
        },
      );

      it('fails closed once another account signs in, writing nowhere', async () => {
        const session = await openGlobalAgent();
        if (session === null) throw new Error('Expected pipeline agent tools');
        await addTask(session, 'Before the switch');
        const countsBefore = harness.store.repository.getStorageCounts();

        harness.accountId = 'account-2';
        const result = await addTask(session, 'After the switch');
        // The first refusal drops the binding; the next call rebinds.
        const retried = await addTask(session, 'Again after the switch');

        for (const refused of [result, retried]) {
          expect(parseResult(refused)).toMatchObject({
            error: { code: 'FEED_UNAVAILABLE', reason: 'no_ledger_scope' },
          });
        }
        // Rechecks and rebinds only look: the new account's Ledger is not minted.
        expect(harness.store.repository.getStorageCounts()).toMatchObject({
          entries: countsBefore.entries,
          scopes: countsBefore.scopes,
        });
      });
    });

    it('tells the agent whose Ledger it records in, without a Plan mode exception', async () => {
      const session = await openPipelineAgent();
      if (session === null) throw new Error('Expected pipeline agent tools');
      const prompt = session.systemPrompt();

      expect(prompt).toContain(LEDGER_PROMPT_NUDGE);
      expect(prompt).toContain('the worktree this pipeline runs in');
      expect(prompt).toContain('the agent of this pipeline step');
      expect(prompt).toContain(
        CANOPY_INJECTED_TOOL_REGISTRY.add_ledger_entry.codexToolName,
      );
      expect(prompt).not.toContain('Plan mode exception');
    });
  });
});

describe('desktop recording setting', () => {
  const readPreferences = jest.mocked(readPreferencesFile);
  const peekLoadError = jest.mocked(peekPreferencesLoadError);
  const LOAD_ERROR: PreferencesLoadErrorDetails = {
    timestamp: '2026-09-29T12:00:00.000Z',
    reason: 'parse',
    message: 'Unexpected token } in JSON',
    filePath: '/mock/userData/preferences.json',
  };

  beforeEach(() => {
    readPreferences.mockReset();
    peekLoadError.mockReset();
    peekLoadError.mockReturnValue(null);
  });

  it('is on by default for a fresh install', async () => {
    readPreferences.mockResolvedValue(DEFAULT_PREFERENCES);

    await expect(DESKTOP_LEDGER_TOOLS_HOST.isRecordingEnabled()).resolves.toBe(
      true,
    );
  });

  it('is off when the person turned it off', async () => {
    readPreferences.mockResolvedValue({
      ...DEFAULT_PREFERENCES,
      ledgerAgentRecordingEnabled: false,
    });

    await expect(DESKTOP_LEDGER_TOOLS_HOST.isRecordingEnabled()).resolves.toBe(
      false,
    );
  });

  it('fails closed while the preferences read is degraded', async () => {
    // Recovery hands back defaults, where recording is on, so the saved
    // choice is unknown until the recovery notice has been shown.
    readPreferences.mockResolvedValue(DEFAULT_PREFERENCES);
    peekLoadError.mockReturnValue(LOAD_ERROR);

    await expect(DESKTOP_LEDGER_TOOLS_HOST.isRecordingEnabled()).resolves.toBe(
      false,
    );
  });

  it('follows the recovered preferences once the notice is acknowledged', async () => {
    readPreferences.mockResolvedValue(DEFAULT_PREFERENCES);
    peekLoadError.mockReturnValueOnce(LOAD_ERROR).mockReturnValue(null);

    await expect(DESKTOP_LEDGER_TOOLS_HOST.isRecordingEnabled()).resolves.toBe(
      false,
    );
    await expect(DESKTOP_LEDGER_TOOLS_HOST.isRecordingEnabled()).resolves.toBe(
      true,
    );
  });

  it('fails closed when the preferences cannot be read', async () => {
    readPreferences.mockRejectedValue(new Error('EIO: i/o error'));

    await expect(DESKTOP_LEDGER_TOOLS_HOST.isRecordingEnabled()).resolves.toBe(
      false,
    );
  });
});
