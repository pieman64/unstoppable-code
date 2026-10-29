/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unsafe-return */
import {
  IPC_CHANNELS,
  orgDefaultCoworkWorkspaceId,
  type SidebarItem,
  type WorkspaceContextBroadcast,
} from '@canopy/desktop-shared/types';

let mockFlagEnabled = true;
let mockState: WorkspaceContextBroadcast = {
  context: { kind: 'personal' },
  organizations: [],
  revision: 1,
  reason: 'startup',
};
let mockListener: ((state: WorkspaceContextBroadcast) => void) | undefined;
const mockEnsureDefaultChats = jest.fn();
const mockRequestCloud = jest.fn();
const mockEnsureLocal = jest.fn();
const mockReadOwnership = jest.fn();
const mockRecordDiagnostic = jest.fn();
const mockSendToAllWindows = jest.fn();
let mockIndexAuthority: 'ok' | 'absent' | 'partial' | 'unreadable' = 'ok';
let mockTeamsLapsed = false;
let mockSidebarItems: SidebarItem[] = [];
let mockPreserveWorkspaceIds: string[] = [];
let mockAccountRead: object = {
  status: 'ok',
  entry: { capabilities: ['org-projects-v1'] },
};

jest.mock('../feature-flags', () => ({
  getFeatureFlagService: () => ({ isEnabled: () => mockFlagEnabled }),
}));
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: () => ({
    getState: () => mockState,
    subscribe: (listener: (state: WorkspaceContextBroadcast) => void) => {
      mockListener = listener;
      return jest.fn();
    },
  }),
}));
jest.mock('../canopy-cloud/client', () => {
  class MockCanopyCloudClientError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly status?: number,
    ) {
      super(message);
    }
  }
  return {
    CanopyCloudClientError: MockCanopyCloudClientError,
    ensureOrgDefaultChats: (...args: unknown[]) =>
      mockEnsureDefaultChats(...args),
    requestCanopyCloudJson: (...args: unknown[]) => mockRequestCloud(...args),
  };
});
jest.mock('../canopy-cloud/oauth-login', () => ({
  getDesktopOAuthClientDeviceId: () => Promise.resolve('device-1'),
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  getCanopyCloudCredentials: () =>
    Promise.resolve({ capabilities: ['org-projects-v1'] }),
  readCanopyCloudAccountWithStatus: () => Promise.resolve(mockAccountRead),
}));
jest.mock('../lib/org-billing-state', () => ({
  isOrganizationTeamsLapsed: () => Promise.resolve(mockTeamsLapsed),
}));
jest.mock('../lib/installation-generation', () => ({
  readInstallationGeneration: () => Promise.resolve(1),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceOwnership: (...args: unknown[]) => mockReadOwnership(...args),
}));
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItemsSnapshot: () =>
    Promise.resolve({
      file: { version: 1, items: mockSidebarItems },
      authority: mockIndexAuthority,
      indexAuthority: mockIndexAuthority,
    }),
}));
jest.mock('../lib/sidebar-items-preservation', () => ({
  getSidebarItemsPreserveWorkspaceIds: () => mockPreserveWorkspaceIds,
}));
jest.mock('../lib/window-send', () => ({
  sendToAllWindows: (...args: unknown[]) => mockSendToAllWindows(...args),
}));
jest.mock('../lib/cowork-workspace-crud', () => ({
  ensureDefaultCoworkWorkspace: (...args: unknown[]) =>
    mockEnsureLocal(...args),
}));
jest.mock('../observability', () => ({
  getObservabilityService: () => ({
    recordAppDiagnostic: (...args: unknown[]) => mockRecordDiagnostic(...args),
  }),
}));

import {
  getOrgDefaultCoworkEligibility,
  installOrgDefaultCoworkProvisioning,
  isOrgCoworkOperationEligible,
  isOrgMemberCodeOperationEligible,
  resetOrgCoworkBindingForTests,
  startOrgDefaultCoworkProvisioning,
} from '../lib/org-cowork-binding-deps';
import {
  settleDetachedWork,
  trackDetachedWork,
} from '@canopy/desktop-shared/node/lib/detached-work';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  jest.clearAllMocks();
  resetOrgCoworkBindingForTests();
  mockFlagEnabled = true;
  mockTeamsLapsed = false;
  mockIndexAuthority = 'ok';
  mockSidebarItems = [];
  mockPreserveWorkspaceIds = [];
  mockAccountRead = {
    status: 'ok',
    entry: { capabilities: ['org-projects-v1'] },
  };
  mockState = {
    context: { kind: 'personal' },
    organizations: [],
    revision: 1,
    reason: 'startup',
  };
  mockListener = undefined;
  mockReadOwnership.mockResolvedValue({ authority: 'absent' });
  mockEnsureDefaultChats.mockResolvedValue({
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  });
  mockRequestCloud.mockImplementation((path: string) =>
    path.endsWith('/instances/claim')
      ? Promise.resolve({
          instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          operationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          fencingGeneration: 1,
          state: 'CLAIMED',
        })
      : Promise.resolve(undefined),
  );
  mockEnsureLocal.mockResolvedValue(undefined);
});

