import path from 'node:path';
import { expect } from '@playwright/test';
import { seedWorktreeChat, writeJson } from '../seeders/index.mjs';
import { INVOCABLE_INVENTORY_CACHE_VERSION } from '../seeders/invocableInventoryCache.mjs';

export const SEARCH_WORKSPACE = 'demo-ts-pnpm-vite';
export const SEARCH_WORKTREE = 'demo-main';
export const SEARCH_CHAT = 'can5271-search-chat';
export const SEARCH_MARKETPLACE = 'demo/market';
export const SEARCH_WEBSITE =
  'https://github.com/unstoppabledomains/agent-plugins#readme';
const AT = '2026-10-27T12:00:00.000Z';
const plugins = [
  {
    name: 'posthog',
    members: Array.from({ length: 6 }, (_, i) => `report-${i}`),
  },
  {
    name: 'ud-code-review',
    members: Array.from({ length: 7 }, (_, i) => `review-${i}`),
  },
  { name: 'ud-ecom-debugger', members: ['ecom-debugger'] },
];

/** Catalog and rebuild source agree; only PostHog starts enabled. */
export function seedSlashSearch(userDataDir) {
  seedWorktreeChat({
    userDataDir,
    workspaceId: SEARCH_WORKSPACE,
    worktreeId: SEARCH_WORKTREE,
    providerType: 'claude',
    tabs: [
      {
        id: SEARCH_CHAT,
        title: 'Slash search',
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [
            { marketplaceId: SEARCH_MARKETPLACE, pluginName: 'posthog' },
          ],
        },
      },
    ],
  });
  const entries = plugins.flatMap((plugin) =>
    plugin.members.map((name) => ({
      id: ['claude', 'plugin_command', SEARCH_MARKETPLACE, plugin.name, name]
        .map(encodeURIComponent)
        .join(':'),
      provider: 'claude',
      kind: 'plugin_command',
      name,
      sourceName: name,
      displayName: `/${name}`,
      description:
        plugin.name === 'posthog'
          ? 'Reports review and ecom debugger activity'
          : `Seeded ${name}`,
      insertText: `/${name} `,
      invocationKey: `/${name}`,
      enableRef: {
        kind: 'plugin',
        marketplaceId: SEARCH_MARKETPLACE,
        pluginName: plugin.name,
      },
      sourceLabel: plugin.name,
    })),
  );
  writeJson(path.join(userDataDir, 'invocable-inventory-cache.json'), {
    version: INVOCABLE_INVENTORY_CACHE_VERSION,
    builtAt: AT,
    entries,
  });
  writeJson(path.join(userDataDir, 'plugins-cache.json'), {
    version: 2,
    lastRefreshed: AT,
    lastProviderRefreshAt: AT,
    marketplaces: [
      {
        id: SEARCH_MARKETPLACE,
        name: 'Demo Market',
        sourceType: 'github',
        sourceUrl: SEARCH_MARKETPLACE,
        installLocation: '/tmp/demo-market',
        pluginCount: plugins.length,
        plugins: plugins.map((plugin) => {
          const details = {
            skills: [],
            agents: [],
            commands: entries
              .filter((entry) => entry.sourceLabel === plugin.name)
              .map((entry) => ({
                name: entry.name,
                description: entry.description,
                filePath: `commands/${entry.name}.md`,
              })),
            apps: [],
            hooks: [],
            mcpServers: [],
            lspServers: [],
            hasReadme: false,
          };
          return {
            name: plugin.name,
            description: `Seeded ${plugin.name}`,
            homepage: SEARCH_WEBSITE,
            sourcePath: '',
            marketplaceId: SEARCH_MARKETPLACE,
            providerSupport: { claude: 'native', codex: 'none' },
            details,
            facets: {
              claude: {
                provider: 'claude',
                mode: 'native',
                name: plugin.name,
                homepage: SEARCH_WEBSITE,
                installLocation: '',
                sourcePath: '',
                details,
              },
            },
          };
        }),
        providerStatus: {
          claude: {
            provider: 'claude',
            state: 'valid',
            accepted: true,
            pluginCount: plugins.length,
            lastCheckedAt: AT,
          },
          // A cached marketplace always records both providers.
          codex: {
            provider: 'codex',
            state: 'invalid',
            accepted: false,
            pluginCount: 0,
            lastCheckedAt: AT,
          },
        },
        validProviders: ['claude'],
      },
    ],
  });
}

/** Runs on the desktop menu or the real Portal rich-editor menu. */
export async function verifySlashSearch({ composer, menu, options, showAll }) {
  await composer.fill('/ecom-debugger');
  await expect(options.first()).toContainText('ecom-debugger');
  // Enabled PostHog description matches remain eligible below this identity.
  await expect(options).not.toHaveCount(1);
  await composer.fill('/ecomm-debugger');
  await expect(options.first()).toContainText('ecom-debugger');
  await composer.fill('/ud-code-review');
  await expect(options).toHaveCount(5);
  await expect(showAll).toHaveText('Show all 7');
  await showAll.hover();
  await composer.press('Tab');
  await expect(showAll).toBeVisible();
  await expect(options).toHaveCount(5);
  await expect(composer).toHaveText('/ud-code-review');
  // Pointer expansion never invokes or resolves a command.
  await showAll.click();
  await expect(options).toHaveCount(7);
  await expect(composer).toHaveText('/ud-code-review');
  await expect(composer).toBeFocused();
  await composer.fill('/re');
  await expect(options).toHaveCount(8);
  const count = Number((await showAll.innerText()).replace('Show all ', ''));
  expect(count).toBeGreaterThanOrEqual(13);
  await composer.press('ArrowUp');
  await composer.press('Tab');
  await expect(showAll).toBeVisible();
  await expect(options).toHaveCount(8);
  await expect(composer).toHaveText('/re');
  await composer.press('Enter');
  await expect(options).toHaveCount(count);
  await expect(showAll).toHaveCount(0);
  await composer.press('ArrowDown');
  await expect(composer).toBeFocused();
  await composer.fill('/ud-code-review');
  await expect(options).toHaveCount(5);
  await options.first().click();
  await expect(menu).toHaveCount(0);
  await expect(composer).toContainText('/review-0');
}
