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
  listLatestHookRunLogTails,
  startHookRunLog,
} from '../lib/hook-log-store';
import { loadWorktreeHookRuns } from '../services/hooks-service';

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
});
