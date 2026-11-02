/**
 * @jest-environment jsdom
 *
 * Covers the shared scope selector and team/organization pickers inside the
 * Share Agent modal: re-sharing preselects the current remote owner, and a
 * first share requires picking a target from the shared picker.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AgentModelDefinition,
  SharedAgentDetail,
} from '@canopy/desktop-shared/types/agent-models';

const mockUseCurrentUiStateReporter = jest.fn();
jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (...args: unknown[]): void => {
    mockUseCurrentUiStateReporter(...args);
  },
}));

const mockPostShareToast = jest.fn();
jest.mock('@/lib/share-toast', () => ({
  postShareToast: (toast: unknown): void => {
    mockPostShareToast(toast);
  },
}));

jest.mock('@/hooks/useUnifiedTableData', () => ({
  useUnifiedTableData: (): { rows: unknown[]; loading: boolean } => ({
    rows: [],
    loading: false,
  }),
}));

import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { AGENT_PUBLIC_SHARE_CHANGED_EVENT } from '@/lib/share-links';
import { ShareAgentModal } from '../ShareAgentModal';

const TEAM = {
  id: 'team-1',
  name: 'Platform',
  organization: { id: 'org-1', name: 'Acme' },
};
const OTHER_TEAM = {
  id: 'team-2',
  name: 'Design',
  organization: { id: 'org-1', name: 'Acme' },
};
const ORG = { id: 'org-1', name: 'Acme' };
const OTHER_ORG = { id: 'org-2', name: 'Initech' };

const mockCreateShared = jest.fn<Promise<SharedAgentDetail>, [unknown]>();
const mockUpdateShared = jest.fn<Promise<SharedAgentDetail>, [unknown]>();
const mockGetShared = jest.fn<Promise<SharedAgentDetail>, [string]>();
const mockRevokePublicShare = jest.fn<Promise<void>, [string, string?]>();
const mockPublishPublicShare = jest.fn();
const mockListSharedTeams = jest.fn();
const mockListSharedOrganizations = jest.fn();

let root: Root | null = null;

function agentDef(
  over: Partial<AgentModelDefinition> = {},
): AgentModelDefinition {
  return {
    id: 'agent_model_reviewer',
    name: 'Code Reviewer',
    baseModel: 'claude-agents-test',
    instructions: '',
    pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    ...over,
  };
}

function sharedDetail(
  over: Partial<SharedAgentDetail> = {},
): SharedAgentDetail {
  return {
    id: 'shared-agent-id',
    name: 'Code Reviewer',
    modelId: 'agent_model_reviewer',
    baseModel: 'claude-agents-test',
    instructionsPreview: '',
    contentHash: 'server-hash',
    shareScope: 'private',
    owner: { type: 'user', id: 'acct', name: 'Me' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    createdBy: { id: 'acct', name: 'Me', email: 'me@example.test' },
    canUpdate: true,
    canDelete: true,
    publicShare: null,
    agent: {
      version: 1,
      id: 'agent_model_reviewer',
      name: 'Code Reviewer',
      baseModel: 'claude-agents-test',
      instructions: '',
      plugins: [],
    },
    ...over,
  };
}

function publicShareInfo(
  over: Partial<NonNullable<SharedAgentDetail['publicShare']>> = {},
): NonNullable<SharedAgentDetail['publicShare']> {
  return {
    externalId: 'public-agent-id',
    pinnedContentHash: 'server-hash',
    upToDate: true,
    sharePath: '/s/agents/public-agent',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...over,
  };
}

/** An existing share owned by {@link ORG}: a real audience to update. */
function organizationDetail(
  over: Partial<SharedAgentDetail> = {},
): SharedAgentDetail {
  return sharedDetail({
    shareScope: 'organization',
    owner: { type: 'organization', id: ORG.id, name: ORG.name },
    ...over,
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve();
    }
  });
}

async function renderModal(
  agent: AgentModelDefinition,
  onPublicLinkRemoved?: () => void,
): Promise<void> {
  root = createRoot(document.body);
  act(() => {
    root?.render(
      createElement(ShareAgentModal, {
        agent,
        onClose: (): void => {},
        onOpenAccountSettings: (): void => {},
        onShared: (): void => {},
        ...(onPublicLinkRemoved ? { onPublicLinkRemoved } : {}),
      }),
    );
  });
  await flush();
}

