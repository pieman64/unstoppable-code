import {
  computeRequiredResourceIds,
  describeDependencyReason,
} from '../capability-package-closure';
import type { PipelinePackageManifestV1 } from '@canopy/protocol/pipelines';

/**
 * Mirrors the motivating pipeline: `/review-loop` is bound to a step and
 * transitively pulls in `review-multi`, which itself pulls in a support file.
 * An unrelated resource is present to prove it stays publisher-optional.
 */
const manifest: PipelinePackageManifestV1 = {
  version: 1,
  pipelineContentHash: 'a'.repeat(64),
  resources: [
    {
      id: 'review-loop',
      kind: 'plugin_command',
      displayName: '/review-loop',
      sourceLabel: 'ud-code-review',
      sourceVisibility: 'private',
      invocationKeys: ['/review-loop'],
      dependencyResourceIds: ['review-multi'],
      trees: [],
    },
    {
      id: 'review-multi',
      kind: 'plugin_skill',
      displayName: 'review-multi',
      sourceLabel: 'ud-code-review',
      sourceVisibility: 'private',
      invocationKeys: ['ud-code-review:review-multi'],
      dependencyResourceIds: ['pr-diff-operations'],
      trees: [],
    },
    {
      id: 'pr-diff-operations',
      kind: 'plugin_skill',
      displayName: 'pr-diff-operations',
      sourceLabel: 'ud-git',
      sourceVisibility: 'private',
      invocationKeys: ['ud-git:pr-diff-operations'],
      dependencyResourceIds: [],
      trees: [],
    },
    {
      id: 'unrelated',
      kind: 'standalone_skill',
      displayName: 'unrelated',
      sourceLabel: 'local',
      sourceVisibility: 'local',
      invocationKeys: ['unrelated'],
      dependencyResourceIds: [],
      trees: [],
    },
  ],
  bindings: [
    { jobId: 'review', stepId: 'review_loop', resourceIds: ['review-loop'] },
  ],
  environmentRequirements: [],
  totalFiles: 0,
  totalBytes: 0,
};

describe('computeRequiredResourceIds', () => {
  it('locks on the bound resource and its transitive closure', () => {
    const required = computeRequiredResourceIds(manifest);
    expect([...required].sort()).toEqual([
      'pr-diff-operations',
      'review-loop',
      'review-multi',
    ]);
  });

  it('leaves an unreferenced resource publisher-optional', () => {
    expect(computeRequiredResourceIds(manifest).has('unrelated')).toBe(false);
  });

  it('terminates on a dependency cycle', () => {
    const cyclic: PipelinePackageManifestV1 = {
      ...manifest,
      resources: [
        { ...manifest.resources[0], dependencyResourceIds: ['review-multi'] },
        { ...manifest.resources[1], dependencyResourceIds: ['review-loop'] },
      ],
    };
    expect([...computeRequiredResourceIds(cyclic)].sort()).toEqual([
      'review-loop',
      'review-multi',
    ]);
  });
});

describe('describeDependencyReason', () => {
  it('has no reason to give for a directly bound resource', () => {
    expect(describeDependencyReason(manifest, 'review-loop')).toBeNull();
  });

  it('explains a first-level transitive inclusion', () => {
    expect(describeDependencyReason(manifest, 'review-multi')).toBe(
      'Required by /review-loop → ud-code-review:review-multi',
    );
  });

  it('explains a deeper chain through every intermediate hop', () => {
    expect(describeDependencyReason(manifest, 'pr-diff-operations')).toBe(
      'Required by /review-loop → ud-code-review:review-multi → ud-git:pr-diff-operations',
    );
  });

  it('returns null for an unreachable resource', () => {
    expect(describeDependencyReason(manifest, 'unrelated')).toBeNull();
  });
});
