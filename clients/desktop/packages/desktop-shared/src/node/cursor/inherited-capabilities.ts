/**
 * Discovers the skills and commands the pinned Cursor CLI would load from the
 * user's own home folders, so a Cursor chat inherits them the way a Claude or
 * Codex chat inherits its native configuration
 * (docs/planning/2026-10-05-cursor-inherited-capabilities/design.md).
 *
 * Roots, in the CLI's order: `~/.cursor/skills`, the Claude configuration
 * directory's `skills`, the Codex home's `skills`, `~/.grok/skills`,
 * `~/.agents/skills`; commands under `~/.cursor/commands` and the Claude
 * configuration directory's `commands`; then the skills and commands of every
 * plugin the Cursor app downloaded to
 * `~/.cursor/plugins/cache/<marketplace>/<plugin>/<version>/` whose download
 * completed (`.cache-complete`), newest completed version per plugin. These
 * are the user's own configuration, so a linked entry is followed to its
 * canonical directory (the materializer copies from there). A cached plugin's
 * members must stay inside that plugin's canonical directory, by manifest
 * path and by link; one that leads outside is skipped and reported. Only
 * `readdir`, `lstat`, `realpath`, a plugin manifest, and the SKILL.md or
 * command file itself are read. A plugin's MCP servers and hooks are not
 * read here.
 */
import { createHash } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { parseFrontmatterAndBody } from '@canopy/plugin-interop/frontmatter';
import {
  CURSOR_INVOCATION_ID_PATTERN,
  inheritedCursorRootLabel,
  sanitizeCursorInvocationSegment,
  type InheritedCursorCommandOrigin,
  type InheritedCursorOrigin,
} from '../../lib/cursor-capabilities';

export interface InheritedCursorRoots {
  /** The real user home (`os.homedir()`), or the test harness override. */
  userHome: string;
  /** The Claude configuration directory, relocated or `~/.claude`. */
  claudeConfigDir: string;
  /** The Codex home, relocated or `~/.codex`. */
  codexHome: string;
}

export interface InheritedCursorSkill {
  origin: InheritedCursorOrigin;
  /** `<marketplace>/<plugin>` when the skill is a cached Cursor plugin member. */
  plugin?: string;
  /** Folder name as found; the CLI keys skills on it. */
  name: string;
  /** Canonical (realpath) directory containing SKILL.md. */
  sourceDir: string;
  description: string;
  /** `user-invocable: false` in the frontmatter keeps the row out of menus. */
  userInvocable: boolean;
}

export interface InheritedCursorCommand {
  origin: InheritedCursorCommandOrigin;
  /** `<marketplace>/<plugin>` when the command is a cached Cursor plugin member. */
  plugin?: string;
  /** File stem as found. */
  name: string;
  /** File content, unmodified: the CLI parses no frontmatter. */
  markdown: string;
  description: string;
}

export interface InheritedCursorSkipped {
  /** `~/.claude/skills/<name>` style, for the once-per-session notice. */
  label: string;
  reason: string;
}

export interface InheritedCursorCapabilities {
  skills: InheritedCursorSkill[];
  commands: InheritedCursorCommand[];
  /** Entries found but not usable; the session reports them once. */
  skipped: InheritedCursorSkipped[];
  /**
   * SHA-256 over the sorted (kind, origin, plugin, name, canonical path,
   * size, mtime) of every SKILL.md and command file found. No content is read
   * for it; the inventory uses it to notice a changed set.
   */
  fingerprint: string;
}

/** Codex's own built-in skill names, which the CLI hides under `.codex/skills`. */
const HIDDEN_CODEX_BUILTIN_SKILLS = new Set([
  'imagegen',
  'openai-docs',
  'opneai-docs',
  'plugin-creator',
  'skill-creator',
  'skill-installer',
]);

/** Where a cached Cursor plugin declares itself, in the order the CLI tries. */
const PLUGIN_MANIFESTS = [
  '.cursor-plugin/plugin.json',
  '.claude-plugin/plugin.json',
  'plugin.json',
];

