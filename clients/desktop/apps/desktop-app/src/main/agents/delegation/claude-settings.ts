import { readFile } from 'node:fs/promises';
import path from 'node:path';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function enabledPluginIds(file: string): Promise<string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
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
}): Promise<string[]> {
  const files = [
    options.configDir
      ? path.join(options.configDir, 'settings.json')
      : path.join(options.home, '.claude', 'settings.json'),
    path.join(options.cwd, '.claude', 'settings.json'),
    path.join(options.cwd, '.claude', 'settings.local.json'),
  ];
  const ids = (await Promise.all(files.map(enabledPluginIds))).flat();
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
