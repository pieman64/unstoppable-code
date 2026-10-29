import { isPipelinePackageRunBlocked } from '../useCapabilityPackageReadiness';
import type { PipelinePackageReadiness } from '@canopy/desktop-shared/types/pipeline';

function requirement(
  overrides: Partial<PipelinePackageReadiness['requirements'][number]> = {},
): PipelinePackageReadiness['requirements'][number] {
  return {
    id: 'github',
    kind: 'connector',
    displayName: 'GitHub authentication',
    required: true,
    affectedSteps: [{ jobId: 'ship', stepId: 'open_pr' }],
    setupHint: 'Connect GitHub in Settings.',
    status: 'available',
    ...overrides,
  };
}

describe('isPipelinePackageRunBlocked', () => {
  it('does not block when there is no readiness data at all', () => {
    // A pipeline with no package (or a build without the readiness IPC) must
    // keep today's unblocked Run behavior.
    expect(isPipelinePackageRunBlocked(null)).toBe(false);
  });

  it('does not block when every required check is available', () => {
    expect(
      isPipelinePackageRunBlocked({
        status: 'ready',
        requirements: [requirement()],
        publisherNotes: [
          {
            id: 'not-a-command-collect-py',
            kind: 'not_a_command',
            label: '/collect.py',
            affectedSteps: [],
          },
        ],
      }),
    ).toBe(false);
  });

  it('blocks on a required missing requirement', () => {
    expect(
      isPipelinePackageRunBlocked({
        status: 'setup_required',
        requirements: [requirement({ status: 'missing' })],
      }),
    ).toBe(true);
  });

  it('does not block on an optional missing requirement', () => {
    expect(
      isPipelinePackageRunBlocked({
        status: 'setup_required',
        requirements: [requirement({ required: false, status: 'missing' })],
      }),
    ).toBe(false);
  });

  it('does not let an unknown check masquerade as blocking or as available', () => {
    // Unknown is surfaced in the UI but never guessed either way.
    expect(
      isPipelinePackageRunBlocked({
        status: 'setup_required',
        requirements: [requirement({ status: 'unknown' })],
      }),
    ).toBe(false);
  });

  it('blocks when the package itself failed verification', () => {
    expect(
      isPipelinePackageRunBlocked({ status: 'invalid', requirements: [] }),
    ).toBe(true);
  });
});
