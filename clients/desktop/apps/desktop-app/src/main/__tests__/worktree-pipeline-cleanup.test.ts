jest.mock('@electron-toolkit/utils', () => ({
  is: { dev: true },
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cleanupWorktreePipelines } from '../pipelines/worktree-cleanup';

async function waitForRemoval(
  filePath: string,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (fs.existsSync(filePath)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${filePath} to be removed`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
import {
  createInitialState,
  listExecutionSummariesWithStates,
  normalizePipeline,
  saveExecutionState,
} from '@canopy/desktop-shared/node/pipelines/executor';
import type {
  ExecutionRuntime,
  ExecutionState,
} from '@canopy/desktop-shared/node/pipelines/executor/types';

function makeRuntime(dir: string): ExecutionRuntime {
  return {
    // Pipeline fixtures do not enforce an org model policy.
    isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
    isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
    executionsDir: dir,
    tempRootDir: dir,
    bundledActionsDir: dir,
    getProjectActionsDir: (repoPath: string): string => repoPath,
    getProjectPipelinesDir: (repoPath: string): string => repoPath,
  };
}

function makeExecution(
  id: string,
  worktreeId: string,
  dir: string,
): ExecutionState {
  const normalized = normalizePipeline({
    name: `Pipeline ${id}`,
    on: 'dispatch',
    jobs: {
      build: {
        steps: [{ id: 'step1', run: 'echo hello' }],
      },
    },
  });
  const state = createInitialState(
    normalized,
    {
      cwd: dir,
      pipelineId: `pipeline-${id}`,
      runtime: makeRuntime(dir),
      projectId: 'project-1',
      worktreeId,
    },
    id,
  );
  return state;
}

describe('cleanupWorktreePipelines', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-wt-cleanup-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty warnings when no executions exist', async () => {
    const runtime = makeRuntime(tempDir);
    const result = await cleanupWorktreePipelines('project-1', 'wt-1', runtime);
    expect(result.warnings).toEqual([]);
  });

  it('deletes disk artifacts for terminal executions', async () => {
    const runtime = makeRuntime(tempDir);

    // Create a completed execution
    const state = makeExecution('exec-1', 'wt-1', tempDir);
    state.status = 'success';
    state.completed_at = new Date().toISOString();
    state.jobs.build.status = 'success';
    state.jobs.build.conclusion = 'success';
    await saveExecutionState(state, tempDir);

    // Create its log directory
    const logDir = path.join(tempDir, 'exec-1', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'build_step1_0.log'), 'log output');

    const result = await cleanupWorktreePipelines('project-1', 'wt-1', runtime);
    expect(result.warnings).toEqual([]);

    // Wait for fire-and-forget deletion to complete
    await waitForRemoval(path.join(tempDir, 'exec-1.json'));
    await waitForRemoval(path.join(tempDir, 'exec-1'));
  });

  it('copies state and artifacts before deleting a relocated execution', async () => {
    const runtime = makeRuntime(tempDir);
    const archiveDir = path.join(tempDir, 'archive');
    const state = makeExecution('exec-relocated', 'wt-1', tempDir);
    state.status = 'success';
    state.completed_at = new Date().toISOString();
    state.jobs.build.status = 'success';
    state.jobs.build.conclusion = 'success';
    state.jobs.build.steps.step1.log_file = path.join(
      tempDir,
      'exec-relocated',
      'logs',
      'build_step1_0.log',
    );
    await saveExecutionState(state, tempDir);
    const logDir = path.join(tempDir, 'exec-relocated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'build_step1_0.log'), 'archived log');

    const result = await cleanupWorktreePipelines(
      'project-1',
      'wt-1',
      runtime,
      { relocateArtifactsTo: archiveDir },
    );

    expect(result).toEqual({
      warnings: [],
      relocatedCount: 1,
      failedRelocationIds: [],
    });
    expect(fs.existsSync(path.join(tempDir, 'exec-relocated.json'))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(tempDir, 'exec-relocated'))).toBe(false);
    expect(fs.existsSync(path.join(archiveDir, 'exec-relocated.json'))).toBe(
      true,
    );
    expect(
      fs.readFileSync(
        path.join(archiveDir, 'exec-relocated', 'logs', 'build_step1_0.log'),
        'utf8',
      ),
    ).toBe('archived log');
    const archivedEntries = await listExecutionSummariesWithStates(archiveDir);
    expect(archivedEntries).toHaveLength(1);
    expect(archivedEntries[0]?.summary.id).toBe('exec-relocated');
    expect(archivedEntries[0]?.state.jobs.build.steps.step1.log_file).toBe(
      path.join(archiveDir, 'exec-relocated', 'logs', 'build_step1_0.log'),
    );
  });

  it('delegates archive artifact copying to the supplied archive executor', async () => {
    const runtime = makeRuntime(tempDir);
    const archiveDir = path.join(tempDir, 'archive');
    const state = makeExecution('exec-worker-copy', 'wt-1', tempDir);
    state.status = 'success';
    state.completed_at = new Date().toISOString();
    state.jobs.build.status = 'success';
    state.jobs.build.conclusion = 'success';
    await saveExecutionState(state, tempDir);
    const artifactDir = path.join(tempDir, 'exec-worker-copy');
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'artifact.txt'), 'worker payload');
    const archiveCaptureExecutor = jest.fn(
      (
        _executionId: string,
        input: {
          entries: readonly { source: string; destination: string }[];
        },
      ): Promise<void> => {
        for (const entry of input.entries) {
          fs.cpSync(entry.source, entry.destination, {
            recursive: true,
            force: true,
          });
        }
        return Promise.resolve();
      },
    );

    const result = await cleanupWorktreePipelines(
      'project-1',
      'wt-1',
      runtime,
      { relocateArtifactsTo: archiveDir, archiveCaptureExecutor },
    );

    expect(result.failedRelocationIds).toEqual([]);
    expect(archiveCaptureExecutor).toHaveBeenCalledWith(
      'exec-worker-copy',
      expect.objectContaining({
        sourceRoots: [tempDir],
        destinationRoot: archiveDir,
        entries: [
          expect.objectContaining({
            kind: 'directory',
            source: artifactDir,
            destination: path.join(archiveDir, 'exec-worker-copy'),
          }),
        ],
      }),
    );
    expect(
      fs.readFileSync(
        path.join(archiveDir, 'exec-worker-copy', 'artifact.txt'),
        'utf8',
      ),
    ).toBe('worker payload');
  });

  it('preserves live artifacts and removes a partial archive when relocation fails', async () => {
    const runtime = makeRuntime(tempDir);
    const archiveDir = path.join(tempDir, 'archive');
    const state = makeExecution('exec-copy-fails', 'wt-1', tempDir);
    state.status = 'success';
    state.completed_at = new Date().toISOString();
    state.jobs.build.status = 'success';
    state.jobs.build.conclusion = 'success';
    await saveExecutionState(state, tempDir);
    fs.mkdirSync(path.join(tempDir, 'exec-copy-fails'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'exec-copy-fails', 'artifact.txt'),
      'live artifact',
    );
    fs.mkdirSync(archiveDir, { recursive: true });
    // Force the recursive directory copy to fail after the JSON state copy.
    fs.writeFileSync(path.join(archiveDir, 'exec-copy-fails'), 'collision');

    const result = await cleanupWorktreePipelines(
      'project-1',
      'wt-1',
      runtime,
      { relocateArtifactsTo: archiveDir },
    );

    expect(result.relocatedCount).toBe(0);
    expect(result.failedRelocationIds).toEqual(['exec-copy-fails']);
    expect(result.warnings).toEqual([
      "Failed to archive workflow execution 'exec-copy-fails' artifacts; the live artifacts were preserved.",
    ]);
    expect(fs.existsSync(path.join(tempDir, 'exec-copy-fails.json'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(tempDir, 'exec-copy-fails'))).toBe(true);
    expect(fs.existsSync(path.join(archiveDir, 'exec-copy-fails.json'))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(archiveDir, 'exec-copy-fails'))).toBe(false);
  });

  it('does not delete executions for other worktrees', async () => {
    const runtime = makeRuntime(tempDir);

    // Execution for a different worktree
    const state = makeExecution('exec-other', 'wt-2', tempDir);
    state.status = 'success';
    state.completed_at = new Date().toISOString();
    state.jobs.build.status = 'success';
    state.jobs.build.conclusion = 'success';
    await saveExecutionState(state, tempDir);

    const result = await cleanupWorktreePipelines('project-1', 'wt-1', runtime);
    expect(result.warnings).toEqual([]);

    // Other worktree's state file should still exist
    expect(fs.existsSync(path.join(tempDir, 'exec-other.json'))).toBe(true);
  });

  it('deletes disk artifacts for paused executions', async () => {
    const runtime = makeRuntime(tempDir);

    const state = makeExecution('exec-paused', 'wt-1', tempDir);
    state.status = 'paused';
    state.jobs.build.status = 'paused';
    await saveExecutionState(state, tempDir);

    const result = await cleanupWorktreePipelines('project-1', 'wt-1', runtime);
    expect(result.warnings).toEqual([]);

    await waitForRemoval(path.join(tempDir, 'exec-paused.json'));
  });

  it('deletes disk artifacts for pending executions', async () => {
    const runtime = makeRuntime(tempDir);

    const state = makeExecution('exec-pending', 'wt-1', tempDir);
    // status is already 'pending' from createInitialState
    await saveExecutionState(state, tempDir);

    const result = await cleanupWorktreePipelines('project-1', 'wt-1', runtime);
    expect(result.warnings).toEqual([]);

    await waitForRemoval(path.join(tempDir, 'exec-pending.json'));
  });

  it('warns when listExecutionSummaries throws', async () => {
    // Point to a file instead of a directory to cause readdir to throw
    const filePath = path.join(tempDir, 'not-a-dir');
    fs.writeFileSync(filePath, 'x');
    const badRuntime: ExecutionRuntime = {
      ...makeRuntime(tempDir),
      executionsDir: filePath,
    };

    const result = await cleanupWorktreePipelines(
      'project-1',
      'wt-1',
      badRuntime,
    );
    expect(result.warnings).toEqual([
      'Failed to list workflow executions for cleanup',
    ]);
  });

  it('fails archival when pipeline executions cannot be enumerated', async () => {
    const filePath = path.join(tempDir, 'not-a-dir');
    fs.writeFileSync(filePath, 'x');
    const badRuntime: ExecutionRuntime = {
      ...makeRuntime(tempDir),
      executionsDir: filePath,
    };

    await expect(
      cleanupWorktreePipelines('project-1', 'wt-1', badRuntime, {
        relocateArtifactsTo: path.join(tempDir, 'archive'),
      }),
    ).rejects.toThrow();
  });

  it('archives despite unreadable execution state files, leaving them in place', async () => {
    const archiveDir = path.join(tempDir, 'archive');
    // Corrupt JSON and an id that fails validateId (uppercase characters):
    // both are unattributable to any worktree and must not fail the archive.
    const malformedStatePath = path.join(tempDir, 'malformed.json');
    fs.writeFileSync(malformedStatePath, '{not-json');
    const invalidIdStatePath = path.join(
      tempDir,
      'pr-exact6-r3-20260716T020318Z.json',
    );
    fs.writeFileSync(
      invalidIdStatePath,
      JSON.stringify({ version: 6, id: 'pr-exact6-r3-20260716T020318Z' }),
    );

    const state = makeExecution('exec-survivor', 'wt-1', tempDir);
    state.status = 'success';
    state.completed_at = new Date().toISOString();
    state.jobs.build.status = 'success';
    state.jobs.build.conclusion = 'success';
    await saveExecutionState(state, tempDir);

    const result = await cleanupWorktreePipelines(
      'project-1',
      'wt-1',
      makeRuntime(tempDir),
      { relocateArtifactsTo: archiveDir },
    );

    expect(result.relocatedCount).toBe(1);
    expect(result.failedRelocationIds).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(
      /^Skipped 2 unreadable workflow execution state file\(s\) left in place: /,
    );
    expect(result.warnings[0]).toContain('malformed.json');
    expect(result.warnings[0]).toContain('pr-exact6-r3-20260716T020318Z.json');
    expect(fs.existsSync(path.join(archiveDir, 'exec-survivor.json'))).toBe(
      true,
    );
    // The unreadable files stay untouched in the live executions directory.
    expect(fs.existsSync(malformedStatePath)).toBe(true);
    expect(fs.existsSync(invalidIdStatePath)).toBe(true);
  });

  it('reports unreadable files even when the worktree has no executions', async () => {
    const archiveDir = path.join(tempDir, 'archive');
    fs.writeFileSync(path.join(tempDir, 'malformed.json'), '{not-json');

    const result = await cleanupWorktreePipelines(
      'project-1',
      'wt-1',
      makeRuntime(tempDir),
      { relocateArtifactsTo: archiveDir },
    );

    expect(result.relocatedCount).toBe(0);
    expect(result.failedRelocationIds).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('malformed.json');
  });
});
