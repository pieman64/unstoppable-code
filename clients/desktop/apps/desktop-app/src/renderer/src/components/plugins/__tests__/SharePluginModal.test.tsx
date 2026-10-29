/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CANOPY_CLOUD_SERVER_ID } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { PipelinePackageAnalysisSummary } from '@canopy/protocol/pipelines';
import { SharePluginModal } from '../SharePluginModal';
import { getShareablePluginRefKey } from '@canopy/protocol/plugins';
import { SHARED_PLUGINS_CHANGED_EVENT } from '@/hooks/useSharedMarketplaceShares';

jest.mock('@/lib/share-links', () => ({
  resolveSharedPluginUrl: jest.fn(() =>
    Promise.resolve('https://example.test/share/plugins/share-id'),
  ),
  createShareLinkResolver: jest.fn(() => ({
    resolveLink: jest.fn(
      (source: {
        kind: 'public' | 'scoped';
        sharePath?: string;
        id?: string;
      }) =>
        Promise.resolve({
          url:
            source.kind === 'public'
              ? 'https://example.test/share/plugins/share-id'
              : `/portal/plugins/plugins/${source.id ?? ''}`,
          kind: source.kind,
        }),
    ),
    linkFromDetail: jest.fn(() => Promise.resolve(null)),
  })),
}));

jest.mock('@/lib/clipboard', () => ({
  copyTextToClipboard: jest.fn(() => Promise.resolve(true)),
}));

const mockPostShareToast = jest.fn();
jest.mock('@/lib/share-toast', () => ({
  postShareToast: (toast: unknown): void => {
    mockPostShareToast(toast);
  },
}));

const pluginRef = {
  type: 'plugin' as const,
  marketplace: { type: 'github' as const, repo: 'acme/plugins' },
  plugin_name: 'browser',
};

const referenceAnalysis: PipelinePackageAnalysisSummary = {
  analysisId: 'reference-analysis',
  state: 'ready',
  pipelineContentHash: 'a'.repeat(64),
  manifest: {
    version: 1,
    pipelineContentHash: 'a'.repeat(64),
    resources: [],
    bindings: [],
    environmentRequirements: [],
    totalFiles: 0,
    totalBytes: 0,
  },
  blockers: [],
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};

