jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest
    .fn()
    .mockResolvedValue({ disabledInstalledItems: [], parkedCodexPlugins: [] }),
}));
const mockSkillContextEnabled = jest.fn(() => false);
const mockAssertSkillContext = jest.fn<Promise<void>, [string]>(() =>
  Promise.resolve(),
);
jest.mock('../skills/resource-lanes', () => ({
  skillResourceContextEnabled: (): boolean => mockSkillContextEnabled(),
  skillContextSnapshot: (): Promise<string> => Promise.resolve('context'),
  assertSkillContextSnapshot: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../skills/skill-install-context', () => ({
  assertStoredSkillContext: (id: string): Promise<void> =>
    mockAssertSkillContext(id),
}));
import type * as PluginResolverModule from '../plugins/plugin-resolver';

jest.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: jest.fn(() => []),
  },
}));
jest.mock('../lib/paths', () => ({
  getDataDir: jest.fn(),
  getCodexCompatibilityCacheRootDir: jest.fn(),
}));
jest.mock('../pipelines/config-paths', () => ({
  getBundledSkillDir: jest.fn((skillName: string) => `/builtin/${skillName}`),
}));
jest.mock('../skills/paths', () => ({
  getSkillDir: jest.fn(
    (sourceId: string, skillName: string) => `/skills/${sourceId}/${skillName}`,
  ),
  getSkillsRootDir: jest.fn(),
  isBuiltinSourceId: jest.fn((sourceId: string) => sourceId === 'builtin:app'),
}));
jest.mock('../skills/skill-service', () => ({
  loadSkills: jest.fn(),
  readSkillContent: jest.fn(),
}));
jest.mock('../plugins/plugin-service', () => ({
  loadMarketplaces: jest.fn(),
  loadMarketplacesCacheOnly: jest.fn(),
}));
jest.mock('../plugins/codex-marketplace-service', () => ({
  listCodexPlugins: jest.fn(),
}));
jest.mock('../collections/collection-store', () => ({
  readCollectionConfig: jest.fn(),
}));
jest.mock('../plugins/plugin-resolver', () => {
  const actual = jest.requireActual<typeof PluginResolverModule>(
    '../plugins/plugin-resolver',
  );
  return {
    ...actual,
    codexAggregateSkillInvocationNamesForRefs: jest.fn(
      actual.codexAggregateSkillInvocationNamesForRefs,
    ),
    resolveEffectivePluginSelectionRefs: jest.fn(
      actual.resolveEffectivePluginSelectionRefs,
    ),
  };
});
import type * as InheritedCapabilitiesModule from '@canopy/desktop-shared/node/cursor/inherited-capabilities';
jest.mock('../cursor/inherited-roots', () => ({
  resolveInheritedCursorRoots: (): unknown => ({
    userHome: '/home/user',
    claudeConfigDir: '/home/user/.claude',
    codexHome: '/home/user/.codex',
  }),
}));
jest.mock('@canopy/desktop-shared/node/cursor/inherited-capabilities', () => {
  const actual = jest.requireActual<typeof InheritedCapabilitiesModule>(
    '@canopy/desktop-shared/node/cursor/inherited-capabilities',
  );
  return {
    ...actual,
    discoverInheritedCursorCapabilities: jest.fn(() =>
      Promise.resolve(actual.emptyInheritedCursorCapabilities()),
    ),
  };
});
import type * as ClaudeEnabledPluginsModule from '../plugins/claude-enabled-plugins';
const mockClaudeEnabledPlugins = jest.fn<
  Map<string, string> | null,
  [string, string?]
