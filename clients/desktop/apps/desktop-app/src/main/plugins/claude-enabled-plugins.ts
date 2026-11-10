import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { SettingSource } from '@anthropic-ai/claude-agent-sdk';
import { parseClaudeJsonFile } from '@canopy/execution-engine/node/plugins/claude-mod-admission';
import { isClaudeModPluginId } from '@canopy/execution-engine/types/claude-mod-admission';
import {
  claudeMarketplaceNames,
  type InheritedPluginMarketplace,
} from './inherited-cursor-plugins';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFile(file: string): boolean {
  try {
    statSync(file);
    return false;
  } catch (error) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    );
  }
}

function readJson(file: string): unknown {
  try {
    // As Claude parses it, so a leading BOM does not hide installs or disables.
    return parseClaudeJsonFile(readFileSync(file));
  } catch {
    return null;
  }
}

/**
 * The installs in a parsed `plugins/installed_plugins.json`, keyed
 * `plugin@marketplace`: Claude Code records them under `plugins`, beside the
 * file's format `version`. `null` when the file has no such map.
 */
export function claudeInstalledPluginsMap(
  installedFile: unknown,
): Record<string, unknown> | null {
  return isRecord(installedFile) && isRecord(installedFile.plugins)
    ? installedFile.plugins
    : null;
}

/** The installation folder one recorded install names, if it names one. */
export function installPathOf(candidate: unknown): string | undefined {
  if (!isRecord(candidate)) return undefined;
  if (typeof candidate.installPath === 'string') return candidate.installPath;
  if (typeof candidate.path === 'string') return candidate.path;
  if (typeof candidate.installLocation === 'string')
    return candidate.installLocation;
  return undefined;
}

/**
 * True when one recorded install applies everywhere: a `user` install or a
 * legacy entry without a scope. A `project` or `local` install belongs to the
 * repository in its `projectPath`.
 */
export function isUserScopedInstall(
  candidate: Record<string, unknown>,
): boolean {
  return candidate.scope !== 'project' && candidate.scope !== 'local';
}

function enabledPluginsOf(settings: unknown): Record<string, unknown> {
  return isRecord(settings) && isRecord(settings.enabledPlugins)
    ? settings.enabledPlugins
    : {};
}

function configuredSources(
  settingSources: readonly SettingSource[] | undefined,
): readonly SettingSource[] {
  return settingSources ?? ['user', 'project', 'local'];
}

/** User-scope disables apply to explicit selections as well as provider carryover. */
export function readClaudeDisabledInstalledPlugins(
  claudeConfigDir: string,
): string[] {
  const installed = claudeInstalledPluginsMap(
    readJson(path.join(claudeConfigDir, 'plugins', 'installed_plugins.json')),
  );
  const settings = enabledPluginsOf(
    readJson(path.join(claudeConfigDir, 'settings.json')),
  );
  return Object.entries(installed ?? {}).flatMap(([id, entry]) => {
    const candidates = Array.isArray(entry) ? entry : [entry];
    return settings[id] === false &&
      candidates.some(
        (candidate) => isRecord(candidate) && isUserScopedInstall(candidate),
      )
      ? [id]
      : [];
  });
}

/** One spelling of a repository path, so two references to it compare equal. */
function canonicalPath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * True for an existing directory: the only thing a plugin's installed root
 * can be. A recorded path that is gone, or that is a file, verifies nothing.
 */