describe('SharePluginModal', () => {
  let container: HTMLElement;
  let root: Root;
  const createShared = jest.fn();
  const analyzeSharedReference = jest.fn();
  const listShared = jest.fn();
  const getShared = jest.fn();
  const updateShared = jest.fn();
  const publishPublicShare = jest.fn();
  const revokePublicShare = jest.fn();
  const onClose = jest.fn();
  const onShared = jest.fn();
  const sharedPluginsChanged = jest.fn();

  beforeEach(() => {
    sharedPluginsChanged.mockClear();
    window.addEventListener(SHARED_PLUGINS_CHANGED_EVENT, sharedPluginsChanged);
    analyzeSharedReference
      .mockReset()
      .mockResolvedValue({ success: true, data: referenceAnalysis });
    mockPostShareToast.mockClear();
    onClose.mockClear();
    onShared.mockClear();
    createShared.mockReset().mockResolvedValue({
      success: true,
      data: {
        externalId: 'share-id',
        refKey: 'plugin:github:acme/plugins:browser',
        ref: pluginRef,
        name: 'Browser',
        description: 'Browser tools',
        marketplaceOrigin: 'github:acme/plugins',
        owner: { type: 'user', id: 'account-1', name: 'Alice' },
        shareScope: 'private',
        createdBy: { id: 'account-1', name: 'Alice' },
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
    });
    listShared.mockReset().mockResolvedValue({
      success: true,
      data: { serverId: CANOPY_CLOUD_SERVER_ID, data: [] },
    });
    getShared.mockReset();
    updateShared.mockReset();
    publishPublicShare.mockReset().mockResolvedValue({
      success: true,
      data: {
        externalId: 'public-share-id',
        pinnedRefKey: 'plugin:github:acme/plugins:browser',
        upToDate: true,
        sharePath: '/share/plugins/share-id',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
    });
    revokePublicShare.mockReset().mockResolvedValue({ success: true });
    Object.assign(window, {
      api: {
        loadCanopyCloudAccount: jest.fn().mockResolvedValue({
          hasApiKey: true,
          capabilities: ['plugins-crud-v1'],
          storageAvailable: true,
          account: { id: 'account-1' },
        }),
      },
      plugins: {
        analyzeSharedReference,
        listShared,
        getShared,
        createShared,
        updateShared,
        publishPublicShare,
        revokePublicShare,
      },
      pipelines: {
        listSharedTeams: jest.fn().mockResolvedValue({
          success: true,
          data: { data: [] },
        }),
        listSharedOrganizations: jest.fn().mockResolvedValue({
          success: true,
          data: { data: [] },
        }),
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    window.removeEventListener(
      SHARED_PLUGINS_CHANGED_EVENT,
      sharedPluginsChanged,
    );
    act(() => root.unmount());
    container.remove();
  });

  it.each(['success', 'failure'])(
    'revokes the public link before changing the plugin audience (%s)',
    async (outcome) => {
      const existing = {
        externalId: 'share-id',
        refKey: getShareablePluginRefKey(pluginRef),
        ref: pluginRef,
        name: 'Browser',
        description: 'Browser tools',
        marketplaceOrigin: 'github:acme/plugins',
        owner: { type: 'user', id: 'account-1', name: 'Alice' },
        shareScope: 'private',
        createdBy: { id: 'account-1', name: 'Alice' },
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        publicShare: {
          externalId: 'public-share-id',
          pinnedRefKey: getShareablePluginRefKey(pluginRef),
          upToDate: true,
          sharePath: '/share/plugins/share-id',
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      };
      listShared.mockResolvedValue({
        success: true,
        data: { serverId: CANOPY_CLOUD_SERVER_ID, data: [existing] },
      });
      getShared.mockResolvedValue({ success: true, data: existing });
      updateShared.mockResolvedValue({
        success: true,
        data: {
          ...existing,
          shareScope: 'organization',
          owner: { type: 'organization', id: 'org-1', name: 'Acme' },
        },
      });
      if (outcome === 'failure')
        revokePublicShare.mockResolvedValue({
          success: false,
          error: 'Revoke failed.',
        });
      Object.assign(window.api, {
        loadCanopyCloudAccount: jest.fn().mockResolvedValue({
          hasApiKey: true,
          storageAvailable: true,
          capabilities: ['plugins-crud-v1', 'organizations-v1'],
          account: { id: 'account-1' },
        }),
      });
      Object.assign(window.pipelines, {
        listSharedOrganizations: jest.fn().mockResolvedValue({
          success: true,
          data: { data: [{ id: 'org-1', name: 'Acme' }] },
        }),
      });
      await act(async () => {
        root.render(
          <SharePluginModal
            pluginRef={pluginRef}
            name="Browser"
            onClose={onClose}
            onShared={onShared}
          />,
        );
        for (let flush = 0; flush < 8; flush += 1) await Promise.resolve();
      });
      await act(async () => {
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="share-plugin-scope-organization"]',
          )
          ?.click();
        for (let flush = 0; flush < 4; flush += 1) await Promise.resolve();
      });
      await act(async () => {
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="share-plugin-organization-picker-option-org-1"]',
          )
          ?.click();
        for (let flush = 0; flush < 4; flush += 1) await Promise.resolve();
      });
      // Share is the only footer action; there is no definition-only path.
      expect(
        document.querySelector('[data-testid="share-plugin-definition-only"]'),
      ).toBeNull();
      await act(async () => {
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="share-plugin-submit"]',
          )
          ?.click();
        for (let flush = 0; flush < 8; flush += 1) await Promise.resolve();
      });
      expect(revokePublicShare).toHaveBeenCalledWith('share-id');
      expect(createShared).not.toHaveBeenCalled();
      if (outcome === 'failure') {
        expect(updateShared).not.toHaveBeenCalled();
        expect(sharedPluginsChanged).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        // A failed share is not a completed share.
        expect(onShared).not.toHaveBeenCalled();
        expect(document.body.textContent).toContain('Revoke failed.');
      } else {
        // Only the share that actually succeeded is reported, once.
        expect(onShared).toHaveBeenCalledTimes(1);
        expect(onShared).toHaveBeenCalledWith(
          expect.objectContaining({
            externalId: 'share-id',
            shareScope: 'organization',
          }),
        );
        expect(updateShared).toHaveBeenCalledWith(
          expect.objectContaining({
            remoteId: 'share-id',
            shareScope: 'organization',
            organizationId: 'org-1',
          }),
        );
        expect(revokePublicShare.mock.invocationCallOrder[0]).toBeLessThan(
          updateShared.mock.invocationCallOrder[0],
        );
      }
    },
  );

  // The server reuses a creator's existing share for the same plugin without
  // applying the requested audience, including one in a lane this dialog did
  // not list.
  it.each([
    ['without a public link', false],
    ['with a public link', true],
  ])(
    'moves a share reused from another organization to the chosen one (%s)',
    async (_label, hasPublicLink) => {
      const reused = {
        externalId: 'share-id',
        refKey: getShareablePluginRefKey(pluginRef),
        ref: pluginRef,
        name: 'Browser',
        description: 'Browser tools',
        marketplaceOrigin: 'github:acme/plugins',
        owner: { type: 'organization', id: 'org-2', name: 'Other' },
        shareScope: 'organization',
        createdBy: { id: 'account-1', name: 'Alice' },
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        ...(hasPublicLink
          ? {
              publicShare: {
                externalId: 'public-share-id',
                pinnedRefKey: getShareablePluginRefKey(pluginRef),
                upToDate: true,
                sharePath: '/share/plugins/share-id',
                createdAt: '2026-10-01T00:00:00.000Z',
                updatedAt: '2026-10-01T00:00:00.000Z',
              },
            }
          : {}),
      };
      createShared.mockResolvedValue({ success: true, data: reused });
      updateShared.mockResolvedValue({
        success: true,
        data: {
          ...reused,
          publicShare: null,
          owner: { type: 'organization', id: 'org-1', name: 'Acme' },
        },
      });
      Object.assign(window.api, {
        loadCanopyCloudAccount: jest.fn().mockResolvedValue({
          hasApiKey: true,
          storageAvailable: true,
          capabilities: ['plugins-crud-v1', 'organizations-v1'],
          account: { id: 'account-1' },
        }),
      });
      Object.assign(window.pipelines, {
        listSharedOrganizations: jest.fn().mockResolvedValue({
          success: true,
          data: { data: [{ id: 'org-1', name: 'Acme' }] },
        }),
      });
      await act(async () => {
        root.render(
          <SharePluginModal
            pluginRef={pluginRef}
            name="Browser"
            onClose={onClose}
          />,
        );
        for (let flush = 0; flush < 8; flush += 1) await Promise.resolve();
      });
      for (const testId of [
        'share-plugin-scope-organization',
        'share-plugin-organization-picker-option-org-1',
        'share-plugin-submit',
      ]) {
        await act(async () => {
          document
            .querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
            ?.click();
          for (let flush = 0; flush < 8; flush += 1) await Promise.resolve();
        });
      }
      expect(createShared).toHaveBeenCalledWith(
        expect.objectContaining({
          shareScope: 'organization',
          organizationId: 'org-1',
        }),
      );
      expect(updateShared).toHaveBeenCalledWith(
        expect.objectContaining({
          remoteId: 'share-id',
          shareScope: 'organization',
          organizationId: 'org-1',
        }),
      );
      if (hasPublicLink) {
        expect(revokePublicShare).toHaveBeenCalledWith('share-id');
        expect(revokePublicShare.mock.invocationCallOrder[0]).toBeLessThan(
          updateShared.mock.invocationCallOrder[0],
        );
      } else {
        expect(revokePublicShare).not.toHaveBeenCalled();
      }
      expect(onClose).toHaveBeenCalledTimes(1);
      // Lists of shared plugins reload instead of waiting for a remount.
      expect(sharedPluginsChanged).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['missing', 'error'])(
    'blocks sharing when reference analysis is %s and permits retry after recovery',
    async (failure) => {
      if (failure === 'missing')
        Reflect.deleteProperty(window.plugins, 'analyzeSharedReference');
      else
        analyzeSharedReference.mockResolvedValue({
          success: false,
          error: 'Reference analysis failed.',
        });
      await act(async () => {
        root.render(
          <SharePluginModal
            pluginRef={pluginRef}
            name="Browser"
            onClose={onClose}
          />,
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      const submit = document.querySelector<HTMLButtonElement>(
        '[data-testid="share-plugin-submit"]',
      );
      expect(submit?.disabled).toBe(true);
      expect(document.body.textContent).not.toContain(
        'No additional setup requirements',
      );
      const retry = document.querySelector<HTMLButtonElement>(
        '[data-testid="share-plugin-dependencies-retry"]',
      );
      expect(retry).not.toBeNull();
      expect(createShared).not.toHaveBeenCalled();
      Object.assign(window.plugins, { analyzeSharedReference });
      analyzeSharedReference.mockResolvedValue({
        success: true,
        data: referenceAnalysis,
      });
      await act(async () => {
        retry?.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(submit?.disabled).toBe(false);
    },
  );

  it.each([
    ['a response that names its personal owner', false],
    // Older servers answer a create without `shareScope` or `owner`.
    ['a response without a scope or owner', true],
  ])(
    'publishes only the portable ref and display metadata (%s)',
    async (_label, scopeless) => {
      if (scopeless) {
        createShared.mockResolvedValue({
          success: true,
          data: {
            externalId: 'share-id',
            refKey: 'plugin:github:acme/plugins:browser',
            ref: pluginRef,
            name: 'Browser',
            description: 'Browser tools',
            marketplaceOrigin: 'github:acme/plugins',
            createdBy: { id: 'account-1', name: 'Alice' },
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
          },
        });
      }
      act(() => {
        root.render(
          <SharePluginModal
            pluginRef={pluginRef}
            name="Browser"
            description="Browser tools"
            onClose={onClose}
          />,
        );
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(document.body.textContent).toContain(
        'Public source: github:acme/plugins',
      );
      // One audience, so no selector: the dialog still says who can see the
      // share, and the note says only what a plugin share is.
      expect(
        document.querySelector('[data-testid="share-plugin-scope-description"]')
          ?.textContent,
      ).toBe(
        'Anyone can view this plugin. It may appear in public discovery and search.',
      );
      expect(
        document.querySelector('[data-testid="share-plugin-reference-note"]')
          ?.textContent,
      ).toBe(
        'Only a reference to this plugin is shared. Credentials, private configuration, and local files are never included.',
      );
      expect(document.body.textContent).not.toContain('Anyone with the link');

      const share = Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Share',
      );
      await act(async () => {
        share?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(createShared).toHaveBeenCalledWith({
        serverId: CANOPY_CLOUD_SERVER_ID,
        ref: pluginRef,
        name: 'Browser',
        description: 'Browser tools',
        shareScope: 'private',
      });
      expect(updateShared).not.toHaveBeenCalled();
      expect(publishPublicShare).toHaveBeenCalledWith('share-id');
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(mockPostShareToast).toHaveBeenCalledWith({
        tone: 'success',
        message: 'Plugin is now public',
        link: 'https://example.test/share/plugins/share-id',
      });
    },
  );

  it('explains a refused share from the handler’s structured failure', async () => {
    createShared.mockResolvedValue({
      success: false,
      error: 'HTTP 403: Forbidden',
      failure: {
        version: 1,
        kind: 'permission',
        stage: 'publish',
        message: 'Forbidden',
        commitState: 'not-committed',
        retryable: false,
        httpStatus: 403,
      },
    });
    act(() => {
      root.render(
        <SharePluginModal
          pluginRef={pluginRef}
          name="Browser"
          onClose={onClose}
          onShared={onShared}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const share = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Share',
    );
    await act(async () => {
      share?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let flush = 0; flush < 4; flush += 1) await Promise.resolve();
    });

    expect(createShared).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(
      "You don't have permission to share this plugin with this audience.",
    );
    expect(document.body.textContent).not.toContain('HTTP 403');
    expect(onClose).not.toHaveBeenCalled();
    expect(onShared).not.toHaveBeenCalled();
  });
});
