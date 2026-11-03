import type * as ScriptExecutionDouble from './helpers/script-execution-double';
import {
  STANDALONE_CHAT_PROJECT_ID,
  type WorkspaceType,
} from '@canopy/desktop-shared/types';

let workspaceType: WorkspaceType | null = null;

jest.mock('../lib/script-execution', () =>
  jest.requireActual<typeof ScriptExecutionDouble>(
    './helpers/script-execution-double',
  ),
);
jest.mock('../lib/workspace-registry', () => ({
  getWorkspaceType: jest.fn(() => workspaceType),
  isCoworkWorkspace: jest.fn((id: string) => id === STANDALONE_CHAT_PROJECT_ID),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(),
}));
jest.mock('../lib/script-log-store', () => ({
  readScriptRunLogTail: jest.fn(),
}));

import { readScriptRunLogTail } from '../lib/script-log-store';
import { readWorkspaceConfig } from '../lib/workspace-persistence';
import { loadScriptOutputSnapshot } from '../mcp/script-output';

const mockedReadScriptRunLogTail = jest.mocked(readScriptRunLogTail);
const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);

describe('script-output resolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    workspaceType = null;
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [
        { id: 'api', name: 'API', repoPath: '/repos/api' },
        { id: 'web', name: 'Web', repoPath: '/repos/web' },
      ],
    });
    mockedReadScriptRunLogTail.mockResolvedValue({
      meta: {
        version: 1,
        runId: 'run-1',
        script: {
          scriptKey: 'project:launch',
          scriptName: 'launch',
          label: 'Launch',
          command: 'npm run dev',
          lifecycle: 'launch',
          target: 'project',
        },
        invocation: 'manual-run',
        status: 'success',
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:01.000Z',
        completedAt: '2026-01-01T00:00:01.000Z',
        exitCode: 0,
        timedOut: false,
        durationMs: 1000,
      },
      lines: ['hello'],
    });
  });

  it('resolves raw single-repo script names', async () => {
    const snapshot = await loadScriptOutputSnapshot({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      scriptId: 'launch',
    });

    expect(mockedReadScriptRunLogTail).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      scriptKey: 'project:launch',
      maxLines: 1000,
    });
    expect(snapshot.found).toBe(true);
    expect(snapshot.humanStatus).toBe('succeeded');
  });

  it('resolves raw colon-named single-repo scripts', async () => {
    await loadScriptOutputSnapshot({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      scriptId: 'lint:fix',
    });

    expect(mockedReadScriptRunLogTail).toHaveBeenCalledWith(
      expect.objectContaining({
        scriptKey: 'project:lint:fix',
      }),
    );
  });

  it('treats registered single-repo projects as single-repo lookups', async () => {
    workspaceType = 'single-repo';

    await loadScriptOutputSnapshot({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      scriptId: 'launch',
    });

    expect(mockedReadScriptRunLogTail).toHaveBeenCalledWith(
      expect.objectContaining({
        scriptKey: 'project:launch',
      }),
    );
  });

  it('resolves workspace-root scripts by default for before/after lifecycle names', async () => {
    workspaceType = 'multi-repo';
    mockedReadScriptRunLogTail.mockResolvedValueOnce({
      meta: {
        version: 1,
        runId: 'run-2',
        script: {
          scriptKey: 'workspace-root:before-setup',
          scriptName: 'before-setup',
          label: 'Workspace root - Before Setup',
          command: 'echo root',
          lifecycle: 'before-setup',
          target: 'workspace-root',
        },
        invocation: 'workspace-lifecycle',
        status: 'running',
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        exitCode: null,
        timedOut: false,
        durationMs: 0,
      },
      lines: ['root line'],
    });

    const snapshot = await loadScriptOutputSnapshot({
      projectId: 'workspace-1',
      worktreeId: 'wt-1',
      scriptId: 'before-setup',
    });

    expect(mockedReadScriptRunLogTail).toHaveBeenCalledWith(
      expect.objectContaining({
        scriptKey: 'workspace-root:before-setup',
      }),
    );
    expect(snapshot.humanStatus).toBe('running');
  });

  it('resolves project repo lookups by exact repo id', async () => {
    workspaceType = 'multi-repo';

    await loadScriptOutputSnapshot({
      projectId: 'workspace-1',
      worktreeId: 'wt-1',
      scriptId: 'launch',
      repo: 'api',
    });

    expect(mockedReadScriptRunLogTail).toHaveBeenCalledWith(
      expect.objectContaining({
        scriptKey: 'workspace-repo:api:launch',
      }),
    );
  });

  it('resolves project repo lookups by unique repo name', async () => {
    workspaceType = 'multi-repo';

    await loadScriptOutputSnapshot({
      projectId: 'workspace-1',
      worktreeId: 'wt-1',
      scriptId: 'launch',
      repo: 'API',
    });

    expect(mockedReadScriptRunLogTail).toHaveBeenCalledWith(
      expect.objectContaining({
        scriptKey: 'workspace-repo:api:launch',
      }),
    );
  });

  it('passes through canonical script keys', async () => {
    workspaceType = 'multi-repo';

    await loadScriptOutputSnapshot({
      projectId: 'workspace-1',
      worktreeId: 'wt-1',
      scriptId: 'workspace-repo:api:launch',
    });

    expect(mockedReadWorkspaceConfig).not.toHaveBeenCalled();
    expect(mockedReadScriptRunLogTail).toHaveBeenCalledWith(
      expect.objectContaining({
        scriptKey: 'workspace-repo:api:launch',
      }),
    );
  });

  it('passes through canonical script keys with colon-named scripts', async () => {
    await loadScriptOutputSnapshot({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      scriptId: 'project:lint:fix',
    });

    expect(mockedReadScriptRunLogTail).toHaveBeenCalledWith(
      expect.objectContaining({
        scriptKey: 'project:lint:fix',
      }),
    );
  });

  it('rejects ambiguous raw script names in multi-repo projects', async () => {
    workspaceType = 'multi-repo';

    const snapshot = await loadScriptOutputSnapshot({
      projectId: 'workspace-1',
      worktreeId: 'wt-1',
      scriptId: 'launch',
    });

    expect(snapshot.found).toBe(false);
    expect(snapshot.error).toContain('requires repo');
    expect(mockedReadScriptRunLogTail).not.toHaveBeenCalled();
  });

  it('rejects duplicate repo-name matches', async () => {
    workspaceType = 'multi-repo';
    mockedReadWorkspaceConfig.mockResolvedValueOnce({
      version: 1,
      type: 'multi-repo',
      repos: [
        { id: 'repo-id-1', name: 'API', repoPath: '/repos/api-1' },
        { id: 'repo-id-2', name: 'API', repoPath: '/repos/api-2' },
      ],
    });

    const snapshot = await loadScriptOutputSnapshot({
      projectId: 'workspace-1',
      worktreeId: 'wt-1',
      scriptId: 'launch',
      repo: 'API',
    });

    expect(snapshot.found).toBe(false);
    expect(snapshot.error).toContain('repo-id-1, repo-id-2');
  });

  it('returns a missing-run error when no persisted output exists', async () => {
    mockedReadScriptRunLogTail.mockResolvedValueOnce({
      meta: null,
      lines: [],
    });

    const snapshot = await loadScriptOutputSnapshot({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      scriptId: 'launch',
    });

    expect(snapshot.found).toBe(false);
    expect(snapshot.error).toContain('No persisted output found');
  });

  it('rejects standalone chats', async () => {
    const snapshot = await loadScriptOutputSnapshot({
      projectId: STANDALONE_CHAT_PROJECT_ID,
      worktreeId: 'chat-1',
      scriptId: 'launch',
    });

    expect(snapshot.found).toBe(false);
    expect(snapshot.error).toContain('only available for worktree chats');
  });

  it('maps timed out and stopped runs to human-readable status', async () => {
    mockedReadScriptRunLogTail
      .mockResolvedValueOnce({
        meta: {
          version: 1,
          runId: 'run-timeout',
          script: {
            scriptKey: 'project:launch',
            scriptName: 'launch',
            label: 'Launch',
            command: 'npm run dev',
            lifecycle: 'launch',
            target: 'project',
          },
          invocation: 'manual-run',
          status: 'failed',
          startedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:01.000Z',
          exitCode: null,
          timedOut: true,
          durationMs: 1000,
        },
        lines: [],
      })
      .mockResolvedValueOnce({
        meta: {
          version: 1,
          runId: 'run-stopped',
          script: {
            scriptKey: 'project:launch',
            scriptName: 'launch',
            label: 'Launch',
            command: 'npm run dev',
            lifecycle: 'launch',
            target: 'project',
          },
          invocation: 'manual-run',
          status: 'failed',
          startedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:01.000Z',
          exitCode: null,
          timedOut: false,
          durationMs: 1000,
        },
        lines: [],
      });

    const timedOut = await loadScriptOutputSnapshot({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      scriptId: 'launch',
    });
    const stopped = await loadScriptOutputSnapshot({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      scriptId: 'launch',
    });

    expect(timedOut.humanStatus).toBe('timed out');
    expect(stopped.humanStatus).toBe('stopped');
  });

  it('maps startup failures to failed', async () => {
    mockedReadScriptRunLogTail.mockResolvedValueOnce({
      meta: {
        version: 1,
        runId: 'run-failed',
        script: {
          scriptKey: 'project:launch',
          scriptName: 'launch',
          label: 'Launch',
          command: 'npm run dev',
          lifecycle: 'launch',
          target: 'project',
        },
        invocation: 'manual-run',
        status: 'failed',
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:01.000Z',
        exitCode: 1,
        timedOut: false,
        durationMs: 1000,
      },
      lines: ['Error: spawn failed'],
    });

    const failed = await loadScriptOutputSnapshot({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      scriptId: 'launch',
    });

    expect(failed.humanStatus).toBe('failed');
  });
});
