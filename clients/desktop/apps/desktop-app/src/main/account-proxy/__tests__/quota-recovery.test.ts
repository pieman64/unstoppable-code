import type {
  ResumeQueueItem,
  UsageLimitedChatEntry,
  ResumeQueueSnapshot,
} from '@canopy/desktop-shared/types';
import type {
  AccountProxyAccount,
  AccountProxyStatus,
} from '@canopy/desktop-shared/types/account-proxy';
import { ResumeQueueService } from '../../services/resume-queue-service';
import {
  AccountProxyQuotaRecovery,
  canResumeAccountProxyChat,
} from '../quota-recovery';

const interruption: UsageLimitedChatEntry = {
  projectId: 'workspace',
  worktreeId: 'worktree',
  chatId: 'chat',
  provider: 'codex',
  detectedAt: 1000,
  resumeReason: 'usage_limit',
  accountProxyConnectionId: 'proxy',
  workspaceName: 'Workspace',
  chatTitle: 'Chat',
};
const account: AccountProxyAccount = {
  authIndex: 'a',
  provider: 'codex',
  label: 'Account',
  source: 'sign-in',
  fileName: 'a.json',
  planType: null,
  status: 'active',
  statusMessage: null,
  availableAt: null,
  limits: [],
};
function status(
  overrides: Partial<AccountProxyStatus> = {},
): AccountProxyStatus {
  return {
    available: true,
    connection: { id: 'proxy', kind: 'server', url: 'https://proxy.example' },
    state: 'connected',
    error: null,
    version: '8.0.27',
    accounts: [account],
    routing: null,
    routeClaude: true,
    routeCodex: true,
    keepChatOnOneAccount: true,
    refreshedAt: 2000,
    local: {
      phase: 'not-installed',
      version: null,
      install: null,
      port: null,
      startWithApp: true,
      message: null,
    },
    signIn: null,
    ...overrides,
  };
}
function item(entry = interruption): ResumeQueueItem {
  return {
    target: {
      kind: 'chat',
      projectId: entry.projectId,
      worktreeId: entry.worktreeId,
      chatId: entry.chatId,
    },
    accountProxyConnectionId: entry.accountProxyConnectionId,
    providers: [entry.provider],
    title: entry.chatTitle,
    workspaceName: entry.workspaceName,
    interruptionId: String(entry.detectedAt),
  };
}
interface RecoveryFixture {
  queue: ResumeQueueService;
  recovery: AccountProxyQuotaRecovery;
  readInterrupted: jest.Mock<Promise<UsageLimitedChatEntry[]>, []>;
  readStatus: jest.Mock<Promise<AccountProxyStatus>, []>;
  resolveItems: jest.Mock<
    Promise<ResumeQueueItem[]>,
    [UsageLimitedChatEntry[]]
  >;
  dispatch: jest.Mock<Promise<'resumed'>, [ResumeQueueItem]>;
  advance: (ms?: number) => void;
}
function fixture(): RecoveryFixture {
  let now = 2000;
  const dispatch = jest
    .fn<Promise<'resumed'>, [ResumeQueueItem]>()
    .mockResolvedValue('resumed');
  const queue = new ResumeQueueService({
    load: (): Promise<ResumeQueueSnapshot | null> => Promise.resolve(null),
    save: (): Promise<void> => Promise.resolve(),
    now: (): number => now,
    dispatch,
    reconcile: (): Promise<{ status: 'waiting' }> =>
      Promise.resolve({ status: 'waiting' }),
    changed: (): void => undefined,
  });
  const readInterrupted = jest
    .fn<Promise<UsageLimitedChatEntry[]>, []>()
    .mockResolvedValue([interruption]);
  const readStatus = jest.fn(() =>
    Promise.resolve(status({ refreshedAt: now })),
  );
  const resolveItems = jest.fn((entries: UsageLimitedChatEntry[]) =>
    Promise.resolve(entries.map(item)),
  );
  const recovery = new AccountProxyQuotaRecovery({
    now: (): number => now,
    readInterrupted,
    readStatus,
    resolveItems,
  });
  return {
    queue,
    recovery,
    readInterrupted,
    readStatus,
    resolveItems,
    dispatch,
    advance: (ms = 5000): void => {
      now += ms;
    },
  };
}