>(() => new Map());
jest.mock('../plugins/claude-enabled-plugins', () => ({
  // The install-folder check stays real: it is what keeps a vanished folder
  // out of id assignment.
  ...jest.requireActual<typeof ClaudeEnabledPluginsModule>(
    '../plugins/claude-enabled-plugins',
  ),
  readClaudeDisabledInstalledPlugins: jest.fn(() => []),
  readClaudeEnabledPlugins: (
    configDir: string,
    projectPath?: string,
  ): Map<string, string> | null =>
    mockClaudeEnabledPlugins(configDir, projectPath),
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  ChatTabPluginSelections,
  InvocableInventoryEntry,
} from '@canopy/desktop-shared/types';
import type {
  MarketplaceInfo,
  PluginInfo,
  PluginSkillInfo,
} from '@canopy/desktop-shared/types/plugins';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import { getDataDir } from '../lib/paths';
import { loadSkills, readSkillContent } from '../skills/skill-service';
import { getSkillDir, getSkillsRootDir } from '../skills/paths';
import {
  loadMarketplaces,
  loadMarketplacesCacheOnly,
} from '../plugins/plugin-service';
import { readCollectionConfig } from '../collections/collection-store';
import { listCodexPlugins } from '../plugins/codex-marketplace-service';
import {
  codexAggregateSkillInvocationNamesForRefs,
  resolveEffectivePluginSelectionRefs,
} from '../plugins/plugin-resolver';
import { createGeneratedSkillName } from '../plugins/codex-plugin-compat';

const getDataDirMock = jest.mocked(getDataDir);
const getSkillDirMock = jest.mocked(getSkillDir);
const getSkillsRootDirMock = jest.mocked(getSkillsRootDir);
const loadSkillsMock = jest.mocked(loadSkills);
const readSkillContentMock = jest.mocked(readSkillContent);
const loadMarketplacesMock = jest.mocked(loadMarketplacesCacheOnly);
const refreshCapableLoadMarketplacesMock = jest.mocked(loadMarketplaces);
const readCollectionConfigMock = jest.mocked(readCollectionConfig);
const resolveEffectivePluginSelectionRefsMock = jest.mocked(
  resolveEffectivePluginSelectionRefs,
);
const codexAggregateSkillInvocationNamesForRefsMock = jest.mocked(
  codexAggregateSkillInvocationNamesForRefs,
);
import { discoverInheritedCursorCapabilities } from '@canopy/desktop-shared/node/cursor/inherited-capabilities';
const discoverInheritedMock = jest.mocked(discoverInheritedCursorCapabilities);

describe('invocable inventory service', () => {
  let tempDir = '';

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.mocked(listCodexPlugins).mockResolvedValue({
      marketplaces: [],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    });
    mockSkillContextEnabled.mockReturnValue(false);
    mockAssertSkillContext.mockReset().mockResolvedValue(undefined);
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-invocable-inventory-'),
    );
    getDataDirMock.mockReturnValue(tempDir);
    getSkillsRootDirMock.mockReturnValue(path.join(tempDir, 'skills'));
    getSkillDirMock.mockImplementation((sourceId: string, skillName: string) =>
      path.join(tempDir, 'skills', sourceId, skillName),
    );
    fs.mkdirSync(path.join(tempDir, 'skills', 'source-a', 'visible-skill'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tempDir, 'skills', 'source-a', 'visible-skill', 'SKILL.md'),
      '---\nname: visible-skill\n---\n',
      'utf8',
    );
    fs.mkdirSync(path.join(tempDir, 'skills', 'source-a', 'hidden-skill'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tempDir, 'skills', 'source-a', 'hidden-skill', 'SKILL.md'),
      '---\nname: hidden-skill\nuser-invocable: false\n---\n',
      'utf8',
    );
    loadSkillsMock.mockReturnValue({
      success: true,
      data: [
        {
          name: 'visible-skill',
          sourceId: 'source-a',
          description: 'Visible',
          source: 'Source A',
          installedAt: '',
          updatedAt: '',
          updateAvailable: false,
        },
        {
          name: 'hidden-skill',
          sourceId: 'source-a',
          description: 'Hidden',
          source: 'Source A',
          installedAt: '',
          updatedAt: '',
          updateAvailable: false,
        },
      ],
    });
    readSkillContentMock.mockImplementation((_sourceId, skillName) => ({
      success: true,
      data: {
        frontmatter:
          skillName === 'hidden-skill' ? { 'user-invocable': false } : {},
        body: '',
      },
    }));
    loadMarketplacesMock.mockResolvedValue({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-06-20T00:00:00.000Z',
        marketplaces: [marketplaceFixture()],
      },
    });
    refreshCapableLoadMarketplacesMock.mockImplementation(() =>
      loadMarketplacesMock(),
    );
    resolveEffectivePluginSelectionRefsMock.mockResolvedValue({
      disabledRefs: [],
      skillRefs: [{ sourceId: 'source-a', skillName: 'visible-skill' }],
      pluginRefs: [],
      mcpServerRefs: [],
      warnings: [],
    });
    codexAggregateSkillInvocationNamesForRefsMock.mockReturnValue(
      new Map([
        ['source-a/visible-skill', 'visible-skill'],
        ['source-a/hidden-skill', 'hidden-skill'],
      ]),
    );
    readCollectionConfigMock.mockResolvedValue(null);
    discoverInheritedMock.mockResolvedValue({
      skills: [],
      commands: [],
      skipped: [],
      fingerprint: 'none',
    });
    const service = await import('../plugins/invocable-inventory-service');
    service.resetInvocableInventoryServiceForTests();
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('lists inherited home-folder skills and commands as insert-only Cursor rows', async () => {
    discoverInheritedMock.mockResolvedValue({
      skills: [
        {
          origin: 'claude',
          name: 'review',
          sourceDir: '/home/user/.claude/skills/review',
          description: 'Review code',
          userInvocable: true,
        },
        {
          origin: 'cursor',
          name: 'quiet',
          sourceDir: '/home/user/.cursor/skills/quiet',
          description: '',
          userInvocable: false,
        },
      ],
      commands: [
        {
          origin: 'cursor',
          name: 'ship',
          markdown: '# Ship\n',
          description: 'Ship',
        },
      ],
      skipped: [],
      fingerprint: 'rows',
    });
    const service = await import('../plugins/invocable-inventory-service');
    const response = await service.refreshInvocableInventory('seed');
    expect(response.success).toBe(true);
    const entries =
      response.success && response.data ? response.data.entries : [];
    expect(entry(entries, 'cursor', 'inherited_skill', 'review')).toEqual({
      id: 'cursor:inherited_skill:claude:review',
      provider: 'cursor',
      kind: 'inherited_skill',
      name: 'review',
      displayName: '/review',
      description: 'Review code',
      insertText: '/review ',
      invocationKey: '/review',
      enableRef: { kind: 'none' },
      sourceLabel: '~/.claude/skills',
    });
    expect(
      entry(entries, 'cursor', 'inherited_skill', 'quiet'),
    ).toBeUndefined();
    expect(entry(entries, 'cursor', 'inherited_command', 'ship')).toMatchObject(
      {
        displayName: '/ship',
        insertText: '/ship ',
        enableRef: { kind: 'none' },
        sourceLabel: '~/.cursor/commands',
      },
    );
    // Copilot runs the same projection, so it mirrors the inherited rows too;
    // OpenCode mirrors Cursor's selectable rows only.
    expect(
      entry(entries, 'copilot', 'inherited_skill', 'review'),
    ).toMatchObject({
      id: 'copilot:cursor%3Ainherited_skill%3Aclaude%3Areview',
      provider: 'copilot',
      kind: 'inherited_skill',
      insertText: '/review ',
      enableRef: { kind: 'none' },
      sourceLabel: '~/.claude/skills',
    });
    expect(
      entry(entries, 'copilot', 'inherited_command', 'ship'),
    ).toMatchObject({ enableRef: { kind: 'none' } });
    expect(
      entries.filter(
        (item) =>
          item.provider === 'opencode' && item.enableRef.kind === 'none',
      ),
    ).toEqual([]);
    const written: unknown = JSON.parse(
      fs.readFileSync(
        path.join(tempDir, 'invocable-inventory-cache.json'),
        'utf8',
      ),
    );
    expect(written).toMatchObject({ version: 5 });
  });

  it('lists cached Cursor plugin members as inherited rows labeled by their plugin', async () => {
    discoverInheritedMock.mockResolvedValue({
      skills: [
        {
          origin: 'cursor-plugin',
          plugin: 'cursor-public/superpowers',
          name: 'brainstorming',
          sourceDir:
            '/home/user/.cursor/plugins/cache/cursor-public/superpowers/a/skills/brainstorming',
          description: 'Brainstorm',
          userInvocable: true,
        },
        {
          origin: 'cursor-plugin',
          plugin: 'cursor-public/other',
          name: 'brainstorming',
          sourceDir:
            '/home/user/.cursor/plugins/cache/cursor-public/other/b/skills/brainstorming',
          description: '',
          userInvocable: true,
        },
      ],
      commands: [],
      skipped: [],
      fingerprint: 'plugins',
    });
    const service = await import('../plugins/invocable-inventory-service');
    const response = await service.refreshInvocableInventory('seed');
    const entries =
      response.success && response.data ? response.data.entries : [];
    const rows = entries.filter(
      (item) => item.provider === 'cursor' && item.kind === 'inherited_skill',
    );
    expect(
      rows.map((row) => [row.id, row.insertText, row.sourceLabel]),
    ).toEqual([
      [
        'cursor:inherited_skill:cursor-plugin:cursor-public%2Fsuperpowers:brainstorming',
        '/brainstorming ',
        '~/.cursor/plugins/cursor-public/superpowers',
      ],
      [
        'cursor:inherited_skill:cursor-plugin:cursor-public%2Fother:brainstorming',
        '/brainstorming-1 ',
        '~/.cursor/plugins/cursor-public/other',
      ],
    ]);
  });

  function inheritedHomeSkill(
    name: string,
    fingerprint: string,
  ): InheritedCapabilitiesModule.InheritedCursorCapabilities {
    return {
      skills: [
        {
          origin: 'cursor',
          name,
          sourceDir: `/home/user/.cursor/skills/${name}`,
          description: '',
          userInvocable: true,
        },
      ],
      commands: [],
      skipped: [],
      fingerprint,
    };
  }

  function inheritedSkillNames(response: {
    data?: { entries: InvocableInventoryEntry[] };
  }): string[] {
    return (response.data?.entries ?? [])
      .filter(
        (entry) =>
          entry.provider === 'cursor' && entry.kind === 'inherited_skill',
      )
      .map((entry) => entry.name);
  }

  it('rebuilds when the inherited Cursor capabilities changed since the cache was built', async () => {
    discoverInheritedMock.mockResolvedValue(
      inheritedHomeSkill('alpha', 'fp-alpha'),
    );
    const service = await import('../plugins/invocable-inventory-service');
    await service.refreshInvocableInventory('seed');
    // The user installs a plugin in the Cursor app: nothing in Canopy
    // mutated, so only the next `/` menu can notice.
    discoverInheritedMock.mockResolvedValue(
      inheritedHomeSkill('beta', 'fp-beta'),
    );

    const first = await service.listInvocableInventory({
      providerType: 'cursor',
    });
    expect(inheritedSkillNames(first)).toEqual(['alpha']);
    let latest = first;
    for (
      let attempt = 0;
      attempt < 100 && !inheritedSkillNames(latest).includes('beta');
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      latest = await service.listInvocableInventory({ providerType: 'cursor' });
    }
    expect(inheritedSkillNames(latest)).toEqual(['beta']);
    expect(latest.data).toMatchObject({ stale: false, rebuilding: false });
  });

  it('rebuilds for a Copilot list too, which runs the same inherited rows', async () => {
    discoverInheritedMock.mockResolvedValue(
      inheritedHomeSkill('alpha', 'fp-alpha'),
    );
    const service = await import('../plugins/invocable-inventory-service');
    await service.refreshInvocableInventory('seed');
    discoverInheritedMock.mockResolvedValue(
      inheritedHomeSkill('beta', 'fp-beta'),
    );
    const copilotNames = (response: {
      data?: { entries: InvocableInventoryEntry[] };
    }): string[] =>
      (response.data?.entries ?? [])
        .filter(
          (entry) =>
            entry.provider === 'copilot' && entry.kind === 'inherited_skill',
        )
        .map((entry) => entry.name);
    let latest = await service.listInvocableInventory({
      providerType: 'copilot',
    });
    expect(copilotNames(latest)).toEqual(['alpha']);
    for (
      let attempt = 0;
      attempt < 100 && !copilotNames(latest).includes('beta');
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      latest = await service.listInvocableInventory({
        providerType: 'copilot',
      });
    }
    expect(copilotNames(latest)).toEqual(['beta']);
  });

  it('keeps the cache when the inherited Cursor capabilities are unchanged', async () => {
    discoverInheritedMock.mockResolvedValue(
      inheritedHomeSkill('alpha', 'fp-alpha'),
    );
    const service = await import('../plugins/invocable-inventory-service');
    const seeded = await service.refreshInvocableInventory('seed');
    const buildsAfterSeed = loadSkillsMock.mock.calls.length;

    await service.listInvocableInventory({ providerType: 'cursor' });
    for (let tick = 0; tick < 10; tick += 1)
      await new Promise((resolve) => setImmediate(resolve));

    // One discovery for the build, one for the re-check, no rebuild.
    expect(discoverInheritedMock).toHaveBeenCalledTimes(2);
    expect(loadSkillsMock).toHaveBeenCalledTimes(buildsAfterSeed);
    const again = await service.listInvocableInventory({
      providerType: 'cursor',
    });
    expect(again.data?.builtAt).toBe(seeded.data?.builtAt);
  });

  it('does not re-check inherited Cursor capabilities for another provider', async () => {
    const service = await import('../plugins/invocable-inventory-service');
    await service.refreshInvocableInventory('seed');
    await service.listInvocableInventory({ providerType: 'claude' });
    for (let tick = 0; tick < 10; tick += 1)
      await new Promise((resolve) => setImmediate(resolve));
    expect(discoverInheritedMock).toHaveBeenCalledTimes(1);
  });

  it('resolves an inherited row against the chat root, where a selected skill of the same name keeps the base id', async () => {
    discoverInheritedMock.mockResolvedValue({
      skills: [
        {
          origin: 'claude',
          name: 'visible-skill',
          sourceDir: '/home/user/.claude/skills/visible-skill',
          description: '',
          userInvocable: true,
        },
      ],
      commands: [],
      skipped: [],
      fingerprint: 'clash',
    });
    const service = await import('../plugins/invocable-inventory-service');
    const row: InvocableInventoryEntry = {
      id: 'cursor:inherited_skill:claude:visible-skill',
      provider: 'cursor',
      kind: 'inherited_skill',
      name: 'visible-skill',
      displayName: '/visible-skill',
      description: '',
      insertText: '/visible-skill ',
      invocationKey: '/visible-skill',
      enableRef: { kind: 'none' },
      sourceLabel: '~/.claude/skills',
    };
    // Nothing selected: the inherited skill holds the base id.
    resolveEffectivePluginSelectionRefsMock.mockResolvedValueOnce({
      disabledRefs: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
      warnings: [],
    });
    expect(
      await service.resolveInvocableSelection({
        providerType: 'cursor',
        entry: row,
        selections: emptySelections(),
      }),
    ).toEqual({
      success: true,
      data: { insertText: '/visible-skill ', invocationKey: '/visible-skill' },
    });
    // The chat selected a skill of the same name: the root gives the pick the
    // base id and the inherited copy the suffix, so the row inserts the
    // suffix rather than the cache's provisional text. Nothing is enabled.
    resolveEffectivePluginSelectionRefsMock.mockResolvedValueOnce({
      disabledRefs: [],
      skillRefs: [{ sourceId: 'source-a', skillName: 'visible-skill' }],
      pluginRefs: [],
      mcpServerRefs: [],
      warnings: [],
    });
    expect(
      await service.resolveInvocableSelection({
        providerType: 'cursor',
        entry: row,
        selections: {
          collectionIds: [],
          skillRefs: [{ sourceId: 'source-a', skillName: 'visible-skill' }],
          pluginRefs: [],
          mcpServerRefs: [],
        },
      }),
    ).toEqual({
      success: true,
      data: {
        insertText: '/visible-skill-1 ',
        invocationKey: '/visible-skill-1',
      },
    });
  });

  it('resolves inherited skill and command rows for a Copilot chat, which reads the same home folders', async () => {
    discoverInheritedMock.mockResolvedValue({
      skills: [
        {
          origin: 'claude',
          name: 'visible-skill',
          sourceDir: '/home/user/.claude/skills/visible-skill',
          description: '',
          userInvocable: true,
        },
      ],
      commands: [
        {
          origin: 'cursor',
          name: 'ship',
          markdown: '# Ship\n',
          description: 'Ship',
        },
      ],
      skipped: [],
      fingerprint: 'copilot',
    });
    const service = await import('../plugins/invocable-inventory-service');
    const row = (
      provider: 'copilot' | 'opencode',
      kind: 'inherited_skill' | 'inherited_command',
      name: string,
      sourceLabel: string,
    ): InvocableInventoryEntry => ({
      id: `${provider}:${kind}:x:${name}`,
      provider,
      kind,
      name,
      displayName: `/${name}`,
      description: '',
      insertText: `/${name} `,
      invocationKey: `/${name}`,
      enableRef: { kind: 'none' },
      sourceLabel,
    });
    resolveEffectivePluginSelectionRefsMock.mockResolvedValue({
      disabledRefs: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
      warnings: [],
    });
    expect(
      await service.resolveInvocableSelection({
        providerType: 'copilot',
        entry: row(
          'copilot',
          'inherited_skill',
          'visible-skill',
          '~/.claude/skills',
        ),
        selections: emptySelections(),
      }),
    ).toEqual({
      success: true,
      data: { insertText: '/visible-skill ', invocationKey: '/visible-skill' },
    });
    expect(
      await service.resolveInvocableSelection({
        providerType: 'copilot',
        entry: row(
          'copilot',
          'inherited_command',
          'ship',
          '~/.cursor/commands',
        ),
        selections: emptySelections(),
      }),
    ).toEqual({
      success: true,
      data: { insertText: '/ship ', invocationKey: '/ship' },
    });
    // OpenCode mirrors Cursor's selectable rows only; an inherited row is
    // still refused there.
    expect(
      await service.resolveInvocableSelection({
        providerType: 'opencode',
        entry: row(
          'opencode',
          'inherited_skill',
          'visible-skill',
          '~/.claude/skills',
        ),
        selections: emptySelections(),
      }),
    ).toEqual({
      success: false,
      error: 'Inherited rows belong to Cursor and Copilot chats.',
    });
  });

  it('drops an inherited skill that is a selected skill’s directory before assigning ids, like the chat root', async () => {
    const selectedDir = fs.realpathSync(
      path.join(tempDir, 'skills', 'source-a', 'visible-skill'),
    );
    discoverInheritedMock.mockResolvedValue({
      skills: [
        {
          origin: 'claude',
          name: 'visible-skill',
          sourceDir: selectedDir,
          description: '',
          userInvocable: true,
        },
        {
          origin: 'cursor',
          name: 'visible-skill',
          sourceDir: '/home/user/.cursor/skills/visible-skill',
          description: '',
          userInvocable: true,
        },
      ],
      commands: [
        {
          origin: 'cursor',
          name: 'visible-skill',
          markdown: '# Visible\n',
          description: 'Visible',
        },
      ],
      skipped: [],
      fingerprint: 'dup',
    });
    const service = await import('../plugins/invocable-inventory-service');
    const selections = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'source-a', skillName: 'visible-skill' }],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    const row = (
      kind: 'inherited_skill' | 'inherited_command',
      sourceLabel: string,
    ): InvocableInventoryEntry => ({
      id: `cursor:${kind}:x:visible-skill`,
      provider: 'cursor',
      kind,
      name: 'visible-skill',
      displayName: '/visible-skill',
      description: '',
      insertText: '/visible-skill ',
      invocationKey: '/visible-skill',
      enableRef: { kind: 'none' },
      sourceLabel,
    });
    const resolve = async (entry: InvocableInventoryEntry): Promise<unknown> =>
      (
        await service.resolveInvocableSelection({
          providerType: 'cursor',
          entry,
          selections,
        })
      ).data;

    // The chat root drops the home-folder copy that IS the selected skill's
    // directory, so the other copy takes the first suffix, not the second.
    expect(await resolve(row('inherited_skill', '~/.cursor/skills'))).toEqual({
      insertText: '/visible-skill-1 ',
      invocationKey: '/visible-skill-1',
    });
    // The dropped copy stands for the retained skill.
    expect(await resolve(row('inherited_skill', '~/.claude/skills'))).toEqual({
      insertText: '/visible-skill ',
      invocationKey: '/visible-skill',
    });
    // Commands come after every skill.
    expect(
      await resolve(row('inherited_command', '~/.cursor/commands')),
    ).toEqual({
      insertText: '/visible-skill-2 ',
      invocationKey: '/visible-skill-2',
    });
  });

  it('numbers inherited ids over the plugin set the chat runs, read from the Claude Code install folders: a plugin turned off for the chat takes no id', async () => {
    // Claude Code's installed copy carries `review`; the marketplace checkout
    // the cache knows carries a different command. The ids must come from
    // the installed copy, the folder the session loads.
    const installRoot = path.join(tempDir, 'claude', 'cache', 'claude-plugin');
    writeClaudePluginTree(installRoot, {
      skills: [],
      commands: [{ name: 'review', description: 'Review' }],
    });
    const checkoutRoot = path.join(tempDir, 'plugins', 'claude-plugin');
    writeClaudePluginTree(checkoutRoot, {
      skills: [],
      commands: [{ name: 'other', description: 'Other' }],
    });
    refreshCapableLoadMarketplacesMock.mockResolvedValue({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-06-20T00:00:00.000Z',
        marketplaces: [
          marketplaceFixture({ claudeInstallLocation: checkoutRoot }),
        ],
      },
    });
    // Claude Code reports the plugin enabled, with its verified install
    // folder, so a Cursor chat inherits it from there.
    mockClaudeEnabledPlugins.mockReturnValue(
      new Map([['claude-plugin@market', installRoot]]),
    );
    resolveEffectivePluginSelectionRefsMock.mockResolvedValue({
      disabledRefs: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
      warnings: [],
    });
    discoverInheritedMock.mockResolvedValue({
      skills: [
        {
          origin: 'cursor',
          name: 'claude-plugin-review',
          sourceDir: '/home/user/.cursor/skills/claude-plugin-review',
          description: '',
          userInvocable: true,
        },
      ],
      commands: [],
      skipped: [],
      fingerprint: 'tombstones',
    });
    const service = await import('../plugins/invocable-inventory-service');
    const row: InvocableInventoryEntry = {
      id: 'cursor:inherited_skill:cursor:claude-plugin-review',
      provider: 'cursor',
      kind: 'inherited_skill',
      name: 'claude-plugin-review',
      displayName: '/claude-plugin-review',
      description: '',
      insertText: '/claude-plugin-review ',
      invocationKey: '/claude-plugin-review',
      enableRef: { kind: 'none' },
      sourceLabel: '~/.cursor/skills',
    };

    // The inherited plugin's `review` command sanitizes to the same id and
    // comes first, so the home skill is suffixed...
    expect(
      (
        await service.resolveInvocableSelection({
          providerType: 'cursor',
          entry: row,
          selections: emptySelections(),
        })
      ).data,
    ).toEqual({
      insertText: '/claude-plugin-review-1 ',
      invocationKey: '/claude-plugin-review-1',
    });
    // ...unless the chat turned that plugin off: the session never
    // materializes it, so the resolver must not count it either.
    expect(
      (
        await service.resolveInvocableSelection({
          providerType: 'cursor',
          entry: row,
          selections: emptySelections(),
          chatTombstones: {
            pluginRefs: [
              { marketplaceId: 'market', pluginName: 'claude-plugin' },
            ],
          },
        })
      ).data,
    ).toEqual({
      insertText: '/claude-plugin-review ',
      invocationKey: '/claude-plugin-review',
    });
  });

  it("reads Claude Code's enabled plugins for the chat's repository, so project-scoped installs count only there", async () => {
    discoverInheritedMock.mockResolvedValue({
      skills: [
        {
          origin: 'cursor',
          name: 'review',
          sourceDir: '/home/user/.cursor/skills/review',
          description: '',
          userInvocable: true,
        },
      ],
      commands: [],
      skipped: [],
      fingerprint: 'scope',
    });
    resolveEffectivePluginSelectionRefsMock.mockResolvedValue({
      disabledRefs: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
      warnings: [],
    });
    const service = await import('../plugins/invocable-inventory-service');
    await service.resolveInvocableSelection({
      providerType: 'cursor',
      entry: {
        id: 'cursor:inherited_skill:cursor:review',
        provider: 'cursor',
        kind: 'inherited_skill',
        name: 'review',
        displayName: '/review',
        description: '',
        insertText: '/review ',
        invocationKey: '/review',
        enableRef: { kind: 'none' },
        sourceLabel: '~/.cursor/skills',
      },
      selections: emptySelections(),
      projectPath: '/repos/own',
    });
    expect(mockClaudeEnabledPlugins).toHaveBeenCalledWith(
      '/home/user/.claude',
      '/repos/own',
    );
  });

  it('refuses an inherited row whose entry is gone from the home folders, so the menu refreshes', async () => {
    const service = await import('../plugins/invocable-inventory-service');
    const result = await service.resolveInvocableSelection({
      providerType: 'cursor',
      entry: {
        id: 'cursor:inherited_skill:claude:review',
        provider: 'cursor',
        kind: 'inherited_skill',
        name: 'review',
        displayName: '/review',
        description: '',
        insertText: '/review ',
        invocationKey: '/review',
        enableRef: { kind: 'none' },
        sourceLabel: '~/.claude/skills',
      },
      selections: emptySelections(),
    });
    expect(result.success).toBe(false);
  });

  it('keeps a selected Cursor skill on its base id when a home-folder skill shares the name', async () => {
    discoverInheritedMock.mockResolvedValue({
      skills: [
        {
          origin: 'claude',
          name: 'visible-skill',
          sourceDir: '/home/user/.claude/skills/visible-skill',
          description: '',
          userInvocable: true,
        },
      ],
      commands: [],
      skipped: [],
      fingerprint: 'clash',
    });
    const service = await import('../plugins/invocable-inventory-service');
    const result = await service.resolveInvocableSelection({
      providerType: 'cursor',
      entry: {
        id: 'cursor:skill:source-a:visible-skill',
        provider: 'cursor',
        kind: 'skill',
        name: 'visible-skill',
        displayName: '/visible-skill',
        description: 'Visible',
        insertText: '/visible-skill ',
        invocationKey: '/visible-skill',
        enableRef: {
          kind: 'skill',
          sourceId: 'source-a',
          skillName: 'visible-skill',
        },
      },
      selections: {
        collectionIds: [],
        skillRefs: [{ sourceId: 'source-a', skillName: 'visible-skill' }],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    });
    expect(result).toEqual({
      success: true,
      data: { insertText: '/visible-skill ', invocationKey: '/visible-skill' },
    });
    expect(discoverInheritedMock).toHaveBeenCalled();
  });

  it('rechecks cached capability/search rows and refuses direct selection', async () => {
    const service = await import('../plugins/invocable-inventory-service');
    await service.refreshInvocableInventory('seed');
    mockSkillContextEnabled.mockReturnValue(true);
    mockAssertSkillContext.mockRejectedValue(
      new Error('Skill unavailable (context-mismatch)'),
    );
    const result = await service.listInvocableInventory({
      providerType: 'claude',
    });
    expect(
      result.data?.entries.some((row) => row.enableRef.kind === 'skill'),
    ).toBe(false);
    await expect(
      service.resolveInvocableSelection({
        providerType: 'claude',
        entry: standaloneEntry('claude', 'source-a', 'visible-skill'),
        selections: emptySelections(),
      }),
    ).rejects.toThrow('context-mismatch');
    expect(mockAssertSkillContext).toHaveBeenCalledWith(
      'source-a/visible-skill',
    );
    const packageSources = await service.loadPipelinePackageInventorySources();
    expect(
      packageSources.inventory.entries.some(
        (row) => row.enableRef.kind === 'skill',
      ),
    ).toBe(false);
  });

  it('builds cached standalone and plugin entries with provider-specific invocation text', async () => {
    const service = await import('../plugins/invocable-inventory-service');

    const refresh = await service.refreshInvocableInventory('test');

    expect(refresh.success).toBe(true);
    // Rebuild reads the cache, then response filtering reads fresh policy.
    expect(loadMarketplacesMock).toHaveBeenCalledTimes(2);
    expect(refreshCapableLoadMarketplacesMock).not.toHaveBeenCalled();
    const entries = refresh.data?.entries ?? [];
    expect(entry(entries, 'claude', 'skill', 'visible-skill')).toMatchObject({
      displayName: '/visible-skill',
      insertText: '/visible-skill ',
    });
    expect(entry(entries, 'claude', 'skill', 'hidden-skill')).toBeUndefined();
    expect(
      entry(entries, 'claude', 'plugin_skill', 'plug-skill'),
    ).toMatchObject({
      displayName: '/claude-plugin:plug-skill',
      insertText: '/claude-plugin:plug-skill ',
    });
    expect(
      entry(entries, 'claude', 'plugin_skill', 'hidden-plug-skill'),
    ).toBeUndefined();
    expect(
      entry(entries, 'claude', 'plugin_command', 'do-thing'),
    ).toMatchObject({
      displayName: '/do-thing',
      insertText: '/do-thing ',
    });
    expect(entry(entries, 'codex', 'skill', 'visible-skill')).toMatchObject({
      displayName: '$builtin-app-plugin:visible-skill',
      insertText: '$builtin-app-plugin:visible-skill ',
    });
    expect(entry(entries, 'codex', 'skill', 'hidden-skill')).toMatchObject({
      displayName: '$builtin-app-plugin:hidden-skill',
      insertText: '$builtin-app-plugin:hidden-skill ',
    });
    expect(
      entry(entries, 'codex', 'plugin_skill', 'codex-skill'),
    ).toMatchObject({
      displayName: '$codex-plugin:codex-skill',
      insertText: '$codex-plugin:codex-skill ',
    });
    expect(
      entry(entries, 'codex', 'plugin_skill', 'hidden-codex-skill'),
    ).toMatchObject({
      displayName: '$codex-plugin:hidden-codex-skill',
      insertText: '$codex-plugin:hidden-codex-skill ',
    });
    expect(
      entry(entries, 'codex', 'plugin_skill', 'hidden-plug-skill'),
    ).toMatchObject({
      displayName: '$compat-plugin:hidden-plug-skill',
      insertText: '$compat-plugin:hidden-plug-skill ',
    });
    expect(
      entry(entries, 'codex', 'plugin_command', 'run-report-2'),
    ).toMatchObject({
      sourceName: 'run report',
      displayName: '$compat-plugin:run-report-2',
      insertText: '$compat-plugin:run-report-2 ',
    });
    // Cursor rows insert the id the chat's private root will hold: the
    // skill name for standalone skills, plugin-member for plugin members.
    expect(entry(entries, 'cursor', 'skill', 'visible-skill')).toMatchObject({
      displayName: '/visible-skill',
      insertText: '/visible-skill ',
      invocationKey: '/visible-skill',
    });
    expect(entry(entries, 'cursor', 'skill', 'hidden-skill')).toBeUndefined();
    expect(
      entry(entries, 'cursor', 'plugin_skill', 'plug-skill'),
    ).toMatchObject({
      displayName: '/claude-plugin-plug-skill',
      insertText: '/claude-plugin-plug-skill ',
      sourceLabel: 'claude-plugin',
    });
    expect(
      entry(entries, 'cursor', 'plugin_skill', 'hidden-plug-skill'),
    ).toBeUndefined();
    expect(
      entry(entries, 'cursor', 'plugin_command', 'do-thing'),
    ).toMatchObject({
      displayName: '/claude-plugin-do-thing',
      insertText: '/claude-plugin-do-thing ',
    });
    // The plugin's `run-report` skill claims the base id first; its
    // `run report` command sanitizes to the same id and is suffixed.
    expect(
      entry(entries, 'cursor', 'plugin_command', 'run report'),
    ).toMatchObject({ displayName: '/claude-plugin-run-report-1' });
    expect(
      entry(entries, 'cursor', 'plugin_skill', 'codex-skill'),
    ).toMatchObject({ displayName: '/codex-plugin-codex-skill' });
    expect(
      entry(entries, 'cursor', 'plugin_skill', 'hidden-codex-skill'),
    ).toBeUndefined();
  });

  it('assigns Cursor ids over every plugin member, including skills hidden from invocation', async () => {
    // The chat's root holds `hidden-plug-skill` (the CLI loads it for the
    // model even though it is not user-invocable), so a command with the same
    // name must take the suffixed id in the inventory as well.
    const pluginRoot = path.join(tempDir, 'plugins', 'claude-plugin');
    writeClaudePluginTree(pluginRoot, {
      skills: [
        { name: 'plug-skill' },
        { name: 'hidden-plug-skill', userInvocable: false },
        { name: 'run-report' },
      ],
      commands: [
        {
          name: 'hidden-plug-skill',
          description: 'Same name as the hidden skill',
        },
      ],
    });
    loadMarketplacesMock.mockResolvedValue({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-06-20T00:00:00.000Z',
        marketplaces: [
          marketplaceFixture({
            claudeInstallLocation: pluginRoot,
            claudeCommands: [
              {
                name: 'hidden-plug-skill',
                description: 'Same name as the hidden skill',
                filePath: 'commands/hidden.md',
              },
            ],
          }),
        ],
      },
    });
    const service = await import('../plugins/invocable-inventory-service');
    const refresh = await service.refreshInvocableInventory('test');
    const entries = refresh.data?.entries ?? [];
    expect(
      entry(entries, 'cursor', 'plugin_skill', 'hidden-plug-skill'),
    ).toBeUndefined();
    expect(
      entry(entries, 'cursor', 'plugin_command', 'hidden-plug-skill'),
    ).toMatchObject({ displayName: '/claude-plugin-hidden-plug-skill-1' });
    resolveEffectivePluginSelectionRefsMock.mockResolvedValue({
      disabledRefs: [],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'claude-plugin' }],
      mcpServerRefs: [],
      warnings: [],
    });
    expect(
      await service.resolveInvocableSelection({
        providerType: 'cursor',
        entry: {
          ...pluginCommandEntry('claude', 'hidden-plug-skill'),
          provider: 'cursor',
        },
        selections: emptySelections(),
      }),
    ).toEqual({
      success: true,
      data: {
        insertText: '/claude-plugin-hidden-plug-skill-1 ',
        invocationKey: '/claude-plugin-hidden-plug-skill-1',
      },
    });
  });

  it('assigns Cursor ids over the skills that exist on disk, the way the chat root is built', async () => {
    // `source-gone` is still referenced by the selection but has no SKILL.md;
    // the resolver skips it, so it must not push the installed skill of the
    // same name onto a suffixed id.
    writeSkill(tempDir, 'source-b', 'review');
    resolveEffectivePluginSelectionRefsMock.mockResolvedValue({
      disabledRefs: [],
      skillRefs: [
        { sourceId: 'source-gone', skillName: 'review' },
        { sourceId: 'source-b', skillName: 'review' },
      ],
      pluginRefs: [],
      mcpServerRefs: [],
      warnings: [],
    });
    const service = await import('../plugins/invocable-inventory-service');
    expect(
      await service.resolveInvocableSelection({
        providerType: 'cursor',
        entry: {
          id: 'cursor:skill:source-b:review',
          provider: 'cursor',
          kind: 'skill',
          name: 'review',
          displayName: '/review',
          description: '',
          insertText: '/review ',
          invocationKey: '/review',
          enableRef: {
            kind: 'skill',
            sourceId: 'source-b',
            skillName: 'review',
          },
        },
        selections: emptySelections(),
      }),
    ).toEqual({
      success: true,
      data: { insertText: '/review ', invocationKey: '/review' },
    });
  });

  it('assigns Cursor ids over the skills inside the skills root only, like the resolver', async () => {
    // A reference that escapes the skills root has a SKILL.md on disk but
    // the resolver refuses it; it must not claim the base id here either.
    fs.mkdirSync(path.join(tempDir, 'escape'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'escape', 'SKILL.md'),
      '---\nname: escape\n---\n',
    );
    writeSkill(tempDir, 'source-b', 'escape');
    resolveEffectivePluginSelectionRefsMock.mockResolvedValue({
      disabledRefs: [],
      skillRefs: [
        { sourceId: 'source-a', skillName: '../../escape' },
        { sourceId: 'source-b', skillName: 'escape' },
      ],
      pluginRefs: [],
      mcpServerRefs: [],
      warnings: [],
    });
    const service = await import('../plugins/invocable-inventory-service');
    expect(
      await service.resolveInvocableSelection({
        providerType: 'cursor',
        entry: {
          id: 'cursor:skill:source-b:escape',
          provider: 'cursor',
          kind: 'skill',
          name: 'escape',
          displayName: '/escape',
          description: '',
          insertText: '/escape ',
          invocationKey: '/escape',
          enableRef: {
            kind: 'skill',
            sourceId: 'source-b',
            skillName: 'escape',
          },
        },
        selections: emptySelections(),
      }),
    ).toEqual({
      success: true,
      data: { insertText: '/escape ', invocationKey: '/escape' },
    });
  });

  it('assigns Cursor ids in the same member order as the chat root, not the facet listing order', async () => {
    // Two skills that sanitize to the same id, listed by the facet in the
    // opposite of code-point order: the root sorts by name first, so
    // `foo bar` (space < hyphen) claims the base id.
    loadMarketplacesMock.mockResolvedValue({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-06-20T00:00:00.000Z',
        marketplaces: [
          {
            ...marketplaceFixture(),
            plugins: [
              {
                name: 'order-plugin',
                description: '',
                sourcePath: '',
                marketplaceId: 'market',
                providerSupport: { claude: 'native', codex: 'none' },
                facets: {
                  claude: {
                    provider: 'claude',
                    mode: 'native',
                    name: 'order-plugin',
                    installLocation: '',
                    sourcePath: '',
                    details: {
                      skills: [
                        {
                          name: 'foo-bar',
                          description: '',
                          path: 'skills/foo-bar',
                        },
                        {
                          name: 'foo bar',
                          description: '',
                          path: 'skills/foo bar',
                        },
                      ],
                      agents: [],
                      commands: [],
                      apps: [],
                      hooks: [],
                      mcpServers: [],
                      lspServers: [],
                      hasReadme: false,
                    },
                  },
                },
              },
            ],
          },
        ],
      },
    });
    const service = await import('../plugins/invocable-inventory-service');
    const entries =
      (await service.refreshInvocableInventory('test')).data?.entries ?? [];
    expect(entry(entries, 'cursor', 'plugin_skill', 'foo bar')).toMatchObject({
      displayName: '/order-plugin-foo-bar',
    });
    expect(entry(entries, 'cursor', 'plugin_skill', 'foo-bar')).toMatchObject({
      displayName: '/order-plugin-foo-bar-1',
    });
  });

  it('resolves a Cursor plugin row against the members on disk, the way the chat root is built', async () => {
    const pluginRoot = path.join(tempDir, 'plugins', 'disk-plugin');
    fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      '{"name":"disk-plugin"}',
    );
    // A skill on disk the cached facet does not know about yet claims the
    // base id ahead of the command with the same name.
    fs.mkdirSync(path.join(pluginRoot, 'skills', 'zeta'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, 'skills', 'zeta', 'SKILL.md'),
      '---\nname: zeta\ndescription: z\n---\n',
    );
    fs.mkdirSync(path.join(pluginRoot, 'commands'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, 'commands', 'zeta.md'),
      '---\ndescription: Zeta command\n---\nGo.\n',
    );
    const plugin: PluginInfo = {
      name: 'disk-plugin',
      description: '',
      sourcePath: '',
      marketplaceId: 'market',
      providerSupport: { claude: 'native', codex: 'none' },
      facets: {
        claude: {
          provider: 'claude',
          mode: 'native',
          name: 'disk-plugin',
          installLocation: pluginRoot,
          sourcePath: '',
          details: {
            skills: [],
            agents: [],
            commands: [
              {
                name: 'zeta',
                description: 'Zeta command',
                filePath: 'commands/zeta.md',
              },
            ],
            apps: [],
            hooks: [],
            mcpServers: [],
            lspServers: [],
            hasReadme: false,
          },
        },
      },
    };
    refreshCapableLoadMarketplacesMock.mockResolvedValue({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-06-20T00:00:00.000Z',
        marketplaces: [{ ...marketplaceFixture(), plugins: [plugin] }],
      },
    });
    resolveEffectivePluginSelectionRefsMock.mockResolvedValue({
      disabledRefs: [],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'disk-plugin' }],
      mcpServerRefs: [],
      warnings: [],
    });
    const service = await import('../plugins/invocable-inventory-service');
    expect(
      await service.resolveInvocableSelection({
        providerType: 'cursor',
        entry: {
          id: 'cursor:plugin_command:market:disk-plugin:zeta',
          provider: 'cursor',
          kind: 'plugin_command',
          name: 'zeta',
          displayName: '/disk-plugin-zeta',
          description: '',
          insertText: '/disk-plugin-zeta ',
          invocationKey: '/disk-plugin-zeta',
          enableRef: {
            kind: 'plugin',
            marketplaceId: 'market',
            pluginName: 'disk-plugin',
          },
        },
        selections: emptySelections(),
      }),
    ).toEqual({
      success: true,
      data: {
        insertText: '/disk-plugin-zeta-1 ',
        invocationKey: '/disk-plugin-zeta-1',
      },
    });
  });

  it('resolves Cursor rows to the ids the chat root will hold after merging the selection', async () => {
    const service = await import('../plugins/invocable-inventory-service');
    writeSkill(tempDir, 'source-b', 'visible-skill');
    const pluginRoot = path.join(tempDir, 'plugins', 'claude-plugin');
    writeClaudePluginTree(pluginRoot, {
      skills: [
        { name: 'plug-skill' },
        { name: 'hidden-plug-skill', userInvocable: false },
        { name: 'run-report' },
      ],
      commands: [
        { name: 'do-thing', description: 'Do thing' },
        { name: 'run report', description: 'Run report' },
      ],
    });
    refreshCapableLoadMarketplacesMock.mockResolvedValue({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-06-20T00:00:00.000Z',
        marketplaces: [
          marketplaceFixture({ claudeInstallLocation: pluginRoot }),
        ],
      },
    });
    resolveEffectivePluginSelectionRefsMock.mockResolvedValue({
      disabledRefs: [],
      skillRefs: [
        { sourceId: 'source-a', skillName: 'visible-skill' },
        { sourceId: 'source-b', skillName: 'visible-skill' },
      ],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'claude-plugin' }],
      mcpServerRefs: [],
      warnings: [],
    });
    const secondSource: InvocableInventoryEntry = {
      id: 'cursor:skill:source-b:visible-skill',
      provider: 'cursor',
      kind: 'skill',
      name: 'visible-skill',
      displayName: '/visible-skill',
      description: '',
      insertText: '/visible-skill ',
      invocationKey: '/visible-skill',
      enableRef: {
        kind: 'skill',
        sourceId: 'source-b',
        skillName: 'visible-skill',
      },
    };
    // A second standalone skill with the same name is suffixed, in
    // selection order, exactly as the resolver assigns ids for the root.
    expect(
      await service.resolveInvocableSelection({
        providerType: 'cursor',
        entry: secondSource,
        selections: {
          ...emptySelections(),
          skillRefs: [{ sourceId: 'source-a', skillName: 'visible-skill' }],
        },
      }),
    ).toEqual({
      success: true,
      data: {
        insertText: '/visible-skill-1 ',
        invocationKey: '/visible-skill-1',
      },
    });
    expect(
      await service.resolveInvocableSelection({
        providerType: 'cursor',
        entry: {
          ...pluginCommandEntry('claude', 'do-thing'),
          provider: 'cursor',
        },
        selections: emptySelections(),
      }),
    ).toEqual({
      success: true,
      data: {
        insertText: '/claude-plugin-do-thing ',
        invocationKey: '/claude-plugin-do-thing',
      },
    });
    expect(
      await service.resolveInvocableSelection({
        providerType: 'cursor',
        entry: {
          ...pluginSkillEntry('claude', 'claude-plugin', 'gone'),
          provider: 'cursor',
        },
        selections: emptySelections(),
      }),
    ).toEqual({
      success: false,
      error: 'Selected plugin skill is no longer available.',
    });
  });

  it('uses the resolved Claude facet install location as the package source root', async () => {
    const pluginRoot = path.join(
      tempDir,
      'marketplace',
      'claude-plugins',
      'claude-plugin',
    );
    const marketplace = marketplaceFixture();
    const claudeFacet = marketplace.plugins[0]?.facets.claude;
    expect(claudeFacet).toBeDefined();
    if (!claudeFacet) return;
    claudeFacet.installLocation = pluginRoot;
    claudeFacet.sourcePath = './claude-plugins/claude-plugin';
    loadMarketplacesMock.mockResolvedValue({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-06-20T00:00:00.000Z',
        marketplaces: [marketplace],
      },
    });
    const service = await import('../plugins/invocable-inventory-service');
    await service.refreshInvocableInventory('package-source-root');

    const { inventory, sources } =
      await service.loadPipelinePackageInventorySources();
    const command = entry(
      inventory.entries,
      'claude',
      'plugin_command',
      'do-thing',
    );

    expect(command).toBeDefined();
    expect(command && sources[command.id]).toMatchObject({
      sourceRoot: pluginRoot,
      memberPath: 'commands/do.md',
    });
  });

  it('builds cached Codex standalone rows with aggregate two-pass duplicate names', async () => {
    const actualResolver = jest.requireActual<typeof PluginResolverModule>(
      '../plugins/plugin-resolver',
    );
    codexAggregateSkillInvocationNamesForRefsMock.mockImplementation(
      actualResolver.codexAggregateSkillInvocationNamesForRefs,
    );
    writeSkill(tempDir, 'source-direct', 'alpha');
    writeSkill(tempDir, 'source-candidate', 'alpha');
    writeSkill(tempDir, 'source-collection', 'alpha');
    loadSkillsMock.mockReturnValue({
      success: true,
      data: [
        installedSkill('source-direct', 'alpha'),
        installedSkill('source-candidate', 'alpha'),
        installedSkill('source-collection', 'alpha'),
      ],
    });
    loadMarketplacesMock.mockResolvedValue({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-06-20T00:00:00.000Z',
        marketplaces: [],
      },
    });
    const service = await import('../plugins/invocable-inventory-service');

    const refresh = await service.refreshInvocableInventory(
      'duplicate-codex-names',
    );

    expect(refresh.success).toBe(true);
    const entries = refresh.data?.entries ?? [];
    const candidate = standaloneSkillEntry(
      entries,
      'codex',
      'source-candidate',
      'alpha',
    );
    expect(candidate).toMatchObject({
      displayName: '$builtin-app-plugin:alpha-1',
      insertText: '$builtin-app-plugin:alpha-1 ',
      invocationKey: '$builtin-app-plugin:alpha-1',
    });
    expect(candidate?.displayName).not.toBe('$builtin-app-plugin:alpha-2');
  });

  it('uses canonical source ordering for cached compatibility collisions', async () => {
    loadMarketplacesMock.mockResolvedValue({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-06-20T00:00:00.000Z',
        marketplaces: [
          marketplaceFixture({
            claudeCommands: [
              {
                name: 'run report',
                description: 'Later source file',
                filePath: 'commands/z-run.md',
              },
              {
                name: 'run-report',
                description: 'Earlier source file',
                filePath: 'commands/a-run.md',
              },
            ],
          }),
        ],
      },
    });
    const service = await import('../plugins/invocable-inventory-service');

    const refresh = await service.refreshInvocableInventory(
      'cached-compat-collision-order',
    );

    expect(refresh.success).toBe(true);
    const entries = refresh.data?.entries ?? [];
    expect(
      entries.find(
        (item) =>
          item.provider === 'codex' &&
          item.kind === 'plugin_command' &&
          item.sourceName === 'run-report',
      ),
    ).toMatchObject({
      displayName: '$compat-plugin:run-report-2',
    });
    expect(
      entries.find(
        (item) =>
          item.provider === 'codex' &&
          item.kind === 'plugin_command' &&
          item.sourceName === 'run report',
      ),
    ).toMatchObject({
      displayName: '$compat-plugin:run-report-3',
    });
  });

  it('returns stale empty results and starts a rebuild when the cache is missing', async () => {
    let resolveLoadMarketplaces: () => void = () => undefined;
    const policyCatalog = await loadMarketplacesMock();
    loadMarketplacesMock.mockResolvedValueOnce(policyCatalog).mockReturnValue(
      new Promise((resolve) => {
        resolveLoadMarketplaces = (): void =>
          resolve({
            success: true,
            data: {
              version: 2,
              lastRefreshed: '2026-06-20T00:00:00.000Z',
              marketplaces: [],
            },
          });
      }),
    );
    const service = await import('../plugins/invocable-inventory-service');

    const result = await service.listInvocableInventory({
      providerType: 'claude',
    });

    expect(result).toMatchObject({
      success: true,
      data: { entries: [], stale: true, rebuilding: true },
    });
    expect(loadSkillsMock).not.toHaveBeenCalled();
    resolveLoadMarketplaces();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const idleResult = await service.listInvocableInventory({
        providerType: 'claude',
      });
      if (
        idleResult.data &&
        !idleResult.data.rebuilding &&
        !idleResult.data.stale
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(loadSkillsMock).toHaveBeenCalledTimes(1);
  });

  it('catches list-triggered missing-cache rebuild failures', async () => {
    const blockedPath = path.join(tempDir, 'blocked');
    fs.writeFileSync(blockedPath, 'not a directory', 'utf8');
    getDataDirMock.mockReturnValue(path.join(blockedPath, 'child'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {
      // Expected from the failed background rebuild.
    });
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    const service = await import('../plugins/invocable-inventory-service');

    try {
      const result = await service.listInvocableInventory({
        providerType: 'claude',
      });

      expect(result).toMatchObject({
        success: true,
        data: { entries: [], stale: true, rebuilding: true },
      });
      for (
        let attempt = 0;
        attempt < 10 && warnSpy.mock.calls.length === 0;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(unhandledRejections).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[invocable-inventory\] Failed to rebuild inventory \(list(?::follow-up)*\):$/,
        ),
        expect.anything(),
      );
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      warnSpy.mockRestore();
    }
  });

  it('keeps stale true when a failed rebuild falls back to an existing disk cache', async () => {
    const diskEntry = standaloneEntry('claude', 'source-a', 'disk-skill');
    fs.writeFileSync(
      path.join(tempDir, 'invocable-inventory-cache.json'),
      `${JSON.stringify({
        version: 5,
        builtAt: '2026-06-20T00:00:00.000Z',
        entries: [diskEntry],
      })}\n`,
      'utf8',
    );
    loadSkillsMock.mockReturnValue({ success: true, data: [] });
    // Only the rebuild fails; the stale response still needs fresh policy.
    loadMarketplacesMock.mockRejectedValueOnce(new Error('refresh failed'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {
      // Expected from the failed rebuild.
    });
    const service = await import('../plugins/invocable-inventory-service');

    try {
      const result =
        await service.refreshInvocableInventory('failed-before-load');

      expect(result).toMatchObject({
        success: true,
        data: {
          entries: [expect.objectContaining({ name: 'disk-skill' })],
          stale: true,
          rebuilding: false,
        },
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('ignores the previous cache version and rebuilds in the background', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'invocable-inventory-cache.json'),
      JSON.stringify({ version: 1, builtAt: 'old', entries: [] }),
      'utf8',
    );
    let resolveLoadMarketplaces: () => void = () => undefined;
    const policyCatalog = await loadMarketplacesMock();
    loadMarketplacesMock.mockResolvedValueOnce(policyCatalog).mockReturnValue(
      new Promise((resolve) => {
        resolveLoadMarketplaces = (): void =>
          resolve({
            success: true,
            data: {
              version: 2,
              lastRefreshed: '2026-06-20T00:00:00.000Z',
              marketplaces: [],
            },
          });
      }),
    );
    const service = await import('../plugins/invocable-inventory-service');

    const result = await service.listInvocableInventory({
      providerType: 'codex',
    });

    expect(result).toMatchObject({
      success: true,
      data: { entries: [], stale: true, rebuilding: true },
    });
    resolveLoadMarketplaces();
    let idleResult = result;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      idleResult = await service.listInvocableInventory({
        providerType: 'codex',
      });
      if (
        idleResult.data &&
        !idleResult.data.rebuilding &&
        !idleResult.data.stale
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(idleResult).toMatchObject({
      success: true,
      data: { stale: false, rebuilding: false },
    });
    expect(loadSkillsMock).toHaveBeenCalledTimes(1);
  });

  it('drops invalid persisted cache entries while loading valid rows', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'invocable-inventory-cache.json'),
      JSON.stringify({
        version: 5,
        builtAt: '2026-06-20T00:00:00.000Z',
        entries: [
          standaloneEntry('claude', 'source-a', 'disk-skill'),
          {
            id: 'invalid',
            provider: 'claude',
            kind: 'skill',
            name: 'invalid',
            displayName: '/invalid',
            description: '',
            insertText: '/invalid ',
            invocationKey: '/invalid',
          },
        ],
      }),
      'utf8',
    );
    const service = await import('../plugins/invocable-inventory-service');

    const result = await service.listInvocableInventory({
      providerType: 'claude',
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        stale: false,
        rebuilding: false,
        entries: [expect.objectContaining({ name: 'disk-skill' })],
      },
    });
  });

  it('schedules another rebuild when stale is marked during a rebuild', async () => {
    let resolveFirstLoadMarketplaces: () => void = () => undefined;
    loadMarketplacesMock
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirstLoadMarketplaces = (): void =>
            resolve({
              success: true,
              data: {
                version: 2,
                lastRefreshed: '2026-06-20T00:00:00.000Z',
                marketplaces: [],
              },
            });
        }),
      )
      .mockResolvedValue({
        success: true,
        data: {
          version: 2,
          lastRefreshed: '2026-06-20T00:00:00.000Z',
          marketplaces: [],
        },
      });
    const service = await import('../plugins/invocable-inventory-service');

    const firstRefresh = service.refreshInvocableInventory('first');
    await new Promise((resolve) => setTimeout(resolve, 0));
    service.markInvocableInventoryStale('during-build');
    resolveFirstLoadMarketplaces();
    const firstResult = await firstRefresh;

    expect(firstResult).toMatchObject({
      success: true,
      data: { stale: true },
    });
    for (
      let attempt = 0;
      attempt < 10 && loadSkillsMock.mock.calls.length < 2;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(loadSkillsMock).toHaveBeenCalledTimes(2);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const idleResult = await service.listInvocableInventory({
        providerType: 'claude',
      });
      if (
        idleResult.data &&
        !idleResult.data.rebuilding &&
        !idleResult.data.stale
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

  it('fails live resolution when a selected plugin command was removed', async () => {
    loadMarketplacesMock.mockResolvedValue({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-06-20T00:00:00.000Z',
        marketplaces: [
          marketplaceFixture({
            claudeCommands: [],
          }),
        ],
      },
    });
    const service = await import('../plugins/invocable-inventory-service');

    const result = await service.resolveInvocableSelection({
      providerType: 'claude',
      entry: pluginCommandEntry('claude', 'do-thing'),
      selections: emptySelections(),
    });

    expect(result.success).toBe(false);
  });

  it('resolves Codex standalone skills through the resolver aggregate-name helper', async () => {
    const service = await import('../plugins/invocable-inventory-service');

    const result = await service.resolveInvocableSelection({
      providerType: 'codex',
      entry: standaloneEntry('codex', 'source-a', 'visible-skill'),
      selections: {
        ...emptySelections(),
        skillRefs: [{ sourceId: 'source-a', skillName: 'visible-skill' }],
      },
    });

    expect(result).toEqual({
      success: true,
      data: {
        insertText: '$builtin-app-plugin:visible-skill ',
        invocationKey: '$builtin-app-plugin:visible-skill',
      },
    });
    expect(resolveEffectivePluginSelectionRefsMock).toHaveBeenCalled();
    expect(codexAggregateSkillInvocationNamesForRefsMock).toHaveBeenCalled();
  });

  it('resolves Codex standalone skills hidden from Claude invocation', async () => {
    resolveEffectivePluginSelectionRefsMock.mockResolvedValueOnce({
      disabledRefs: [],
      skillRefs: [{ sourceId: 'source-a', skillName: 'hidden-skill' }],
      pluginRefs: [],
      mcpServerRefs: [],
      warnings: [],
    });
    codexAggregateSkillInvocationNamesForRefsMock.mockReturnValueOnce(
      new Map([['source-a/hidden-skill', 'hidden-skill']]),
    );
    const service = await import('../plugins/invocable-inventory-service');

    const result = await service.resolveInvocableSelection({
      providerType: 'codex',
      entry: standaloneEntry('codex', 'source-a', 'hidden-skill'),
      selections: emptySelections(),
    });

    expect(result).toEqual({
      success: true,
      data: {
        insertText: '$builtin-app-plugin:hidden-skill ',
        invocationKey: '$builtin-app-plugin:hidden-skill',
      },
    });
  });

  it('uses actual two-pass Codex aggregate names with Collection-expanded skills', async () => {
    const actualResolver = jest.requireActual<typeof PluginResolverModule>(
      '../plugins/plugin-resolver',
    );
    resolveEffectivePluginSelectionRefsMock.mockImplementation(
      actualResolver.resolveEffectivePluginSelectionRefs,
    );
    codexAggregateSkillInvocationNamesForRefsMock.mockImplementation(
      actualResolver.codexAggregateSkillInvocationNamesForRefs,
    );

    const writeSkill = (sourceId: string, skillName: string): void => {
      const dir = path.join(tempDir, 'skills', sourceId, skillName);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        `---\nname: ${skillName}\n---\n`,
        'utf8',
      );
    };
    writeSkill('source-direct', 'alpha');
    writeSkill('source-candidate', 'alpha');
    writeSkill('source-collection', 'alpha');

    readCollectionConfigMock.mockResolvedValue({
      version: 2,
      collection: {
        id: 'c0ffee',
        name: 'Collection',
        description: '',
        skills: [{ sourceId: 'source-collection', skillName: 'alpha' }],
        plugins: [],
        mcpServers: [],
        createdAt: '',
        updatedAt: '',
      },
    });

    const selections: ChatTabPluginSelections = {
      collectionIds: ['c0ffee'],
      skillRefs: [{ sourceId: 'source-direct', skillName: 'alpha' }],
      pluginRefs: [],
    };
    const candidate = standaloneEntry('codex', 'source-candidate', 'alpha');
    const service = await import('../plugins/invocable-inventory-service');

    const result = await service.resolveInvocableSelection({
      providerType: 'codex',
      entry: candidate,
      selections,
    });

    const effective = await actualResolver.resolveEffectivePluginSelectionRefs({
      ...selections,
      skillRefs: [
        ...selections.skillRefs,
        { sourceId: 'source-candidate', skillName: 'alpha' },
      ],
    });
    const aggregateNames =
      actualResolver.codexAggregateSkillInvocationNamesForRefs(
        effective.skillRefs,
      );
    const aggregateName = aggregateNames.get('source-candidate/alpha');
    const usedSinglePassNames = new Set<string>();
    const singlePassNames = new Map<string, string>();
    for (const ref of effective.skillRefs) {
      singlePassNames.set(
        `${ref.sourceId}/${ref.skillName}`,
        createGeneratedSkillName(ref.skillName, usedSinglePassNames),
      );
    }
    const singlePassCandidate = singlePassNames.get('source-candidate/alpha');

    expect(effective.skillRefs).toEqual([
      { sourceId: 'source-direct', skillName: 'alpha' },
      { sourceId: 'source-candidate', skillName: 'alpha' },
      { sourceId: 'source-collection', skillName: 'alpha' },
    ]);
    expect(aggregateName).toBe('alpha-1');
    expect(singlePassCandidate).toBe('alpha-2');
    expect(aggregateName).not.toBe(singlePassCandidate);
    expect(result).toEqual({
      success: true,
      data: {
        insertText: `$builtin-app-plugin:${aggregateName} `,
        invocationKey: `$builtin-app-plugin:${aggregateName}`,
      },
    });
  });

  it('validates Codex compatibility commands against generated skills after prepare', async () => {
    const service = await import('../plugins/invocable-inventory-service');

    const result = await service.resolveInvocableSelection({
      providerType: 'codex',
      entry: pluginCommandEntry('codex', 'run-report-2', 'run report'),
      selections: emptySelections(),
    });

    expect(result).toEqual({
      success: true,
      data: {
        insertText: '$compat-plugin:run-report-2 ',
        invocationKey: '$compat-plugin:run-report-2',
      },
    });

    loadMarketplacesMock.mockResolvedValue({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-06-20T00:00:00.000Z',
        marketplaces: [
          marketplaceFixture({
            compatSkills: [
              {
                name: 'run-report',
                description: 'Collision',
                path: 'skills/run-report',
              },
            ],
          }),
        ],
      },
    });
    const missing = await service.resolveInvocableSelection({
      providerType: 'codex',
      entry: pluginCommandEntry('codex', 'run-report-2', 'run report'),
      selections: emptySelections(),
    });
    expect(missing.success).toBe(false);

    loadMarketplacesMock.mockResolvedValue({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-06-20T00:00:00.000Z',
        marketplaces: [marketplaceFixture({ codexCompatDisabled: true })],
      },
    });
    const disabled = await service.resolveInvocableSelection({
      providerType: 'codex',
      entry: pluginCommandEntry('codex', 'run-report-2', 'run report'),
      selections: emptySelections(),
    });
    expect(disabled.success).toBe(false);
  });

  it('resolves Codex-native plugin skills hidden from Claude invocation', async () => {
    const service = await import('../plugins/invocable-inventory-service');

    const result = await service.resolveInvocableSelection({
      providerType: 'codex',
      entry: pluginSkillEntry('codex', 'codex-plugin', 'hidden-codex-skill'),
      selections: emptySelections(),
    });

    expect(result).toEqual({
      success: true,
      data: {
        insertText: '$codex-plugin:hidden-codex-skill ',
        invocationKey: '$codex-plugin:hidden-codex-skill',
      },
    });
  });

  it('keeps native Codex plugin skills when compatibility mode is disabled', async () => {
    loadMarketplacesMock.mockResolvedValue({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-06-20T00:00:00.000Z',
        marketplaces: [
          marketplaceFixture({
            codexNativeCompatDisabled: true,
          }),
        ],
      },
    });
    const service = await import('../plugins/invocable-inventory-service');

    const refresh = await service.refreshInvocableInventory(
      'native-codex-disabled-compat',
    );
    const entries = refresh.data?.entries ?? [];
    expect(
      entry(entries, 'codex', 'plugin_skill', 'codex-skill'),
    ).toBeDefined();

    const result = await service.resolveInvocableSelection({
      providerType: 'codex',
      entry: pluginSkillEntry('codex', 'codex-plugin', 'codex-skill'),
      selections: emptySelections(),
    });
    expect(result).toEqual({
      success: true,
      data: {
        insertText: '$codex-plugin:codex-skill ',
        invocationKey: '$codex-plugin:codex-skill',
      },
    });
  });

  it('recovers serialized cache writes after a failed write', async () => {
    const blockedPath = path.join(tempDir, 'blocked');
    fs.writeFileSync(blockedPath, 'not a directory', 'utf8');
    getDataDirMock.mockReturnValue(path.join(blockedPath, 'child'));
    const service = await import('../plugins/invocable-inventory-service');

    const failed = await service.refreshInvocableInventory('write-failure');

    expect(failed).toMatchObject({
      success: true,
      data: { entries: [], stale: true },
    });

    getDataDirMock.mockReturnValue(tempDir);
    const recovered = await service.refreshInvocableInventory('write-recovery');

    expect(recovered.success).toBe(true);
    expect(
      fs.existsSync(path.join(tempDir, 'invocable-inventory-cache.json')),
    ).toBe(true);
  });
});

