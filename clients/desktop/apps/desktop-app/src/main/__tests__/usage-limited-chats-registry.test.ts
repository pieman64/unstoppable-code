jest.mock('../lib/atomic-file', () => ({
  writeFileAtomically: jest.fn().mockResolvedValue(undefined),
}));
import { writeFileAtomically } from '../lib/atomic-file';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { buildUsageLimitedChatGroups } from '../lib/usage-limited-chats-registry';
import { isRecord } from '../lib/type-guards';
import {
  STANDALONE_CHAT_PROJECT_ID,
  type ChatActiveSessions,
  type UsageLimitedChatEntry,
  type ResumeQueueEntry,
} from '@canopy/desktop-shared/types';

jest.mock('node:fs/promises');
jest.mock('../lib/paths', () => ({
  getUsageLimitedChatsFilePath: (): string => '/tmp/ulc.json',
}));

const markAttention = jest.fn<
  void,
  [{ state: string; reason: string; detail?: string }]
>();
jest.mock('../services/attention-tracker', () => ({
  getAttentionTracker: (): { mark: jest.Mock; clear: jest.Mock } => ({
    mark: markAttention,
    clear: jest.fn(),
  }),
}));

const entry = (
  over: Partial<UsageLimitedChatEntry> = {},
): UsageLimitedChatEntry => ({
  projectId: 'ws-a',
  worktreeId: 'wt-1',
  chatId: 'chat-1',
  provider: 'claude',
  detectedAt: 100,
  workspaceName: 'Workspace A',
  chatTitle: 'Chat 1',
  ...over,
});

const noSessions: ChatActiveSessions = { activeChatIds: [], sessions: [] };

