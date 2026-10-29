const mockUnsubscribe = jest.fn();
const mockForkThread = jest.fn();

jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: jest.fn(() => ({
    forkThread: mockForkThread,
  })),
}));

jest.mock('../lib/user-environment-runtime', () => ({
  resolveCodexRuntimeEnvironmentProfile: jest.fn(() => ({
    environment: { WORKSPACE_ENV: 'enabled' },
    logicalWorkspaceEnvironmentId: 'agent:workspace-environment',
    secretVersionFingerprint: 'secret-version',
  })),
}));

import type { AgentModelConfig } from '@canopy/desktop-shared/types';
import {
  forkCodexThreadByIdViaOneShot,
  waitForPendingCodexFork,
} from '../codex/fork-thread';

describe('forkCodexThreadByIdViaOneShot', () => {
  it('shares one in-progress native fork for the same destination', async () => {
    let finish:
      | ((value: {
          threadId: string;
          unsubscribe: typeof mockUnsubscribe;
        }) => void)
      | undefined;
    mockForkThread.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const opts = {
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'forked-chat',
      sourceThreadId: 'thread-source',
    };
    const first = forkCodexThreadByIdViaOneShot(opts);
    const second = forkCodexThreadByIdViaOneShot(opts);
    const count = mockForkThread.mock.calls.length;
    finish?.({ threadId: 'thread-forked', unsubscribe: mockUnsubscribe });
    expect(count).toBe(1);
    await expect(Promise.all([first, second])).resolves.toEqual([
      'thread-forked',
      'thread-forked',
    ]);
  });

  it('keeps the completed fork available until canonical persistence finishes', async () => {
    let finishPersistence: (() => void) | undefined;
    const persistence = new Promise<void>((resolve) => {
      finishPersistence = resolve;
    });
    const opts = {
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'persisting-fork',
      sourceThreadId: 'thread-source',
      onForked: jest.fn(() => persistence),
    };

    const fork = forkCodexThreadByIdViaOneShot(opts);
    await new Promise((resolve) => setImmediate(resolve));
    const wait = waitForPendingCodexFork(opts, new AbortController().signal);

    await Promise.resolve();
    expect(opts.onForked).toHaveBeenCalledWith('thread-forked');
    await expect(
      Promise.race([fork.then(() => 'done'), Promise.resolve('pending')]),
    ).resolves.toBe('pending');
    await expect(
      Promise.race([wait.then(() => 'done'), Promise.resolve('pending')]),
    ).resolves.toBe('pending');
    finishPersistence?.();
    await expect(wait).resolves.toBe('thread-forked');
    await expect(fork).resolves.toBe('thread-forked');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockUnsubscribe.mockResolvedValue(undefined);
    mockForkThread.mockResolvedValue({
      threadId: 'thread-forked',
      unsubscribe: mockUnsubscribe,
    });
  });

  it('lets a cancelled sender detach while another sender receives the fork', async () => {
    let finish:
      | ((value: {
          threadId: string;
          unsubscribe: typeof mockUnsubscribe;
        }) => void)
      | undefined;
    mockForkThread.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const opts = {
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'cancelled-wait',
      sourceThreadId: 'source',
    };
    const fork = forkCodexThreadByIdViaOneShot(opts);
    const cancelled = new AbortController();
    const wait = waitForPendingCodexFork(opts, cancelled.signal);
    const other = waitForPendingCodexFork(opts, new AbortController().signal);
    cancelled.abort();
    await expect(wait).rejects.toThrow('cancelled');
    finish?.({ threadId: 'native-fork', unsubscribe: mockUnsubscribe });
    await expect(other).resolves.toBe('native-fork');
    await fork;
    expect(mockForkThread).toHaveBeenCalledTimes(1);
    await expect(
      waitForPendingCodexFork(opts, new AbortController().signal),
    ).resolves.toBeUndefined();
  });

  it('clears a failed fork so a retry can create native history', async () => {
    const opts = {
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'retry-fork',
      sourceThreadId: 'source',
    };
    mockForkThread.mockRejectedValueOnce(new Error('fork unavailable'));
    await expect(forkCodexThreadByIdViaOneShot(opts)).rejects.toThrow(
      'fork unavailable',
    );
    await expect(
      waitForPendingCodexFork(opts, new AbortController().signal),
    ).resolves.toBeUndefined();
    await expect(forkCodexThreadByIdViaOneShot(opts)).resolves.toBe(
      'thread-forked',
    );
  });

  it('forks canonical state through the host-owned runtime service', async () => {
    await expect(
      forkCodexThreadByIdViaOneShot({
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'forked-chat',
        sourceThreadId: 'thread-source',
        codexMultiAgentEnabled: false,
        codexMaxConcurrentSubagents: 2,
      }),
    ).resolves.toBe('thread-forked');

    expect(mockForkThread).toHaveBeenCalledWith({
      params: {
        threadId: 'thread-source',
        cwd: '/tmp/repo',
        config: {
          project_doc_max_bytes: 131_072,
          project_doc_fallback_filenames: ['CLAUDE.md'],
          'features.multi_agent': false,
          'features.multi_agent_v2': false,
          'agents.enabled': false,
          'agents.max_concurrent_threads_per_session': 2,
        },
      },
      capabilitySnapshotId: 'legacy-canonical',
      profile: {
        environment: { WORKSPACE_ENV: 'enabled' },
        logicalWorkspaceEnvironmentId: 'agent:workspace-environment',
        secretVersionFingerprint: 'secret-version',
      },
    });
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ speed: 'fast', fastMode: true }, 'priority'],
    [{ speed: 'standard', fastMode: false }, 'default'],
    // Fork is metadata-only: Ultra fast is kept as the chat's requested speed
    // but the thread gets an explicit default until an admitted turn.
    [{ speed: 'ultrafast', fastMode: false }, 'default'],
  ] satisfies Array<[AgentModelConfig, string]>)(
    'sends an explicit lifecycle service tier for %j',
    async (modelConfig, serviceTier) => {
      await expect(
        forkCodexThreadByIdViaOneShot({
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: `tier-fork-${serviceTier}-${modelConfig.speed}`,
          sourceThreadId: 'thread-source',
          modelConfig,
        }),
      ).resolves.toBe('thread-forked');
      const lastCall: unknown = mockForkThread.mock.lastCall;
      expect(lastCall).toMatchObject([{ params: { serviceTier } }]);
    },
  );

  it('keeps inheriting the source tier when no speed was supplied', async () => {
    await forkCodexThreadByIdViaOneShot({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'no-speed-fork',
      sourceThreadId: 'thread-source',
    });
    const lastCall: unknown = mockForkThread.mock.lastCall;
    expect(lastCall).toHaveProperty('0.params.threadId', 'thread-source');
    expect(lastCall).not.toHaveProperty('0.params.serviceTier');
  });

  it('reads the legacy Fast alias after a thinking-only model config', async () => {
    await forkCodexThreadByIdViaOneShot({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'legacy-fast-fork',
      sourceThreadId: 'thread-source',
      modelConfig: { thinkingLevel: 'medium' },
      codexFastModeEnabled: true,
    });
    const lastCall: unknown = mockForkThread.mock.lastCall;
    expect(lastCall).toMatchObject([{ params: { serviceTier: 'priority' } }]);
  });
});