function byTestId(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function shareButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    '[data-testid="share-agent-submit"]',
  );
}

async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error('element to click not found');
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  mockPostShareToast.mockClear();
  mockCreateShared.mockReset();
  mockUpdateShared.mockReset();
  mockGetShared.mockReset();
  mockRevokePublicShare.mockReset();
  mockPublishPublicShare.mockReset();
  mockListSharedTeams.mockReset();
  mockListSharedOrganizations.mockReset();
  mockUseCurrentUiStateReporter.mockClear();
  mockCreateShared.mockResolvedValue(sharedDetail());
  mockUpdateShared.mockResolvedValue(sharedDetail());
  mockGetShared.mockResolvedValue(sharedDetail());
  mockRevokePublicShare.mockResolvedValue(undefined);
  mockPublishPublicShare.mockResolvedValue({
    sharePath: '/s/agents/public-agent',
    upToDate: true,
  });
  mockListSharedTeams.mockResolvedValue({
    success: true,
    data: { data: [OTHER_TEAM, TEAM] },
  });
  mockListSharedOrganizations.mockResolvedValue({
    success: true,
    data: { data: [OTHER_ORG, ORG] },
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      getCanopyCloudBaseUrl: jest
        .fn()
        .mockResolvedValue('https://cloud.example.test'),
      loadCanopyCloudAccount: jest.fn().mockResolvedValue({
        hasApiKey: true,
        account: { id: 'acct' },
        capabilities: ['agents-crud-v1', 'teams-v1', 'organizations-v1'],
      }),
    },
  });
  Object.defineProperty(window, 'pipelines', {
    configurable: true,
    value: {
      listSharedTeams: mockListSharedTeams,
      listSharedOrganizations: mockListSharedOrganizations,
    },
  });
  Object.defineProperty(window, 'agents', {
    configurable: true,
    value: {
      analyzeCapabilityPackage: jest.fn().mockResolvedValue({
        analysisId: 'analysis-empty',
        state: 'ready',
        blockers: [],
        manifest: { resources: [], bindings: [], environmentRequirements: [] },
      }),
      cancelCapabilityPackageAnalysis: jest.fn().mockResolvedValue(undefined),
      commitCapabilityPackage: jest.fn(),
      createShared: mockCreateShared,
      updateShared: mockUpdateShared,
      getShared: mockGetShared,
      publishPublicShare: mockPublishPublicShare,
      revokePublicShare: mockRevokePublicShare,
    },
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = '';
});

