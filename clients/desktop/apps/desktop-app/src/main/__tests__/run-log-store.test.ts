import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as FsPromises from 'node:fs/promises';
import type {
  HookDescriptor,
  ScriptDescriptor,
} from '@canopy/desktop-shared/types';

let tempDir = '';
let mockFailingInstallPath: string | null = null;

jest.mock('@canopy/desktop-shared/canopy-paths', () => ({
  getCanopyDataDir: jest.fn(() => tempDir),
}));
jest.mock('../lib/workspace-registry', () => ({
  getWorkspaceType: jest.fn(() => null),
}));
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  function takeFailure(target: unknown): boolean {
    if (mockFailingInstallPath === null || target !== mockFailingInstallPath) {
      return false;
    }
    mockFailingInstallPath = null;
    return true;
  }
  function installError(): NodeJS.ErrnoException {
    const error: NodeJS.ErrnoException = new Error('no space left on device');
    error.code = 'ENOSPC';
    return error;
  }
  return {
    ...actual,
    writeFile: async (
      ...args: Parameters<typeof actual.writeFile>
    ): Promise<void> => {
      if (takeFailure(args[0])) {
        await actual.writeFile(args[0], '{"vers', 'utf8');
        throw installError();
      }
      return actual.writeFile(...args);
    },
    rename: async (
      ...args: Parameters<typeof actual.rename>
    ): Promise<void> => {
      if (takeFailure(args[1])) {
        throw installError();
      }
      return actual.rename(...args);
    },
  };
});

import {
  appendRunLogLines,
  completeRunLogFiles,
  createRunLogCoordinator,
  MAX_RUN_LOG_BYTES,
  MAX_RUN_LOG_LINES,
  startRunLogFiles,
  type RunLogCoordinator,
  type RunLogPaths,
} from '../lib/run-log-store';
import {
  appendHookRunLogLines,
  readHookRunLogTail,
  startHookRunLog,
} from '../lib/hook-log-store';
import {
  appendScriptRunLogLines,
  listScriptRunLogTails,
  readScriptRunLogTail,
  startScriptRunLog,
} from '../lib/script-log-store';

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'wt-1';
const RUN_KEY = 'project:build';

interface TestMeta {
  runId: string;
  status: string;
  completedAt?: string;
}

function buildPaths(): RunLogPaths {
  const dirPath = path.join(tempDir, 'runs');
  return {
    dirPath,
    metaPath: path.join(dirPath, 'meta.json'),
    logPath: path.join(dirPath, 'output.log'),
  };
}

async function readTestMeta(metaPath: string): Promise<TestMeta | null> {
  const parsed: unknown = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('runId' in parsed) ||
    typeof parsed.runId !== 'string' ||
    !('status' in parsed) ||
    typeof parsed.status !== 'string'
  ) {
    return null;
  }
  return { runId: parsed.runId, status: parsed.status };
}

async function startTestRun(
  coordinator: RunLogCoordinator,
  runId: string,
): Promise<void> {
  await startRunLogFiles({
    coordinator,
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    runKey: RUN_KEY,
    runId,
    paths: buildPaths(),
    meta: { runId, status: 'running' },
  });
}

async function appendTestLines(
  coordinator: RunLogCoordinator,
  runId: string,
  lines: string[],
): Promise<void> {
  await appendRunLogLines({
    coordinator,
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    runKey: RUN_KEY,
    runId,
    logPath: buildPaths().logPath,
    lines,
    isCurrentRun: () => Promise.resolve(true),
  });
}

async function listTempSiblings(dirPath: string): Promise<string[]> {
  const names = await fs.readdir(dirPath);
  return names.filter((name) => name.endsWith('.tmp'));
}

function numberedLines(count: number, prefix = 'line'): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
}

