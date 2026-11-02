import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveActionRuntime } from '../../action-resolver';
import { resolveChildPipeline } from '../child-pipeline-resolver';
import type { PipelinePackageCapabilityOverlay } from '../../../../types/pipeline';

describe('capability package runtime overlay resolution', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'package-overlay-resolution-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('resolves packaged project actions before workspace action roots', async () => {
    const packagedAction = join(root, 'packaged-action');
    await mkdir(packagedAction, { recursive: true });
    await writeFile(
      join(packagedAction, 'action.yml'),
      'name: Packaged review\nruns:\n  using: composite\n  steps: []\n',
    );
    const overlay: PipelinePackageCapabilityOverlay = {
      packageDigest: `pp:v1:${'A'.repeat(43)}`,
      resources: [
        {
          virtualSourceId: 'package/action',
          resourceId: 'action',
          provider: 'claude',
          rootPath: packagedAction,
          kind: 'pipeline_action',
          displayName: 'project/review',
          invocationKeys: ['project/review'],
        },
      ],
    };

    const resolved = resolveActionRuntime(
      'project/review',
      {
        bundledActionsDir: join(root, 'builtin'),
        getProjectActionsDir: () => join(root, 'workspace-actions'),
        getProjectActionsDirCandidates: () => [join(root, 'workspace-actions')],
      },
      join(root, 'repo'),
      overlay,
    );

    expect(resolved?.definition.name).toBe('Packaged review');
    expect(resolved?.actionDir).toBe(packagedAction);
  });

  it('resolves relative child pipelines from the package overlay', async () => {
    const packagedPipelines = join(root, 'packaged-pipelines');
    await mkdir(join(packagedPipelines, 'children'), { recursive: true });
    await writeFile(
      join(packagedPipelines, 'children', 'review.yaml'),
      'name: Child\non: dispatch\njobs:\n  run:\n    steps:\n      - run: echo child\n',
    );
    const overlay: PipelinePackageCapabilityOverlay = {
      packageDigest: `pp:v1:${'B'.repeat(43)}`,
      resources: [
        {
          virtualSourceId: 'package/child',
          resourceId: 'child',
          provider: 'claude',
          rootPath: packagedPipelines,
          kind: 'child_pipeline',
          displayName: 'children/review.yaml',
          invocationKeys: ['children/review.yaml'],
        },
      ],
    };

    const resolved = await resolveChildPipeline({
      pipelineRef: 'children/review.yaml',
      cwd: join(root, 'cwd'),
      packageOverlay: overlay,
    });

    expect(resolved.pipeline.name).toBe('Child');
    expect(resolved.pipelineId).toBe('review.yaml');
    expect(resolved.preferenceLocator).toEqual({
      type: 'file',
      value: join(packagedPipelines, 'children', 'review.yaml'),
    });
  });

  it('matches an interpolated child ref with surrounding whitespace to the packaged child', async () => {
    const workerId = '5b0f4c3e-2a1d-4e6f-9c8b-7a6d5e4f3a2b';
    const packagedPipelines = join(root, 'packaged-env-child');
    await mkdir(packagedPipelines, { recursive: true });
    await writeFile(
      join(packagedPipelines, `${workerId}.yaml`),
      'name: Worker\non: dispatch\njobs:\n  run:\n    steps:\n      - run: echo worker\n',
    );
    const overlay: PipelinePackageCapabilityOverlay = {
      packageDigest: `pp:v1:${'C'.repeat(43)}`,
      resources: [
        {
          virtualSourceId: 'package/env-child',
          resourceId: 'env-child',
          provider: 'claude',
          rootPath: packagedPipelines,
          kind: 'child_pipeline',
          displayName: '${{ env.WORKER_PIPELINE }}',
          invocationKeys: ['${{ env.WORKER_PIPELINE }}', workerId],
        },
      ],
    };

    // `with.pipeline` is interpolated before the resolver sees it, so a run
    // passes the evaluated id, padded however the env value was written.
    const resolved = await resolveChildPipeline({
      pipelineRef: `  ${workerId}\n`,
      cwd: join(root, 'cwd'),
      packageOverlay: overlay,
    });

    expect(resolved.packaged).toBe(true);
    expect(resolved.pipeline.name).toBe('Worker');
    expect(resolved.preferenceLocator).toEqual({
      type: 'file',
      value: join(packagedPipelines, `${workerId}.yaml`),
    });
  });
});