function emptySelections(): ChatTabPluginSelections {
  return {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
  };
}

function standaloneEntry(
  provider: 'claude' | 'codex' | 'ollama',
  sourceId: string,
  skillName: string,
): InvocableInventoryEntry {
  const prefix = provider === 'codex' ? '$builtin-app-plugin:' : '/';
  const invocationKey = `${prefix}${skillName}`;
  return {
    id: `${provider}:skill:${sourceId}:${skillName}`,
    provider,
    kind: 'skill',
    name: skillName,
    displayName: invocationKey,
    description: '',
    insertText: `${invocationKey} `,
    invocationKey,
    enableRef: { kind: 'skill', sourceId, skillName },
  };
}

function standaloneSkillEntry(
  entries: readonly InvocableInventoryEntry[],
  provider: InvocableInventoryEntry['provider'],
  sourceId: string,
  skillName: string,
): InvocableInventoryEntry | undefined {
  return entries.find(
    (item) =>
      item.provider === provider &&
      item.kind === 'skill' &&
      item.enableRef.kind === 'skill' &&
      item.enableRef.sourceId === sourceId &&
      item.enableRef.skillName === skillName,
  );
}

function writeSkill(
  tempDir: string,
  sourceId: string,
  skillName: string,
): void {
  const dir = path.join(tempDir, 'skills', sourceId, skillName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${skillName}\n---\n`,
    'utf8',
  );
}

/**
 * Writes `claude-plugin`'s members as installed files, mirroring what the
 * facet in `marketplaceFixture` declares, so a Cursor selection can be
 * resolved against the tree the chat root is built from.
 */
function writeClaudePluginTree(
  root: string,
  members: {
    skills: Array<{ name: string; userInvocable?: boolean }>;
    commands: Array<{ name: string; description: string }>;
  },
): void {
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.claude-plugin', 'plugin.json'),
    '{"name":"claude-plugin"}',
    'utf8',
  );
  for (const skill of members.skills) {
    const dir = path.join(root, 'skills', skill.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${skill.name}\n${
        skill.userInvocable === false ? 'user-invocable: false\n' : ''
      }---\n`,
      'utf8',
    );
  }
  fs.mkdirSync(path.join(root, 'commands'), { recursive: true });
  for (const command of members.commands) {
    fs.writeFileSync(
      path.join(root, 'commands', `${command.name}.md`),
      `---\ndescription: ${command.description}\n---\nRun ${command.name}.\n`,
      'utf8',
    );
  }
}

