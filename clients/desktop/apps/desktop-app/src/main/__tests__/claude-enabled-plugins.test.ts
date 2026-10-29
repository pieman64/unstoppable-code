import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  readClaudeEnabledPlugins,
  readClaudeMissingPluginInstalls,
} from '../plugins/claude-enabled-plugins';

/** The map as sorted `[key, installPath]` pairs; `[]` for an unavailable read. */
function entries(
  plugins: ReadonlyMap<string, string> | null,
): Array<[string, string]> {
  return Array.from(plugins ?? []).sort(([a], [b]) => a.localeCompare(b));
}

describe('readClaudeEnabledPlugins', () => {
  let configDir = '';
  beforeEach(() => {
    configDir = mkdtempSync(path.join(tmpdir(), 'canopy-claude-config-'));
    mkdirSync(path.join(configDir, 'plugins'), { recursive: true });
    installedEntries.clear();
  });
  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  // Every entry written so far, keyed like Claude Code keys them, so each
  // call rewrites the whole install file without re-parsing it.
  const installedEntries = new Map<string, unknown[]>();
  function installed(
    key: string,
    installPath: string,
    entry: { scope?: 'user' | 'project' | 'local'; projectPath?: string } = {},
  ): void {
    const list = installedEntries.get(key) ?? [];
    list.push({
      scope: entry.scope ?? 'user',
      ...(entry.projectPath ? { projectPath: entry.projectPath } : {}),
      installPath,
      version: '1.0.0',
    });
    installedEntries.set(key, list);
    writeFileSync(
      path.join(configDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: Object.fromEntries(installedEntries),
      }),
    );
  }

  function projectSettings(
    projectPath: string,
    enabledPlugins: Record<string, boolean>,
    file = 'settings.json',
  ): void {
    mkdirSync(path.join(projectPath, '.claude'), { recursive: true });
    writeFileSync(
      path.join(projectPath, '.claude', file),
      JSON.stringify({ enabledPlugins }),
    );
  }

  it('returns the verified install path of each plugin whose folder exists and that settings do not disable', () => {
    const present = path.join(configDir, 'cache', 'present');
    mkdirSync(present, { recursive: true });
    installed('alpha@claude-plugins-official', present);
    installed('beta@acme-marketplace', present);
    installed('gone@acme-marketplace', path.join(configDir, 'cache', 'gone'));
    writeFileSync(
      path.join(configDir, 'settings.json'),
      JSON.stringify({
        enabledPlugins: {
          'alpha@claude-plugins-official': true,
          'beta@acme-marketplace': false,
        },
      }),
    );

    expect(entries(readClaudeEnabledPlugins(configDir))).toEqual([
      ['alpha@claude-plugins-official', present],
    ]);
  });

  it('treats a plugin with no settings entry as enabled, like Claude Code does', () => {
    const present = path.join(configDir, 'cache', 'present');
    mkdirSync(present, { recursive: true });
    installed('gamma@acme-marketplace', present);

    expect(entries(readClaudeEnabledPlugins(configDir))).toEqual([
      ['gamma@acme-marketplace', present],
    ]);
  });

  it('drops an entry whose recorded install path is a file, not a plugin folder', () => {
    // Only a directory can be the plugin root the session reads skills,
    // commands, and MCP configuration from.
    const file = path.join(configDir, 'cache', 'not-a-folder');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '');
    installed('flat@acme-marketplace', file);

    expect(entries(readClaudeEnabledPlugins(configDir))).toEqual([]);
  });

  it('inherits a project-scoped plugin only in its own repository, and a user-scoped one everywhere', () => {
    // Claude Code installs at user, project, or local scope; a project or
    // local install belongs to one repository and must not reach a Cursor
    // chat in another, where its MCP server would otherwise start.
    const present = path.join(configDir, 'cache', 'present');
    mkdirSync(present, { recursive: true });
    const ownRepo = path.join(configDir, 'repos', 'own');
    const otherRepo = path.join(configDir, 'repos', 'other');
    mkdirSync(ownRepo, { recursive: true });
    mkdirSync(otherRepo, { recursive: true });
    installed('everywhere@acme-marketplace', present);
    installed('scoped@acme-marketplace', present, {
      scope: 'project',
      projectPath: ownRepo,
    });
    installed('local-only@acme-marketplace', present, {
      scope: 'local',
      projectPath: ownRepo,
    });

    expect(entries(readClaudeEnabledPlugins(configDir, otherRepo))).toEqual([
      ['everywhere@acme-marketplace', present],
    ]);
    expect(entries(readClaudeEnabledPlugins(configDir, ownRepo))).toEqual([
      ['everywhere@acme-marketplace', present],
      ['local-only@acme-marketplace', present],
      ['scoped@acme-marketplace', present],
    ]);
    // No repository at all (a draft, the inventory's chat-less resolver):
    // only user-scoped installs.
    expect(entries(readClaudeEnabledPlugins(configDir))).toEqual([
      ['everywhere@acme-marketplace', present],
    ]);
  });

  it("returns the repository's own installation of a plugin over the user-wide one", () => {
    // The same plugin installed twice: Claude Code loads the most specific
    // scope in a repository, so that is the folder a Cursor chat there reads.
    const userCopy = path.join(configDir, 'cache', 'user-copy');
    const repoCopy = path.join(configDir, 'cache', 'repo-copy');
    mkdirSync(userCopy, { recursive: true });
    mkdirSync(repoCopy, { recursive: true });
    const repo = path.join(configDir, 'repos', 'repo');
    mkdirSync(repo, { recursive: true });
    installed('tool@acme-marketplace', userCopy);
    installed('tool@acme-marketplace', repoCopy, {
      scope: 'project',
      projectPath: repo,
    });

    expect(entries(readClaudeEnabledPlugins(configDir, repo))).toEqual([
      ['tool@acme-marketplace', repoCopy],
    ]);
    expect(entries(readClaudeEnabledPlugins(configDir))).toEqual([
      ['tool@acme-marketplace', userCopy],
    ]);
  });

  it("honors the repository's own settings for a project-scoped plugin", () => {
    const present = path.join(configDir, 'cache', 'present');
    mkdirSync(present, { recursive: true });
    const repo = path.join(configDir, 'repos', 'repo');
    mkdirSync(repo, { recursive: true });
    installed('scoped@acme-marketplace', present, {
      scope: 'project',
      projectPath: repo,
    });
    installed('everywhere@acme-marketplace', present);
    projectSettings(repo, {
      'scoped@acme-marketplace': false,
      // The repository may also turn a user-scoped plugin off for itself.
      'everywhere@acme-marketplace': false,
    });

    expect(entries(readClaudeEnabledPlugins(configDir, repo))).toEqual([]);
    // Elsewhere the user-scoped plugin is still on.
    expect(entries(readClaudeEnabledPlugins(configDir))).toEqual([
      ['everywhere@acme-marketplace', present],
    ]);
  });

  it('names the enabled user-scope installs whose folder is gone', () => {
    const present = path.join(configDir, 'cache', 'present');
    mkdirSync(present, { recursive: true });
    installed('alpha@claude-plugins-official', present);
    installed('gone@acme-marketplace', path.join(configDir, 'cache', 'gone'));
    // Turned off by the user, and installed for one repository only: neither
    // is something Claude Code would load everywhere, so neither is missing.
    installed('off@acme-marketplace', path.join(configDir, 'cache', 'off'));
    installed('repo@acme-marketplace', path.join(configDir, 'cache', 'repo'), {
      scope: 'project',
      projectPath: path.join(configDir, 'repo'),
    });
    writeFileSync(
      path.join(configDir, 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'off@acme-marketplace': false } }),
    );

    expect(readClaudeMissingPluginInstalls(configDir)).toEqual([
      'gone@acme-marketplace',
    ]);
    expect(entries(readClaudeEnabledPlugins(configDir))).toEqual([
      ['alpha@claude-plugins-official', present],
    ]);
  });

  it('names nothing as missing when the install file is absent or malformed', () => {
    expect(readClaudeMissingPluginInstalls(configDir)).toEqual([]);
    writeFileSync(
      path.join(configDir, 'plugins', 'installed_plugins.json'),
      '{ not json',
    );
    expect(readClaudeMissingPluginInstalls(configDir)).toEqual([]);
  });

  it('reports an unavailable read, null, for a missing or malformed install file', () => {
    // Callers inherit nothing in this case; an empty map means Claude Code
    // has nothing enabled.
    expect(readClaudeEnabledPlugins(configDir)).toBeNull();
    writeFileSync(
      path.join(configDir, 'plugins', 'installed_plugins.json'),
      '{ not json',
    );
    expect(readClaudeEnabledPlugins(configDir)).toBeNull();
  });
});