export function isPluginInstallRoot(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** The most specific install wins where Claude Code would load it. */
function scopeRank(scope: unknown): number {
  if (scope === 'local') return 2;
  if (scope === 'project') return 1;
  return 0;
}

/**
 * The Claude Code plugins a chat working in `projectPath` would load, keyed
 * `plugin@marketplace`, each mapped to its verified installation folder: the
 * `installPath` recorded in `plugins/installed_plugins.json`, which must be
 * an existing directory. Only that folder is a trustworthy source of the
 * plugin's skills, commands, and MCP configuration; a marketplace checkout or
 * a cache can hold a different version than the one the user installed.
 *
 * A plugin set to `false` under `enabledPlugins` is left out. Claude Code
 * installs at `user`, `project`, or `local` scope. A user-scoped install (or
 * a legacy entry without a scope) applies everywhere; a project or local
 * install belongs to the repository in its `projectPath` and counts only when
 * that is the chat's repository, so a plugin installed for one repository
 * never starts its MCP server in another. Where several installs of one
 * plugin apply, the most specific scope's folder is returned, as Claude Code
 * loads it. Settings layer the same way Claude Code reads them: the
 * repository's `.claude/settings.local.json` over its `.claude/settings.json`
 * over the user's `settings.json`; absent means enabled. Without a
 * `projectPath` (a draft, the inventory's chat-less resolver) only
 * user-scoped installs count.
 *
 * Read fresh every turn, this is the only signal for every marketplace,
 * including the ones Canopy manages. `null` means the read is unavailable (no
 * install file, or one that does not parse); callers inherit nothing then,
 * as Claude Code itself would load nothing. An empty map means Claude Code
 * has nothing enabled here.
 */
export function readClaudeEnabledPlugins(
  claudeConfigDir: string,
  projectPath?: string,
  settingSources?: readonly SettingSource[],
): Map<string, string> | null {
  const sources = configuredSources(settingSources);
  if (sources.length === 0) return new Map();
  const installedFile = path.join(
    claudeConfigDir,
    'plugins',
    'installed_plugins.json',
  );
  // With no install record Claude loads no installed plugin; only a record
  // it cannot read leaves that unknown.
  if (isMissingFile(installedFile)) return new Map();
  const plugins = claudeInstalledPluginsMap(readJson(installedFile));
  if (!plugins) return null;
  const project =
    projectPath === undefined ? undefined : canonicalPath(projectPath);
  const userSettings = sources.includes('user')
    ? enabledPluginsOf(readJson(path.join(claudeConfigDir, 'settings.json')))
    : {};
  const projectSettings =
    project === undefined || !sources.includes('project')
      ? {}
      : enabledPluginsOf(
          readJson(path.join(project, '.claude', 'settings.json')),
        );
  const localSettings =
    project === undefined || !sources.includes('local')
      ? {}
      : enabledPluginsOf(
          readJson(path.join(project, '.claude', 'settings.local.json')),
        );
  const enabled = new Map<string, string>();
  for (const [key, entry] of Object.entries(plugins)) {
    const setting =
      localSettings[key] ?? projectSettings[key] ?? userSettings[key];
    if (setting === false) continue;
    const candidates = Array.isArray(entry) ? entry : [entry];
    let best: { rank: number; installPath: string } | undefined;
    for (const candidate of candidates) {
      if (!isRecord(candidate)) continue;
      const installPath = installPathOf(candidate);
      if (installPath === undefined || !isPluginInstallRoot(installPath))
        continue;
      if (!isUserScopedInstall(candidate)) {
        if (
          project === undefined ||
          typeof candidate.projectPath !== 'string' ||
          canonicalPath(candidate.projectPath) !== project
        )
          continue;
      }
      const rank = scopeRank(candidate.scope);
      if (best === undefined || rank > best.rank) {
        best = { rank, installPath: path.resolve(installPath) };
      }
    }
    if (best) enabled.set(key, best.installPath);
  }
  return enabled;
}

export type ClaudePluginInstallLookup =
  | { status: 'unreadable' }
  | { status: 'ok'; found: boolean; installPaths: readonly string[] };

/** All extant install paths for one id, including distinct scoped copies. */
export function readClaudePluginInstallPathsById(
  claudeConfigDir: string,
  pluginId: string,
): ClaudePluginInstallLookup {
  const installedPath = path.join(
    claudeConfigDir,
    'plugins',
    'installed_plugins.json',
  );
  let parsed: unknown;
  try {
    parsed = parseClaudeJsonFile(readFileSync(installedPath));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { status: 'ok', found: false, installPaths: [] };
    }
    return { status: 'unreadable' };
  }
  const plugins = claudeInstalledPluginsMap(parsed);
  if (!plugins) return { status: 'unreadable' };
  if (!Object.prototype.hasOwnProperty.call(plugins, pluginId)) {
    return { status: 'ok', found: false, installPaths: [] };
  }
  const entry = plugins[pluginId];
  const candidates = Array.isArray(entry) ? entry : [entry];
  const installPaths = new Set<string>();
  for (const candidate of candidates) {
    const installPath = installPathOf(candidate);
    if (installPath !== undefined && isPluginInstallRoot(installPath)) {
      installPaths.add(path.resolve(installPath));
    }
  }
  return {
    status: 'ok',
    found: true,
    installPaths: Array.from(installPaths),
  };
}

/**
 * The plugins Claude Code records as installed for every repository and the
 * user has not turned off, keyed `plugin@marketplace`, whose recorded install
 * folder is gone (or that record none): Claude Code loads nothing from them,
 * so `readClaudeEnabledPlugins` leaves them out, and a summary should name
 * them rather than count them as absent. Project and local installs belong
 * to one repository and are not judged here. `[]` when the install file is
 * missing or does not parse.
 */
export function readClaudeMissingPluginInstalls(
  claudeConfigDir: string,
): string[] {
  const plugins = claudeInstalledPluginsMap(
    readJson(path.join(claudeConfigDir, 'plugins', 'installed_plugins.json')),
  );
  if (!plugins) return [];
  const userSettings = enabledPluginsOf(
    readJson(path.join(claudeConfigDir, 'settings.json')),
  );
  const missing: string[] = [];
  for (const [key, entry] of Object.entries(plugins)) {
    if (userSettings[key] === false) continue;
    const everywhere = (Array.isArray(entry) ? entry : [entry]).filter(
      (candidate): candidate is Record<string, unknown> =>
        isRecord(candidate) && isUserScopedInstall(candidate),
    );
    if (everywhere.length === 0) continue;
    const present = everywhere.some((candidate) => {
      const installPath = installPathOf(candidate);
      return installPath !== undefined && isPluginInstallRoot(installPath);
    });
    if (!present) missing.push(key);
  }
  return missing;
}

/**
 * The id Claude keys a catalog plugin's native install under, trying the
 * marketplace's registered name first, so consent matches what launches
 * check. The id given when Claude has no install under any spelling.
 */
export function registeredClaudePluginId(
  pluginId: string,
  marketplaces: readonly InheritedPluginMarketplace[],
  claudeConfigDir: string,
): string {
  const separator = pluginId.indexOf('@');
  if (separator < 0) return pluginId;
  const marketplace = marketplaces.find(
    (entry) => entry.id === pluginId.slice(separator + 1),
  );
  if (!marketplace) return pluginId;
  const name = pluginId.slice(0, separator);
  for (const spelling of claudeMarketplaceNames(marketplace)) {
    const candidate = `${name}@${spelling}`;
    if (!isClaudeModPluginId(candidate)) continue;
    const lookup = readClaudePluginInstallPathsById(claudeConfigDir, candidate);
    if (lookup.status === 'ok' && lookup.found) return candidate;
  }
  return pluginId;
}