function installedSkill(
  sourceId: string,
  skillName: string,
): InstalledSkillInfo {
  return {
    name: skillName,
    sourceId,
    description: skillName,
    source: sourceId,
    installedAt: '',
    updatedAt: '',
    updateAvailable: false,
  };
}

function pluginCommandEntry(
  provider: 'claude' | 'codex' | 'ollama',
  name: string,
  sourceName?: string,
): InvocableInventoryEntry {
  const invocationKey =
    provider === 'codex' ? `$compat-plugin:${name}` : `/${name}`;
  return {
    id: `${provider}:plugin_command:market:claude-plugin:${name}`,
    provider,
    kind: 'plugin_command',
    name,
    displayName: invocationKey,
    description: '',
    insertText: `${invocationKey} `,
    invocationKey,
    enableRef: {
      kind: 'plugin',
      marketplaceId: 'market',
      pluginName: 'claude-plugin',
    },
    ...(sourceName ? { sourceName } : {}),
  };
}

function pluginSkillEntry(
  provider: 'claude' | 'codex' | 'ollama',
  pluginName: string,
  name: string,
): InvocableInventoryEntry {
  const invocationKey =
    provider === 'codex' ? `$${pluginName}:${name}` : `/${pluginName}:${name}`;
  return {
    id: `${provider}:plugin_skill:market:${pluginName}:${name}`,
    provider,
    kind: 'plugin_skill',
    name,
    displayName: invocationKey,
    description: '',
    insertText: `${invocationKey} `,
    invocationKey,
    enableRef: {
      kind: 'plugin',
      marketplaceId: 'market',
      pluginName,
    },
  };
}

