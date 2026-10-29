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
});
