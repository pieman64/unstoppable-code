import * as fs from 'fs';
import * as path from 'path';
import type {
  PluginManifest,
  PluginDetails,
  PluginSkillInfo,
  PluginAgentInfo,
  PluginAppInfo,
  PluginCommandInfo,
  PluginHookInfo,
  PluginMcpServerInfo,
  PluginLspServerInfo,
} from '@canopy/desktop-shared/types/plugins';
import { safeReadJson, safeReadText } from '../lib/fs-utils';
import { parseFrontmatter } from '../lib/frontmatter';
import { canonicalPathInside } from './plugin-members';

interface Frontmatter {
  name?: string;
  description?: string;
  'user-invocable'?: boolean;
  'disable-model-invocation'?: boolean;
}

export type PluginManifestKind = 'claude' | 'codex';

interface ScanPluginDetailsOptions {
  manifestKind?: PluginManifestKind;
}

type PluginManifestLike = PluginManifest & {
  interface?: {
    displayName?: string | null;
    shortDescription?: string | null;
    longDescription?: string | null;
    developerName?: string | null;
    websiteUrl?: string | null;
  } | null;
  shortDescription?: string;
  developerName?: string;
  websiteUrl?: string;
  author?: PluginManifest['author'] | string;
  apps?: string | string[];
};

function isScanOptions(value: unknown): value is ScanPluginDetailsOptions {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'manifestKind' in value
  );
}

function manifestPathForKind(
  pluginDir: string,
  kind: PluginManifestKind,
): string {
  return path.join(
    pluginDir,
    kind === 'codex' ? '.codex-plugin' : '.claude-plugin',
    'plugin.json',
  );
}

function normalizeManifestForScanning(
  manifest: PluginManifestLike | null,
): PluginManifest | null {
  if (!manifest) {
    return null;
  }

  const author =
    typeof manifest.author === 'string'
      ? { name: manifest.author }
      : manifest.author;

  return {
    ...manifest,
    name: manifest.interface?.displayName ?? manifest.name,
    description:
      manifest.shortDescription ??
      manifest.interface?.shortDescription ??
      manifest.description ??
      manifest.interface?.longDescription ??
      undefined,
    author:
      author ??
      ((manifest.developerName ?? manifest.interface?.developerName)
        ? {
            name:
              manifest.developerName ?? manifest.interface?.developerName ?? '',
          }
        : undefined),
    homepage:
      manifest.websiteUrl ??
      manifest.interface?.websiteUrl ??
      manifest.homepage,
  };
}

function normalizePaths(value: string | string[] | undefined): string[] {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  return value;
}

/** The plugin dir with links resolved: member paths are measured from it. */
function canonicalPluginDir(pluginDir: string): string {
  try {
    return fs.realpathSync(pluginDir);
  } catch {
    return pluginDir;
  }
}

function scanSkills(
  pluginDir: string,
  manifest: PluginManifest | null,
): PluginSkillInfo[] {
  const results: PluginSkillInfo[] = [];
  const realPluginDir = canonicalPluginDir(pluginDir);
  const customPaths = normalizePaths(manifest?.skills);
  const dirs =
    customPaths.length > 0
      ? customPaths.map((p) => path.resolve(pluginDir, p))
      : [path.join(pluginDir, 'skills')];

  for (const declaredRoot of dirs) {
    // Realpath containment, as the resolver applies: a link anywhere in a
    // declared path must not let the picker list members a session refuses.
    const skillsRoot = canonicalPathInside(pluginDir, declaredRoot);
    if (!skillsRoot || !fs.statSync(skillsRoot).isDirectory()) continue;

    const entries = fs.readdirSync(skillsRoot);
    for (const entry of entries) {
      const skillDir = path.join(skillsRoot, entry);
      if (!fs.statSync(skillDir).isDirectory()) continue;

      const skillMd = path.join(skillDir, 'SKILL.md');
      const content = safeReadText(skillMd);
      if (!content) continue;

      const fm = parseFrontmatter<Frontmatter>(content);
      // Use frontmatter name, or fall back to directory name
      const name = fm?.name || entry || null;
      if (!name) continue;

      results.push({
        name,
        description: fm?.description || '',
        path: path.relative(realPluginDir, skillDir),
        ...(typeof fm?.['user-invocable'] === 'boolean'
          ? { userInvocable: fm['user-invocable'] }
          : {}),
      });
    }
  }

  return results;
}