function entry(
  entries: readonly InvocableInventoryEntry[],
  provider: InvocableInventoryEntry['provider'],
  kind: InvocableInventoryEntry['kind'],
  name: string,
): InvocableInventoryEntry | undefined {
  return entries.find(
    (item) =>
      item.provider === provider && item.kind === kind && item.name === name,
  );
}

function marketplaceFixture(options?: {
  claudeCommands?: Array<{
    name: string;
    description: string;
    filePath: string;
  }>;
  compatSkills?: PluginSkillInfo[];
  codexCompatDisabled?: boolean;
  codexNativeCompatDisabled?: boolean;
  /** Installed root of `claude-plugin`; Cursor resolves against its files. */
  claudeInstallLocation?: string;
}): MarketplaceInfo {
  const plugins: PluginInfo[] = [
    {
      name: 'claude-plugin',
      description: '',
      sourcePath: '',
      marketplaceId: 'market',
      providerSupport: { claude: 'native', codex: 'compat' },
      ...(options?.codexCompatDisabled ? { codexCompatDisabled: true } : {}),
      facets: {
        claude: {
          provider: 'claude',
          mode: 'native',
          name: 'claude-plugin',
          installLocation: options?.claudeInstallLocation ?? '',
          sourcePath: '',
          details: {
            skills: [
              {
                name: 'plug-skill',
                description: 'Plugin skill',
                path: 'skills/plug-skill',
              },
              {
                name: 'hidden-plug-skill',
                description: '',
                path: 'skills/hidden-plug-skill',
                userInvocable: false,
              },
              {
                name: 'run-report',
                description: 'Collision',
                path: 'skills/run-report',
              },
            ],
            agents: [],
            commands: options?.claudeCommands ?? [
              {
                name: 'do-thing',
                description: 'Do thing',
                filePath: 'commands/do.md',
              },
              {
                name: 'run report',
                description: 'Run report',
                filePath: 'commands/run.md',
              },
            ],
            apps: [],
            hooks: [],
            mcpServers: [],
            lspServers: [],
            hasReadme: false,
          },
        },
        codexCompatibility: {
          provider: 'codex',
          mode: 'compat',
          name: 'compat-plugin',
          installLocation: '',
          sourcePath: '',
          details: {
            skills: options?.compatSkills ?? [
              {
                name: 'plug-skill',
                description: 'Plugin skill',
                path: 'skills/plug-skill',
              },
              {
                name: 'hidden-plug-skill',
                description: '',
                path: 'skills/hidden-plug-skill',
              },
              {
                name: 'run-report',
                description: 'Collision',
                path: 'skills/run-report',
              },
              {
                name: 'do-thing',
                description: 'Do thing',
                path: 'skills/do-thing',
              },
              {
                name: 'run-report-2',
                description: 'Run report',
                path: 'skills/run-report-2',
              },
            ],
            agents: [],
            commands: [],
            apps: [],
            hooks: [],
            mcpServers: [],
            lspServers: [],
            hasReadme: false,
          },
        },
      },
    },
    {
      name: 'codex-plugin',
      description: '',
      sourcePath: '',
      marketplaceId: 'market',
      providerSupport: { claude: 'none', codex: 'native' },
      ...(options?.codexNativeCompatDisabled
        ? { codexCompatDisabled: true }
        : {}),
      facets: {
        codex: {
          provider: 'codex',
          mode: 'native',
          name: 'codex-plugin',
          installLocation: '',
          sourcePath: '',
          details: {
            skills: [
              {
                name: 'codex-skill',
                description: 'Codex skill',
                path: 'skills/codex-skill',
              },
              {
                name: 'hidden-codex-skill',
                description: '',
                path: 'skills/hidden-codex-skill',
                userInvocable: false,
              },
            ],
            agents: [],
            commands: [],
            apps: [],
            hooks: [],
            mcpServers: [],
            lspServers: [],
            hasReadme: false,
          },
        },
      },
    },
  ];

  return {
    id: 'market',
    name: 'Market',
    sourceType: 'github',
    sourceUrl: 'owner/repo',
    installLocation: '',
    pluginCount: plugins.length,
    plugins,
    providerStatus: {
      claude: {
        provider: 'claude',
        state: 'valid',
        accepted: true,
        pluginCount: 1,
        lastCheckedAt: '',
      },
      codex: {
        provider: 'codex',
        state: 'valid',
        accepted: true,
        pluginCount: 2,
        lastCheckedAt: '',
      },
    },
    validProviders: ['claude', 'codex'],
  };
}