describe('proxy quota recovery', () => {
  it.each(['server', 'local'] as const)(
    'recovers through the same %s connection after adding an account',
    async (kind) => {
      const f = fixture();
      f.readStatus.mockResolvedValue(
        status({
          connection: { id: 'proxy', kind, url: 'http://localhost:8317' },
          accounts: [{ ...account, status: 'cooling' }],
        }),
      );
      await f.recovery.collect(f.queue);
      expect(f.queue.snapshot().entries).toHaveLength(0);
      f.advance();
      f.readStatus.mockResolvedValue(
        status({
          connection: { id: 'proxy', kind, url: 'http://localhost:8317' },
          accounts: [
            { ...account, status: 'cooling' },
            { ...account, authIndex: 'new' },
          ],
          refreshedAt: 7000,
        }),
      );
      await f.recovery.collect(f.queue);
      await f.queue.tick();
      expect(f.dispatch).toHaveBeenCalledTimes(1);
      expect(f.dispatch.mock.calls[0][0]).toMatchObject({
        accountProxyConnectionId: 'proxy',
      });
    },
  );

  it('keeps a dismissed automatic attempt suppressed after its queue history is gone', async () => {
    const f = fixture();
    f.readInterrupted.mockResolvedValue([
      { ...interruption, accountProxyAutoResumeSuppressed: true },
    ]);
    await f.recovery.collect(f.queue);
    expect(f.readStatus).not.toHaveBeenCalled();
    expect(f.queue.snapshot().entries).toHaveLength(0);
  });

  it('does not contact the proxy for native limits or while idle', async () => {
    const f = fixture();
    f.readInterrupted.mockResolvedValue([
      { ...interruption, accountProxyConnectionId: undefined },
    ]);
    await f.recovery.collect(f.queue);
    expect(f.readStatus).not.toHaveBeenCalled();
    f.advance(500);
    await f.recovery.collect(f.queue);
    expect(f.readInterrupted).toHaveBeenCalledTimes(1);
  });

  it('uses a short cache at a known reset and still requires refreshed server availability', async () => {
    const f = fixture();
    f.readInterrupted.mockResolvedValue([{ ...interruption, resetsAt: 2000 }]);
    f.readStatus.mockResolvedValue(
      status({
        refreshedAt: 1500,
        accounts: [{ ...account, status: 'cooling' }],
      }),
    );
    await f.recovery.collect(f.queue);
    expect(f.readStatus).toHaveBeenLastCalledWith({
      refresh: true,
      maxAgeMs: 5000,
    });
    expect(f.queue.snapshot().entries).toHaveLength(0);
    f.advance();
    f.readStatus.mockResolvedValue(status({ refreshedAt: 7000 }));
    await f.recovery.collect(f.queue);
    expect(f.queue.snapshot().entries).toHaveLength(1);
  });

  it('enrolls an interruption once and preserves Stop across later scans and restarts', async () => {
    const f = fixture();
    await f.recovery.collect(f.queue);
    f.advance();
    await f.recovery.collect(f.queue);
    expect(f.queue.snapshot().entries).toHaveLength(1);
    await f.queue.control('stop');
    await f.queue.control('resume');
    f.readStatus.mockClear();
    f.advance();
    await f.recovery.collect(f.queue);
    expect(f.readStatus).not.toHaveBeenCalled();
    const restarted = new AccountProxyQuotaRecovery({
      now: (): number => 20000,
      readInterrupted: f.readInterrupted,
      readStatus: f.readStatus,
      resolveItems: f.resolveItems,
    });
    await restarted.collect(f.queue);
    expect(f.queue.snapshot().entries[0].status).toBe('stopped');
    expect(f.readStatus).not.toHaveBeenCalled();
  });

  it('does not enroll a different interruption found during live target resolution', async () => {
    const f = fixture();
    f.resolveItems.mockResolvedValue([{ ...item(), interruptionId: '9999' }]);
    await f.recovery.collect(f.queue);
    expect(f.queue.snapshot().entries).toHaveLength(0);
  });

  it('does not enqueue when Pause arrives during an availability read', async () => {
    const f = fixture();
    f.readStatus.mockImplementation(async () => {
      await f.queue.control('pause');
      return status();
    });
    await f.recovery.collect(f.queue);
    expect(f.queue.snapshot().entries).toHaveLength(0);
  });

  it.each(['availability', 'target resolution'] as const)(
    'does not re-enroll stopped and dismissed work during %s',
    async (phase) => {
      const f = fixture();
      const stopAndDismiss = async (): Promise<void> => {
        await f.queue.control('stop');
        await f.queue.control('dismiss');
      };
      if (phase === 'availability') {
        await f.queue.enqueue([item()]);
        f.readStatus.mockImplementationOnce(async () => {
          await stopAndDismiss();
          return status();
        });
      } else {
        f.resolveItems.mockImplementationOnce(async (entries) => {
          await f.queue.enqueue([item()]);
          await stopAndDismiss();
          return entries.map(item);
        });
      }
      await f.recovery.collect(f.queue);
      expect(f.queue.snapshot().entries).toHaveLength(0);
      expect(f.queue.snapshot().suppressedAutomaticResumes).toHaveLength(1);
      await f.queue.tick();
      expect(f.dispatch).not.toHaveBeenCalled();
    },
  );

  it.each([
    status({
      connection: {
        id: 'another',
        kind: 'server',
        url: 'https://other.example',
      },
    }),
    status({ routeCodex: false }),
    status({ available: false }),
    status({ refreshedAt: 999 }),
    status({
      state: 'error',
      error: { code: 'unreachable', message: 'unreachable' },
    }),
    status({ accounts: [{ ...account, provider: 'claude' }] }),
    status({ accounts: [{ ...account, status: 'disabled' }] }),
    status({
      accounts: [
        {
          ...account,
          status: 'cooling',
          availableAt: 3000,
          limits: [{ id: 'weekly', usedPercent: 100, resetsAt: 3000 }],
        },
      ],
    }),
  ])(
    'waits when recovery cannot use the original billing route %#',
    (snapshot) => {
      expect(canResumeAccountProxyChat(interruption, snapshot, 2000)).toBe(
        false,
      );
    },
  );

  it('probes a quota error with no active cooldown to discover an external reset', () => {
    expect(
      canResumeAccountProxyChat(
        interruption,
        status({
          accounts: [
            {
              ...account,
              status: 'error',
              statusMessage: 'Quota exceeded',
              limits: [{ id: 'weekly', usedPercent: 100, resetsAt: 99999 }],
            },
          ],
        }),
        2000,
      ),
    ).toBe(true);
    expect(
      canResumeAccountProxyChat(
        interruption,
        status({
          accounts: [
            {
              ...account,
              status: 'error',
              statusMessage: '429 authentication invalid credentials',
            },
          ],
        }),
        2000,
      ),
    ).toBe(false);
  });

  it('allows stale passive usage counters after a confirmed reset', () => {
    expect(
      canResumeAccountProxyChat(
        interruption,
        status({
          accounts: [
            {
              ...account,
              limits: [{ id: 'five-hour', usedPercent: 100, resetsAt: 1500 }],
            },
          ],
        }),
        2000,
      ),
    ).toBe(true);
  });
});