describe('run-log-store', () => {
  beforeEach(async () => {
    mockFailingInstallPath = null;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-run-log-'));
  });

  afterEach(async () => {
    mockFailingInstallPath = null;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('metadata installs', () => {
    it('keeps the previous metadata when a new run fails to install it', async () => {
      const coordinator = createRunLogCoordinator();
      const { dirPath, metaPath } = buildPaths();
      await startTestRun(coordinator, 'run-1');
      const before = await fs.readFile(metaPath, 'utf8');

      mockFailingInstallPath = metaPath;
      await expect(startTestRun(coordinator, 'run-2')).rejects.toThrow(
        'no space left on device',
      );

      expect(await fs.readFile(metaPath, 'utf8')).toBe(before);
      expect(await listTempSiblings(dirPath)).toEqual([]);
    });

    it('keeps the running metadata when completion fails to install it', async () => {
      const coordinator = createRunLogCoordinator();
      const { dirPath, metaPath, logPath } = buildPaths();
      await startTestRun(coordinator, 'run-1');
      const before = await fs.readFile(metaPath, 'utf8');

      mockFailingInstallPath = metaPath;
      await expect(
        completeRunLogFiles<TestMeta>({
          coordinator,
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          runKey: RUN_KEY,
          runId: 'run-1',
          paths: { metaPath, logPath },
          readMeta: () => readTestMeta(metaPath),
          buildNextMeta: (meta, now) => ({
            ...meta,
            status: 'success',
            completedAt: now,
          }),
        }),
      ).rejects.toThrow('no space left on device');

      expect(await fs.readFile(metaPath, 'utf8')).toBe(before);
      expect(await listTempSiblings(dirPath)).toEqual([]);
    });

    it('keeps hook metadata when the active action update fails to install', async () => {
      const hook: HookDescriptor = {
        hookKey: 'project:pre-commit',
        triggerName: 'Pre Commit',
        label: 'Pre Commit',
        actions: [],
        target: 'project',
      };
      const ref = await startHookRunLog({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        hook,
        invocation: 'manual',
      });
      const runDir = path.join(
        tempDir,
        'workspaces',
        PROJECT_ID,
        'worktree-data',
        WORKTREE_ID,
        'hook-invocations',
        ref.runId,
      );
      const metaPath = path.join(runDir, 'meta.json');
      const before = await fs.readFile(metaPath, 'utf8');

      mockFailingInstallPath = metaPath;
      await expect(
        appendHookRunLogLines({ ref, lines: ['out'], activeActionIndex: 2 }),
      ).rejects.toThrow('no space left on device');

      expect(await fs.readFile(metaPath, 'utf8')).toBe(before);
      expect(await listTempSiblings(runDir)).toEqual([]);
    });
  });

  describe('log compaction', () => {
    it('rewrites the log at most once across ten appends after reaching the cap', async () => {
      const coordinator = createRunLogCoordinator();
      const { logPath } = buildPaths();
      await startTestRun(coordinator, 'run-1');
      await appendTestLines(
        coordinator,
        'run-1',
        numberedLines(MAX_RUN_LOG_LINES),
      );

      let rewrites = 0;
      let size = (await fs.stat(logPath)).size;
      for (let index = 0; index < 10; index += 1) {
        const line = `extra-${index}`;
        await appendTestLines(coordinator, 'run-1', [line]);
        const nextSize = (await fs.stat(logPath)).size;
        if (nextSize !== size + Buffer.byteLength(`${line}\n`)) {
          rewrites += 1;
        }
        size = nextSize;
      }

      expect(rewrites).toBeLessThanOrEqual(1);
    });

    it('trims to the cap once the log passes the compaction threshold', async () => {
      const coordinator = createRunLogCoordinator();
      const { logPath } = buildPaths();
      await startTestRun(coordinator, 'run-1');
      await appendTestLines(
        coordinator,
        'run-1',
        numberedLines(Math.floor(MAX_RUN_LOG_LINES * 1.25) + 1),
      );

      const lines = (await fs.readFile(logPath, 'utf8')).split('\n');
      lines.pop();
      expect(lines).toHaveLength(MAX_RUN_LOG_LINES);
      expect(lines[lines.length - 1]).toBe(
        `line-${Math.floor(MAX_RUN_LOG_LINES * 1.25)}`,
      );
    });

    it('never returns more than the line or byte cap from readers', async () => {
      const script: ScriptDescriptor = {
        scriptKey: 'project:launch',
        scriptName: 'launch',
        label: 'Launch',
        command: 'npm run dev',
        lifecycle: 'launch',
        target: 'project',
      };
      const scriptRef = await startScriptRunLog({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        script,
        invocation: 'manual-run',
      });
      await appendScriptRunLogLines({
        ref: scriptRef,
        lines: numberedLines(MAX_RUN_LOG_LINES + 200),
      });
      const longLine = 'x'.repeat(1023);
      const hook: HookDescriptor = {
        hookKey: 'project:post-merge',
        triggerName: 'Post Merge',
        label: 'Post Merge',
        actions: [],
        target: 'project',
      };
      const hookRef = await startHookRunLog({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        hook,
        invocation: 'manual',
      });
      await appendHookRunLogLines({
        ref: hookRef,
        lines: Array.from({ length: 1100 }, () => longLine),
      });

      const scriptTail = await readScriptRunLogTail({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        scriptKey: script.scriptKey,
        maxLines: MAX_RUN_LOG_LINES * 2,
      });
      const [listedScript] = await listScriptRunLogTails({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        maxLines: MAX_RUN_LOG_LINES * 2,
      });
      const hookTail = await readHookRunLogTail({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        runId: hookRef.runId,
        maxLines: MAX_RUN_LOG_LINES * 2,
      });

      expect(scriptTail.lines).toHaveLength(MAX_RUN_LOG_LINES);
      expect(scriptTail.lines[MAX_RUN_LOG_LINES - 1]).toBe(
        `line-${MAX_RUN_LOG_LINES + 199}`,
      );
      expect(listedScript?.lines).toHaveLength(MAX_RUN_LOG_LINES);
      expect(
        hookTail.lines.reduce(
          (total, line) => total + Buffer.byteLength(line) + 1,
          0,
        ),
      ).toBeLessThanOrEqual(MAX_RUN_LOG_BYTES);
    });
  });
});