function scanMarkdownDir(
  pluginDir: string,
  defaultSubdir: string,
  manifest: PluginManifest | null,
  manifestKey: 'agents' | 'commands' | 'apps',
): Array<{ name: string; description: string; filePath: string }> {
  const results: Array<{
    name: string;
    description: string;
    filePath: string;
  }> = [];
  const realPluginDir = canonicalPluginDir(pluginDir);
  const customPaths = normalizePaths(manifest?.[manifestKey]);

  // Custom paths can be individual files or directories
  const paths =
    customPaths.length > 0
      ? customPaths.map((p) => path.resolve(pluginDir, p))
      : [path.join(pluginDir, defaultSubdir)];

  for (const declared of paths) {
    const dirOrFile = canonicalPathInside(pluginDir, declared);
    if (!dirOrFile) continue;

    const stat = fs.statSync(dirOrFile);
    const mdFiles: string[] = [];

    if (stat.isDirectory()) {
      const entries = fs.readdirSync(dirOrFile);
      for (const entry of entries) {
        if (entry.endsWith('.md')) {
          mdFiles.push(path.join(dirOrFile, entry));
        }
      }
    } else if (dirOrFile.endsWith('.md')) {
      mdFiles.push(dirOrFile);
    }

    for (const mdFile of mdFiles) {
      const content = safeReadText(mdFile);
      if (!content) continue;

      const fm = parseFrontmatter<Frontmatter>(content);
      // Use frontmatter name, or fall back to filename without extension
      const name =
        fm?.name || path.basename(mdFile, path.extname(mdFile)) || null;
      if (!name) continue;

      results.push({
        name,
        description: fm?.description || '',
        filePath: path.relative(realPluginDir, mdFile),
      });
    }
  }

  return results;
}

function scanAgents(
  pluginDir: string,
  manifest: PluginManifest | null,
): PluginAgentInfo[] {
  return scanMarkdownDir(pluginDir, 'agents', manifest, 'agents');
}

function scanCommands(
  pluginDir: string,
  manifest: PluginManifest | null,
): PluginCommandInfo[] {
  return scanMarkdownDir(pluginDir, 'commands', manifest, 'commands');
}

function scanApps(
  pluginDir: string,
  manifest: PluginManifest | null,
): PluginAppInfo[] {
  return scanMarkdownDir(pluginDir, 'apps', manifest, 'apps');
}

function flattenHooksConfig(config: Record<string, unknown>): PluginHookInfo[] {
  const results: PluginHookInfo[] = [];

  // config.hooks is an object keyed by event name, or config itself is
  const hooks =
    config.hooks && typeof config.hooks === 'object'
      ? (config.hooks as Record<string, unknown>)
      : config;

  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as Record<string, unknown>[]) {
      if (!entry || typeof entry !== 'object') continue;
      const hooksList = Array.isArray(entry.hooks)
        ? (entry.hooks as Record<string, unknown>[])
        : [entry];
      for (const hook of hooksList) {
        if (!hook || typeof hook !== 'object') continue;
        const h = hook;
        const e = entry;
        results.push({
          event,
          matcher: typeof e.matcher === 'string' ? e.matcher : undefined,
          hookType: typeof h.type === 'string' ? h.type : 'command',
          command: typeof h.command === 'string' ? h.command : undefined,
        });
      }
    }
  }

  return results;
}

