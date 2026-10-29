const requestMock = jest.fn();

jest.mock('node:fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
}));
jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: jest.fn(() => ({
    admin: (): { request: typeof requestMock } => ({ request: requestMock }),
    getCanonicalState: jest.fn().mockResolvedValue({
      codexHome: '/mock/.codex',
    }),
  })),
}));

import * as fs from 'node:fs';
import {
  addCodexMarketplace,
  isStructuralCodexMarketplaceFailure,
  readCodexMarketplaceInstallMetadata,
  removeCodexMarketplace,
  resolveCodexPluginInstallRoots,
  upgradeCodexMarketplace,
} from '../plugins/codex-marketplace-service';
import type { PluginMarketplaceEntry } from '@canopy/desktop-shared/node/codex-runtime/generated/v2/PluginMarketplaceEntry';

const existsSyncMock = jest.mocked(fs.existsSync);
const readFileSyncMock = jest.mocked(fs.readFileSync);

describe('resolveCodexPluginInstallRoots', () => {
  beforeEach(() => {
    requestMock.mockReset();
    existsSyncMock.mockReset();
    readFileSyncMock.mockReset();
  });

  it('routes marketplace mutations through the host-owned runtime service', async () => {
    requestMock.mockResolvedValue({
      marketplaceName: 'acme',
      installedRoot: '/mock/.codex/marketplaces/acme',
      alreadyAdded: false,
    });
    const result = await addCodexMarketplace('acme/plugins');

    expect(result).toMatchObject({
      accepted: true,
      marketplaceName: 'acme',
      installedRoot: '/mock/.codex/marketplaces/acme',
      alreadySatisfied: false,
    });
    expect(requestMock).toHaveBeenCalledWith('marketplace/add', {
      source: 'acme/plugins',
    });
  });

  it('reads the installed marketplace revision used for structural-failure gating', async () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        source: 'https://github.com/acme/plugins',
        revision: 'abc123',
      }),
    );

    await expect(readCodexMarketplaceInstallMetadata('acme')).resolves.toEqual({
      source: 'https://github.com/acme/plugins',
      revision: 'abc123',
    });
  });

  it('distinguishes structural marketplace failures from transient failures', () => {
    expect(
      isStructuralCodexMarketplaceFailure(
        'marketplace did not contain .codex-plugin/plugin.json',
      ),
    ).toBe(true);
    expect(
      isStructuralCodexMarketplaceFailure(
        'missing required .codex-plugin/plugin.json manifest',
      ),
    ).toBe(true);
    expect(
      isStructuralCodexMarketplaceFailure('No Codex plugins were detected.'),
    ).toBe(true);
    expect(
      isStructuralCodexMarketplaceFailure(
        'Codex marketplace operation timed out after 60s.',
      ),
    ).toBe(false);
  });

  it('pins the exact reason strings that drive Codex deregistration', () => {
    // `isStructuralCodexMarketplaceFailure` is a regex over PROSE, and a
    // structural verdict deregisters a marketplace from Codex. Two of the
    // matched strings are emitted by this repo and two come from the bundled
    // Codex CLI, so the contract can drift silently in either direction:
    //   - a `npm run update:codex` bump that rewords the CLI's message stops
    //     deregistering genuinely broken marketplaces, reintroducing the
    //     staging-leak churn;
    //   - a reword on our side changes which failures deregister.
    // These assertions pin the literal strings so either drift fails here.
    //
    // Canopy-emitted (codex-marketplace-service.ts `resolveCodexPluginInstallRoots`):
    expect(
      isStructuralCodexMarketplaceFailure(
        'Local Codex plugin "acme" did not contain .codex-plugin/plugin.json at /repo/plugins/acme.',
      ),
    ).toBe(true);
    // Canopy-emitted (plugin-service.ts, empty-facet fallback):
    expect(
      isStructuralCodexMarketplaceFailure('No Codex plugins were detected.'),
    ).toBe(true);
    // Canopy-emitted (resolveCodexPluginInstallRoots, `plugins.length === 0`).
    // Codex listed the marketplace and reported zero plugins for it - the most
    // clearly permanent shape. Note this is the reason that is ACTUALLY
    // emitted; the 'No Codex plugins were detected.' fallback above is
    // unreachable in practice, because `unresolvedMessages` is never empty
    // when the plugin list is empty.
    expect(
      isStructuralCodexMarketplaceFailure(
        'Codex marketplace "acme" did not report any plugins.',
      ),
    ).toBe(true);

    // A checkout that is present-but-incomplete is TRANSIENT, and must never
    // deregister a working marketplace. `resolveCodexPluginInstallRoots`
    // deliberately words that case so it does not match.
    expect(
      isStructuralCodexMarketplaceFailure(
        'Local Codex plugin "acme" has no checkout at /repo/plugins/acme yet; the marketplace checkout looks incomplete.',
      ),
    ).toBe(false);
  });

  it('rejects an existing Codex marketplace from another source', async () => {
    requestMock.mockRejectedValue(
      new Error(
        "marketplace 'unstoppable-domains-plugins' is already added from a different source; remove it before adding this source",
      ),
    );

    const result = await addCodexMarketplace(
      'https://github.com/unstoppabledomains/agent-plugins',
    );

    expect(result).toEqual({
      accepted: false,
      marketplaceName: 'unstoppable-domains-plugins',
      error:
        "marketplace 'unstoppable-domains-plugins' is already added from a different source; remove it before adding this source",
    });
  });

  it('repairs an equivalent existing Codex marketplace source before retrying add', async () => {
    requestMock
      .mockRejectedValueOnce(
        new Error(
          "marketplace 'unstoppable-domains-plugins' is already added from a different source; remove it before adding this source",
        ),
      )
      .mockResolvedValueOnce({
        marketplaceName: 'unstoppable-domains-plugins',
        installedRoot:
          '/mock/.codex/.tmp/marketplaces/unstoppable-domains-plugins',
      })
      .mockResolvedValueOnce({
        marketplaceName: 'unstoppable-domains-plugins',
        installedRoot:
          '/mock/.codex/.tmp/marketplaces/unstoppable-domains-plugins',
        alreadyAdded: false,
      });
    existsSyncMock.mockImplementation((target) =>
      String(target).endsWith(
        '.codex/.tmp/marketplaces/unstoppable-domains-plugins/.codex-marketplace-install.json',
      ),
    );
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        source: 'https://github.com/unstoppabledomains/agent-plugins.git',
      }),
    );

    const result = await addCodexMarketplace(
      'https://github.com/unstoppabledomains/agent-plugins',
    );

    expect(result).toMatchObject({
      accepted: true,
      marketplaceName: 'unstoppable-domains-plugins',
      alreadySatisfied: false,
    });
    expect(requestMock).toHaveBeenNthCalledWith(1, 'marketplace/add', {
      source: 'https://github.com/unstoppabledomains/agent-plugins',
    });
    expect(requestMock).toHaveBeenNthCalledWith(2, 'marketplace/remove', {
      marketplaceName: 'unstoppable-domains-plugins',
    });
    expect(requestMock).toHaveBeenNthCalledWith(3, 'marketplace/add', {
      source: 'https://github.com/unstoppabledomains/agent-plugins',
    });
  });

  it('rejects a missing different local Codex marketplace source without provenance', async () => {
    requestMock.mockRejectedValue(
      new Error(
        "marketplace 'canopy-plugins' is already added from a different source; remove it before adding this source",
      ),
    );
    existsSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      return filePath.endsWith(
        '.codex/.tmp/marketplaces/canopy-plugins/.codex-marketplace-install.json',
      );
    });
    readFileSyncMock.mockReturnValue(
      JSON.stringify({ source: '/old/resources/plugins' }),
    );

    const result = await addCodexMarketplace('/new/resources/plugins', {
      repairEquivalentSourceConflict: true,
    });

    expect(result).toEqual({
      accepted: false,
      marketplaceName: 'canopy-plugins',
      error:
        "marketplace 'canopy-plugins' is already added from a different source; remove it before adding this source",
    });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('repairs a missing previous local Codex marketplace source when provenance approves it', async () => {
    requestMock
      .mockRejectedValueOnce(
        new Error(
          "marketplace 'canopy-plugins' is already added from a different source; remove it before adding this source",
        ),
      )
      .mockResolvedValueOnce({
        marketplaceName: 'canopy-plugins',
        installedRoot: '/mock/.codex/.tmp/marketplaces/canopy-plugins',
      })
      .mockResolvedValueOnce({
        marketplaceName: 'canopy-plugins',
        installedRoot: '/mock/.codex/.tmp/marketplaces/canopy-plugins',
        alreadyAdded: false,
      });
    existsSyncMock.mockImplementation((target) => {
      const filePath = String(target);
      return filePath.endsWith(
        '.codex/.tmp/marketplaces/canopy-plugins/.codex-marketplace-install.json',
      );
    });
    readFileSyncMock.mockReturnValue(
      JSON.stringify({ source: '/old/resources/plugins' }),
    );

    const result = await addCodexMarketplace('/new/resources/plugins', {
      repairEquivalentSourceConflict: true,
      repairMissingLocalSourceConflict: (input) => {
        expect(input).toEqual({
          marketplaceName: 'canopy-plugins',
          existingSource: '/old/resources/plugins',
          requestedSource: '/new/resources/plugins',
        });
        return true;
      },
    });

    expect(result).toMatchObject({
      accepted: true,
      marketplaceName: 'canopy-plugins',
      alreadySatisfied: false,
    });
    expect(requestMock).toHaveBeenNthCalledWith(1, 'marketplace/add', {
      source: '/new/resources/plugins',
    });
    expect(requestMock).toHaveBeenNthCalledWith(2, 'marketplace/remove', {
      marketplaceName: 'canopy-plugins',
    });
    expect(requestMock).toHaveBeenNthCalledWith(3, 'marketplace/add', {
      source: '/new/resources/plugins',
    });
  });

  it('does not accept a named marketplace upgrade satisfied by another marketplace', async () => {
    requestMock.mockResolvedValue({
      selectedMarketplaces: ['other-marketplace'],
      upgradedRoots: ['/mock/.codex/marketplaces/other-marketplace'],
      errors: [],
    });

    const result = await upgradeCodexMarketplace('requested-marketplace');

    expect(result).toEqual({
      accepted: false,
      marketplaceName: 'requested-marketplace',
      installedRoot: undefined,
      error: undefined,
    });
    expect(requestMock).toHaveBeenCalledWith('marketplace/upgrade', {
      marketplaceName: 'requested-marketplace',
    });
  });

  it('treats an unconfigured Codex marketplace as already absent on remove', async () => {
    requestMock.mockRejectedValue(
      new Error(
        'marketplace `canopy-chat-plugins` is not configured or installed',
      ),
    );

    const result = await removeCodexMarketplace('canopy-chat-plugins');

    expect(result).toEqual({
      accepted: true,
      marketplaceName: 'canopy-chat-plugins',
      alreadySatisfied: true,
      error: 'marketplace `canopy-chat-plugins` is not configured or installed',
    });
    expect(requestMock).toHaveBeenCalledWith('marketplace/remove', {
      marketplaceName: 'canopy-chat-plugins',
    });
  });

  it('resolves available local Codex plugin sources from plugin/list even when they are not installed', async () => {
    requestMock.mockResolvedValue({ marketplaces: [] });
    existsSyncMock.mockImplementation(
      (target) =>
        target === '/repo/plugins/relative-plugin/.codex-plugin/plugin.json',
    );

    const result = await resolveCodexPluginInstallRoots('acme', {
      listedMarketplace: {
        name: 'acme',
        path: '/repo/.agents/plugins/marketplace.json',
        plugins: [
          {
            name: 'relative-plugin',
            installed: false,
            source: { type: 'local', path: './plugins/relative-plugin' },
          },
        ],
      } as PluginMarketplaceEntry,
    });

    expect(result.unresolved).toEqual([]);
    expect(result.locations).toEqual([
      {
        pluginName: 'relative-plugin',
        marketplaceName: 'acme',
        installRoot: '/repo/plugins/relative-plugin',
      },
    ]);
  });

  it('resolves plugins listed by a non-default manifest file under .agents/plugins', async () => {
    // Signed out of Codex, the app-server serves the curated catalog from
    // `api_marketplace.json`, a sibling of `marketplace.json` in the same
    // checkout. Its plugins still live under the checkout root.
    requestMock.mockResolvedValue({ marketplaces: [] });
    existsSyncMock.mockImplementation(
      (target) =>
        target ===
        '/codex/.tmp/plugins/plugins/game-studio/.codex-plugin/plugin.json',
    );
    const listedMarketplace: PluginMarketplaceEntry = {
      name: 'openai-api-curated',
      path: '/codex/.tmp/plugins/.agents/plugins/api_marketplace.json',
      interface: null,
      plugins: [
        {
          id: 'game-studio@openai-api-curated',
          remotePluginId: null,
          version: null,
          localVersion: null,
          name: 'game-studio',
          shareContext: null,
          source: {
            type: 'local',
            path: '/codex/.tmp/plugins/plugins/game-studio',
          },
          installed: false,
          installedAt: null,
          enabled: false,
          installPolicy: 'AVAILABLE',
          installPolicySource: null,
          mustShowInstallationInterstitial: null,
          authPolicy: 'ON_USE',
          availability: 'AVAILABLE',
          disabledReason: null,
          eligiblePlanTypes: null,
          interface: null,
          keywords: [],
        },
      ],
    };

    const result = await resolveCodexPluginInstallRoots('openai-api-curated', {
      listedMarketplace,
    });

    expect(result.unresolved).toEqual([]);
    expect(result.locations).toEqual([
      {
        pluginName: 'game-studio',
        marketplaceName: 'openai-api-curated',
        installRoot: '/codex/.tmp/plugins/plugins/game-studio',
      },
    ]);
  });

  it('rejects relative local Codex plugin sources when no marketplace root is available', async () => {
    requestMock.mockResolvedValue({
      marketplaces: [
        {
          name: 'acme',
          plugins: [
            {
              name: 'relative-plugin',
              installed: true,
              source: { type: 'local', path: 'relative/plugin' },
            },
          ],
        },
      ],
    });
    existsSyncMock.mockReturnValue(true);

    const result = await resolveCodexPluginInstallRoots('acme', {
      listedMarketplace: {
        name: 'acme',
        path: null,
        plugins: [],
      } as PluginMarketplaceEntry,
    });

    expect(result.locations).toEqual([]);
    expect(result.unresolved).toEqual([
      {
        pluginName: 'relative-plugin',
        sourceKind: 'local-missing',
        reason:
          'Local Codex plugin "relative-plugin" reported path "relative/plugin", but it could not be resolved inside the marketplace root.',
      },
    ]);
    expect(existsSyncMock).not.toHaveBeenCalled();
  });

  it('rejects relative local Codex plugin sources outside the marketplace root', async () => {
    requestMock.mockResolvedValue({ marketplaces: [] });
    existsSyncMock.mockReturnValue(true);

    const result = await resolveCodexPluginInstallRoots('acme', {
      listedMarketplace: {
        name: 'acme',
        path: '/repo/.agents/plugins/marketplace.json',
        plugins: [
          {
            name: 'escaped-plugin',
            installed: false,
            source: { type: 'local', path: '../outside' },
          },
        ],
      } as PluginMarketplaceEntry,
    });

    expect(result.locations).toEqual([]);
    expect(result.unresolved).toEqual([
      {
        pluginName: 'escaped-plugin',
        sourceKind: 'local-missing',
        reason:
          'Local Codex plugin "escaped-plugin" reported path "../outside", but it could not be resolved inside the marketplace root.',
      },
    ]);
    expect(existsSyncMock).not.toHaveBeenCalled();
  });

  it('marks only the absent-root entry transient in a mixed marketplace', async () => {
    requestMock.mockResolvedValue({ marketplaces: [] });
    // `claude-only` has a checkout but no Codex manifest (structural);
    // `codex-plugin`'s checkout is momentarily absent (transient).
    existsSyncMock.mockImplementation(
      (target) => String(target) === '/repo/plugins/claude-only',
    );

    const result = await resolveCodexPluginInstallRoots('acme', {
      listedMarketplace: {
        name: 'acme',
        path: '/repo/.agents/plugins/marketplace.json',
        plugins: [
          {
            name: 'claude-only',
            installed: true,
            source: { type: 'local', path: '/repo/plugins/claude-only' },
          },
          {
            name: 'codex-plugin',
            installed: true,
            source: { type: 'local', path: '/repo/plugins/codex-plugin' },
          },
        ],
      } as PluginMarketplaceEntry,
    });

    expect(result.unresolved.map((entry) => entry.sourceKind)).toEqual([
      'local-missing',
      'local-incomplete',
    ]);

    // The joined reason string DOES match the structural regex, because one
    // entry is genuinely structural. Classifying on the join alone would
    // deregister a marketplace that really does support Codex whenever its
    // checkout is mid-clone, so `plugin-service` vetoes on the per-entry kind
    // instead. This assertion pins why that veto is required.
    const joined = result.unresolved.map((entry) => entry.reason).join('; ');
    expect(isStructuralCodexMarketplaceFailure(joined)).toBe(true);
    expect(
      result.unresolved.some(
        (entry) => entry.sourceKind === 'local-incomplete',
      ),
    ).toBe(true);
  });

  it('reports an absent install root as an incomplete checkout, not a structural failure', async () => {
    requestMock.mockResolvedValue({ marketplaces: [] });
    // The install root itself does not exist: an interrupted clone, a
    // mid-upgrade swap through `marketplace-backup-*`, or a sparse/LFS
    // checkout. `resolveLocalPluginRoot` is pure path arithmetic, so without
    // this check the missing manifest is indistinguishable from a genuinely
    // Claude-only plugin and would deregister a working marketplace.
    existsSyncMock.mockReturnValue(false);

    const result = await resolveCodexPluginInstallRoots('acme', {
      listedMarketplace: {
        name: 'acme',
        path: '/repo/.agents/plugins/marketplace.json',
        plugins: [
          {
            name: 'local-plugin',
            installed: true,
            source: { type: 'local', path: '/repo/plugins/local-plugin' },
          },
        ],
      } as PluginMarketplaceEntry,
    });

    expect(result.locations).toEqual([]);
    expect(result.unresolved).toEqual([
      {
        pluginName: 'local-plugin',
        // Distinct kind, so a caller can classify PER ENTRY instead of over
        // the joined reason string.
        sourceKind: 'local-incomplete',
        reason:
          'Local Codex plugin "local-plugin" has no checkout at /repo/plugins/local-plugin yet; the marketplace checkout looks incomplete.',
      },
    ]);
    expect(
      isStructuralCodexMarketplaceFailure(result.unresolved[0]?.reason),
    ).toBe(false);
  });

  it('admits local Codex plugin sources only when the absolute root is inside the marketplace root and contains a manifest', async () => {
    requestMock.mockResolvedValue({
      marketplaces: [
        {
          name: 'acme',
          plugins: [
            {
              name: 'local-plugin',
              installed: true,
              source: { type: 'local', path: '/repo/plugins/local-plugin' },
            },
          ],
        },
      ],
    });
    existsSyncMock.mockImplementation(
      (target) =>
        target === '/repo/plugins/local-plugin/.codex-plugin/plugin.json',
    );

    const result = await resolveCodexPluginInstallRoots('acme', {
      listedMarketplace: {
        name: 'acme',
        path: '/repo/.agents/plugins/marketplace.json',
        plugins: [
          {
            name: 'local-plugin',
            installed: true,
            source: { type: 'local', path: '/repo/plugins/local-plugin' },
          },
        ],
      } as PluginMarketplaceEntry,
    });

    expect(result.unresolved).toEqual([]);
    expect(result.locations).toEqual([
      {
        pluginName: 'local-plugin',
        marketplaceName: 'acme',
        installRoot: '/repo/plugins/local-plugin',
      },
    ]);
  });

  it('defers git and remote Codex plugin sources without deriving speculative install roots', async () => {
    requestMock.mockResolvedValue({
      marketplaces: [
        {
          name: 'acme',
          path: '/system/.codex/marketplaces/acme/.agents/plugins/marketplace.json',
          plugins: [
            {
              name: 'git-plugin',
              installed: true,
              source: {
                type: 'git',
                url: 'https://github.com/acme/git-plugin',
                path: 'plugins/git-plugin',
                refName: null,
                sha: null,
              },
            },
            {
              name: 'remote-plugin',
              installed: true,
              source: { type: 'remote' },
            },
          ],
        },
      ],
    });
    existsSyncMock.mockReturnValue(true);

    const result = await resolveCodexPluginInstallRoots('acme');

    expect(result.locations).toEqual([]);
    expect(result.unresolved).toEqual([
      {
        pluginName: 'git-plugin',
        sourceKind: 'git',
        reason:
          'Codex plugin "git-plugin" uses git source; the app-server protocol does not expose a materialized install path for this source type yet.',
      },
      {
        pluginName: 'remote-plugin',
        sourceKind: 'remote',
        reason:
          'Codex plugin "remote-plugin" uses remote source; the app-server protocol does not expose a materialized install path for this source type yet.',
      },
    ]);
    expect(existsSyncMock).not.toHaveBeenCalled();
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith('plugin/installed', {
      cwds: null,
      installSuggestionPluginNames: null,
    });
    expect(
      requestMock.mock.calls.some(([method]) => method === 'plugin/install'),
    ).toBe(false);
  });

  it('does not call plugin/install when scan-only install-root resolution finds no marketplace', async () => {
    requestMock.mockResolvedValue({ marketplaces: [] });

    const result = await resolveCodexPluginInstallRoots('missing');

    expect(result.locations).toEqual([]);
    expect(result.unresolved).toEqual([
      {
        pluginName: 'missing',
        sourceKind: 'local-missing',
        reason:
          'Codex marketplace "missing" was not returned by plugin/list or plugin/installed.',
      },
    ]);
    expect(
      requestMock.mock.calls.some(([method]) => method === 'plugin/install'),
    ).toBe(false);
  });
});