describe('ShareAgentModal', () => {
  it('reports the active Agent share state to App Advisor', async () => {
    await renderModal(agentDef({ remoteId: 'shared-agent-id' }));

    expect(mockUseCurrentUiStateReporter).toHaveBeenLastCalledWith(
      'agents.shareModal',
      {
        open: true,
        localAgentId: 'agent_model_reviewer',
        sharedAgentId: 'shared-agent-id',
        state: 'unpublished',
        busy: false,
        copied: false,
        canUpdate: true,
      },
    );
  });

  it('reports the Agent public share as unavailable after account loss', async () => {
    mockGetShared.mockResolvedValue(
      sharedDetail({
        publicShare: publicShareInfo({
          externalId: 'public-agent-id',
        }),
      }),
    );
    await renderModal(agentDef({ remoteId: 'shared-agent-id' }));

    expect(mockUseCurrentUiStateReporter).toHaveBeenLastCalledWith(
      'agents.shareModal',
      expect.objectContaining({ state: 'published' }),
    );

    jest.mocked(window.api.loadCanopyCloudAccount).mockResolvedValue({
      hasApiKey: false,
      capabilities: [],
      authMode: null,
      credentialSource: null,
      storageAvailable: true,
    });
    act(() => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    });
    await flush();

    expect(mockUseCurrentUiStateReporter).toHaveBeenLastCalledWith(
      'agents.shareModal',
      expect.objectContaining({ state: 'unavailable' }),
    );
  });

  it('blocks an update until the existing public-share state is loaded', async () => {
    let resolveDetail: (detail: SharedAgentDetail) => void = () => {};
    mockGetShared.mockReturnValue(
      new Promise((resolve) => {
        resolveDetail = resolve;
      }),
    );

    await renderModal(agentDef({ remoteId: 'shared-agent-id' }));

    expect(shareButton()).toBeNull();
    expect(
      document.querySelector('[data-testid="share-agent-preflight"]'),
    ).not.toBeNull();
    act(() => {
      resolveDetail(
        sharedDetail({
          publicShare: publicShareInfo({
            sharePath: '/s/agents/public-agent',
          }),
        }),
      );
    });
    await flush();
    expect(
      byTestId('share-agent-scope-public')?.getAttribute('aria-checked'),
    ).toBe('true');
    expect(shareButton()?.disabled).toBe(false);
  });

  it('blocks a transient existing-share load failure and offers Retry', async () => {
    mockGetShared.mockRejectedValueOnce(
      Object.assign(new Error('HTTP 503'), { status: 503 }),
    );
    await renderModal(agentDef({ remoteId: 'shared-agent-id' }));

    expect(byTestId('share-agent-unavailable')?.textContent).toContain(
      'existing agent share could not be loaded',
    );
    expect(byTestId('share-agent-unavailable-action')?.textContent).toBe(
      'Retry',
    );
    expect(shareButton()).toBeNull();
  });

  it('does not recreate a missing share linked to another cloud account', async () => {
    mockGetShared.mockRejectedValueOnce(
      Object.assign(new Error('HTTP 404'), { status: 404 }),
    );
    await renderModal(
      agentDef({
        remoteId: 'shared-agent-id',
        remoteAccountId: 'different-account',
        remoteContentHash: 'server-hash',
      }),
    );

    expect(byTestId('share-agent-unavailable')?.textContent).toContain(
      'existing agent share could not be loaded',
    );
    expect(shareButton()).toBeNull();
    expect(mockCreateShared).not.toHaveBeenCalled();
  });

  it('atomically revokes the observed public link with a narrower update', async () => {
    mockGetShared.mockResolvedValue(
      sharedDetail({
        publicShare: publicShareInfo({
          externalId: 'public-agent-id',
          updatedAt: '2026-08-30T00:00:00.000Z',
        }),
      }),
    );
    await renderModal(
      agentDef({
        remoteId: 'shared-agent-id',
        remoteContentHash: 'server-hash',
      }),
    );

    // Narrowing Public to a team revokes the link inside the same update.
    await click(byTestId('share-agent-scope-team'));
    await click(byTestId(`share-agent-team-picker-option-${TEAM.id}`));
    await click(shareButton());

    expect(mockUpdateShared).toHaveBeenCalledWith(
      expect.objectContaining({
        shareScope: 'team',
        teamId: TEAM.id,
        revokePublicShare: {
          externalId: 'public-agent-id',
          updatedAt: '2026-08-30T00:00:00.000Z',
        },
      }),
    );
    expect(mockRevokePublicShare).not.toHaveBeenCalled();
    expect(mockPublishPublicShare).not.toHaveBeenCalled();
  });

  it('repairs stale local metadata with the freshly loaded remote hash', async () => {
    mockGetShared.mockResolvedValue(
      organizationDetail({ contentHash: 'fresh-server-hash' }),
    );
    await renderModal(
      agentDef({
        remoteId: 'shared-agent-id',
        remoteContentHash: 'stale-local-hash',
      }),
    );

    await click(shareButton());

    expect(mockUpdateShared).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'shared-agent-id',
        expectedContentHash: 'fresh-server-hash',
      }),
    );
  });

  it('detaches an existing package after a ready empty analysis', async () => {
    mockGetShared.mockResolvedValue(organizationDetail());
    await renderModal(agentDef({ remoteId: 'shared-agent-id' }));

    await click(shareButton());

    expect(mockUpdateShared).toHaveBeenCalledWith(
      expect.objectContaining({ capabilityPackage: null }),
    );
  });

  it('preselects the team that owns a re-shared agent', async () => {
    mockGetShared.mockResolvedValue(
      sharedDetail({
        shareScope: 'team',
        owner: {
          type: 'team',
          id: TEAM.id,
          name: TEAM.name,
          organization: TEAM.organization,
        },
      }),
    );
    await renderModal(agentDef({ remoteId: 'shared-agent-id' }));

    expect(
      byTestId('share-agent-scope-team')?.getAttribute('aria-checked'),
    ).toBe('true');
    expect(mockListSharedTeams).toHaveBeenCalled();
    expect(
      byTestId(`share-agent-team-picker-option-${TEAM.id}`)?.getAttribute(
        'aria-pressed',
      ),
    ).toBe('true');
    expect(
      byTestId(`share-agent-team-picker-option-${OTHER_TEAM.id}`)?.getAttribute(
        'aria-pressed',
      ),
    ).toBe('false');
    // The team row carries its organization as the secondary label.
    expect(
      byTestId(`share-agent-team-picker-option-${TEAM.id}`)?.textContent,
    ).toContain('Acme');
  });

  it('keeps a newly selected team across the parent state rerender', async () => {
    mockGetShared.mockResolvedValue(
      sharedDetail({
        shareScope: 'team',
        owner: {
          type: 'team',
          id: TEAM.id,
          name: TEAM.name,
          organization: TEAM.organization,
        },
      }),
    );
    await renderModal(agentDef({ remoteId: 'shared-agent-id' }));

    await click(byTestId(`share-agent-team-picker-option-${OTHER_TEAM.id}`));

    expect(
      byTestId(`share-agent-team-picker-option-${OTHER_TEAM.id}`)?.getAttribute(
        'aria-pressed',
      ),
    ).toBe('true');
    expect(
      byTestId(`share-agent-team-picker-option-${TEAM.id}`)?.getAttribute(
        'aria-pressed',
      ),
    ).toBe('false');
    await click(shareButton());
    expect(mockUpdateShared).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: OTHER_TEAM.id }),
    );
  });

  it('preselects the organization that owns a re-shared agent', async () => {
    mockGetShared.mockResolvedValue(
      sharedDetail({
        shareScope: 'organization',
        owner: { type: 'organization', id: ORG.id, name: ORG.name },
      }),
    );
    await renderModal(agentDef({ remoteId: 'shared-agent-id' }));

    expect(
      byTestId('share-agent-scope-organization')?.getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      byTestId(
        `share-agent-organization-picker-option-${ORG.id}`,
      )?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      byTestId(
        `share-agent-organization-picker-option-${OTHER_ORG.id}`,
      )?.getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('requires a team pick before a first share and sends the chosen team', async () => {
    await renderModal(agentDef());

    await click(byTestId('share-agent-scope-team'));

    const search = byTestId('share-agent-team-picker')?.querySelector('input');
    expect(search?.getAttribute('placeholder')).toBe('Search teams…');
    expect(shareButton()?.disabled).toBe(true);

    await click(byTestId(`share-agent-team-picker-option-${TEAM.id}`));
    expect(shareButton()?.disabled).toBe(false);

    await click(shareButton());
    expect(mockCreateShared).toHaveBeenCalledTimes(1);
    expect(mockCreateShared.mock.calls[0]?.[0]).toMatchObject({
      shareScope: 'team',
      teamId: TEAM.id,
    });
  });
  it('keeps the scope selectable but blocks Share while packaging is blocked', async () => {
    Object.defineProperty(window, 'agents', {
      configurable: true,
      value: {
        ...window.agents,
        analyzeCapabilityPackage: jest.fn().mockResolvedValue({
          analysisId: 'analysis-blocked',
          state: 'blocked',
          blockers: [
            {
              code: 'SOURCE_PATH_ESCAPE',
              message: 'A dependency cannot be packaged safely.',
            },
          ],
          manifest: null,
        }),
      },
    });
    await renderModal(agentDef());

    const teamScope = byTestId('share-agent-scope-team');
    expect(teamScope?.hasAttribute('disabled')).toBe(false);
    await click(teamScope);
    expect(teamScope?.getAttribute('aria-checked')).toBe('true');
    await click(byTestId(`share-agent-team-picker-option-${TEAM.id}`));

    expect(shareButton()?.disabled).toBe(true);
    expect(byTestId('share-agent-definition-only')).toBeNull();
    await click(shareButton());
    expect(mockCreateShared).not.toHaveBeenCalled();
  });

  it('clears the picked team and reloads the list when the account changes', async () => {
    await renderModal(agentDef());
    await click(byTestId('share-agent-scope-team'));
    await click(byTestId(`share-agent-team-picker-option-${TEAM.id}`));
    expect(
      byTestId(`share-agent-team-picker-option-${TEAM.id}`)?.getAttribute(
        'aria-pressed',
      ),
    ).toBe('true');
    const loadsBefore = mockListSharedTeams.mock.calls.length;

    // Another account with the same capabilities: `enabled` stays true, so
    // only the account identity can force the reload and the reset.
    jest.mocked(window.api.loadCanopyCloudAccount).mockResolvedValue({
      hasApiKey: true,
      capabilities: ['agents-crud-v1', 'teams-v1', 'organizations-v1'],
      authMode: 'api_key',
      credentialSource: 'manual',
      storageAvailable: true,
      account: {
        id: 'acct-2',
        name: 'Alice',
        email: 'alice@example.com',
        role: 'ADMIN',
      },
    });
    act(() => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    });
    await flush();

    expect(mockListSharedTeams.mock.calls.length).toBeGreaterThan(loadsBefore);
    expect(
      byTestId(`share-agent-team-picker-option-${TEAM.id}`)?.getAttribute(
        'aria-pressed',
      ),
    ).toBe('false');
    expect(shareButton()?.disabled).toBe(true);
  });

  it('opens a private share without a public link as a first share', async () => {
    // The default detail is `private` with no public share: the owner's
    // Personal copy, not an audience the author picked.
    await renderModal(agentDef({ remoteId: 'shared-agent-id' }));

    expect(byTestId('share-agent-scope-private')).toBeNull();
    expect(shareButton()?.textContent?.trim()).toBe('Share');
    expect(
      byTestId('share-agent-scope-public')?.getAttribute('aria-checked'),
    ).not.toBe('true');
    expect(byTestId('share-agent-remove-public-link')).toBeNull();
  });

  it('removes an existing public link behind a confirm and announces it', async () => {
    mockGetShared.mockResolvedValue(
      sharedDetail({
        publicShare: publicShareInfo({
          externalId: 'public-agent-id',
          updatedAt: '2026-08-30T00:00:00.000Z',
        }),
      }),
    );
    const changed = jest.fn();
    const onPublicLinkRemoved = jest.fn();
    window.addEventListener(AGENT_PUBLIC_SHARE_CHANGED_EVENT, changed);
    try {
      await renderModal(
        agentDef({ remoteId: 'shared-agent-id' }),
        onPublicLinkRemoved,
      );

      expect(
        byTestId('share-agent-scope-public')?.getAttribute('aria-checked'),
      ).toBe('true');
      expect(byTestId('share-agent-copy-link')).not.toBeNull();

      // Cancel leaves the link in place.
      await click(byTestId('share-agent-remove-public-link'));
      expect(byTestId('share-agent-remove-public-link-confirm')).not.toBeNull();
      await click(byTestId('share-agent-remove-public-link-cancel'));
      expect(byTestId('share-agent-remove-public-link-confirm')).toBeNull();
      expect(mockRevokePublicShare).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled();
      expect(onPublicLinkRemoved).not.toHaveBeenCalled();

      await click(byTestId('share-agent-remove-public-link'));
      await click(byTestId('share-agent-remove-public-link-confirm-action'));

      expect(mockRevokePublicShare).toHaveBeenCalledTimes(1);
      expect(mockRevokePublicShare).toHaveBeenCalledWith('shared-agent-id');
      expect(mockUpdateShared).not.toHaveBeenCalled();
      expect(changed).toHaveBeenCalledTimes(1);
      // The Agents page refreshes its Shared list from this hook.
      expect(onPublicLinkRemoved).toHaveBeenCalledTimes(1);
      expect(byTestId('share-agent-remove-public-link-confirm')).toBeNull();
      expect(mockPostShareToast).toHaveBeenCalledWith({
        tone: 'success',
        message: 'Public link removed',
      });
    } finally {
      window.removeEventListener(AGENT_PUBLIC_SHARE_CHANGED_EVENT, changed);
    }
  });
});

