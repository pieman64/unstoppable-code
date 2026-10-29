import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import { normalizeChatTabPluginSelections } from '../lib/preferences-store';
import { mergePluginSelections } from '../lib/plugin-selection-utils';
import { effectivePluginSelections } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { cloneSelections } from '../pipelines/plugin-collection-resolver';

function baseSelections(): ChatTabPluginSelections {
  return {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [{ marketplaceId: 'market', pluginName: 'plugin' }],
    mcpServerRefs: [],
    mcpHttpAuthPreferences: [
      {
        target: {
          kind: 'standalone',
          serverId: 'server-1',
          configId: 'config-1',
        },
        handler: 'provider',
      },
    ],
  };
}

describe('ChatTabPluginSelections MCP HTTP auth preference plumbing', () => {
  it('preserves preferences through clone, merge, and normalization helpers', () => {
    const cloned = cloneSelections(baseSelections());
    expect(cloned.mcpHttpAuthPreferences).toEqual([
      {
        target: {
          kind: 'standalone',
          serverId: 'server-1',
          configId: 'config-1',
        },
        handler: 'provider',
      },
    ]);

    const merged = mergePluginSelections(cloned, {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
      mcpHttpAuthPreferences: [
        {
          target: {
            kind: 'standalone',
            serverId: 'server-1',
            configId: 'config-1',
          },
          handler: 'canopy',
        },
        {
          target: {
            kind: 'plugin',
            marketplaceId: 'market',
            pluginName: 'plugin',
            serverName: 'remote',
          },
          handler: 'provider',
        },
      ],
    });

    const normalized = normalizeChatTabPluginSelections(merged);
    expect(normalized.mcpHttpAuthPreferences).toEqual([
      {
        target: {
          kind: 'standalone',
          serverId: 'server-1',
          configId: 'config-1',
        },
        handler: 'canopy',
      },
      {
        target: {
          kind: 'plugin',
          marketplaceId: 'market',
          pluginName: 'plugin',
          serverName: 'remote',
        },
        handler: 'provider',
      },
    ]);
  });
});

it('preserves stored colon-bearing targets through normalization and merges', (): void => {
  const account: ChatTabPluginSelections = {
    ...baseSelections(),
    mcpHttpAuthPreferences: [
      {
        target: {
          kind: 'plugin',
          marketplaceId: 'market:place',
          pluginName: 'plugin',
          serverName: 'server',
        },
        handler: 'account',
      },
    ],
  };
  const provider: ChatTabPluginSelections = {
    ...baseSelections(),
    mcpHttpAuthPreferences: [
      {
        target: {
          kind: 'plugin',
          marketplaceId: 'market',
          pluginName: 'place:plugin',
          serverName: 'server',
        },
        handler: 'provider',
      },
    ],
  };
  const expected = [
    ...(account.mcpHttpAuthPreferences ?? []),
    ...(provider.mcpHttpAuthPreferences ?? []),
  ];
  const persisted = { ...account, mcpHttpAuthPreferences: expected };
  expect(
    normalizeChatTabPluginSelections(persisted).mcpHttpAuthPreferences,
  ).toEqual(expected);
  expect(
    mergePluginSelections(account, provider)?.mcpHttpAuthPreferences,
  ).toEqual(expected);
  expect(
    effectivePluginSelections(provider, account).mcpHttpAuthPreferences,
  ).toEqual(expected);
});
