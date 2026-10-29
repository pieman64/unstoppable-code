import type { PipelinePackageManifestV1 } from '@canopy/protocol/pipelines';
import {
  filterPackageOverlayForBindingKey,
  filterPipelinePackageOverlayForStep,
  resourceIdsForBindingKey,
  resourceIdsForPipelineStep,
} from '../package-runtime';

const manifest: PipelinePackageManifestV1 = {
  version: 1,
  pipelineContentHash: 'a'.repeat(64),
  resources: [],
  bindings: [
    { jobId: 'job', stepId: 'step', resourceIds: ['one'] },
    { jobId: 'automation', stepId: 'action', resourceIds: ['two'] },
  ],
  environmentRequirements: [],
  totalFiles: 0,
  totalBytes: 0,
};

describe('capability package binding filters', () => {
  it('resolves generic binding keys and preserves the pipeline wrappers', () => {
    expect(resourceIdsForBindingKey(manifest, 'automation\0action')).toEqual([
      'two',
    ]);
    expect(resourceIdsForPipelineStep(manifest, 'job', 'step')).toEqual([
      'one',
    ]);
  });

  it('filters overlays through generic keys and pipeline wrappers', () => {
    const overlay = {
      packageDigest: `pp:v1:${'a'.repeat(43)}`,
      resources: [
        {
          virtualSourceId: 'one',
          resourceId: 'one',
          provider: 'claude' as const,
          rootPath: '/one',
          kind: 'standalone_skill' as const,
          displayName: 'One',
        },
        {
          virtualSourceId: 'two',
          resourceId: 'two',
          provider: 'claude' as const,
          rootPath: '/two',
          kind: 'standalone_skill' as const,
          displayName: 'Two',
        },
      ],
    };
    expect(
      filterPackageOverlayForBindingKey(
        overlay,
        manifest.bindings,
        'automation\0action',
      )?.resources.map((resource) => resource.resourceId),
    ).toEqual(['two']);
    expect(
      filterPipelinePackageOverlayForStep(
        overlay,
        manifest.bindings,
        'job',
        'step',
      )?.resources.map((resource) => resource.resourceId),
    ).toEqual(['one']);
  });
});
