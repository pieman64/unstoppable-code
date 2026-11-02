/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { shareEnvelope } from '@/test-utils/shareOperation';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ResourceContextProvider } from '@canopy/ui-app/capability';

const mockPostShareToast = jest.fn();
jest.mock('@/lib/share-toast', () => ({
  postShareToast: (toast: unknown): void => {
    mockPostShareToast(toast);
  },
}));

import { ShareCollectionModal } from '../ShareCollectionModal';

describe('ShareCollectionModal', () => {
  let container: HTMLElement;
  let root: Root;
  const createShared = jest.fn(() => Promise.resolve({ id: 'shared-col' }));
  const getShared = jest.fn();
  const updateShared = jest.fn();
  const deleteCollection = jest.fn(() => Promise.resolve());
  const analyzeCapabilityPackage = jest.fn<
    ReturnType<typeof window.collections.analyzeCapabilityPackage>,
    Parameters<typeof window.collections.analyzeCapabilityPackage>
  >(() =>
    Promise.resolve({
      analysisId: 'analysis-1',
      state: 'ready',
      pipelineContentHash: 'a'.repeat(64),
      blockers: [],
      manifest: {
        version: 1,
        pipelineContentHash: 'a'.repeat(64),
        resources: [],
        bindings: [],
        environmentRequirements: [
          {
            id: 'mcp:server',
            kind: 'mcp',
            displayName: 'server',
            required: true,
            affectedSteps: [],
            setupHint: 'Connect server in Settings.',
          },
        ],
        totalFiles: 0,
        totalBytes: 0,
      },
      expiresAt: '2027-10-02T00:00:00.000Z',
    } satisfies Awaited<
      ReturnType<typeof window.collections.analyzeCapabilityPackage>
    >),
  );
  const commitCapabilityPackage = jest.fn(() =>
    Promise.resolve({
      capabilityPackage: {
        version: 1,
        digest: `pp:v1:${'A'.repeat(43)}`,
      },
      committedPackageUploadId: 'upload-1',
    }),
  );
  const publishPublicShare = jest.fn(() =>
    Promise.resolve({
      externalId: 'public-col',
      pinnedContentHash: 'hash',
      upToDate: true,
      sharePath: '/share/collections/public-col',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    }),
  );
  const revokePublicShare = jest.fn(() => Promise.resolve());
  const listSharedTeams = jest.fn();
  const listSharedOrganizations = jest.fn();
  const ORGANIZATION = { id: 'org-1', name: 'Acme' };
  // An organization-owned share: the audience a Collection update keeps.
  const organizationOwner = {
    type: 'organization',
    id: ORGANIZATION.id,
    name: ORGANIZATION.name,
  };

  // Collections offer Team and Organization only. This account can share
  // with an organization, which is preselected, so a share needs only the
  // organization picked.
  async function chooseOrganization(): Promise<void> {
    await act(async () => {
      document
        .querySelector<HTMLElement>(
          `[data-testid="share-collection-organization-picker-option-${ORGANIZATION.id}"]`,
        )
        ?.click();
      for (let flush = 0; flush < 3; flush += 1) await Promise.resolve();
    });
  }

  beforeEach(() => {
    mockPostShareToast.mockClear();
    createShared.mockClear();
    getShared.mockReset();
    updateShared.mockReset();
    deleteCollection.mockReset();
    deleteCollection.mockResolvedValue();
    analyzeCapabilityPackage.mockClear();
    commitCapabilityPackage.mockClear();
    publishPublicShare.mockClear();
    revokePublicShare.mockClear();
    listSharedTeams.mockReset();
    listSharedOrganizations.mockReset();
    listSharedOrganizations.mockResolvedValue({
      success: true,
      data: { data: [ORGANIZATION] },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    Object.assign(window, {
      api: {
        loadCanopyCloudAccount: jest.fn(() =>
          Promise.resolve({
            hasApiKey: true,
            authMode: 'api_key',
            credentialSource: 'manual',
            capabilities: ['collections-crud-v1', 'organizations-v1'],
            storageAvailable: true,
            account: {
              id: 'acct-1',
              name: 'Alice',
              email: 'alice@example.com',
              role: 'ADMIN',
            },
          }),
        ),
      },
      collections: {
        createShared: shareEnvelope(createShared),
        getShared,
        updateShared: shareEnvelope(updateShared),
        deleteCollection,
        analyzeCapabilityPackage,
        cancelCapabilityPackageAnalysis: jest.fn(() => Promise.resolve()),
        commitCapabilityPackage: shareEnvelope(commitCapabilityPackage),
        publishPublicShare,
        revokePublicShare,
      },
      plugins: {
        loadMarketplaces: jest.fn(() =>
          Promise.resolve({ success: true, data: { marketplaces: [] } }),
        ),
      },
      skills: {
        loadSkills: jest.fn(() => Promise.resolve({ success: true, data: [] })),
        readRawSkill: jest.fn(),
      },
      pipelines: {
        listSharedOrganizations,
        listSharedTeams,
      },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it.each(['success', 'failure', 'missing'])(
    'revokes the public link before changing the collection audience (%s)',
    async (outcome) => {
      const existing = {
        id: 'shared-col',
        name: 'Collection',
        description: '',
        contentHash: 'server-hash',
        shareScope: 'private',
        owner: { type: 'user', id: 'acct-1' },
        createdBy: { id: 'acct-1', name: 'Alice', email: 'alice@example.com' },
        createdAt: '2026-05-22T00:00:00.000Z',
        updatedAt: '2026-05-22T00:00:00.000Z',
        canUpdate: true,
        canDelete: true,
        rawCollection: '{"version":1,"name":"Collection","items":[]}',
        publicShare: {
          externalId: 'public-col',
          pinnedContentHash: 'server-hash',
          upToDate: true,
          sharePath: '/share/collections/public-col',
          createdAt: '2026-05-22T00:00:00.000Z',
          updatedAt: '2026-05-22T00:00:00.000Z',
        },
      };
      getShared.mockResolvedValue(existing);
      updateShared.mockResolvedValue({
        ...existing,
        shareScope: 'organization',
        owner: organizationOwner,
      });
      if (outcome !== 'success')
        revokePublicShare.mockRejectedValueOnce({
          status: outcome === 'missing' ? 404 : 500,
          message: 'Revoke failed.',
        });
      const onShared = jest.fn();
      await act(async () => {
        root.render(
          <ShareCollectionModal
            collection={{
              id: 'collection-1',
              name: 'Collection',
              description: '',
              skills: [],
              plugins: [],
              mcpServers: [],
              createdAt: existing.createdAt,
              updatedAt: existing.updatedAt,
              remote: {
                remoteId: existing.id,
                contentHash: existing.contentHash,
                shareScope: 'private',
                sharedAt: existing.updatedAt,
                accountId: 'acct-1',
              },
            }}
            onClose={() => {}}
            onOpenAccountSettings={() => {}}
            onShared={onShared}
          />,
        );
        for (let flush = 0; flush < 8; flush += 1) await Promise.resolve();
      });
      await act(async () => {
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="share-collection-scope-organization"]',
          )
          ?.click();
        for (let flush = 0; flush < 4; flush += 1) await Promise.resolve();
      });
      await chooseOrganization();
      await act(async () => {
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="share-collection-submit"]',
          )
          ?.click();
        for (let flush = 0; flush < 8; flush += 1) await Promise.resolve();
      });
      expect(revokePublicShare).toHaveBeenCalledWith('shared-col');
      expect(createShared).not.toHaveBeenCalled();
      if (outcome !== 'success') {
        expect(updateShared).not.toHaveBeenCalled();
        expect(onShared).not.toHaveBeenCalled();
        expect(document.body.textContent).toContain(
          outcome === 'missing'
            ? 'This shared resource was not found.'
            : 'Canopy Cloud returned an unexpected error.',
        );
      } else {
        expect(updateShared).toHaveBeenCalledWith(
          expect.objectContaining({
            collectionId: 'shared-col',
            shareScope: 'organization',
            organizationId: 'org-1',
          }),
        );
        expect(revokePublicShare.mock.invocationCallOrder.at(-1)).toBeLessThan(
          updateShared.mock.invocationCallOrder[0],
        );
      }
    },
  );

  it('blocks MCP-backed collections before offering any sharing audience', async () => {
    await act(async () => {
      root.render(
        <ShareCollectionModal
          collection={{
            id: 'collection-1',
            name: 'MCP Collection',
            description: '',
            skills: [],
            plugins: [],
            mcpServers: [{ serverId: 'server', configId: 'private-config' }],
            createdAt: '2026-05-22T00:00:00.000Z',
            updatedAt: '2026-05-22T00:00:00.000Z',
          }}
          onClose={() => {}}
          onOpenAccountSettings={() => {}}
          onShared={() => {}}
        />,
      );
      for (let flush = 0; flush < 6; flush += 1) await Promise.resolve();
    });
    expect(document.body.textContent).toContain(
      'Collections containing MCP servers cannot be shared.',
    );
    expect(
      document.querySelector('[data-testid="share-collection-scope"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="share-collection-submit"]'),
    ).toBeNull();
    expect(analyzeCapabilityPackage).not.toHaveBeenCalled();
    expect(commitCapabilityPackage).not.toHaveBeenCalled();
    expect(createShared).not.toHaveBeenCalled();
    expect(publishPublicShare).not.toHaveBeenCalled();
  });

  it('keeps the local collection after sharing it', async () => {
    const onShared = jest.fn();

    await act(async () => {
      root.render(
        <ShareCollectionModal
          collection={{
            id: 'collection-1',
            name: 'Collection with local copy',
            description: '',
            skills: [],
            plugins: [],
            mcpServers: [],
            createdAt: '2026-05-22T00:00:00.000Z',
            updatedAt: '2026-05-22T00:00:00.000Z',
          }}
          onClose={() => {}}
          onOpenAccountSettings={() => {}}
          onShared={onShared}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await chooseOrganization();
    expect(document.body.textContent).not.toContain('Delete local copy');
    await act(async () => {
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent?.trim() === 'Share')
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(deleteCollection).not.toHaveBeenCalled();
    // The dialog stays open on its success notice with the link; no toast.
    expect(mockPostShareToast).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="share-collection-success"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="share-collection-link"]')
        ?.textContent,
    ).toBe('/portal/plugins/collections/shared/shared-col');
    expect(onShared).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'shared-col' }),
    );
  });

  it('blocks Share while packaging is blocked', async () => {
    analyzeCapabilityPackage.mockResolvedValueOnce({
      analysisId: 'analysis-blocked',
      state: 'blocked',
      blockers: [
        {
          code: 'SOURCE_PATH_ESCAPE',
          message: 'A dependency cannot be packaged safely.',
          occurrences: [],
        },
      ],
      pipelineContentHash: 'a'.repeat(64),
      expiresAt: '2027-10-02T00:00:00.000Z',
    });

    await act(async () => {
      root.render(
        <ShareCollectionModal
          collection={{
            id: 'collection-1',
            name: 'Blocked Collection',
            description: '',
            skills: [],
            plugins: [],
            mcpServers: [],
            createdAt: '2026-05-22T00:00:00.000Z',
            updatedAt: '2026-05-22T00:00:00.000Z',
          }}
          onClose={() => {}}
          onOpenAccountSettings={() => {}}
          onShared={() => {}}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await chooseOrganization();

    const submit = document.querySelector<HTMLButtonElement>(
      '[data-testid="share-collection-submit"]',
    );
    expect(submit?.disabled).toBe(true);
    expect(
      document.querySelector(
        '[data-testid="share-collection-definition-only"]',
      ),
    ).toBeNull();
    await act(async () => {
      submit?.click();
      await Promise.resolve();
    });

    expect(commitCapabilityPackage).not.toHaveBeenCalled();
    expect(createShared).not.toHaveBeenCalled();
  });

  it('keeps Share available after optional contents or the selected team change', async () => {
    jest.mocked(window.api.loadCanopyCloudAccount).mockResolvedValue({
      hasApiKey: true,
      authMode: 'api_key',
      credentialSource: 'manual',
      capabilities: ['collections-crud-v1', 'teams-v1'],
      storageAvailable: true,
      account: {
        id: 'acct-1',
        name: 'Alice',
        email: 'alice@example.com',
        role: 'ADMIN',
      },
    });
    analyzeCapabilityPackage.mockResolvedValueOnce({
      analysisId: 'analysis-ready',
      state: 'ready',
      pipelineContentHash: 'a'.repeat(64),
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
      expiresAt: '2027-10-02T00:00:00.000Z',
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
        <ShareCollectionModal
          collection={{
            id: 'collection-1',
            name: 'Packaged Collection',
            description: '',
            skills: [],
            plugins: [],
            mcpServers: [],
            createdAt: '2026-05-22T00:00:00.000Z',
            updatedAt: '2026-05-22T00:00:00.000Z',
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
        '[data-testid="share-collection-submit"]',
      );
    expect(
      document.querySelector('[data-testid="share-collection-consent"]'),
    ).toBeNull();
    expect(submit()?.disabled).toBe(false);
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="share-collection-dependencies-toggle"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      document
        .querySelector<HTMLInputElement>(
          '[data-testid="share-collection-dependencies-item-optional-resource"] input',
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

  it('shares a collection with a team picked from the shared picker', async () => {
    Object.assign(window.api, {
      loadCanopyCloudAccount: jest.fn(() =>
        Promise.resolve({
          hasApiKey: true,
          capabilities: ['collections-crud-v1', 'teams-v1'],
          storageAvailable: true,
          account: {
            id: 'acct-1',
            name: 'Alice',
            email: 'alice@example.com',
            role: 'ADMIN',
          },
        }),
      ),
    });
    Object.assign(window.pipelines, {
      listSharedTeams: jest.fn(() =>
        Promise.resolve({
          success: true,
          data: {
            data: [
              {
                id: 'team-1',
                name: 'Platform',
                organization: { id: 'org-1', name: 'Acme' },
              },
            ],
          },
        }),
      ),
    });
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    };

    await act(async () => {
      root.render(
        <ShareCollectionModal
          collection={{
            id: 'collection-1',
            name: 'Collection',
            description: '',
            skills: [],
            plugins: [],
            mcpServers: [],
            createdAt: '2026-05-22T00:00:00.000Z',
            updatedAt: '2026-05-22T00:00:00.000Z',
          }}
          onClose={() => {}}
          onOpenAccountSettings={() => {}}
          onShared={() => {}}
        />,
      );
      await flush();
    });

    expect(
      container.ownerDocument.querySelector(
        '[data-testid="share-collection-scope"]',
      ),
    ).not.toBeNull();
    const picker = container.ownerDocument.querySelector(
      '[data-testid="share-collection-team-picker"]',
    );
    expect(picker?.querySelector('input')?.getAttribute('placeholder')).toBe(
      'Search teams…',
    );
    expect(picker?.textContent).toContain('Acme');

    const row = container.ownerDocument.querySelector<HTMLElement>(
      '[data-testid="share-collection-team-picker-option-team-1"]',
    );
    await act(async () => {
      row?.click();
      await flush();
    });
    expect(row?.getAttribute('aria-pressed')).toBe('true');

    const shareButton = Array.from(
      container.ownerDocument.querySelectorAll('button'),
    ).find((button) => button.textContent === 'Share');
    await act(async () => {
      shareButton?.click();
      await flush();
    });

    expect(createShared).toHaveBeenCalledWith(
      expect.objectContaining({ shareScope: 'team', teamId: 'team-1' }),
    );
    expect(JSON.stringify(createShared.mock.calls)).not.toContain(
      'private-config',
    );
  });

  // CAN-3844: an organization-owned Collection can't move to the personal
  // owner Public needs while context policy applies.
  it('disables Public for an organization-owned Collection under context policy', async () => {
    const detail = {
      id: 'shared-col',
      name: 'Collection',
      description: '',
      contentHash: 'server-hash',
      shareScope: 'organization',
      owner: organizationOwner,
      createdBy: { id: 'acct-1', name: 'Alice', email: 'alice@example.com' },
      createdAt: '2026-05-22T00:00:00.000Z',
      updatedAt: '2026-05-22T00:00:00.000Z',
      canUpdate: true,
      canDelete: true,
      rawCollection: '{"version":1,"name":"Collection","items":[]}',
      publicShare: null,
    };
    getShared.mockResolvedValue(detail);
    updateShared.mockResolvedValue(detail);

    await act(async () => {
      root.render(
        <ResourceContextProvider
          context={{ kind: 'organization', organizationId: ORGANIZATION.id }}
          personalOrganizationId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        >
          <ShareCollectionModal
            collection={{
              id: 'collection-1',
              name: 'Collection',
              description: '',
              skills: [],
              plugins: [],
              mcpServers: [],
              createdAt: '2026-05-22T00:00:00.000Z',
              updatedAt: '2026-05-22T00:00:00.000Z',
              remote: {
                remoteId: detail.id,
                contentHash: detail.contentHash,
                shareScope: 'organization',
                sharedAt: detail.updatedAt,
              },
            }}
            onClose={() => {}}
            onOpenAccountSettings={() => {}}
            onShared={() => {}}
          />
        </ResourceContextProvider>,
      );
      for (let flush = 0; flush < 6; flush += 1) await Promise.resolve();
    });

    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="share-collection-scope-public"]',
      )?.disabled,
    ).toBe(true);
    expect(
      document.querySelector(
        '[data-testid="share-collection-public-locked-hint"]',
      )?.textContent,
    ).toBe("Organization shares can't be made public yet.");

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="share-collection-submit"]',
        )
        ?.click();
      for (let flush = 0; flush < 6; flush += 1) await Promise.resolve();
    });
    expect(updateShared).toHaveBeenCalledWith(
      expect.objectContaining({
        shareScope: 'organization',
        organizationId: ORGANIZATION.id,
      }),
    );
    expect(publishPublicShare).not.toHaveBeenCalled();
  });

  it('repairs stale local metadata with the freshly loaded remote hash', async () => {
    const detail = {
      id: 'shared-col',
      name: 'Collection',
      description: '',
      contentHash: 'server-hash',
      shareScope: 'organization',
      owner: organizationOwner,
      createdBy: { id: 'acct-1', name: 'Alice', email: 'alice@example.com' },
      createdAt: '2026-05-22T00:00:00.000Z',
      updatedAt: '2026-05-22T00:00:00.000Z',
      canUpdate: true,
      canDelete: true,
      rawCollection: '{"version":1,"name":"Collection","items":[]}',
      publicShare: null,
    };
    getShared.mockResolvedValue(detail);
    updateShared.mockResolvedValue(detail);

    await act(async () => {
      root.render(
        <ShareCollectionModal
          collection={{
            id: 'collection-1',
            name: 'Collection',
            description: '',
            skills: [],
            plugins: [],
            mcpServers: [],
            createdAt: '2026-05-22T00:00:00.000Z',
            updatedAt: '2026-05-22T00:00:00.000Z',
            remote: {
              remoteId: detail.id,
              contentHash: 'stale-local-hash',
              shareScope: 'organization',
              sharedAt: detail.updatedAt,
            },
          }}
          onClose={() => {}}
          onOpenAccountSettings={() => {}}
          onShared={() => {}}
        />,
      );
      for (let flush = 0; flush < 6; flush += 1) await Promise.resolve();
    });

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="share-collection-submit"]',
        )
        ?.click();
      for (let flush = 0; flush < 6; flush += 1) await Promise.resolve();
    });

    expect(updateShared).toHaveBeenCalledWith(
      expect.objectContaining({
        collectionId: detail.id,
        expectedContentHash: detail.contentHash,
        shareScope: 'organization',
        organizationId: ORGANIZATION.id,
      }),
    );
  });

  it('labels a same-account stale remote recreation as a new share', async () => {
    getShared.mockRejectedValue({
      status: 404,
      message: 'HTTP 404: Collection not found',
    });

    await act(async () => {
      root.render(
        <ShareCollectionModal
          collection={{
            id: 'collection-1',
            name: 'Collection',
            description: '',
            skills: [],
            plugins: [],
            mcpServers: [],
            createdAt: '2026-05-22T00:00:00.000Z',
            updatedAt: '2026-05-22T00:00:00.000Z',
            remote: {
              remoteId: 'missing-shared-col',
              contentHash: 'stale-local-hash',
              shareScope: 'private',
              sharedAt: '2026-05-22T00:00:00.000Z',
              accountId: 'acct-1',
            },
          }}
          onClose={() => {}}
          onOpenAccountSettings={() => {}}
          onShared={() => {}}
        />,
      );
      for (let flush = 0; flush < 6; flush += 1) await Promise.resolve();
    });

    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="share-collection-submit"]',
      )?.textContent,
    ).toBe('Share');
  });

  it('detaches an existing package after a ready empty analysis', async () => {
    const detail = {
      id: 'shared-col',
      name: 'Collection',
      description: '',
      contentHash: 'server-hash',
      shareScope: 'organization',
      owner: organizationOwner,
      createdBy: { id: 'acct-1', name: 'Alice', email: 'alice@example.com' },
      createdAt: '2026-05-22T00:00:00.000Z',
      updatedAt: '2026-05-22T00:00:00.000Z',
      canUpdate: true,
      canDelete: true,
      rawCollection: '{"version":1,"name":"Collection","items":[]}',
      publicShare: null,
    };
    getShared.mockResolvedValue(detail);
    updateShared.mockResolvedValue(detail);
    analyzeCapabilityPackage.mockResolvedValueOnce({
      analysisId: 'analysis-empty',
      state: 'ready',
      pipelineContentHash: 'a'.repeat(64),
      blockers: [],
      manifest: {
        version: 1,
        pipelineContentHash: 'a'.repeat(64),
        resources: [],
        bindings: [],
        environmentRequirements: [],
        totalFiles: 0,
        totalBytes: 0,
      },
      expiresAt: '2027-10-02T00:00:00.000Z',
    });

    await act(async () => {
      root.render(
        <ShareCollectionModal
          collection={{
            id: 'collection-1',
            name: 'Collection',
            description: '',
            skills: [],
            plugins: [],
            mcpServers: [],
            createdAt: '2026-05-22T00:00:00.000Z',
            updatedAt: '2026-05-22T00:00:00.000Z',
            remote: {
              remoteId: detail.id,
              contentHash: detail.contentHash,
              shareScope: 'organization',
              sharedAt: detail.updatedAt,
            },
          }}
          onClose={() => {}}
          onOpenAccountSettings={() => {}}
          onShared={() => {}}
        />,
      );
      for (let flush = 0; flush < 6; flush += 1) await Promise.resolve();
    });

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="share-collection-submit"]',
        )
        ?.click();
      for (let flush = 0; flush < 6; flush += 1) await Promise.resolve();
    });

    expect(updateShared).toHaveBeenCalledWith(
      expect.objectContaining({ capabilityPackage: null }),
    );
  });

  it('does not expose the share target until existing metadata loads', async () => {
    let resolveDetail: ((detail: object) => void) | undefined;
    const detailPromise = new Promise<object>((resolve) => {
      resolveDetail = resolve;
    });
    getShared.mockReturnValue(detailPromise);

    await act(async () => {
      root.render(
        <ShareCollectionModal
          collection={{
            id: 'collection-1',
            name: 'Collection',
            description: '',
            skills: [],
            plugins: [],
            mcpServers: [],
            createdAt: '2026-05-22T00:00:00.000Z',
            updatedAt: '2026-05-22T00:00:00.000Z',
            remote: {
              remoteId: 'shared-col',
              contentHash: 'local-hash',
              shareScope: 'private',
              sharedAt: '2026-05-22T00:00:00.000Z',
            },
          }}
          onClose={() => {}}
          onOpenAccountSettings={() => {}}
          onShared={() => {}}
        />,
      );
      for (let flush = 0; flush < 4; flush += 1) await Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="share-collection-preflight"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="share-collection-scope"]'),
    ).toBeNull();

    await act(async () => {
      resolveDetail?.({
        id: 'shared-col',
        name: 'Collection',
        description: '',
        contentHash: 'server-hash',
        shareScope: 'private',
        owner: { type: 'user', id: 'acct-1' },
        createdBy: { id: 'acct-1', name: 'Alice', email: 'alice@example.com' },
        createdAt: '2026-05-22T00:00:00.000Z',
        updatedAt: '2026-05-22T00:00:00.000Z',
        canUpdate: true,
        canDelete: true,
        rawCollection: '{"version":1,"name":"Collection","items":[]}',
        publicShare: null,
      });
      for (let flush = 0; flush < 4; flush += 1) await Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="share-collection-preflight"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="share-collection-scope"]'),
    ).not.toBeNull();
    expect(
      document.querySelector(
        '[data-testid="share-collection-organization-picker"]',
      ),
    ).not.toBeNull();
    // A `private` Collection is the owner's Personal copy, not an audience:
    // it opens as a first share with no Private option to keep.
    expect(
      document.querySelector('[data-testid="share-collection-scope-private"]'),
    ).toBeNull();
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="share-collection-submit"]',
      )?.textContent,
    ).toBe('Share');
  });
});
