import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  inferExecutionScope,
  resolvePipelineTarget,
  validateResolvedExecutionTarget,
} from '../pipeline-target-resolver';
import type {
  ExecutionRuntime,
  ResolvePipelineTargetRequest,
  ResolvePipelineTargetResult,
} from '../types';

function createRuntime(
  root: string,
  resolveTarget?: (
    request: ResolvePipelineTargetRequest,
  ) => Promise<ResolvePipelineTargetResult>,
): ExecutionRuntime {
  return {
    // Pipeline fixtures do not enforce an org model policy.
    isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
    isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
    executionsDir: path.join(root, 'executions'),
    tempRootDir: path.join(root, 'tmp'),
    bundledActionsDir: path.join(root, 'actions'),
    getProjectActionsDir: (repoPath) =>
      path.join(repoPath, '.canopy', 'actions'),
    getProjectPipelinesDir: (repoPath) =>
      path.join(repoPath, '.canopy', 'pipelines'),
    resolvePipelineTarget: resolveTarget,
  };
}

describe('pipeline target resolution', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-target-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('infers worktree scope when project and worktree ids are present', () => {
    expect(
      inferExecutionScope({ projectId: 'workspace-a', worktreeId: 'feature' }),
    ).toBe('worktree');
    expect(inferExecutionScope({})).toBe('directory');
  });

  it('inherit preserves parent context', async () => {
    const runtime = createRuntime(tempDir);
    const target = {
      scope: 'worktree' as const,
      workspace_id: 'workspace-a',
      worktree_id: 'feature',
      path: tempDir,
      created: false,
    };

    await expect(
      resolvePipelineTarget(runtime, {
        parent: {
          cwd: tempDir,
          scope: 'worktree',
          target,
          projectId: 'workspace-a',
          worktreeId: 'feature',
          repoPath: tempDir,
        },
        requested: { scope: 'inherit' },
      }),
    ).resolves.toEqual({
      cwd: tempDir,
      scope: 'worktree',
      target,
      projectId: 'workspace-a',
      worktreeId: 'feature',
      repoPath: tempDir,
    });
  });

  it('inherit aligns the persisted target with a narrowed parent cwd', async () => {
    const runtime = createRuntime(tempDir);
    const childDir = path.join(tempDir, 'child');
    fs.mkdirSync(childDir);
    const target = {
      scope: 'worktree' as const,
      workspace_id: 'workspace-a',
      worktree_id: 'feature',
      path: tempDir,
      created: false,
    };

    await expect(
      resolvePipelineTarget(runtime, {
        parent: {
          cwd: childDir,
          scope: 'worktree',
          target,
          projectId: 'workspace-a',
          worktreeId: 'feature',
          repoPath: tempDir,
        },
        requested: { scope: 'inherit' },
      }),
    ).resolves.toEqual({
      cwd: childDir,
      scope: 'worktree',
      target: {
        scope: 'worktree',
        workspace_id: 'workspace-a',
        worktree_id: 'feature',
        path: childDir,
        created: false,
      },
      projectId: 'workspace-a',
      worktreeId: 'feature',
      repoPath: tempDir,
    });
  });

  it('resolves relative and absolute directory targets', async () => {
    const childDir = path.join(tempDir, 'child');
    fs.mkdirSync(childDir);
    const runtime = createRuntime(tempDir);

    await expect(
      resolvePipelineTarget(runtime, {
        parent: { cwd: tempDir, scope: 'directory' },
        requested: { scope: 'directory', path: 'child' },
      }),
    ).resolves.toMatchObject({
      cwd: childDir,
      scope: 'directory',
      target: { scope: 'directory', path: childDir },
      repoPath: childDir,
    });

    await expect(
      resolvePipelineTarget(runtime, {
        parent: { cwd: tempDir, scope: 'directory' },
        requested: { scope: 'directory', path: childDir },
      }),
    ).resolves.toMatchObject({ cwd: childDir });
  });

  it('global clears project and worktree metadata', async () => {
    const runtime = createRuntime(tempDir);

    await expect(
      resolvePipelineTarget(runtime, {
        parent: {
          cwd: tempDir,
          scope: 'worktree',
          projectId: 'workspace-a',
          worktreeId: 'feature',
          repoPath: tempDir,
        },
        requested: { scope: 'global' },
      }),
    ).resolves.toEqual({
      cwd: tempDir,
      scope: 'global',
      target: { scope: 'global' },
    });
  });

  it('delegates existing worktree targets to the runtime resolver', async () => {
    const calls: ResolvePipelineTargetRequest[] = [];
    const runtime = createRuntime(tempDir, (request) => {
      calls.push(request);
      return Promise.resolve({
        cwd: path.join(tempDir, 'worktree'),
        scope: 'worktree',
        target: {
          scope: 'worktree',
          workspace_id:
            request.requested.scope === 'worktree'
              ? request.requested.workspace_id
              : 'workspace-a',
          worktree_id: 'created',
          path: path.join(tempDir, 'worktree'),
          created: false,
        },
        projectId: 'workspace-a',
        worktreeId: 'created',
        repoPath: path.join(tempDir, 'worktree'),
      });
    });

    const resolved = await resolvePipelineTarget(runtime, {
      parent: { cwd: tempDir, scope: 'directory' },
      requested: {
        scope: 'worktree',
        workspace_id: 'workspace-a',
        worktree: { id: 'existing' },
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.requested).toEqual({
      scope: 'worktree',
      workspace_id: 'workspace-a',
      worktree: { id: 'existing' },
    });
    expect(resolved.target).toMatchObject({ created: false });
  });

  it('fails worktree targets without a runtime resolver', async () => {
    await expect(
      resolvePipelineTarget(createRuntime(tempDir), {
        parent: { cwd: tempDir, scope: 'directory' },
        requested: {
          scope: 'worktree',
          workspace_id: 'workspace-a',
          worktree: { id: 'feature' },
        },
      }),
    ).rejects.toThrow('This runtime cannot resolve worktree pipeline targets');
  });

  it('reports stale persisted directory and worktree targets clearly', async () => {
    await expect(
      validateResolvedExecutionTarget(createRuntime(tempDir), {
        scope: 'directory',
        path: path.join(tempDir, 'missing'),
      }),
    ).rejects.toThrow('Directory target path does not exist:');

    await expect(
      validateResolvedExecutionTarget(createRuntime(tempDir), {
        scope: 'worktree',
        workspace_id: 'workspace-a',
        worktree_id: 'feature',
        path: path.join(tempDir, 'missing'),
        created: true,
      }),
    ).rejects.toThrow('Worktree target "workspace-a/feature" no longer exists');
  });
});

describe('nested pipeline resource authorization', () => {
  it('does not fall through to a stored or file resource after a host denial', async () => {
    const { resolveChildPipeline } = await import('../child-pipeline-resolver');
    const authorize = jest.fn(() =>
      Promise.reject(new Error('Workflow unavailable (context-mismatch)')),
    );
    await expect(
      resolveChildPipeline({
        pipelineRef: 'org-installed',
        parent: { owner: { type: 'user', id: 'user-a', name: null } },
        cwd: '/unreadable',
        resolvePipelineResource: authorize,
      }),
    ).rejects.toThrow('context-mismatch');
    expect(authorize).toHaveBeenCalledWith('org-installed', {
      owner: { type: 'user', id: 'user-a', name: null },
    });
  });
  it('uses the freshly authorized shared definition supplied by the host', async () => {
    const { resolveChildPipeline } = await import('../child-pipeline-resolver');
    const resolved = {
      pipeline: { name: 'Shared', on: 'dispatch' as const, jobs: {} },
      pipelineId: 'shared:canopy-cloud:remote-a',
    };
    await expect(
      resolveChildPipeline({
        pipelineRef: resolved.pipelineId,
        cwd: '/unreadable',
        resolvePipelineResource: jest.fn(() => Promise.resolve(resolved)),
      }),
    ).resolves.toEqual(resolved);
  });
});