it('does not provision at startup in Personal scope or when the flag is off', async () => {
  installOrgDefaultCoworkProvisioning();
  await flush();
  expect(mockEnsureDefaultChats).not.toHaveBeenCalled();

  resetOrgCoworkBindingForTests();
  mockFlagEnabled = false;
  mockState = {
    ...mockState,
    context: { kind: 'organization', organizationId },
  };
  installOrgDefaultCoworkProvisioning();
  await flush();
  expect(mockEnsureDefaultChats).not.toHaveBeenCalled();
});

it('starts provisioning on startup in organization scope', async () => {
  mockState = {
    ...mockState,
    context: { kind: 'organization', organizationId },
  };
  installOrgDefaultCoworkProvisioning();
  await flush();
  expect(mockEnsureDefaultChats).toHaveBeenCalledWith({ organizationId });
  expect(mockEnsureLocal).toHaveBeenCalled();
});

it('broadcasts after publishing a repaired indexed organization default', async () => {
  const workspaceId = orgDefaultCoworkWorkspaceId(organizationId);
  mockState = {
    ...mockState,
    context: { kind: 'organization', organizationId },
  };
  mockPreserveWorkspaceIds = [workspaceId];
  mockEnsureLocal.mockImplementation(
    (
      _items: SidebarItem[],
      _preserveIds: string[],
      target: { owner: SidebarItem['owner'] },
      options: { publishToIndex: boolean },
    ) => {
      if (!options.publishToIndex) {
        mockSidebarItems = [
          {
            id: workspaceId,
            name: 'Chats',
            type: 'cowork',
            color: '#7C3AED',
            collapsed: false,
            order: 0,
            owner: target.owner,
          },
        ];
        mockPreserveWorkspaceIds = [];
      }
      return Promise.resolve();
    },
  );

  installOrgDefaultCoworkProvisioning();
  await flush();

  expect(mockEnsureLocal).toHaveBeenCalledTimes(2);
  expect(mockSendToAllWindows).toHaveBeenCalledWith(
    IPC_CHANNELS.workspaceWorktreesUpdated,
    { workspaceId },
  );
  expect(mockRequestCloud.mock.invocationCallOrder[1]).toBeLessThan(
    mockSendToAllWindows.mock.invocationCallOrder[0] ?? 0,
  );
});

it('starts provisioning on a switch into organization scope', async () => {
  installOrgDefaultCoworkProvisioning();
  mockState = {
    ...mockState,
    context: { kind: 'organization', organizationId },
    reason: 'switch',
  };
  mockListener?.(mockState);
  await flush();
  expect(mockEnsureDefaultChats).toHaveBeenCalledWith({ organizationId });
});

it('resolves the provisioning starter only after the default workspace is ensured', async () => {
  mockState = {
    ...mockState,
    context: { kind: 'organization', organizationId },
  };
  let release: (() => void) | undefined;
  mockEnsureLocal.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  let settled = false;
  trackDetachedWork(() => startOrgDefaultCoworkProvisioning(organizationId));
  const settling = settleDetachedWork().then(() => {
    settled = true;
  });
  try {
    for (let turn = 0; turn < 5; turn += 1) await flush();
    expect(mockEnsureLocal).toHaveBeenCalled();
    expect(settled).toBe(false);
  } finally {
    mockEnsureLocal.mockResolvedValue(undefined);
    release?.();
  }
  await settling;
  expect(mockEnsureLocal).toHaveBeenCalledTimes(2);
});

it('resolves the provisioning starter when provisioning fails', async () => {
  mockState = {
    ...mockState,
    context: { kind: 'organization', organizationId },
  };
  mockEnsureLocal.mockRejectedValue(new Error('index write failed'));

  await expect(
    startOrgDefaultCoworkProvisioning(organizationId),
  ).resolves.toBeUndefined();
  mockTeamsLapsed = true;
  await expect(
    startOrgDefaultCoworkProvisioning(organizationId),
  ).resolves.toBeUndefined();
});

