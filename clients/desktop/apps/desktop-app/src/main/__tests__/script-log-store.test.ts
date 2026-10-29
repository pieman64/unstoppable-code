import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  ScriptDescriptor,
  ScriptRunResponse,
} from '@canopy/desktop-shared/types';
import {
  MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH,
  MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH,
  MAX_SCRIPT_DEV_SERVER_PATTERNS,
} from '@canopy/desktop-shared/scripts';

let tempDir = '';
let workspaceType: 'multi-repo' | 'single-repo' | null = null;

jest.mock('@canopy/desktop-shared/canopy-paths', () => ({
  getCanopyDataDir: jest.fn(() => tempDir),
}));
jest.mock('../lib/workspace-registry', () => ({
  getWorkspaceType: jest.fn(() => workspaceType),
}));

import {
  appendScriptRunLogLines,
  completeScriptRunLog,
  deleteScriptRunLogsForWorktree,
  readScriptRunLogTail,
  startScriptRunLog,
} from '../lib/script-log-store';
import { buildScriptRunFileStem } from '../lib/paths';

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'wt-1';
const SCRIPT: ScriptDescriptor = {
  scriptKey: 'project:launch',
  scriptName: 'launch',
  label: 'Launch',
  command: 'npm run dev',
  lifecycle: 'launch',
  target: 'project',
};

