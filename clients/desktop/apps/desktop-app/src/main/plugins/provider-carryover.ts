import {
  discoverInheritedCursorCapabilities,
  emptyInheritedCursorCapabilities,
  type InheritedCursorCapabilities,
  type InheritedCursorRoots,
} from '@canopy/desktop-shared/node/cursor/inherited-capabilities';
import { constants as fsConstants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { resolveInheritedCursorRoots } from '../cursor/inherited-roots';
import {
  readClaudeEnabledPlugins,
  readClaudeMissingPluginInstalls,
} from './claude-enabled-plugins';
import {
  inheritedClaudePluginRefs,
  type InheritedPluginMarketplace,
} from './inherited-cursor-plugins';

/**
 * What carried over when the user connected a provider (CAN-3701, CAN-1063):
 * the skills, commands, and plugins a chat on that provider reads from the
 * user's own setup without an import step, counted from the same discovery
 * the chats run, plus the entries that could not be loaded.
 *
 * Claude and Codex chats read their native configuration; a Cursor chat
 * inherits every home root. The counts are a confirmation, not an inventory:
 * the Marketplace lists the items.
 */
export type CarryoverProvider = 'claude' | 'codex' | 'cursor';

export interface ProviderCarryoverSummary {
  provider: CarryoverProvider;
  skills: number;
  commands: number;
  plugins: number;
  /** Home entries found but not usable, as `~/.claude/skills/<name>` labels. */
  attention: string[];
}

/** The part of Codex's `plugin/list` answer the summary reads. */
export interface CodexPluginListLike {
  marketplaces: ReadonlyArray<{
    plugins: ReadonlyArray<{
      installed?: boolean | null;
      enabled?: boolean | null;
    }>;
  }>;
}

/** The part of Codex's `skills/list` answer the summary reads. */
export interface CodexSkillLike {
  name: string;
  enabled: boolean;
  scope?: string;
  pluginId?: string | null;
}

/** A skill Codex found but could not load, as `skills/list` reports it. */
export interface CodexSkillErrorLike {
  path: string;
  message: string;
}

export interface CodexSkillsListLike {
  skills: readonly CodexSkillLike[];
  errors: readonly CodexSkillErrorLike[];
}

export interface ProviderCarryoverDependencies {
  roots: () => InheritedCursorRoots;
  listCodexPlugins: () => Promise<CodexPluginListLike>;
  /**
   * Codex's own skills list, which knows which skills the user turned off and
   * which ones it could not load.
   */
  listCodexSkills: () => Promise<CodexSkillsListLike>;
  /** The cached marketplaces a Cursor chat matches Claude Code plugins against. */
  marketplaces: () => Promise<readonly InheritedPluginMarketplace[]>;
}

function liveDependencies(): ProviderCarryoverDependencies {
  return {
    roots: () => resolveInheritedCursorRoots(),
    listCodexPlugins: async (): Promise<CodexPluginListLike> => {
      const { listCodexPlugins } = await import('./codex-marketplace-service');
      return listCodexPlugins();
    },
    listCodexSkills: async (): Promise<CodexSkillsListLike> => {
      const { getCodexRuntimeService } =
        await import('../codex/runtime-service');
      const response = await getCodexRuntimeService()
        .admin()
        .request('skills/list', { cwds: [homedir()], forceReload: true });
      return {
        skills: response.data.flatMap((entry) => entry.skills),
        errors: response.data.flatMap((entry) => entry.errors),
      };
    },
    marketplaces: async (): Promise<readonly InheritedPluginMarketplace[]> => {
      const { loadMarketplacesCacheOnly } = await import('./plugin-service');
      const result = await loadMarketplacesCacheOnly();
      return result.success && result.data ? result.data.marketplaces : [];
    },
  };
}

/**
 * A folder that never exists, standing in for the roots a provider does not
 * read: the discovery treats a missing root as empty, so scoping it this way
 * counts one provider's own folders without the cross-provider de-duplication
 * a Cursor chat needs (a skill linked into several folders stays countable
 * for each provider that reads it).
 */
const NO_ROOT = join(tmpdir(), 'canopy-provider-carryover', 'no-root');

function ownRoots(
  roots: InheritedCursorRoots,
  provider: 'claude' | 'codex',
): InheritedCursorRoots {
  return provider === 'claude'
    ? {
        userHome: NO_ROOT,
        claudeConfigDir: roots.claudeConfigDir,
        codexHome: NO_ROOT,
      }
    : {
        userHome: NO_ROOT,
        claudeConfigDir: NO_ROOT,
        codexHome: roots.codexHome,
      };
}

/** The label for an enabled Claude Code plugin a chat could not load. */
function claudePluginLabel(key: string): string {
  return `Claude Code plugin ${key}`;
}

/**
 * The enabled Claude Code plugins whose install folder is gone, as labels:
 * Claude Code loads nothing from them, so they are reported, not counted.
 */
function missingClaudePlugins(claudeConfigDir: string): string[] {
  return readClaudeMissingPluginInstalls(claudeConfigDir).map(
    claudePluginLabel,
  );
}

/**
 * The Claude Code plugins a Cursor chat inherits: only those that match an
 * entry in the cached marketplaces, the rule `cursor-session` applies. An
 * enabled plugin no cached marketplace lists does not reach a Cursor chat,
 * but Claude Code still loads it, so it is neither counted nor named: the
 * Marketplace lists what a Cursor chat reads. A plugin whose install folder
 * is gone loads nowhere, and is named, as the Claude row names it.
 */
async function countCursorPlugins(
  roots: InheritedCursorRoots,
  deps: ProviderCarryoverDependencies,
): Promise<{ plugins: number; attention: string[] }> {
  const missing = missingClaudePlugins(roots.claudeConfigDir);
  const enabled = readClaudeEnabledPlugins(roots.claudeConfigDir);
  if (!enabled || enabled.size === 0) return { plugins: 0, attention: missing };
  let marketplaces: readonly InheritedPluginMarketplace[];
  try {
    marketplaces = await deps.marketplaces();
  } catch {
    marketplaces = [];
  }
  const refs = inheritedClaudePluginRefs(
    marketplaces,
    { pluginRefs: [] },
    undefined,
    enabled,
  );
  return { plugins: refs.length, attention: missing };
}

async function discover(
  roots: InheritedCursorRoots,
): Promise<InheritedCursorCapabilities> {
  try {
    return await discoverInheritedCursorCapabilities(roots);
  } catch {
    return emptyInheritedCursorCapabilities();
  }
}

/**
 * The skipped labels at or under the folder `under` (a `~/...` label), or
 * all of them. The folder itself counts: a skills folder that could not be
 * read is reported under its own label, not as an empty one.
 */
function attentionUnder(
  inherited: InheritedCursorCapabilities,
  under?: string,
): string[] {
  return inherited.skipped
    .map((entry) => entry.label)
    .filter(
      (label) =>
        under === undefined || label === under || label.startsWith(`${under}/`),
    );
}

/** `~/.codex/skills/<name>` for a path inside the Codex home skills folder, else null. */
function codexHomeSkillLabel(
  skillsRoot: string,
  skillPath: string,
): string | null {
  const rel = relative(skillsRoot, skillPath);
  if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`))
    return null;
  return `~/.codex/skills/${rel.split(sep).join('/')}`;
}

/**
 * The skills a Codex chat loads from the user's own Codex home: Codex's list
 * leaves out the ones the user turned off, and plugin and repository skills
 * are not the user's home skills. A home skill Codex found but could not
 * load is reported, as the chat's own notice would report it.
 */
async function countCodexSkills(
  roots: InheritedCursorRoots,
  deps: ProviderCarryoverDependencies,
): Promise<{ skills: number; attention: string[] }> {
  try {
    const list = await deps.listCodexSkills();
    const skillsRoot = join(roots.codexHome, 'skills');
    const skills = list.skills.filter(
      (skill) =>
        skill.enabled &&
        (skill.scope === undefined || skill.scope === 'user') &&
        (skill.pluginId === undefined || skill.pluginId === null),
    ).length;
    const attention = list.errors
      .map((error) => codexHomeSkillLabel(skillsRoot, error.path))
      .filter((label): label is string => label !== null);
    return { skills, attention: Array.from(new Set(attention)) };
  } catch {
    return { skills: 0, attention: [] };
  }
}

async function countCodexPlugins(
  deps: ProviderCarryoverDependencies,
): Promise<number> {
  try {
    const list = await deps.listCodexPlugins();
    let count = 0;
    for (const marketplace of list.marketplaces)
      for (const plugin of marketplace.plugins)
        if (plugin.installed === true && plugin.enabled !== false) count += 1;
    return count;
  } catch {
    return 0;
  }
}

/** The `code` of a filesystem error, when it carries one. */
function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

/**
 * Claude Code reads `~/.claude/commands/**` and names a nested command by its
 * folders (`team/ship.md` runs as `team:ship`), so the count walks the tree,
 * following symbolic links the way Claude Code does. A folder or command
 * that cannot be read is reported rather than counted.
 */
async function countClaudeCommands(
  dir: string,
  label: string,
  attention: string[],
  depth = 0,
): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') attention.push(label);
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const entryPath = join(dir, entry.name);
    // Named the way the chat's notice names a command: without `.md`.
    const entryLabel = `${label}/${entry.name.replace(/\.md$/, '')}`;
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const target = await stat(entryPath);
        isDirectory = target.isDirectory();
        isFile = target.isFile();
      } catch {
        attention.push(entryLabel);
        continue;
      }
    }
    if (isDirectory) {
      if (depth < 8)
        count += await countClaudeCommands(
          entryPath,
          entryLabel,
          attention,
          depth + 1,
        );
      continue;
    }
    if (!isFile || !entry.name.endsWith('.md')) continue;
    try {
      await access(entryPath, fsConstants.R_OK);
      count += 1;
    } catch {
      attention.push(entryLabel);
    }
  }
  return count;
}

