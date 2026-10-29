import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InheritedPluginMarketplace } from '../plugins/inherited-cursor-plugins';
import {
  summarizeProviderCarryover,
  type CodexPluginListLike,
  type CodexSkillsListLike,
  type ProviderCarryoverDependencies,
} from '../plugins/provider-carryover';

function skill(root: string, name: string, body = `Use ${name}.`): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(
    join(root, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name}\n---\n${body}\n`,
  );
}

describe('summarizeProviderCarryover', () => {
  let dir: string;
  let roots: { userHome: string; claudeConfigDir: string; codexHome: string };
  let deps: ProviderCarryoverDependencies;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'provider-carryover-'));
    roots = {
      userHome: join(dir, 'home'),
      claudeConfigDir: join(dir, 'claude'),
      codexHome: join(dir, 'codex'),
    };
    mkdirSync(roots.userHome, { recursive: true });
    mkdirSync(roots.claudeConfigDir, { recursive: true });
    mkdirSync(roots.codexHome, { recursive: true });
    deps = {
      roots: (): typeof roots => roots,
      listCodexPlugins: (): Promise<CodexPluginListLike> =>
        Promise.resolve({
          marketplaces: [],
          marketplaceLoadErrors: [],
          featuredPluginIds: [],
        }),
      marketplaces: (): Promise<InheritedPluginMarketplace[]> =>
        Promise.resolve([]),
      listCodexSkills: (): Promise<CodexSkillsListLike> =>
        Promise.resolve({ skills: [], errors: [] }),
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("counts what a Claude chat reads from the user's Claude Code setup", async () => {
    skill(join(roots.claudeConfigDir, 'skills'), 'review');
    skill(join(roots.claudeConfigDir, 'skills'), 'triage');
    mkdirSync(join(roots.claudeConfigDir, 'commands'), { recursive: true });
    writeFileSync(
      join(roots.claudeConfigDir, 'commands', 'ship.md'),
      '# Ship\n\nShip it.\n',
    );
    const installed = join(dir, 'installed', 'tool');
    mkdirSync(installed, { recursive: true });
    mkdirSync(join(roots.claudeConfigDir, 'plugins'), { recursive: true });
    writeFileSync(
      join(roots.claudeConfigDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          'tool@market': { scope: 'user', installPath: installed },
          'off@market': { scope: 'user', installPath: installed },
        },
      }),
    );
    writeFileSync(
      join(roots.claudeConfigDir, 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'off@market': false } }),
    );
    // A Codex skill is not Claude's.
    skill(join(roots.codexHome, 'skills'), 'codex-only');

    await expect(summarizeProviderCarryover('claude', deps)).resolves.toEqual({
      provider: 'claude',
      skills: 2,
      commands: 1,
      plugins: 1,
      attention: [],
    });
  });

  it("counts what a Codex chat reads from the user's Codex home, plugins included, leaving out skills the user turned off", async () => {
    skill(join(roots.codexHome, 'skills'), 'triage');
    skill(join(roots.codexHome, 'skills'), 'muted');
    skill(join(roots.claudeConfigDir, 'skills'), 'claude-only');
    deps.listCodexSkills = (): Promise<CodexSkillsListLike> =>
      Promise.resolve({
        skills: [
          { name: 'triage', enabled: true, scope: 'user', pluginId: null },
          { name: 'muted', enabled: false, scope: 'user', pluginId: null },
          { name: 'repo-only', enabled: true, scope: 'repo', pluginId: null },
          { name: 'from-plugin', enabled: true, scope: 'user', pluginId: 'p' },
        ],
        // Codex found a home skill it could not load, and a repository one
        // that is not the user's home skill.
        errors: [
          {
            path: join(roots.codexHome, 'skills', 'broken', 'SKILL.md'),
            message: 'invalid frontmatter',
          },
          { path: '/repo/.codex/skills/other', message: 'nope' },
        ],
      });
    deps.listCodexPlugins = (): Promise<CodexPluginListLike> =>
      Promise.resolve({
        marketplaces: [
          {
            name: 'openai-curated',
            plugins: [
              { name: 'linear', installed: true, enabled: true },
              { name: 'slack', installed: false },
              { name: 'gmail', installed: true, enabled: false },
            ],
          },
        ],
        marketplaceLoadErrors: [],
        featuredPluginIds: [],
      });

    await expect(summarizeProviderCarryover('codex', deps)).resolves.toEqual({
      provider: 'codex',
      skills: 1,
      commands: 0,
      plugins: 1,
      attention: ['~/.codex/skills/broken/SKILL.md'],
    });
  });

  it('counts everything a Cursor chat inherits and names what it could not load', async () => {
    skill(join(roots.userHome, '.cursor', 'skills'), 'home-review');
    skill(join(roots.claudeConfigDir, 'skills'), 'review');
    skill(join(roots.codexHome, 'skills'), 'triage');
    mkdirSync(join(roots.userHome, '.cursor', 'commands'), { recursive: true });
    writeFileSync(
      join(roots.userHome, '.cursor', 'commands', 'ship.md'),
      '# Ship\n',
    );
    // A skill whose SKILL.md is not a file is reported, not counted.
    mkdirSync(join(roots.userHome, '.cursor', 'skills', 'broken', 'SKILL.md'), {
      recursive: true,
    });

    const summary = await summarizeProviderCarryover('cursor', deps);
    expect(summary).toMatchObject({
      provider: 'cursor',
      skills: 3,
      commands: 1,
      plugins: 0,
    });
    expect(summary.attention).toEqual(['~/.cursor/skills/broken']);
  });

  it('counts Claude commands in subfolders, which Claude Code runs by their folder names', async () => {
    mkdirSync(join(roots.claudeConfigDir, 'commands', 'team'), {
      recursive: true,
    });
    writeFileSync(
      join(roots.claudeConfigDir, 'commands', 'ship.md'),
      '# Ship\n',
    );
    writeFileSync(
      join(roots.claudeConfigDir, 'commands', 'team', 'release.md'),
      '# Release\n',
    );
    writeFileSync(
      join(roots.claudeConfigDir, 'commands', 'team', 'notes.txt'),
      'not a command',
    );
    expect(await summarizeProviderCarryover('claude', deps)).toMatchObject({
      commands: 2,
      attention: [],
    });
  });

  it('follows symbolic links to Claude commands and reports a command it cannot read', async () => {
    const commands = join(roots.claudeConfigDir, 'commands');
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(join(elsewhere, 'team'), { recursive: true });
    mkdirSync(commands, { recursive: true });
    writeFileSync(join(elsewhere, 'ship.md'), '# Ship\n');
    writeFileSync(join(elsewhere, 'team', 'release.md'), '# Release\n');
    // A dotfile manager links the file and the folder into place.
    symlinkSync(join(elsewhere, 'ship.md'), join(commands, 'ship.md'));
    symlinkSync(join(elsewhere, 'team'), join(commands, 'team'));
    // A link to nothing, and a command the user cannot read.
    symlinkSync(join(elsewhere, 'gone.md'), join(commands, 'gone.md'));
    writeFileSync(join(commands, 'locked.md'), '# Locked\n', { mode: 0o000 });
    try {
      expect(await summarizeProviderCarryover('claude', deps)).toMatchObject({
        commands: 2,
        attention: ['~/.claude/commands/gone', '~/.claude/commands/locked'],
      });
    } finally {
      chmodSync(join(commands, 'locked.md'), 0o600);
    }
  });

  it('reports a Claude skills folder it cannot read instead of counting it as empty', async () => {
    const skills = join(roots.claudeConfigDir, 'skills');
    mkdirSync(skills, { recursive: true });
    chmodSync(skills, 0o000);
    try {
      expect(await summarizeProviderCarryover('claude', deps)).toMatchObject({
        skills: 0,
        attention: ['~/.claude/skills'],
      });
    } finally {
      chmodSync(skills, 0o755);
    }
  });

  it('counts a skill linked into several provider folders for each provider that reads it', async () => {
    skill(join(roots.claudeConfigDir, 'skills'), 'shared');
    mkdirSync(join(roots.codexHome, 'skills'), { recursive: true });
    symlinkSync(
      join(roots.claudeConfigDir, 'skills', 'shared'),
      join(roots.codexHome, 'skills', 'shared'),
    );
    expect(await summarizeProviderCarryover('claude', deps)).toMatchObject({
      skills: 1,
      attention: [],
    });
    deps.listCodexSkills = (): Promise<CodexSkillsListLike> =>
      Promise.resolve({
        skills: [{ name: 'shared', enabled: true, scope: 'user' }],
        errors: [],
      });
    expect(await summarizeProviderCarryover('codex', deps)).toMatchObject({
      skills: 1,
      attention: [],
    });
    // One Cursor chat loads it once.
    expect(await summarizeProviderCarryover('cursor', deps)).toMatchObject({
      skills: 1,
    });
  });

  it('counts for Cursor only the Claude Code plugins a Cursor chat inherits, without naming the ones no cached marketplace lists', async () => {
    const slack = join(dir, 'installed', 'slack');
    const privatePlugin = join(dir, 'installed', 'private');
    mkdirSync(slack, { recursive: true });
    mkdirSync(privatePlugin, { recursive: true });
    mkdirSync(join(roots.claudeConfigDir, 'plugins'), { recursive: true });
    writeFileSync(
      join(roots.claudeConfigDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          'slack@canopy-curated': { scope: 'user', installPath: slack },
          'private@elsewhere': { scope: 'user', installPath: privatePlugin },
        },
      }),
    );
    // No cached marketplace matches: nothing reaches a Cursor chat. Claude
    // Code still loads both, so neither is a failure to name; the Marketplace
    // lists what a Cursor chat reads.
    expect(await summarizeProviderCarryover('cursor', deps)).toMatchObject({
      plugins: 0,
      attention: [],
    });
    // Canopy caches its own curated marketplace under a Canopy id and a
    // display name; Claude Code keys the install by the name Canopy
    // registered the marketplace under, which only the provider status holds.
    deps.marketplaces = (): Promise<InheritedPluginMarketplace[]> =>
      Promise.resolve([
        {
          id: 'curated/cloud',
          name: 'Canopy Curated Marketplace',
          providerStatus: { claude: { marketplaceName: 'canopy-curated' } },
          plugins: [{ name: 'slack' }],
        },
      ]);
    expect(await summarizeProviderCarryover('cursor', deps)).toMatchObject({
      plugins: 1,
      attention: [],
    });
    // Claude chats load every enabled plugin natively.
    expect(await summarizeProviderCarryover('claude', deps)).toMatchObject({
      plugins: 2,
      attention: [],
    });
  });

  it('names an enabled Claude Code plugin whose install folder is gone instead of counting it', async () => {
    const tool = join(dir, 'installed', 'tool');
    mkdirSync(tool, { recursive: true });
    mkdirSync(join(roots.claudeConfigDir, 'plugins'), { recursive: true });
    writeFileSync(
      join(roots.claudeConfigDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          'tool@canopy-curated': { scope: 'user', installPath: tool },
          'gone@canopy-curated': {
            scope: 'user',
            installPath: join(dir, 'installed', 'gone'),
          },
          // Turned off by the user: not a failure to report.
          'off@canopy-curated': {
            scope: 'user',
            installPath: join(dir, 'installed', 'off'),
          },
        },
      }),
    );
    writeFileSync(
      join(roots.claudeConfigDir, 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'off@canopy-curated': false } }),
    );
    deps.marketplaces = (): Promise<InheritedPluginMarketplace[]> =>
      Promise.resolve([
        {
          id: 'curated/cloud',
          name: 'canopy-curated',
          plugins: [{ name: 'tool' }, { name: 'gone' }],
        },
      ]);
    expect(await summarizeProviderCarryover('claude', deps)).toMatchObject({
      plugins: 1,
      attention: ['Claude Code plugin gone@canopy-curated'],
    });
    expect(await summarizeProviderCarryover('cursor', deps)).toMatchObject({
      plugins: 1,
      attention: ['Claude Code plugin gone@canopy-curated'],
    });
  });

  it('reports nothing carried over when the home folders are empty or unreadable', async () => {
    deps.listCodexPlugins = (): Promise<CodexPluginListLike> =>
      Promise.reject(new Error('codex offline'));
    await expect(summarizeProviderCarryover('codex', deps)).resolves.toEqual({
      provider: 'codex',
      skills: 0,
      commands: 0,
      plugins: 0,
      attention: [],
    });
  });
});