describe('buildUsageLimitedChatGroups', () => {
  it('keeps only the requested provider', () => {
    const groups = buildUsageLimitedChatGroups(
      [entry(), entry({ chatId: 'c2', provider: 'codex' })],
      'claude',
      noSessions,
      () => true,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].chats.map((c) => c.chatId)).toEqual(['chat-1']);
  });

  it('preserves authentication as a distinct account-change resume reason', () => {
    const groups = buildUsageLimitedChatGroups(
      [entry({ resumeReason: 'authentication' })],
      'claude',
      noSessions,
      () => true,
    );

    expect(groups[0].chats[0].resumeReason).toBe('authentication');
  });

  it('uses the recorded workspaceType, defaulting to single-repo when absent', () => {
    const cowork = buildUsageLimitedChatGroups(
      [entry({ workspaceType: 'cowork' })],
      'claude',
      noSessions,
      () => true,
    );
    expect(cowork[0].workspaceType).toBe('cowork');

    const legacy = buildUsageLimitedChatGroups(
      [entry({ chatId: 'legacy' })],
      'claude',
      noSessions,
      () => true,
    );
    expect(legacy[0].workspaceType).toBe('single-repo');
  });

  it('drops chats whose live session turn is active (streaming)', () => {
    const sessions: ChatActiveSessions = {
      activeChatIds: ['chat-1'],
      sessions: [
        {
          chatId: 'chat-1',
          projectId: 'ws-a',
          worktreeId: 'wt-1',
          providerType: 'claude',
          turnActive: true,
          createdAt: 0,
          lastActivityAt: 0,
          turnCount: 1,
          pendingMessageCount: 0,
        },
      ],
    };
    const groups = buildUsageLimitedChatGroups(
      [entry()],
      'claude',
      sessions,
      () => true,
    );
    expect(groups).toEqual([]);
  });

  it('does not drop a matching chatId from a different project or worktree', () => {
    const sessions: ChatActiveSessions = {
      activeChatIds: ['chat-1'],
      sessions: [
        {
          chatId: 'chat-1',
          projectId: 'ws-other',
          worktreeId: 'wt-other',
          providerType: 'claude',
          turnActive: true,
          createdAt: 0,
          lastActivityAt: 0,
          turnCount: 1,
          pendingMessageCount: 0,
        },
      ],
    };
    const groups = buildUsageLimitedChatGroups(
      [entry()],
      'claude',
      sessions,
      () => true,
    );
    expect(groups[0].chats.map((c) => c.chatId)).toEqual(['chat-1']);
  });

  it('keeps idle sessions (turnActive false) and absent sessions', () => {
    const sessions: ChatActiveSessions = {
      activeChatIds: ['chat-1'],
      sessions: [
        {
          chatId: 'chat-1',
          projectId: 'ws-a',
          worktreeId: 'wt-1',
          providerType: 'claude',
          turnActive: false,
          createdAt: 0,
          lastActivityAt: 0,
          turnCount: 1,
          pendingMessageCount: 0,
        },
      ],
    };
    const groups = buildUsageLimitedChatGroups(
      [entry(), entry({ chatId: 'c2' })],
      'claude',
      sessions,
      () => true,
    );
    expect(groups[0].chats.map((c) => c.chatId).sort()).toEqual([
      'c2',
      'chat-1',
    ]);
  });

  it('excludes non-real (app-managed) project targets', () => {
    const groups = buildUsageLimitedChatGroups(
      [entry(), entry({ chatId: 'adv', projectId: 'app-advisor' })],
      'claude',
      noSessions,
      (t) => t.projectId !== 'app-advisor',
    );
    expect(groups.flatMap((g) => g.chats.map((c) => c.chatId))).toEqual([
      'chat-1',
    ]);
  });

  it('groups by project', () => {
    const groups = buildUsageLimitedChatGroups(
      [
        entry(),
        entry({
          chatId: 'c2',
          projectId: 'ws-b',
          worktreeId: 'home',
          workspaceName: 'B',
        }),
      ],
      'claude',
      noSessions,
      () => true,
    );
    expect(groups.map((g) => g.workspaceId).sort()).toEqual(['ws-a', 'ws-b']);
  });

  it('groups legacy standalone cowork entries by their real cowork project id', () => {
    const groups = buildUsageLimitedChatGroups(
      [
        entry({
          projectId: STANDALONE_CHAT_PROJECT_ID,
          worktreeId: 'cowork-a',
          workspaceType: 'cowork',
          workspaceName: 'Cowork A',
        }),
        entry({
          projectId: STANDALONE_CHAT_PROJECT_ID,
          worktreeId: 'cowork-b',
          chatId: 'chat-2',
          workspaceType: 'cowork',
          workspaceName: 'Cowork B',
        }),
      ],
      'claude',
      noSessions,
      () => true,
    );

    expect(groups.map((g) => g.workspaceId).sort()).toEqual([
      'cowork-a',
      'cowork-b',
    ]);
    expect(groups[0].chats[0]).toMatchObject({
      projectId: STANDALONE_CHAT_PROJECT_ID,
    });
  });

  it('groups legacy standalone cowork entries without workspaceType by their real cowork project id', () => {
    const groups = buildUsageLimitedChatGroups(
      [
        entry({
          projectId: STANDALONE_CHAT_PROJECT_ID,
          worktreeId: 'cowork-a',
          workspaceName: 'Cowork A',
        }),
        entry({
          projectId: STANDALONE_CHAT_PROJECT_ID,
          worktreeId: 'cowork-b',
          chatId: 'chat-2',
          workspaceName: 'Cowork B',
        }),
      ],
      'claude',
      noSessions,
      () => true,
    );

    expect(groups.map((g) => g.workspaceId).sort()).toEqual([
      'cowork-a',
      'cowork-b',
    ]);
    expect(groups.map((g) => g.workspaceType)).toEqual(['cowork', 'cowork']);
  });
});

interface WrittenUsageLimitedChatsFile {
  version: unknown;
  entries: unknown[];
}

function parseWrittenPayload(
  callArgs: unknown[],
): WrittenUsageLimitedChatsFile {
  const payload = callArgs[1];
  if (typeof payload !== 'string') {
    throw new Error('expected a string write payload');
  }
  const parsed: unknown = JSON.parse(payload);
  if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
    throw new Error('unexpected written file shape');
  }
  return { version: parsed.version, entries: parsed.entries };
}

