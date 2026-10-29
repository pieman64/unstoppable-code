const mockIsEnabled = jest.fn<boolean, [string]>();
const mockPeekCanopyCloudAccount = jest.fn<
  { capabilities: string[] } | null,
  []
>();
const mockBuildProjectedModelCatalog = jest.fn((): [] => []);

jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): { isEnabled: typeof mockIsEnabled } => ({
    isEnabled: mockIsEnabled,
  }),
}));
jest.mock('../../lib/canopy-cloud-account-store', () => ({
  peekCanopyCloudAccount: (): { capabilities: string[] } | null =>
    mockPeekCanopyCloudAccount(),
}));
jest.mock('../../auth/provider-auth-state', () => ({
  peekPortalProviderAvailability: (): Record<string, never> => ({}),
}));
jest.mock('../model-catalog-projection', () => ({
  buildProjectedModelCatalog: (...args: unknown[]): [] =>
    mockBuildProjectedModelCatalog(...args),
}));

import type { PortalEntityEnvelope } from '@canopy/desktop-shared/types';
import { projectNewTaskControls } from '../worktree-new-task-controls';

const worktree = {
  entityType: 'worktree',
  localId: 'worktree-1',
  payload: {},
} as PortalEntityEnvelope;

describe('projectNewTaskControls model routing capability', () => {
  beforeEach(() => {
    mockIsEnabled.mockReset();
    mockPeekCanopyCloudAccount.mockReset();
  });

  it.each([
    ['the effective rollout flag is disabled', false, ['model-routing-v1']],
    ['the paired server lacks the capability', true, ['portal-v1']],
  ])('does not advertise Auto when %s', (_label, flag, capabilities) => {
    mockIsEnabled.mockReturnValue(flag);
    mockPeekCanopyCloudAccount.mockReturnValue({ capabilities });

    const projected = projectNewTaskControls(
      [worktree],
      'worktree-1',
      undefined,
    )[0];

    expect(projected?.payload).not.toHaveProperty('modelRoutingSupported');
  });

  it('advertises Auto only when rollout and server capability are effective', () => {
    mockIsEnabled.mockReturnValue(true);
    mockPeekCanopyCloudAccount.mockReturnValue({
      capabilities: ['portal-v1', 'model-routing-v1'],
    });

    const owner = {
      kind: 'organization' as const,
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    };
    const projected = projectNewTaskControls(
      [worktree],
      'worktree-1',
      owner,
    )[0];

    expect(projected?.payload).toMatchObject({ modelRoutingSupported: true });
    expect(mockBuildProjectedModelCatalog).toHaveBeenCalledWith(undefined, {
      cursor: true,
      copilot: true,
      opencode: true,
      owner,
    });
  });
});