function buildPaths(scriptKey: string): { metaPath: string; logPath: string } {
  const stem = buildScriptRunFileStem(scriptKey);
  return {
    metaPath: path.join(
      tempDir,
      'workspaces',
      PROJECT_ID,
      'script-runs',
      WORKTREE_ID,
      `${stem}.json`,
    ),
    logPath: path.join(
      tempDir,
      'workspaces',
      PROJECT_ID,
      'script-runs',
      WORKTREE_ID,
      `${stem}.log`,
    ),
  };
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('script-log-store', () => {
  beforeEach(async () => {
    workspaceType = null;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-script-log-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('writes versioned metadata when a run starts', async () => {
    const ref = await startScriptRunLog({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      script: SCRIPT,
      invocation: 'manual-run',
    });

    const { metaPath } = buildPaths(SCRIPT.scriptKey);
    const meta = await readJson(metaPath);

    expect(ref.runId).toEqual(expect.any(String));
    expect(meta).toEqual(
      expect.objectContaining({
        version: 1,
        runId: ref.runId,
        script: SCRIPT,
        invocation: 'manual-run',
        status: 'running',
        exitCode: null,
        timedOut: false,
        durationMs: 0,
      }),
    );
  });

  it('persists and loads descriptors with devServerPattern destinations and auto-open', async () => {
    const script: ScriptDescriptor = {
      ...SCRIPT,
      devServerPattern: [
        'https?://localhost:\\d+\\S*',
        {
          pattern: 'Docs:\\s+(https?://\\S+)',
          label: 'Docs',
          openTarget: 'external',
          autoOpen: true,
        },
      ],
    };

    const ref = await startScriptRunLog({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      script,
      invocation: 'manual-run',
    });

    const snapshot = await readScriptRunLogTail({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      scriptKey: script.scriptKey,
      maxLines: 10,
    });

    expect(snapshot.meta?.runId).toBe(ref.runId);
    expect(snapshot.meta?.script.devServerPattern).toEqual(
      script.devServerPattern,
    );
  });

  it('loads old persisted metadata without devServerPattern', async () => {
    const { metaPath } = buildPaths(SCRIPT.scriptKey);
    await fs.mkdir(path.dirname(metaPath), { recursive: true });
    await fs.writeFile(
      metaPath,
      JSON.stringify({
        version: 1,
        runId: 'old-run',
        script: SCRIPT,
        invocation: 'manual-run',
        status: 'running',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        exitCode: null,
        timedOut: false,
        durationMs: 0,
      }),
    );

    const snapshot = await readScriptRunLogTail({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      scriptKey: SCRIPT.scriptKey,
      maxLines: 10,
    });

    expect(snapshot.meta?.runId).toBe('old-run');
    expect(snapshot.meta?.script.devServerPattern).toBeUndefined();
  });

  it.each([
    ['non-string object pattern', { pattern: 42 }],
    ['empty string pattern', '   '],
    ['invalid regex pattern', '('],
    [
      'over-limit string pattern',
      'a'.repeat(MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH + 1),
    ],
    ['empty array', []],
    [
      'over-limit array',
      Array.from(
        { length: MAX_SCRIPT_DEV_SERVER_PATTERNS + 1 },
        (_, index) => `https?://localhost:${index}`,
      ),
    ],
    ['empty object label', { pattern: 'https?://localhost:\\d+', label: ' ' }],
    [
      'invalid destination',
      { pattern: 'https?://localhost:\\d+', openTarget: 'other' },
    ],
    [
      'non-boolean autoOpen',
      { pattern: 'https?://localhost:\\d+', autoOpen: 'true' },
    ],
    [
      'over-limit object label',
      {
        pattern: 'https?://localhost:\\d+',
        label: 'x'.repeat(MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH + 1),
      },
    ],
  ])(
    'drops persisted metadata with malformed devServerPattern: %s',
    async (_, devServerPattern) => {
      const { metaPath } = buildPaths(SCRIPT.scriptKey);
      await fs.mkdir(path.dirname(metaPath), { recursive: true });
      await fs.writeFile(
        metaPath,
        JSON.stringify({
          version: 1,
          runId: 'bad-run',
          script: {
            ...SCRIPT,
            devServerPattern,
          },
          invocation: 'manual-run',
          status: 'running',
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          exitCode: null,
          timedOut: false,
          durationMs: 0,
        }),
      );

      const snapshot = await readScriptRunLogTail({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        scriptKey: SCRIPT.scriptKey,
        maxLines: 10,
      });

      expect(snapshot.meta).toBeNull();
      expect(snapshot.lines).toEqual([]);
    },
  );

  it('appends output and completes metadata', async () => {
    const ref = await startScriptRunLog({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      script: SCRIPT,
      invocation: 'manual-run',
    });

    await appendScriptRunLogLines({
      ref,
      lines: ['line 1', 'line 2'],
    });

    const response: ScriptRunResponse = {
      success: false,
      exitCode: 1,
      output: 'line 1\nline 2',
      timedOut: false,
      durationMs: 1234,
    };
    await completeScriptRunLog({ ref, response });

    const { metaPath, logPath } = buildPaths(SCRIPT.scriptKey);
    const meta = await readJson(metaPath);
    const log = await fs.readFile(logPath, 'utf8');

    expect(log).toBe('line 1\nline 2\n');
    expect(meta).toEqual(
      expect.objectContaining({
        status: 'failed',
        exitCode: 1,
        timedOut: false,
        durationMs: 1234,
      }),
    );
    expect(meta.completedAt).toEqual(expect.any(String));
    expect(meta.updatedAt).toEqual(expect.any(String));
  });

  it('caps stored log tails by line count and file size', async () => {
    const ref = await startScriptRunLog({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      script: SCRIPT,
      invocation: 'manual-run',
    });

    await appendScriptRunLogLines({
      ref,
      lines: Array.from({ length: 2505 }, (_, index) => `line-${index}`),
    });

    const { meta, lines } = await readScriptRunLogTail({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      scriptKey: SCRIPT.scriptKey,
      maxLines: 2500,
    });

    expect(meta?.runId).toBe(ref.runId);
    expect(lines).toHaveLength(2000);
    expect(lines[0]).toBe('line-505');
    expect(lines[lines.length - 1]).toBe('line-2504');
  });

  it('serializes writes and reads after pending writes resolve', async () => {
    const ref = await startScriptRunLog({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      script: SCRIPT,
      invocation: 'manual-run',
    });

    const writes = Promise.all([
      appendScriptRunLogLines({ ref, lines: ['first'] }),
      appendScriptRunLogLines({ ref, lines: ['second'] }),
      completeScriptRunLog({
        ref,
        response: {
          success: true,
          exitCode: 0,
          output: '',
          timedOut: false,
          durationMs: 42,
        },
      }),
    ]);

    const snapshot = await readScriptRunLogTail({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      scriptKey: SCRIPT.scriptKey,
      maxLines: 10,
    });

    await writes;

    expect(snapshot.lines).toEqual(['first', 'second']);
    expect(snapshot.meta?.status).toBe('success');
  });

  it('ignores stale appends and completion from an older run', async () => {
    const refA = await startScriptRunLog({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      script: SCRIPT,
      invocation: 'manual-run',
    });
    const refB = await startScriptRunLog({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      script: SCRIPT,
      invocation: 'manual-run',
    });

    await appendScriptRunLogLines({ ref: refA, lines: ['stale'] });
    await completeScriptRunLog({
      ref: refA,
      response: {
        success: false,
        exitCode: 1,
        output: 'stale',
        timedOut: false,
        durationMs: 1,
      },
    });
    await appendScriptRunLogLines({ ref: refB, lines: ['fresh'] });

    const snapshot = await readScriptRunLogTail({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      scriptKey: SCRIPT.scriptKey,
      maxLines: 10,
    });

    expect(snapshot.meta?.runId).toBe(refB.runId);
    expect(snapshot.meta?.status).toBe('running');
    expect(snapshot.lines).toEqual(['fresh']);
  });

  it('deletes the whole worktree script-log directory', async () => {
    const ref = await startScriptRunLog({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      script: SCRIPT,
      invocation: 'manual-run',
    });
    await appendScriptRunLogLines({ ref, lines: ['hello'] });

    const targetDir = path.join(
      tempDir,
      'workspaces',
      PROJECT_ID,
      'script-runs',
      WORKTREE_ID,
    );
    await deleteScriptRunLogsForWorktree(PROJECT_ID, WORKTREE_ID);

    await expect(fs.access(targetDir)).rejects.toThrow();
  });

  it('stores project worktree logs under the project metadata root', async () => {
    workspaceType = 'multi-repo';
    const ref = await startScriptRunLog({
      projectId: 'workspace-1',
      worktreeId: WORKTREE_ID,
      script: {
        ...SCRIPT,
        scriptKey: 'workspace-root:before-setup',
        scriptName: 'before-setup',
        label: 'Workspace root - Before Setup',
        lifecycle: 'before-setup',
        target: 'workspace-root',
      },
      invocation: 'workspace-lifecycle',
    });

    await appendScriptRunLogLines({ ref, lines: ['project line'] });

    const stem = buildScriptRunFileStem(ref.script.scriptKey);
    await expect(
      fs.access(
        path.join(
          tempDir,
          'workspaces',
          'workspace-1',
          'script-runs',
          WORKTREE_ID,
          `${stem}.log`,
        ),
      ),
    ).resolves.toBeUndefined();
  });
});
