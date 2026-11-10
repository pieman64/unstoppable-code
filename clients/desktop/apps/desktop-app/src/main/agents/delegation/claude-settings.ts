import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SettingSource } from '@anthropic-ai/claude-agent-sdk';
import {
  findClaudeProjectGitRoot,
  inspectClaudePluginHooks,
  listClaudeAutoLoadedPlugins,
  parseClaudeJsonFile,
} from '@canopy/execution-engine/node/plugins/claude-mod-admission';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function enabledPluginIds(file: string): Promise<string[]> {
  let parsed: unknown;
  try {
    // As Claude parses it: a leading BOM must not hide what the file enables.
    parsed = parseClaudeJsonFile(await readFile(file));
  } catch {
    // Missing or malformed settings contribute nothing, as in the CLI.
    return [];
  }
  const plugins = isRecord(parsed) ? parsed.enabledPlugins : undefined;
  if (!isRecord(plugins)) return [];
  return Object.entries(plugins)
    .filter(([, value]) => value !== false && value !== null)
    .map(([id]) => id);
}

/**
 * Marketplace plugins that the user, project, and local settings files enable.
 * Delegates load those settings sources, but receive only their Agent's
 * selected plugins, so the host switches these off at the flag tier.
 */
export async function resolveAmbientClaudePluginIds(options: {
  readonly home: string;
  readonly cwd: string;
  /** The host's `CLAUDE_CONFIG_DIR`, which holds user settings when set. */
  readonly configDir?: string;
  /** Omitted preserves Claude's default of loading all settings sources. */
  readonly settingSources?: readonly SettingSource[];
}): Promise<string[]> {
  const sources = options.settingSources ?? ['user', 'project', 'local'];
  const files: string[] = [];
  if (sources.includes('user')) {
    files.push(
      options.configDir
        ? path.join(options.configDir, 'settings.json')
        : path.join(options.home, '.claude', 'settings.json'),
    );
  }
  if (sources.includes('project')) {
    files.push(path.join(options.cwd, '.claude', 'settings.json'));
  }
  if (sources.includes('local')) {
    files.push(path.join(options.cwd, '.claude', 'settings.local.json'));
  }
  const ids = (await Promise.all(files.map(enabledPluginIds))).flat();
  return Array.from(new Set(ids)).sort();
}

/**
 * Skills-folder and claude.ai-synced plugins that carry a Mod. Claude loads
 * them with no `enabledPlugins` entry, so a delegate switches them off by id;
 * a copy that cannot be inspected counts as a Mod.
 */
export function resolveAutoLoadedClaudeModPluginIds(options: {
  readonly home: string;
  readonly cwd: string;
  readonly configDir?: string;
  readonly settingSources?: readonly SettingSource[];
}): string[] {
  const cwd = path.resolve(options.cwd);
  const gitRoot = findClaudeProjectGitRoot(cwd);
  const plugins = listClaudeAutoLoadedPlugins({
    claudeConfigDir: options.configDir ?? path.join(options.home, '.claude'),
    projectPaths: gitRoot && gitRoot !== cwd ? [cwd, gitRoot] : [cwd],
    settingSources: options.settingSources ?? ['user', 'project', 'local'],
  });
  const ids = plugins.flatMap(({ pluginId, installPath }) => {
    if (installPath === null) return [pluginId];
    const inspection = inspectClaudePluginHooks(installPath);
    return !inspection.success || inspection.hasMods ? [pluginId] : [];
  });
  return Array.from(new Set(ids)).sort();
}

/** The host's Claude config directory, which a parent chat's CLI inherits.
 * A delegate receives it too, so both read the same user settings. */
export function delegatedClaudeConfigDirectory(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const value = environment.CLAUDE_CONFIG_DIR;
  return value && path.isAbsolute(value) ? value : undefined;
}