it('treats a stored Teams lapse as permanently ineligible without provisioning', async () => {
  mockTeamsLapsed = true;
  mockState = {
    ...mockState,
    context: { kind: 'organization', organizationId },
  };

  installOrgDefaultCoworkProvisioning();
  await flush();

  expect(mockEnsureDefaultChats).not.toHaveBeenCalled();
  await expect(getOrgDefaultCoworkEligibility(organizationId)).resolves.toBe(
    'ineligible',
  );
});

it('propagates a degraded account read and recovers on the next eligibility check', async () => {
  mockState = {
    ...mockState,
    context: { kind: 'organization', organizationId },
  };
  mockAccountRead = { status: 'error', error: new Error('keychain locked') };

  await expect(getOrgDefaultCoworkEligibility(organizationId)).rejects.toThrow(
    'keychain locked',
  );

  mockAccountRead = {
    status: 'ok',
    entry: { capabilities: ['org-projects-v1'] },
  };
  await expect(getOrgDefaultCoworkEligibility(organizationId)).resolves.toBe(
    'eligible',
  );
});

it.each(['partial', 'unreadable'] as const)(
  'does not create locally with %s workspace-index authority',
  async (authority) => {
    mockIndexAuthority = authority;
    mockState = {
      ...mockState,
      context: { kind: 'organization', organizationId },
    };

    installOrgDefaultCoworkProvisioning();
    await flush();

    expect(mockEnsureDefaultChats).toHaveBeenCalledWith({ organizationId });
    expect(mockEnsureLocal).not.toHaveBeenCalled();
    expect(mockRecordDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'org_default_chats_provision_failed',
        reason: 'transient',
      }),
    );
  },
);

describe('membership scope', () => {
  const otherOrganizationId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const membership = { scope: 'membership' } as const;

  beforeEach(() => {
    mockState = {
      context: { kind: 'personal' },
      organizations: [{ id: organizationId, name: 'Acme', role: 'MEMBER' }],
      revision: 1,
      reason: 'startup',
    };
    mockAccountRead = {
      status: 'ok',
      entry: {
        capabilities: ['org-projects-v1', 'org-member-code-projects-v1'],
      },
    };
  });

  it('accepts a member organization from Personal and refuses a non-member one', async () => {
    await expect(
      isOrgCoworkOperationEligible(organizationId, membership),
    ).resolves.toBe(true);
    await expect(
      isOrgCoworkOperationEligible(otherOrganizationId, membership),
    ).resolves.toBe(false);
  });

  it('keeps the selected-context default for existing callers', async () => {
    await expect(isOrgCoworkOperationEligible(organizationId)).resolves.toBe(
      false,
    );
    await expect(
      isOrgMemberCodeOperationEligible(organizationId),
    ).resolves.toBe(false);
    mockState = {
      ...mockState,
      context: { kind: 'organization', organizationId: otherOrganizationId },
    };
    await expect(
      isOrgCoworkOperationEligible(otherOrganizationId),
    ).resolves.toBe(true);
  });

  it('still applies the flag, the Teams lapse, and the account capabilities', async () => {
    mockFlagEnabled = false;
    await expect(
      isOrgCoworkOperationEligible(organizationId, membership),
    ).resolves.toBe(false);
    mockFlagEnabled = true;

    mockAccountRead = {
      status: 'ok',
      entry: { capabilities: ['org-projects-v1'] },
    };
    await expect(
      isOrgCoworkOperationEligible(organizationId, membership),
    ).resolves.toBe(true);
    await expect(
      isOrgMemberCodeOperationEligible(organizationId, membership),
    ).resolves.toBe(false);
    mockAccountRead = { status: 'ok', entry: { capabilities: [] } };
    await expect(
      isOrgCoworkOperationEligible(organizationId, membership),
    ).resolves.toBe(false);

    mockAccountRead = {
      status: 'ok',
      entry: {
        capabilities: ['org-projects-v1', 'org-member-code-projects-v1'],
      },
    };
    mockTeamsLapsed = true;
    await expect(
      isOrgCoworkOperationEligible(organizationId, membership),
    ).resolves.toBe(false);
  });

  it('forwards the scope from the member Code check', async () => {
    await expect(
      isOrgMemberCodeOperationEligible(organizationId, membership),
    ).resolves.toBe(true);
    await expect(
      isOrgMemberCodeOperationEligible(otherOrganizationId, membership),
    ).resolves.toBe(false);
  });
});