type FingerprintRow = readonly [
  kind: 'skill' | 'command',
  origin: string,
  plugin: string,
  name: string,
  path: string,
  size: number,
  mtimeMs: number,
];

function fingerprintOf(rows: readonly FingerprintRow[]): string {
  const hash = createHash('sha256');
  const lines = rows.map((row) => row.join('\u0000')).sort();
  for (const line of lines) hash.update(line).update('\n');
  return hash.digest('hex');
}

export function emptyInheritedCursorCapabilities(): InheritedCursorCapabilities {
  return {
    skills: [],
    commands: [],
    skipped: [],
    fingerprint: fingerprintOf([]),
  };
}

function missing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function skillRoots(
  roots: InheritedCursorRoots,
): { origin: InheritedCursorOrigin; dir: string }[] {
  return [
    { origin: 'cursor', dir: join(roots.userHome, '.cursor', 'skills') },
    { origin: 'claude', dir: join(roots.claudeConfigDir, 'skills') },
    { origin: 'codex', dir: join(roots.codexHome, 'skills') },
    { origin: 'grok', dir: join(roots.userHome, '.grok', 'skills') },
    { origin: 'agents', dir: join(roots.userHome, '.agents', 'skills') },
  ];
}

function commandRoots(
  roots: InheritedCursorRoots,
): { origin: InheritedCursorCommandOrigin; dir: string }[] {
  return [
    { origin: 'cursor', dir: join(roots.userHome, '.cursor', 'commands') },
    { origin: 'claude', dir: join(roots.claudeConfigDir, 'commands') },
  ];
}

/** Sorted entries of a directory; a missing one is simply empty. */
async function listEntries(
  dir: string,
  label: string,
  skipped: InheritedCursorSkipped[],
): Promise<Dirent[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
  } catch (error) {
    if (!missing(error))
      skipped.push({
        label,
        reason: `could not be read: ${describeError(error)}`,
      });
    return [];
  }
}

function firstHeading(markdown: string): string | null {
  const match = /^#\s+(.+?)\s*$/m.exec(markdown);
  return match ? match[1] : null;
}

/** One scan's shared accumulators. */
interface Collector {
  skills: InheritedCursorSkill[];
  commands: InheritedCursorCommand[];
  skipped: InheritedCursorSkipped[];
  rows: FingerprintRow[];
  /** Canonical skill directories already taken: the earlier root wins. */
  seenDirs: Set<string>;
  /**
   * Command files already taken, so a manifest that lists a file the
   * conventional folder already holds adds nothing.
   */
  seenFiles: Set<string>;
}

interface SkillRoot {
  dir: string;
  origin: InheritedCursorOrigin;
  plugin?: string;
  rootLabel: string;
  /**
   * Canonical directory every member must stay inside (a cached plugin's).
   * Plugin content is third-party: a manifest path or a link that leaves the
   * plugin would put any local file into the chat. Home folders have no
   * bound; their links are the user's own configuration.
   */
  within?: string;
}

interface CommandRoot {
  dir: string;
  origin: InheritedCursorCommandOrigin;
  plugin?: string;
  rootLabel: string;
  /** See `SkillRoot.within`. */
  within?: string;
}

function isInside(base: string, candidate: string): boolean {
  return (
    candidate === base ||
    candidate.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
  );
}

const OUTSIDE_PLUGIN = 'leads outside its plugin';

/** Every skill folder directly under `root.dir`. */
async function collectSkills(
  collector: Collector,
  root: SkillRoot,
): Promise<void> {
  for (const entry of await listEntries(
    root.dir,
    root.rootLabel,
    collector.skipped,
  )) {
    if (entry.name.startsWith('.')) continue;
    if (root.origin === 'codex' && HIDDEN_CODEX_BUILTIN_SKILLS.has(entry.name))
      continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    await collectSkillEntry(collector, root, entry.name);
  }
}

