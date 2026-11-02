import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  HookDescriptor,
  HookRunResponse,
} from '@canopy/desktop-shared/types';

let tempDir = '';

jest.mock('@canopy/desktop-shared/canopy-paths', () => ({
  getCanopyDataDir: jest.fn(() => tempDir),
}));
jest.mock('../lib/workspace-registry', () => ({
  getWorkspaceType: jest.fn(() => null),
}));

import {
  appendHookRunLogLines,
  completeHookRunLog,
  deleteHookRunLogsForWorktree,
  listHookRunLogTails,
  listLatestHookRunLogTails,
  MAX_RETAINED_HOOK_RUNS_PER_HOOK,
  startHookRunLog,
} from '../lib/hook-log-store';
import * as runLogStore from '../lib/run-log-store';
import {
  listHookRuns,
  loadWorktreeHookRuns,
  readHookRunTail,
} from '../services/hooks-service';

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'wt-1';
const HOOK: HookDescriptor = {
  hookKey: 'project:pre-commit',
  triggerName: 'Pre Commit',
  label: 'Pre Commit',
  actions: [],
  target: 'project',
};

function getHookRunPaths(runId: string): { metaPath: string; logPath: string } {
  const runDir = path.join(
    tempDir,
    'workspaces',
    PROJECT_ID,
    'worktree-data',
    WORKTREE_ID,
    'hook-invocations',
    runId,
  );
  return {
    metaPath: path.join(runDir, 'meta.json'),
    logPath: path.join(runDir, 'output.log'),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function writePersistedRun(args: {
  runId: string;
  hook?: HookDescriptor;
  status: 'running' | 'success' | 'failed' | 'cancelled';
  startedAt: string;
  updatedAt?: string;
  version?: number;
  lines?: string[];
}): Promise<void> {
  const { metaPath, logPath } = getHookRunPaths(args.runId);
  await fs.mkdir(path.dirname(metaPath), { recursive: true });
  await fs.writeFile(
    metaPath,
    JSON.stringify({
      version: args.version ?? 1,
      runId: args.runId,
      hook: args.hook ?? HOOK,
      invocation: 'automatic',
      status: args.status,
      startedAt: args.startedAt,
      updatedAt: args.updatedAt ?? args.startedAt,
      ...(args.status === 'running' ? {} : { completedAt: args.startedAt }),
      exitCode: args.status === 'success' ? 0 : null,
      timedOut: false,
      durationMs: 10,
    }),
  );
  await fs.writeFile(
    logPath,
    args.lines && args.lines.length > 0 ? `${args.lines.join('\n')}\n` : '',
  );
}

function minuteTimestamp(minute: number): string {
  return new Date(Date.UTC(2025, 0, 1, 0, minute)).toISOString();
}

async function listRunDirs(): Promise<string[]> {
  const names = await fs.readdir(
    path.dirname(path.dirname(getHookRunPaths('x').metaPath)),
  );
  return names.sort();
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error('Expected object JSON');
  }
  return parsed;
}

describe('hook-log-store', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-hook-log-'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('writes output and completion metadata for a hook run', async () => {
    const ref = await startHookRunLog({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      hook: HOOK,
      invocation: 'manual',
    });
    await appendHookRunLogLines({
      ref,
      lines: ['first', 'second'],
      activeActionIndex: 1,
    });

    const response: HookRunResponse = {
      success: true,
      exitCode: 0,
      output: 'first\nsecond',
      timedOut: false,
      durationMs: 42,
    };
    await completeHookRunLog({ ref, response });

    const { metaPath, logPath } = getHookRunPaths(ref.runId);
    const meta = await readJson(metaPath);
    const log = await fs.readFile(logPath, 'utf8');

    expect(log).toBe('first\nsecond\n');
    expect(meta).toEqual(
      expect.objectContaining({
        version: 1,
        runId: ref.runId,
        hook: HOOK,
        invocation: 'manual',
        status: 'success',
        exitCode: 0,
        timedOut: false,
        durationMs: 42,
        activeActionIndex: 1,
      }),
    );
  });

  it('deletes hook logs without leaving in-flight writes behind', async () => {
    const ref = await startHookRunLog({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      hook: HOOK,
      invocation: 'automatic',
    });

    await Promise.all([
      appendHookRunLogLines({ ref, lines: ['first'] }),
      appendHookRunLogLines({ ref, lines: ['second'] }),
      deleteHookRunLogsForWorktree(PROJECT_ID, WORKTREE_ID),
    ]);

    const targetDir = path.join(
      tempDir,
      'workspaces',
      PROJECT_ID,
      'worktree-data',
      WORKTREE_ID,
      'hook-invocations',
    );
    await expect(fs.access(targetDir)).rejects.toThrow();
  });

  it('returns only the latest run per hook key', async () => {
    const oldRef = await startHookRunLog({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      hook: HOOK,
      invocation: 'manual',
    });
    await appendHookRunLogLines({ ref: oldRef, lines: ['old output'] });

    const newRef = await startHookRunLog({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      hook: HOOK,
      invocation: 'manual',
    });
    await appendHookRunLogLines({ ref: newRef, lines: ['new output'] });

    const oldPaths = getHookRunPaths(oldRef.runId);
    const newPaths = getHookRunPaths(newRef.runId);
    const oldMeta = await readJson(oldPaths.metaPath);
    const newMeta = await readJson(newPaths.metaPath);
    await fs.writeFile(
      oldPaths.metaPath,
      JSON.stringify({ ...oldMeta, startedAt: '2025-01-01T00:00:00.000Z' }),
    );
    await fs.writeFile(
      newPaths.metaPath,
      JSON.stringify({ ...newMeta, startedAt: '2025-01-02T00:00:00.000Z' }),
    );

    const runs = await listLatestHookRunLogTails({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      maxLines: 100,
    });

    expect(runs).toHaveLength(1);
    expect(runs[0].meta.runId).toBe(newRef.runId);
    expect(runs[0].lines).toEqual(['new output']);
  });

  it('hydrates the persisted active action index for a running hook', async () => {
    const ref = await startHookRunLog({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      hook: HOOK,
      invocation: 'manual',
    });
    const { metaPath } = getHookRunPaths(ref.runId);
    const meta = await readJson(metaPath);
    await fs.writeFile(
      metaPath,
      JSON.stringify({ ...meta, activeActionIndex: 1 }),
    );

    const snapshots = await loadWorktreeHookRuns({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].activeActionIndex).toBe(1);
  });

  describe('interrupted runs', () => {
    const startedAt = '2025-01-01T00:00:00.000Z';
    const updatedAt = '2025-01-01T00:05:00.000Z';

    it('reports a persisted running run without a live run as cancelled', async () => {
      await writePersistedRun({
        runId: 'crashed-run',
        status: 'running',
        startedAt,
        updatedAt,
        lines: ['partial'],
      });

      const [latest] = await listLatestHookRunLogTails({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        maxLines: 10,
      });
      const [listed] = await listHookRunLogTails({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        maxLines: 10,
      });
      const [snapshot] = await loadWorktreeHookRuns({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
      });
      const [portalRun] = await listHookRuns({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
      });
      const tail = await readHookRunTail({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        runId: 'crashed-run',
      });

      expect(latest?.meta).toEqual(
        expect.objectContaining({
          status: 'cancelled',
          completedAt: updatedAt,
        }),
      );
      expect(listed?.meta).toEqual(
        expect.objectContaining({
          status: 'cancelled',
          completedAt: updatedAt,
        }),
      );
      expect(snapshot).toEqual(
        expect.objectContaining({
          status: 'cancelled',
          completedAt: updatedAt,
        }),
      );
      expect(portalRun).toEqual(
        expect.objectContaining({ status: 'cancelled', finishedAt: updatedAt }),
      );
      expect(tail.run).toEqual(
        expect.objectContaining({ status: 'cancelled', finishedAt: updatedAt }),
      );
    });

    it('persists a timed-out run as failed, not cancelled', async () => {
      const ref = await startHookRunLog({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        hook: HOOK,
        invocation: 'automatic',
      });

      await completeHookRunLog({
        ref,
        response: {
          success: false,
          exitCode: null,
          output: '',
          timedOut: true,
          stopped: false,
          durationMs: 30_000,
        },
      });

      const persisted: unknown = JSON.parse(
        await fs.readFile(getHookRunPaths(ref.runId).metaPath, 'utf8'),
      );
      expect(persisted).toEqual(
        expect.objectContaining({ status: 'failed', timedOut: true }),
      );
    });

    it('reports the real status of a run that completes while a listing reads it', async () => {
      const ref = await startHookRunLog({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        hook: HOOK,
        invocation: 'manual',
      });
      const readTail = runLogStore.readRunLogTailLines;
      const tailSpy = jest
        .spyOn(runLogStore, 'readRunLogTailLines')
        .mockImplementationOnce(async (logPath, maxLines) => {
          await completeHookRunLog({
            ref,
            response: {
              success: true,
              exitCode: 0,
              output: '',
              timedOut: false,
              durationMs: 5,
            },
          });
          return readTail(logPath, maxLines);
        });

      try {
        const [listed] = await listHookRunLogTails({
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          maxLines: 10,
        });

        expect(listed?.meta).toEqual(
          expect.objectContaining({ runId: ref.runId, status: 'success' }),
        );
      } finally {
        tailSpy.mockRestore();
      }
    });

    it('keeps reporting a live run as running', async () => {
      const ref = await startHookRunLog({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        hook: HOOK,
        invocation: 'manual',
      });

      const [snapshot] = await loadWorktreeHookRuns({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
      });
      const [portalRun] = await listHookRuns({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
      });

      expect(snapshot?.status).toBe('running');
      expect(snapshot?.completedAt).toBeUndefined();
      expect(portalRun).toEqual(
        expect.objectContaining({ runId: ref.runId, status: 'running' }),
      );
      expect(portalRun?.finishedAt).toBeUndefined();
    });
  });

  it('omits runs with an unsupported metadata version from both listings', async () => {
    await writePersistedRun({
      runId: 'future-run',
      status: 'success',
      startedAt: minuteTimestamp(1),
      version: 2,
    });
    await writePersistedRun({
      runId: 'current-run',
      status: 'success',
      startedAt: minuteTimestamp(0),
    });

    const storeRuns = await listHookRunLogTails({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      maxLines: 10,
    });
    const portalRuns = await listHookRuns({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });

    expect(storeRuns.map((run) => run.meta.runId)).toEqual(['current-run']);
    expect(portalRuns.map((run) => run.runId)).toEqual(['current-run']);
  });

  it('prunes finished runs for the hook beyond the retention limit when a run starts', async () => {
    const otherHook: HookDescriptor = {
      ...HOOK,
      hookKey: 'project:post-merge',
      triggerName: 'Post Merge',
      label: 'Post Merge',
    };
    const finishedCount = MAX_RETAINED_HOOK_RUNS_PER_HOOK + 3;
    for (let index = 0; index < finishedCount; index += 1) {
      await writePersistedRun({
        runId: `finished-${String(index).padStart(2, '0')}`,
        status: index % 2 === 0 ? 'success' : 'failed',
        startedAt: minuteTimestamp(index + 10),
      });
    }
    for (let index = 0; index < finishedCount; index += 1) {
      await writePersistedRun({
        runId: `other-${String(index).padStart(2, '0')}`,
        hook: otherHook,
        status: 'success',
        startedAt: minuteTimestamp(index),
      });
    }
    await writePersistedRun({
      runId: 'still-running',
      status: 'running',
      startedAt: minuteTimestamp(0),
    });
    const unreadable = getHookRunPaths('unreadable-run');
    await fs.mkdir(path.dirname(unreadable.metaPath), { recursive: true });
    await fs.writeFile(unreadable.metaPath, '{"version": 1, "runId"');

    const ref = await startHookRunLog({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      hook: HOOK,
      invocation: 'automatic',
    });

    const dirs = await listRunDirs();
    const keptFinished = dirs.filter((name) => name.startsWith('finished-'));
    expect(keptFinished).toEqual(
      Array.from(
        { length: MAX_RETAINED_HOOK_RUNS_PER_HOOK },
        (_, index) => `finished-${String(index + 3).padStart(2, '0')}`,
      ),
    );
    expect(dirs.filter((name) => name.startsWith('other-'))).toHaveLength(
      finishedCount,
    );
    expect(dirs).toEqual(
      expect.arrayContaining(['still-running', 'unreadable-run', ref.runId]),
    );
  });
});