function resolveHooks(
  pluginDir: string,
  manifest: PluginManifest | null,
): PluginHookInfo[] {
  const results: PluginHookInfo[] = [];
  const manifestHooks = manifest?.hooks;

  // If manifest specifies hooks, use only that (overrides default)
  if (manifestHooks) {
    if (typeof manifestHooks === 'string') {
      const resolved = canonicalPathInside(
        pluginDir,
        path.resolve(pluginDir, manifestHooks),
      );
      if (resolved) {
        const config = safeReadJson<Record<string, unknown>>(resolved);
        if (config) results.push(...flattenHooksConfig(config));
      }
    } else if (Array.isArray(manifestHooks)) {
      for (const entry of manifestHooks) {
        if (typeof entry === 'string') {
          const resolved = canonicalPathInside(
            pluginDir,
            path.resolve(pluginDir, entry),
          );
          if (resolved) {
            const config = safeReadJson<Record<string, unknown>>(resolved);
            if (config) results.push(...flattenHooksConfig(config));
          }
        }
      }
    } else if (typeof manifestHooks === 'object') {
      results.push(...flattenHooksConfig(manifestHooks));
    }
  } else {
    // No manifest override — fall back to default hooks/hooks.json
    const defaultPath = path.join(pluginDir, 'hooks', 'hooks.json');
    const defaultConfig = safeReadJson<Record<string, unknown>>(defaultPath);
    if (defaultConfig) {
      results.push(...flattenHooksConfig(defaultConfig));
    }
  }

  return results;
}

function extractMcpServers(
  config: Record<string, unknown>,
): PluginMcpServerInfo[] {
  const results: PluginMcpServerInfo[] = [];
  const servers =
    config.mcpServers && typeof config.mcpServers === 'object'
      ? (config.mcpServers as Record<string, unknown>)
      : config;

  for (const [name, def] of Object.entries(servers)) {
    if (!def || typeof def !== 'object') continue;
    const d = def as Record<string, unknown>;

    // HTTP-type servers use url instead of command
    if (d.type === 'http' && typeof d.url === 'string') {
      results.push({
        name,
        type: 'http',
        url: d.url,
      });
    } else if (typeof d.command === 'string') {
      results.push({
        name,
        type: 'command',
        command: d.command,
        args: Array.isArray(d.args) ? (d.args as string[]) : undefined,
      });
    }
  }

  return results;
}

function resolveMcpServers(
  pluginDir: string,
  manifest: PluginManifest | null,
): PluginMcpServerInfo[] {
  const results: PluginMcpServerInfo[] = [];
  const manifestMcp = manifest?.mcpServers;

  // If manifest specifies mcpServers, use only that (overrides default)
  if (manifestMcp) {
    if (typeof manifestMcp === 'string') {
      const resolved = canonicalPathInside(
        pluginDir,
        path.resolve(pluginDir, manifestMcp),
      );
      if (resolved) {
        const config = safeReadJson<Record<string, unknown>>(resolved);
        if (config) results.push(...extractMcpServers(config));
      }
    } else if (Array.isArray(manifestMcp)) {
      for (const entry of manifestMcp) {
        if (typeof entry === 'string') {
          const resolved = canonicalPathInside(
            pluginDir,
            path.resolve(pluginDir, entry),
          );
          if (resolved) {
            const config = safeReadJson<Record<string, unknown>>(resolved);
            if (config) results.push(...extractMcpServers(config));
          }
        }
      }
    } else if (typeof manifestMcp === 'object') {
      results.push(...extractMcpServers(manifestMcp));
    }
  } else {
    // No manifest override — fall back to default .mcp.json
    const defaultPath = path.join(pluginDir, '.mcp.json');
    const defaultConfig = safeReadJson<Record<string, unknown>>(defaultPath);
    if (defaultConfig) {
      results.push(...extractMcpServers(defaultConfig));
    }
  }

  return results;
}