/** One skill folder, `<root.dir>/<name>`, holding `SKILL.md`. */
async function collectSkillEntry(
  collector: Collector,
  root: SkillRoot,
  name: string,
): Promise<void> {
  const { skills, skipped, rows, seenDirs } = collector;
  const label = `${root.rootLabel}/${name}`;
  let sourceDir: string;
  try {
    sourceDir = await realpath(join(root.dir, name));
    if (!(await lstat(sourceDir)).isDirectory()) return;
  } catch (error) {
    skipped.push({
      label,
      reason: `could not be resolved: ${describeError(error)}`,
    });
    return;
  }
  if (root.within !== undefined && !isInside(root.within, sourceDir)) {
    skipped.push({ label, reason: OUTSIDE_PLUGIN });
    return;
  }
  if (seenDirs.has(sourceDir)) return;
  const skillMd = join(sourceDir, 'SKILL.md');
  let info: Stats;
  try {
    info = await lstat(skillMd);
  } catch (error) {
    if (!missing(error))
      skipped.push({
        label,
        reason: `SKILL.md could not be read: ${describeError(error)}`,
      });
    return;
  }
  if (!info.isFile()) {
    skipped.push({ label, reason: 'SKILL.md is not a regular file' });
    return;
  }
  if (
    !CURSOR_INVOCATION_ID_PATTERN.test(sanitizeCursorInvocationSegment(name))
  ) {
    skipped.push({
      label,
      reason: 'its name cannot be used as a Cursor skill id',
    });
    return;
  }
  let content: string;
  try {
    content = await readFile(skillMd, 'utf8');
  } catch (error) {
    skipped.push({
      label,
      reason: `SKILL.md could not be read: ${describeError(error)}`,
    });
    return;
  }
  const { frontmatter } = parseFrontmatterAndBody(content);
  seenDirs.add(sourceDir);
  skills.push({
    origin: root.origin,
    ...(root.plugin !== undefined ? { plugin: root.plugin } : {}),
    name,
    sourceDir,
    description:
      typeof frontmatter.description === 'string'
        ? frontmatter.description.trim()
        : '',
    userInvocable: frontmatter['user-invocable'] !== false,
  });
  rows.push([
    'skill',
    root.origin,
    root.plugin ?? '',
    name,
    sourceDir,
    info.size,
    info.mtimeMs,
  ]);
}

/** Every `*.md` file directly under `root.dir`. */
async function collectCommands(
  collector: Collector,
  root: CommandRoot,
): Promise<void> {
  for (const entry of await listEntries(
    root.dir,
    root.rootLabel,
    collector.skipped,
  )) {
    if (entry.name.startsWith('.')) continue;
    await collectCommandFile(collector, root, entry.name);
  }
}

/** One command file, `<root.dir>/<fileName>`; only `*.md` counts. */
async function collectCommandFile(
  collector: Collector,
  root: CommandRoot,
  fileName: string,
): Promise<void> {
  const { commands, skipped, rows, seenFiles } = collector;
  if (!fileName.endsWith('.md')) return;
  const name = fileName.slice(0, -'.md'.length);
  const label = `${root.rootLabel}/${name}`;
  const file = join(root.dir, fileName);
  if (seenFiles.has(file)) return;
  let info: Stats;
  try {
    info = await stat(file);
  } catch (error) {
    skipped.push({
      label,
      reason: `could not be read: ${describeError(error)}`,
    });
    return;
  }
  if (!info.isFile()) return;
  if (root.within !== undefined) {
    try {
      if (!isInside(root.within, await realpath(file))) {
        skipped.push({ label, reason: OUTSIDE_PLUGIN });
        return;
      }
    } catch (error) {
      skipped.push({
        label,
        reason: `could not be resolved: ${describeError(error)}`,
      });
      return;
    }
  }
  if (
    !CURSOR_INVOCATION_ID_PATTERN.test(sanitizeCursorInvocationSegment(name))
  ) {
    skipped.push({
      label,
      reason: 'its name cannot be used as a Cursor command id',
    });
    return;
  }
  let markdown: string;
  try {
    markdown = await readFile(file, 'utf8');
  } catch (error) {
    skipped.push({
      label,
      reason: `could not be read: ${describeError(error)}`,
    });
    return;
  }
  seenFiles.add(file);
  commands.push({
    origin: root.origin,
    ...(root.plugin !== undefined ? { plugin: root.plugin } : {}),
    name,
    markdown,
    description: firstHeading(markdown) ?? name,
  });
  rows.push([
    'command',
    root.origin,
    root.plugin ?? '',
    name,
    file,
    info.size,
    info.mtimeMs,
  ]);
}