describe('registry persistence', () => {
  const mockRead = jest.mocked(readFile);
  const mockWrite = jest.mocked(writeFile);
  const mockMkdir = jest.mocked(mkdir);
  beforeEach(() => {
    jest.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('persists suppression before queue dismissal and leaves newer interruptions eligible', async () => {
    const { suppressDismissedAccountProxyRecovery, readUsageLimitedChats } =
      await import('../lib/usage-limited-chats-registry');
    const stopped: ResumeQueueEntry = {
      id: 'resume',
      target: {
        kind: 'chat',
        projectId: 'ws-a',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
      },
      accountProxyConnectionId: 'proxy',
      interruptionId: '100',
      title: 'Chat',
      workspaceName: 'Workspace',
      createdAt: 100,
      status: 'stopped',
      providers: ['claude'],
    };
    mockRead.mockResolvedValue(
      JSON.stringify({
        version: 1,
        entries: [entry({ accountProxyConnectionId: 'proxy' })],
      }),
    );
    await suppressDismissedAccountProxyRecovery([stopped]);
    const saved = jest.mocked(writeFileAtomically).mock.calls.at(-1);
    if (!saved) throw new Error('Expected suppression to be saved');
    const written = parseWrittenPayload(saved);
    expect(written.entries[0]).toMatchObject({
      accountProxyAutoResumeSuppressed: true,
    });
    mockRead.mockResolvedValue(JSON.stringify(written));
    expect(await readUsageLimitedChats()).toEqual([
      expect.objectContaining({ accountProxyAutoResumeSuppressed: true }),
    ]);
    mockRead.mockResolvedValue(
      JSON.stringify({
        version: 1,
        entries: [
          entry({ accountProxyConnectionId: 'proxy', detectedAt: 200 }),
        ],
      }),
    );
    await suppressDismissedAccountProxyRecovery([stopped]);
    const newer = jest.mocked(writeFileAtomically).mock.calls.at(-1);
    if (!newer) throw new Error('Expected registry to be saved');
    expect(parseWrittenPayload(newer).entries[0]).not.toHaveProperty(
      'accountProxyAutoResumeSuppressed',
    );
  });

  it('normalizes legacy entries to usage limits and preserves auth reasons', async () => {
    mockRead.mockResolvedValue(
      JSON.stringify({
        version: 1,
        entries: [
          entry({ chatId: 'legacy' }),
          entry({ chatId: 'proxy', accountProxyConnectionId: 'proxy-id' }),
          entry({ chatId: 'auth', resumeReason: 'authentication' }),
          entry({
            chatId: 'shutdown',
            provider: 'ollama',
            resumeReason: 'app_shutdown',
          }),
        ],
      }),
    );
    const { readUsageLimitedChats } =
      await import('../lib/usage-limited-chats-registry');

    await expect(readUsageLimitedChats()).resolves.toEqual([
      expect.objectContaining({
        chatId: 'legacy',
        resumeReason: 'usage_limit',
      }),
      expect.objectContaining({
        chatId: 'proxy',
        accountProxyConnectionId: 'proxy-id',
      }),
      expect.objectContaining({
        chatId: 'auth',
        resumeReason: 'authentication',
      }),
      expect.objectContaining({
        chatId: 'shutdown',
        provider: 'ollama',
        resumeReason: 'app_shutdown',
      }),
    ]);
  });

  it('preserves a new interruption recorded after resume dispatch started', async () => {
    mockRead.mockResolvedValue(
      JSON.stringify({ version: 1, entries: [entry({ detectedAt: 200 })] }),
    );
    const { clearUsageLimitedChat } =
      await import('../lib/usage-limited-chats-registry');
    await clearUsageLimitedChat(
      { projectId: 'ws-a', worktreeId: 'wt-1', chatId: 'chat-1' },
      { onlyIfDetectedBefore: 150 },
    );
    expect(parseWrittenPayload(mockWrite.mock.calls[0]).entries).toEqual([
      entry({ detectedAt: 200, resumeReason: 'usage_limit' }),
    ]);
  });

  it('clears only the interruption proven resumed during crash recovery', async () => {
    mockRead.mockResolvedValue(
      JSON.stringify({ version: 1, entries: [entry({ detectedAt: 200 })] }),
    );
    const { clearUsageLimitedChat } =
      await import('../lib/usage-limited-chats-registry');
    await clearUsageLimitedChat(
      { projectId: 'ws-a', worktreeId: 'wt-1', chatId: 'chat-1' },
      { onlyIfDetectedAt: 100 },
    );
    expect(parseWrittenPayload(mockWrite.mock.calls[0]).entries).toEqual([
      entry({ detectedAt: 200, resumeReason: 'usage_limit' }),
    ]);
  });

  it('upserts then clears by target', async () => {
    mockRead.mockRejectedValue(new Error('missing'));
    const { recordUsageLimitedChat, clearUsageLimitedChat } =
      await import('../lib/usage-limited-chats-registry');
    await recordUsageLimitedChat(entry());
    const firstWrite = parseWrittenPayload(mockWrite.mock.calls[0]);
    expect(firstWrite.entries).toHaveLength(1);
    // Next read returns what we just wrote.
    mockRead.mockResolvedValue(JSON.stringify(firstWrite));
    await clearUsageLimitedChat({
      projectId: 'ws-a',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
    });
    const secondWrite = parseWrittenPayload(mockWrite.mock.calls[1]);
    expect(secondWrite.entries).toEqual([]);
  });

  // CAN: resuming a usage-limited chat clears its registry entry AFTER the
  // resume prompt is dispatched. When the resumed turn immediately re-hits the
  // usage limit, its fresh record lands BEFORE that clear -- and an
  // unconditional clear silently deletes it, so the chat disappears from
  // "Resume interrupted sessions" with no way back to it. The clear must
  // therefore never remove a record detected at or after the resume began.
  it('preserves a record detected after the resume began', async () => {
    mockRead.mockResolvedValue(
      JSON.stringify({
        version: 1,
        entries: [entry({ detectedAt: 5_000 })],
      }),
    );
    const { clearUsageLimitedChat } =
      await import('../lib/usage-limited-chats-registry');
    await clearUsageLimitedChat(
      { projectId: 'ws-a', worktreeId: 'wt-1', chatId: 'chat-1' },
      { onlyIfDetectedBefore: 4_000 },
    );
    const written = parseWrittenPayload(mockWrite.mock.calls[0]);
    expect(written.entries).toHaveLength(1);
    expect(written.entries[0]).toEqual(
      expect.objectContaining({ chatId: 'chat-1', detectedAt: 5_000 }),
    );
  });

  it('still clears a record detected before the resume began', async () => {
    mockRead.mockResolvedValue(
      JSON.stringify({
        version: 1,
        entries: [entry({ detectedAt: 3_000 })],
      }),
    );
    const { clearUsageLimitedChat } =
      await import('../lib/usage-limited-chats-registry');
    await clearUsageLimitedChat(
      { projectId: 'ws-a', worktreeId: 'wt-1', chatId: 'chat-1' },
      { onlyIfDetectedBefore: 4_000 },
    );
    const written = parseWrittenPayload(mockWrite.mock.calls[0]);
    expect(written.entries).toEqual([]);
  });

  // The `blocked` attention detail the desktop records here is dropped
  // verbatim into the server-composed push body (`<branch> · <detail>`), so it
  // has to be copy rather than a machine value — and it must never be able to
  // reject the recording path it rides on.
  // The clock is pinned rather than derived from `new Date()`: the label drops
  // the weekday only when the reset lands on the same calendar day, so a test
  // that adds an hour to "now" silently swaps branches during the 23:00 hour
  // and fails on whichever one it did not expect.
  it.each([
    {
      when: 'later the same day',
      now: '2026-09-21T13:00:00',
      resets: '2026-09-21T14:30:00',
      weekday: false,
    },
    {
      when: 'after midnight',
      now: '2026-09-21T23:30:00',
      resets: '2026-09-22T00:30:00',
      weekday: true,
    },
  ])(
    'records a readable reset time as the attention detail ($when)',
    async ({ now, resets, weekday }) => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      jest.setSystemTime(new Date(now));
      try {
        mockRead.mockRejectedValue(new Error('missing'));
        const { recordUsageLimitedChat } =
          await import('../lib/usage-limited-chats-registry');

        const resetsAt = new Date(resets);
        await recordUsageLimitedChat(entry({ resetsAt: resetsAt.getTime() }));

        const marked = markAttention.mock.calls[0]?.[0];
        const detail: string | undefined = marked?.detail;
        expect(typeof detail).toBe('string');
        // Copy, never a machine value: this rides into a push body verbatim.
        expect(detail).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
        // Formatted through the same Intl call rather than a literal, so the
        // assertion pins the branch rather than the runner's locale.
        expect(detail).toBe(
          `resets ${
            weekday
              ? resetsAt.toLocaleString([], {
                  weekday: 'short',
                  hour: 'numeric',
                  minute: '2-digit',
                })
              : resetsAt.toLocaleTimeString([], {
                  hour: 'numeric',
                  minute: '2-digit',
                })
          }`,
        );
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('omits the attention detail rather than throwing on an unusable reset time', async () => {
    mockRead.mockRejectedValue(new Error('missing'));
    const { recordUsageLimitedChat } =
      await import('../lib/usage-limited-chats-registry');

    await expect(
      recordUsageLimitedChat(entry({ resetsAt: Number.NaN })),
    ).resolves.toBeUndefined();
    expect(markAttention).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'blocked', reason: 'usage_limit' }),
    );
    const marked: { detail?: string } | undefined =
      markAttention.mock.calls[0]?.[0];
    expect(marked).not.toHaveProperty('detail');
  });

  it('self-heals after a failed write so later writes still persist', async () => {
    mockRead.mockResolvedValue(JSON.stringify({ version: 1, entries: [] }));
    mockWrite.mockRejectedValueOnce(new Error('disk full'));
    const { recordUsageLimitedChat } =
      await import('../lib/usage-limited-chats-registry');

    // The failed write must not reject the caller's promise.
    await expect(recordUsageLimitedChat(entry())).resolves.toBeUndefined();
    expect(mockWrite).toHaveBeenCalledTimes(1);

    // A later write must still go through instead of being skipped because
    // the chain was poisoned by the earlier failure.
    mockWrite.mockResolvedValueOnce(undefined);
    await expect(
      recordUsageLimitedChat(entry({ chatId: 'chat-2' })),
    ).resolves.toBeUndefined();

    expect(mockWrite).toHaveBeenCalledTimes(2);
    const secondWrite = parseWrittenPayload(mockWrite.mock.calls[1]);
    expect(secondWrite.entries).toContainEqual(
      expect.objectContaining({ chatId: 'chat-2' }),
    );
  });
});

describe('shutdown registry writes', () => {
  it('round-trips interrupted Cursor sessions through shutdown and startup reads', async () => {
    const { recordInterruptedChats, readUsageLimitedChats } =
      await import('../lib/usage-limited-chats-registry');
    jest.mocked(readFile).mockResolvedValue(JSON.stringify({ entries: [] }));
    const interrupted = entry({
      provider: 'cursor',
      resumeReason: 'app_shutdown',
    });
    await recordInterruptedChats([interrupted]);
    const writes = jest.mocked(writeFileAtomically).mock.calls;
    const written = writes[writes.length - 1];
    if (!written || typeof written[1] !== 'string')
      throw new Error('No shutdown snapshot');
    jest.mocked(readFile).mockResolvedValue(written[1]);
    await expect(readUsageLimitedChats(true)).resolves.toEqual([interrupted]);
  });

  it('preserves usage blockers, atomically adds interrupted chats, and reports persistence failures', async () => {
    const { recordInterruptedChats } =
      await import('../lib/usage-limited-chats-registry');
    jest
      .mocked(readFile)
      .mockResolvedValue(JSON.stringify({ entries: [entry()] }));
    const added = entry({ chatId: 'shutdown', resumeReason: 'app_shutdown' });
    await recordInterruptedChats([
      entry({ resumeReason: 'app_shutdown' }),
      added,
    ]);
    const calls = jest.mocked(writeFileAtomically).mock.calls;
    const args = calls[calls.length - 1];
    if (!args) throw new Error('No atomic write');
    const saved = JSON.parse(String(args[1])) as {
      entries: UsageLimitedChatEntry[];
    };
    expect(saved.entries).toEqual([
      expect.objectContaining({
        chatId: 'chat-1',
        resumeReason: 'usage_limit',
      }),
      added,
    ]);
    jest
      .mocked(writeFileAtomically)
      .mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(recordInterruptedChats([added])).rejects.toThrow(
      'disk unavailable',
    );
  });

  it('upgrades an existing usage blocker to the authentication recovery attempt', async () => {
    const { recordInterruptedChats } =
      await import('../lib/usage-limited-chats-registry');
    jest
      .mocked(readFile)
      .mockResolvedValue(
        JSON.stringify({ entries: [entry({ resumeReason: 'usage_limit' })] }),
      );
    const interrupted = entry({
      resumeReason: 'provider_sign_in',
      authenticationAttemptId: 'attempt-1',
    });
    await recordInterruptedChats([interrupted]);
    const calls = jest.mocked(writeFileAtomically).mock.calls;
    const saved: unknown = JSON.parse(String(calls[calls.length - 1]?.[1]));
    expect(saved).toEqual({ version: 1, entries: [interrupted] });
  });
});

describe('Codex authentication recovery grants', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(mkdir).mockResolvedValue(undefined);
  });

  it('persists a bounded account fingerprint grant and matches only that account', async () => {
    jest
      .mocked(readFile)
      .mockRejectedValueOnce(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );
    const { recordCodexAuthenticationGrant, hasCodexAuthenticationGrant } =
      await import('../lib/usage-limited-chats-registry');

    await recordCodexAuthenticationGrant('attempt-1', 'fingerprint-1');
    const call = jest.mocked(writeFileAtomically).mock.calls.at(-1);
    if (!call || typeof call[1] !== 'string') throw new Error('No grant write');
    jest.mocked(readFile).mockResolvedValue(call[1]);

    await expect(
      hasCodexAuthenticationGrant('attempt-1', 'fingerprint-1'),
    ).resolves.toBe(true);
    await expect(
      hasCodexAuthenticationGrant('attempt-1', 'fingerprint-2'),
    ).resolves.toBe(false);
  });

  it('revokes a saved grant before a cancelled attempt can resume', async () => {
    jest
      .mocked(readFile)
      .mockRejectedValueOnce(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );
    const {
      recordCodexAuthenticationGrant,
      revokeCodexAuthenticationGrant,
      hasCodexAuthenticationGrant,
    } = await import('../lib/usage-limited-chats-registry');
    await recordCodexAuthenticationGrant('cancelled', 'fingerprint');
    const saved = jest.mocked(writeFileAtomically).mock.calls.at(-1);
    if (!saved || typeof saved[1] !== 'string')
      throw new Error('No grant write');
    jest.mocked(readFile).mockResolvedValue(saved[1]);
    await revokeCodexAuthenticationGrant('cancelled');
    const revoked = jest.mocked(writeFileAtomically).mock.calls.at(-1);
    if (!revoked || typeof revoked[1] !== 'string')
      throw new Error('No revocation write');
    jest.mocked(readFile).mockResolvedValue(revoked[1]);
    await expect(
      hasCodexAuthenticationGrant('cancelled', 'fingerprint'),
    ).resolves.toBe(false);
  });

  it('persists resume claims until cleanup and rejects a duplicate after restart', async () => {
    jest
      .mocked(readFile)
      .mockRejectedValueOnce(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );
    const {
      claimCodexAuthenticationResume,
      clearCodexAuthenticationResumeClaim,
    } = await import('../lib/usage-limited-chats-registry');

    await expect(
      claimCodexAuthenticationResume('attempt-1/chat-1'),
    ).resolves.toBe(true);
    const claimedWrite = jest.mocked(writeFileAtomically).mock.calls.at(-1);
    if (!claimedWrite || typeof claimedWrite[1] !== 'string')
      throw new Error('No resume claim write');
    jest.mocked(readFile).mockResolvedValue(claimedWrite[1]);

    await expect(
      claimCodexAuthenticationResume('attempt-1/chat-1'),
    ).resolves.toBe(false);
    await clearCodexAuthenticationResumeClaim('attempt-1/chat-1');
    const clearedWrite = jest.mocked(writeFileAtomically).mock.calls.at(-1);
    if (!clearedWrite || typeof clearedWrite[1] !== 'string')
      throw new Error('No resume claim cleanup write');
    expect(JSON.parse(clearedWrite[1])).toEqual({ version: 1, claims: [] });
  });
});