function extractLspServers(
  config: Record<string, unknown>,
): PluginLspServerInfo[] {
  const results: PluginLspServerInfo[] = [];

  for (const [name, def] of Object.entries(config)) {
    if (!def || typeof def !== 'object') continue;
    const d = def as Record<string, unknown>;
    if (typeof d.command !== 'string') continue;

    let languages: string[] | undefined;
    if (d.extensionToLanguage && typeof d.extensionToLanguage === 'object') {
      languages = Array.from(
        new Set(Object.values(d.extensionToLanguage as Record<string, string>)),
      );
    }

    results.push({
      name,
      command: d.command,
      args: Array.isArray(d.args) ? (d.args as string[]) : undefined,
      languages,
    });
  }

  return results;
}

function resolveLspServers(
  pluginDir: string,
  manifest: PluginManifest | null,
): PluginLspServerInfo[] {
  const results: PluginLspServerInfo[] = [];
  const manifestLsp = manifest?.lspServers;

  // If manifest specifies lspServers, use only that (overrides default)
  if (manifestLsp) {
    if (typeof manifestLsp === 'string') {
      const resolved = canonicalPathInside(
        pluginDir,
        path.resolve(pluginDir, manifestLsp),
      );
      if (resolved) {
        const config = safeReadJson<Record<string, unknown>>(resolved);
        if (config) results.push(...extractLspServers(config));
      }
    } else if (Array.isArray(manifestLsp)) {
      for (const entry of manifestLsp) {
        if (typeof entry === 'string') {
          const resolved = canonicalPathInside(
            pluginDir,
            path.resolve(pluginDir, entry),
          );
          if (resolved) {
            const config = safeReadJson<Record<string, unknown>>(resolved);
            if (config) results.push(...extractLspServers(config));
          }
        }
      }
    } else if (typeof manifestLsp === 'object') {
      results.push(...extractLspServers(manifestLsp));
    }
  } else {
    // No manifest override — fall back to default .lsp.json
    const defaultPath = path.join(pluginDir, '.lsp.json');
    const defaultConfig = safeReadJson<Record<string, unknown>>(defaultPath);
    if (defaultConfig) {
      results.push(...extractLspServers(defaultConfig));
    }
  }

  return results;
}

export function scanPluginDetails(
  pluginDir: string,
  manifestOrOptions?: PluginManifest | null | ScanPluginDetailsOptions,
  maybeOptions?: ScanPluginDetailsOptions,
): PluginDetails {
  const options = isScanOptions(manifestOrOptions)
    ? manifestOrOptions
    : maybeOptions;
  const kind = options?.manifestKind ?? 'claude';
  const manifest = normalizeManifestForScanning(
    isScanOptions(manifestOrOptions)
      ? safeReadJson<PluginManifestLike>(manifestPathForKind(pluginDir, kind))
      : (manifestOrOptions ??
          safeReadJson<PluginManifestLike>(
            manifestPathForKind(pluginDir, kind),
          )),
  );
  const details: PluginDetails = {
    skills: [],
    agents: [],
    commands: [],
    apps: [],
    hooks: [],
    mcpServers: [],
    lspServers: [],
    hasReadme: false,
  };

  if (!fs.existsSync(pluginDir)) return details;

  try {
    details.skills = scanSkills(pluginDir, manifest);
  } catch {
    /* skip */
  }
  try {
    details.agents = scanAgents(pluginDir, manifest);
  } catch {
    /* skip */
  }
  try {
    details.commands = scanCommands(pluginDir, manifest);
  } catch {
    /* skip */
  }
  try {
    details.apps = scanApps(pluginDir, manifest);
  } catch {
    /* skip */
  }
  try {
    details.hooks = resolveHooks(pluginDir, manifest);
  } catch {
    /* skip */
  }
  try {
    details.mcpServers = resolveMcpServers(pluginDir, manifest);
  } catch {
    /* skip */
  }
  try {
    details.lspServers = resolveLspServers(pluginDir, manifest);
  } catch {
    /* skip */
  }

  try {
    const readmePath = path.join(pluginDir, 'README.md');
    details.hasReadme = fs.existsSync(readmePath);
  } catch {
    /* skip */
  }

  return details;
}