/**
 * Every plugin the Cursor app downloaded whose download completed, with its
 * newest completed version. The app records which plugins are installed
 * only in its own state database, keyed by numeric ids that nothing on disk
 * maps to these folders, so a completed download is the install signal.
 */
async function cachedCursorPlugins(
  roots: InheritedCursorRoots,
  skipped: InheritedCursorSkipped[],
): Promise<{ plugin: string; dir: string }[]> {
  const cacheRoot = join(roots.userHome, '.cursor', 'plugins', 'cache');
  const found: { plugin: string; dir: string }[] = [];
  for (const marketplace of await listEntries(
    cacheRoot,
    '~/.cursor/plugins',
    skipped,
  )) {
    if (marketplace.name.startsWith('.') || !marketplace.isDirectory())
      continue;
    const marketplaceDir = join(cacheRoot, marketplace.name);
    for (const plugin of await listEntries(
      marketplaceDir,
      `~/.cursor/plugins/${marketplace.name}`,
      skipped,
    )) {
      if (plugin.name.startsWith('.') || !plugin.isDirectory()) continue;
      const pluginDir = join(marketplaceDir, plugin.name);
      const label = `~/.cursor/plugins/${marketplace.name}/${plugin.name}`;
      let newest: { dir: string; completedAt: number } | undefined;
      for (const version of await listEntries(pluginDir, label, skipped)) {
        if (version.name.startsWith('.') || !version.isDirectory()) continue;
        const dir = join(pluginDir, version.name);
        try {
          const marker = await stat(join(dir, '.cache-complete'));
          if (!newest || marker.mtimeMs > newest.completedAt)
            newest = { dir, completedAt: marker.mtimeMs };
        } catch (error) {
          if (!missing(error))
            skipped.push({
              label,
              reason: `could not be read: ${describeError(error)}`,
            });
        }
      }
      if (newest)
        found.push({
          plugin: `${marketplace.name}/${plugin.name}`,
          dir: newest.dir,
        });
    }
  }
  return found;
}

/**
 * Where a cached plugin keeps its skills and commands: the conventional
 * `skills/` and `commands/` folders, plus whatever its manifest
 * (`.cursor-plugin/plugin.json`, else `.claude-plugin/plugin.json`, else
 * `plugin.json`) lists under `skills` and `commands`, a string or a list.
 * Listed paths add to the conventional folders, the way Claude Code reads a
 * plugin manifest, and may name a folder of members, a single skill folder,
 * or a command file. A listed path that leads outside the plugin (`dir` is
 * canonical) is skipped and reported. A missing or unreadable manifest
 * leaves the conventional folders.
 */
async function pluginMemberPaths(
  dir: string,
  label: string,
  skipped: InheritedCursorSkipped[],
): Promise<{ skills: string[]; commands: string[] }> {
  let manifest: Record<string, unknown> = {};
  for (const relative of PLUGIN_MANIFESTS) {
    try {
      const parsed: unknown = JSON.parse(
        await readFile(join(dir, relative), 'utf8'),
      );
      if (isRecord(parsed)) manifest = parsed;
      break;
    } catch {
      // Try the next manifest location.
    }
  }
  const listed = (value: unknown): string[] =>
    typeof value === 'string'
      ? [value]
      : Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : [];
  const unique = (relatives: string[]): string[] => {
    const seen = new Set<string>();
    const paths: string[] = [];
    for (const relative of relatives) {
      // `resolve` drops a trailing slash (`./skills/`), so the conventional
      // folder and its listed spelling are one path. It also settles `..`
      // and absolute paths, which is what the containment check needs.
      const absolute = resolve(dir, relative);
      if (!isInside(dir, absolute)) {
        skipped.push({
          label,
          reason: `manifest path "${relative}" ${OUTSIDE_PLUGIN}`,
        });
        continue;
      }
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      paths.push(absolute);
    }
    return paths;
  };
  return {
    skills: unique(['skills', ...listed(manifest.skills)]),
    commands: unique(['commands', ...listed(manifest.commands)]),
  };
}

