import { assertResourceContextForContext } from '../lib/resource-context';
import { assertInstalledResourceContext } from '../lib/resource-install-context';
import type {
  InstallReceipt,
  ResourceContextDecision,
  ResourceContextInput,
} from '@canopy/desktop-shared/lib/resource-context-policy';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import { serializeWorkspaceContext } from '@canopy/protocol/workspace-context';

const mockDecide = jest.fn<
  Promise<ResourceContextDecision>,
  [ResourceContextInput]
>(() => Promise.resolve({ allow: true }));
jest.mock('../services/resource-context-policy-service', () => ({
  getResourceContextPolicyService: (): {
    decide: (input: ResourceContextInput) => Promise<ResourceContextDecision>;
  } => ({
    decide: (input): Promise<ResourceContextDecision> => mockDecide(input),
  }),
}));

const mockFindLocal = jest.fn<
  Promise<{ accountId: string; receipt: InstallReceipt } | undefined>,
  [string, string]
>();
jest.mock('../lib/resource-install-receipts', () => ({
  createResourceInstallReceiptsStore: (): {
    findLocal: (
      family: string,
      localId: string,
    ) => ReturnType<typeof mockFindLocal>;
  } => ({
    findLocal: (family, localId): ReturnType<typeof mockFindLocal> =>
      mockFindLocal(family, localId),
  }),
}));

jest.mock('../lib/canopy-cloud-account-store', () => ({
  readCanopyCloudAccountWithStatus: (): Promise<{
    status: 'ok';
    entry: { account: { id: string } };
  }> =>
    Promise.resolve({ status: 'ok', entry: { account: { id: 'account-1' } } }),
}));

jest.mock('../feature-flags', () => ({
  getFeatureFlagService: (): { isEnabled: () => boolean } => ({
    isEnabled: (): boolean => true,
  }),
}));

describe('explicit resource context authorization', () => {
  const ownerContext: WorkspaceContext = {
    kind: 'organization',
    organizationId: 'org-1',
  };

  beforeEach(() => {
    mockDecide.mockReset().mockResolvedValue({ allow: true });
    mockFindLocal.mockReset().mockResolvedValue(undefined);
  });

  it('asks policy to authorize a background invocation in the supplied context', async (): Promise<void> => {
    await assertResourceContextForContext(
      { owner: { type: 'organization', id: 'org-1', name: 'Acme' } },
      ownerContext,
    );

    expect(mockDecide).toHaveBeenCalledWith({
      resource: { owner: { type: 'organization', id: 'org-1', name: 'Acme' } },
      invocation: {
        mode: 'background',
        context: ownerContext,
        executionContext: serializeWorkspaceContext(ownerContext),
      },
    });
  });

  it('revalidates an installed automation receipt and current remote owner in that context', async (): Promise<void> => {
    const receipt: InstallReceipt = {
      family: 'automations',
      remoteId: 'remote-automation-1',
      localResourceIds: ['activity-1'],
      shareScope: 'organization',
      ownerContext,
      hash: 'hash-1',
      authorizedAt: '2026-05-28T12:00:00.000Z',
    };
    mockFindLocal.mockResolvedValue({ accountId: 'account-1', receipt });
    const fetch = jest.fn<
      Promise<{
        id: string;
        contentHash: string;
        owner: { type: 'organization'; id: string; name: string };
      }>,
      [string]
    >(() =>
      Promise.resolve({
        id: 'remote-automation-1',
        contentHash: 'hash-1',
        owner: { type: 'organization', id: 'org-1', name: 'Acme' },
      }),
    );

    await assertInstalledResourceContext(
      'automations',
      'activity-1',
      fetch,
      ownerContext,
    );

    expect(mockFindLocal).toHaveBeenCalledWith('automations', 'activity-1');
    expect(fetch).toHaveBeenCalledWith('remote-automation-1');
    expect(mockDecide).toHaveBeenCalledWith({
      resource: {
        owner: { type: 'organization', id: 'org-1', name: 'Acme' },
        provenance: receipt,
      },
      invocation: {
        mode: 'background',
        context: ownerContext,
        executionContext: serializeWorkspaceContext(ownerContext),
      },
    });
  });
});
