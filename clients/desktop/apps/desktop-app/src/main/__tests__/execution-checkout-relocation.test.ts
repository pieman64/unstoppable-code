jest.mock('../pipelines/execution-runtime', () => ({
  createElectronExecutionRuntime: jest.fn(),
}));
jest.mock('../agents/session-manager', () => ({
  getActiveChatIds: jest.fn(() => []),
}));
jest.mock('../ledger/lifecycle', () => ({}));
jest.mock('../lib/workspace-service', () => ({}));
jest.mock('../lib/safe-remove-worktree', () => ({}));
jest.mock('../services/chat-state-service', () => ({}));

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElectronExecutionRuntime } from '../pipelines/execution-runtime';
import {
  migrateSplitPipelineExecutions,
  restoreSplitExecutionSnapshots,
} from '../lib/split-temporary-workspace-items';
import {
  migratePipelineExecutions,
  restorePipelineSnapshots,
} from '../lib/adhoc-combine-core';
import {
  loadExecutionState,
  saveExecutionState,
} from '@canopy/desktop-shared/node/pipelines/executor';
import {
  relocateExecutionCheckout,
  relocateCheckoutPath,
} from '../pipelines/execution-checkout-location';
import {
  policyExecution,
  policyRuntime,
  replayPolicy,
  seedDestinationPolicy,
} from './helpers/copilot-policy-replay';

describe('execution checkout relocation owners', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'checkout-relocation-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each(['retry', 'rerun'] as const)(
    'split keeps retained root separate from cwd on %s',
    async (mode) => {
      const runtime = policyRuntime(root);
      jest.mocked(createElectronExecutionRuntime).mockReturnValue(runtime);
      const source = join(root, 'source');
      const destination = join(root, 'destination');
      await writeFile(join(root, 'CLAUDE.md'), 'ANCESTOR');
      await seedDestinationPolicy(destination);
      const original = policyExecution(runtime, source);
      await saveExecutionState(original, runtime.executionsDir);
      const persistedOriginal = await loadExecutionState(
        original.id,
        runtime.executionsDir,
      );
      const snapshots = await migrateSplitPipelineExecutions({
        workspaceId: 'source',
        worktreeId: 'old',
        targets: [
          {
            repoId: 'repo',
            oldCheckoutPath: source,
            newCheckoutPath: destination,
            destinationWorkspaceId: 'destination',
            destinationWorktreeId: 'new',
          },
        ],
      });
      const migrated = await loadExecutionState(
        original.id,
        runtime.executionsDir,
      );
      if (!migrated) throw new Error('Missing relocated execution');
      // Replay first: the regression must fail at Copilot preparation, not only a field assertion.
      await replayPolicy(migrated, runtime, mode);
      expect(migrated.execution_checkout_root).toBe(destination);
      expect(migrated.cwd).toBe(join(destination, 'desktop'));
      await restoreSplitExecutionSnapshots(snapshots);
      expect(
        await loadExecutionState(original.id, runtime.executionsDir),
      ).toEqual(persistedOriginal);
    },
  );

  it('does not narrow an unmapped ancestor root to a split child', async () => {
    const runtime = policyRuntime(root);
    jest.mocked(createElectronExecutionRuntime).mockReturnValue(runtime);
    const ancestor = join(root, 'source-tree');
    const source = join(ancestor, 'repo');
    const destination = join(root, 'destination');
    await seedDestinationPolicy(destination);
    const original = policyExecution(runtime, source);
    original.execution_checkout_root = ancestor;
    await saveExecutionState(original, runtime.executionsDir);
    await migrateSplitPipelineExecutions({
      workspaceId: 'source',
      worktreeId: 'old',
      targets: [
        {
          repoId: 'repo',
          oldCheckoutPath: source,
          newCheckoutPath: destination,
          destinationWorkspaceId: 'destination',
          destinationWorktreeId: 'new',
        },
      ],
    });
    const migrated = await loadExecutionState(
      original.id,
      runtime.executionsDir,
    );
    if (!migrated) throw new Error('Missing relocated execution');
    expect(migrated.execution_checkout_root).toBe(ancestor);
    await replayPolicy(migrated, runtime, 'retry', 'Start over keeps');
  });

  it.each(['resume', 'matrix'] as const)(
    'combine/join primitive maps source-owned targets on %s',
    async (mode) => {
      const runtime = policyRuntime(root);
      jest.mocked(createElectronExecutionRuntime).mockReturnValue(runtime);
      const source = join(root, 'source');
      const destination = join(root, 'joined');
      await writeFile(join(root, 'CLAUDE.md'), 'ANCESTOR');
      await seedDestinationPolicy(destination);
      const original = policyExecution(runtime, source, mode === 'matrix');
      await saveExecutionState(original, runtime.executionsDir);
      const persistedOriginal = await loadExecutionState(
        original.id,
        runtime.executionsDir,
      );
      const snapshots = await migratePipelineExecutions({
        sourceWorkspaceId: 'source',
        sourceWorktreeId: 'old',
        destinationWorkspaceId: 'destination',
        destinationWorktreeId: 'new',
        rewrites: [{ fromRoot: source, toRoot: destination }],
      });
      const migrated = await loadExecutionState(
        original.id,
        runtime.executionsDir,
      );
      if (!migrated) throw new Error('Missing relocated execution');
      await replayPolicy(migrated, runtime, mode);
      expect(migrated).toMatchObject({
        execution_checkout_root: destination,
        cwd: join(destination, 'desktop'),
        target: {
          workspace_id: 'destination',
          worktree_id: 'new',
          path: join(destination, 'desktop'),
        },
      });
      await restorePipelineSnapshots(snapshots);
      expect(
        await loadExecutionState(original.id, runtime.executionsDir),
      ).toEqual(persistedOriginal);
    },
  );
});