/**
 * A listed skill path: one skill when the folder holds `SKILL.md` itself,
 * else a folder of skills. A missing path adds nothing.
 */
async function collectSkillsAt(
  collector: Collector,
  root: Omit<SkillRoot, 'dir'>,
  target: string,
): Promise<void> {
  let holdsSkill = false;
  try {
    holdsSkill = (await lstat(join(target, 'SKILL.md'))).isFile();
  } catch {
    // Not a skill folder itself; read it as a folder of skills below.
  }
  if (holdsSkill)
    await collectSkillEntry(
      collector,
      { ...root, dir: dirname(target) },
      basename(target),
    );
  else await collectSkills(collector, { ...root, dir: target });
}

/**
 * A listed command path: one file, or a folder of files. A missing path adds
 * nothing.
 */
async function collectCommandsAt(
  collector: Collector,
  root: Omit<CommandRoot, 'dir'>,
  target: string,
): Promise<void> {
  let info: Stats;
  try {
    info = await stat(target);
  } catch (error) {
    if (!missing(error))
      collector.skipped.push({
        label: root.rootLabel,
        reason: `could not be read: ${describeError(error)}`,
      });
    return;
  }
  if (info.isFile())
    await collectCommandFile(
      collector,
      { ...root, dir: dirname(target) },
      basename(target),
    );
  else if (info.isDirectory())
    await collectCommands(collector, { ...root, dir: target });
}

export async function discoverInheritedCursorCapabilities(
  roots: InheritedCursorRoots,
): Promise<InheritedCursorCapabilities> {
  const collector: Collector = {
    skills: [],
    commands: [],
    skipped: [],
    rows: [],
    seenDirs: new Set<string>(),
    seenFiles: new Set<string>(),
  };

  for (const root of skillRoots(roots)) {
    await collectSkills(collector, {
      ...root,
      rootLabel: inheritedCursorRootLabel({
        kind: 'inherited_skill',
        origin: root.origin,
      }),
    });
  }
  for (const root of commandRoots(roots)) {
    await collectCommands(collector, {
      ...root,
      rootLabel: inheritedCursorRootLabel({
        kind: 'inherited_command',
        origin: root.origin,
      }),
    });
  }
  // Cached Cursor plugins come after the user's own folders, so a skill the
  // user wrote keeps its id over a plugin's skill of the same name.
  for (const cached of await cachedCursorPlugins(roots, collector.skipped)) {
    const rootLabel = inheritedCursorRootLabel({
      kind: 'inherited_skill',
      origin: 'cursor-plugin',
      plugin: cached.plugin,
    });
    // The canonical plugin directory bounds every member it contributes.
    let within: string;
    try {
      within = await realpath(cached.dir);
    } catch (error) {
      collector.skipped.push({
        label: rootLabel,
        reason: `could not be resolved: ${describeError(error)}`,
      });
      continue;
    }
    const members = await pluginMemberPaths(
      within,
      rootLabel,
      collector.skipped,
    );
    const root = {
      origin: 'cursor-plugin' as const,
      plugin: cached.plugin,
      rootLabel,
      within,
    };
    for (const target of members.skills)
      await collectSkillsAt(collector, root, target);
    for (const target of members.commands)
      await collectCommandsAt(collector, root, target);
  }

  return {
    skills: collector.skills,
    commands: collector.commands,
    skipped: collector.skipped,
    fingerprint: fingerprintOf(collector.rows),
  };
}