describe('ShareAgentModal package review', () => {
  let container: HTMLDivElement;
  let root: Root;
  let createShared: jest.Mock;
  let commitCapabilityPackage: jest.Mock;
  let analyzeCapabilityPackage: jest.Mock;
  let listSharedTeams: jest.Mock;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    createShared = jest.fn().mockResolvedValue({
      id: 'shared-agent-1',
      canUpdate: true,
      publicShare: null,
    });
    commitCapabilityPackage = jest.fn();
    analyzeCapabilityPackage = jest.fn().mockResolvedValue({
      analysisId: 'analysis-blocked',
      state: 'blocked',
      blockers: [
        {
          code: 'SOURCE_PATH_ESCAPE',
          message: 'A dependency cannot be packaged safely.',
        },
      ],
      manifest: null,
    });
    listSharedTeams = jest.fn();
    const testWindow = {
      api: {
        loadCanopyCloudAccount: jest.fn().mockResolvedValue({
          hasApiKey: true,
          capabilities: ['agents-crud-v1'],
          storageAvailable: true,
          account: {
            id: 'account-1',
            name: 'Alice',
            email: 'alice@example.com',
            role: 'ADMIN',
          },
        }),
      },
      agents: {
        analyzeCapabilityPackage,
        cancelCapabilityPackageAnalysis: jest.fn().mockResolvedValue(undefined),
        commitCapabilityPackage,
        createShared,
        updateShared: jest.fn(),
        publishPublicShare: jest.fn(),
        revokePublicShare: jest.fn(),
      },
      pipelines: {
        listSharedOrganizations: jest.fn(),
        listSharedTeams,
      },
    };
    for (const [key, value] of Object.entries(testWindow)) {
      Object.defineProperty(window, key, { configurable: true, value });
    }
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keeps Share available after optional contents or the selected team change', async () => {
    jest.mocked(window.api.loadCanopyCloudAccount).mockResolvedValue({
      hasApiKey: true,
      capabilities: ['agents-crud-v1', 'teams-v1'],
      storageAvailable: true,
      authMode: 'api_key',
      credentialSource: 'manual',
      account: {
        id: 'account-1',
        name: 'Alice',
        email: 'alice@example.com',
        role: 'ADMIN',
      },
    });
    analyzeCapabilityPackage.mockResolvedValue({
      analysisId: 'analysis-ready',
      state: 'ready',
      blockers: [],
      manifest: {
        version: 1,
        pipelineContentHash: 'a'.repeat(64),
        resources: [
          {
            id: 'skill-resource',
            kind: 'standalone_skill',
            displayName: 'Helper',
            sourceLabel: 'custom:app',
            sourceVisibility: 'local',
            invocationKeys: ['/helper'],
            dependencyResourceIds: [],
            trees: [],
          },
          {
            id: 'optional-resource',
            kind: 'standalone_skill',
            displayName: 'Optional helper',
            sourceLabel: 'custom:app',
            sourceVisibility: 'local',
            invocationKeys: ['/optional-helper'],
            dependencyResourceIds: [],
            trees: [],
          },
        ],
        bindings: [{ target: 'subject', resourceIds: ['skill-resource'] }],
        environmentRequirements: [],
        totalFiles: 1,
        totalBytes: 4,
      },
      dismissedInvocations: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
      pipelineContentHash: 'a'.repeat(64),
    });
    listSharedTeams.mockResolvedValue({
      success: true,
      data: {
        data: [
          {
            id: 'team-1',
            name: 'Platform',
            organization: { id: 'org-1', name: 'Acme' },
          },
          {
            id: 'team-2',
            name: 'Research',
            organization: { id: 'org-1', name: 'Acme' },
          },
        ],
      },
    });

    await act(async () => {
      root.render(
        <ShareAgentModal
          agent={{
            ...agentDef({
              id: 'agent-1',
              name: 'Reviewer',
              baseModel: 'claude-sonnet-4-6',
              instructions: 'Review this change.',
              pluginSelections: {
                collectionIds: [],
                skillRefs: [],
                pluginRefs: [],
                mcpServerRefs: [],
              },
            }),
          }}
          onClose={() => {}}
          onOpenAccountSettings={() => {}}
          onShared={() => {}}
        />,
      );
      for (let flush = 0; flush < 4; flush += 1) await Promise.resolve();
    });
    await act(async () => {
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent?.trim() === 'Team')
        ?.click();
      for (let flush = 0; flush < 3; flush += 1) await Promise.resolve();
    });
    await act(async () => {
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Platform'))
        ?.click();
      await Promise.resolve();
    });
    const submit = (): HTMLButtonElement | null =>
      document.querySelector<HTMLButtonElement>(
        '[data-testid="share-agent-submit"]',
      );
    // No acknowledgment: pressing Share is the publication decision.
    expect(
      document.querySelector('[data-testid="share-agent-consent"]'),
    ).toBeNull();
    expect(submit()?.disabled).toBe(false);
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="share-agent-dependencies-toggle"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      document
        .querySelector<HTMLInputElement>(
          '[data-testid="share-agent-dependencies-item-optional-resource"] input',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(submit()?.disabled).toBe(false);
    await act(async () => {
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Research'))
        ?.click();
      await Promise.resolve();
    });
    expect(submit()?.disabled).toBe(false);
  });
});