describe('pure checkout-location transform', () => {
  const relocation = {
    sourceWorkspaceId: 'source',
    sourceWorktreeId: 'old',
    destinationWorkspaceId: 'destination',
    destinationWorktreeId: 'new',
    rewrites: [
      { fromRoot: '/source', toRoot: '/destination' },
      { fromRoot: '/source/nested', toRoot: '/separate' },
    ],
  };
  it('uses the most-specific mapping and keeps subdirectory boundaries, artifacts and unknown fields', () => {
    const original = {
      cwd: '/source/nested/sub/desktop',
      execution_checkout_root: '/source/nested/sub',
      target: {
        scope: 'worktree',
        workspace_id: 'source',
        worktree_id: 'old',
        path: '/source/nested/sub/desktop',
        future: 42,
      },
      future: { path: '/source/not-a-known-checkout-field' },
      jobs: { log_file: '/artifacts/log' },
    };
    const snapshot = structuredClone(original);
    expect(relocateExecutionCheckout(original, relocation)).toEqual({
      ...original,
      cwd: '/separate/sub/desktop',
      execution_checkout_root: '/separate/sub',
      target: {
        ...original.target,
        workspace_id: 'destination',
        worktree_id: 'new',
        path: '/separate/sub/desktop',
      },
    });
    expect(original).toEqual(snapshot);
  });
  it.each([
    {},
    { execution_checkout_root: null },
    { execution_checkout_root: '' },
    { execution_checkout_root: '/external' },
  ])(
    'preserves missing or unavailable authority and global targets: %j',
    (authority) => {
      const original = {
        ...authority,
        cwd: '/source/desktop',
        scope: 'global',
        target: { scope: 'global' },
      };
      expect(relocateExecutionCheckout(original, relocation)).toEqual({
        ...original,
        cwd: '/destination/desktop',
      });
    },
  );
  it('maps directory targets but does not rewrite a foreign worktree target', () => {
    expect(
      relocateExecutionCheckout(
        { target: { scope: 'directory', path: '/source/sub' } },
        relocation,
      ),
    ).toEqual({ target: { scope: 'directory', path: '/destination/sub' } });
    const foreign = {
      target: {
        scope: 'worktree',
        workspace_id: 'foreign',
        worktree_id: 'old',
        path: '/source/sub',
        extra: true,
      },
    };
    expect(relocateExecutionCheckout(foreign, relocation)).toEqual(foreign);
  });
  it.each([
    {
      repo_path: '/source/nested/sub',
      pipeline_file_dir: '/source/pipelines',
      expectedRepo: '/separate/sub',
      expectedDirectory: '/destination/pipelines',
    },
    {
      repo_path: '/independent/source',
      pipeline_file_dir: '/independent/pipelines',
      expectedRepo: '/independent/source',
      expectedDirectory: '/independent/pipelines',
    },
    {
      repo_path: '/independent/source',
      pipeline_file_dir: '/source/nested/pipelines',
      expectedRepo: '/independent/source',
      expectedDirectory: '/separate/pipelines',
    },
  ])(
    'relocates only source references inside a trusted mapping: %j',
    ({ repo_path, pipeline_file_dir, expectedRepo, expectedDirectory }) => {
      const original = { cwd: '/source/desktop', repo_path, pipeline_file_dir };
      expect(relocateExecutionCheckout(original, relocation)).toEqual({
        cwd: '/destination/desktop',
        repo_path: expectedRepo,
        pipeline_file_dir: expectedDirectory,
      });
      expect(original).toEqual({
        cwd: '/source/desktop',
        repo_path,
        pipeline_file_dir,
      });
    },
  );
  it.each(['/source-other', '/elsewhere', 'relative/path', ''])(
    'does not rebase external or relative path %j',
    (path) => {
      expect(relocateCheckoutPath(path, relocation.rewrites)).toBe(path);
    },
  );
  it('preserves unavailable source locations and absent fields without inventing authority', () => {
    const original = {
      repo_path: null,
      pipeline_file_dir: 42,
      target: { scope: 'global', future: '/source/untouched' },
    };
    expect(relocateExecutionCheckout(original, relocation)).toStrictEqual(
      original,
    );
    expect(relocateExecutionCheckout({}, relocation)).toStrictEqual({});
    expect(
      relocateCheckoutPath('/source/desktop', [
        { fromRoot: 'source', toRoot: '/destination' },
        { fromRoot: '/source', toRoot: 'destination' },
      ]),
    ).toBe('/source/desktop');
  });
});