export async function summarizeProviderCarryover(
  provider: CarryoverProvider,
  deps: ProviderCarryoverDependencies = liveDependencies(),
): Promise<ProviderCarryoverSummary> {
  const roots = deps.roots();
  switch (provider) {
    case 'claude': {
      const own = await discover(ownRoots(roots, 'claude'));
      // Skills come from the shared discovery; commands have their own walk
      // below, which also reports what it could not read.
      const attention = attentionUnder(own, '~/.claude/skills');
      const commands = await countClaudeCommands(
        join(roots.claudeConfigDir, 'commands'),
        '~/.claude/commands',
        attention,
      );
      // An enabled plugin whose install folder is gone loads nothing in a
      // Claude chat either: named, not counted.
      attention.push(...missingClaudePlugins(roots.claudeConfigDir));
      return {
        provider,
        skills: own.skills.length,
        commands,
        plugins: readClaudeEnabledPlugins(roots.claudeConfigDir)?.size ?? 0,
        attention,
      };
    }
    case 'codex': {
      // The folder scan reports what could not be read; the count itself
      // comes from Codex, which knows which skills the user turned off.
      const own = await discover(ownRoots(roots, 'codex'));
      const codexSkills = await countCodexSkills(roots, deps);
      return {
        provider,
        skills: codexSkills.skills,
        commands: 0,
        plugins: await countCodexPlugins(deps),
        attention: Array.from(
          new Set([
            ...attentionUnder(own, '~/.codex'),
            ...codexSkills.attention,
          ]),
        ),
      };
    }
    case 'cursor': {
      // One chat reads every root, so a skill linked into several folders
      // counts once, as the chat loads it once.
      const inherited = await discover(roots);
      const cursorPlugins = await countCursorPlugins(roots, deps);
      return {
        provider,
        skills: inherited.skills.length,
        commands: inherited.commands.length,
        plugins: cursorPlugins.plugins,
        attention: [...attentionUnder(inherited), ...cursorPlugins.attention],
      };
    }
  }
}
