/**
 * Names-only extraction of the external capabilities a SKILL.md references.
 *
 * Environment-neutral on purpose: `apps/web` renders these on the public share
 * page and the desktop turns them into package environment requirements, so
 * one implementation has to serve both. Everything host-specific is injected —
 * the brand tool namespaces and the parsed frontmatter — rather than imported,
 * which is what keeps this file free of `js-yaml`, brand runtime, and app
 * modules.
 */

import type { PipelinePackageEnvironmentRequirement } from '../pipelines/package';

export interface SkillDependencyExtractionOptions {
  /**
   * Tool namespaces the host injects itself (code-graph, ask-user, App
   * Advisor, the pipeline editor, the `_ui` ask-user surface, ...). A
   * reference to one of these is not an external requirement. Hosts pass each
   * brand's `tools.namespace`; the legacy `canopy` namespace is always
   * included.
   */
  builtinToolNamespaces?: readonly string[];
  /**
   * Parsed SKILL.md frontmatter, when the host has one. Parsing YAML is the
   * host's job so this module stays dependency-free.
   */
  frontmatter?: Record<string, unknown> | null;
}

/**
 * A named external capability a shared skill's instructions reference — an MCP
 * server/connector or a plugin. Extraction is names-only by design: MCP/plugin
 * configuration (URLs, tokens, env values) must never be extracted, stored, or
 * displayed alongside a public share.
 */
export type SkillDependency = {
  kind: SkillDependencyKind;
  /** Human-readable display name (e.g. "Slack") or verbatim plugin id. */
  name: string;
};

export type SkillDependencyKind = 'mcp' | 'plugin';

const MAX_DEPENDENCIES = 20;
const MAX_NAME_LENGTH = 64;

/**
 * Explicit provider tool references like `mcp__claude_ai_Slack__slack_send_message`.
 * The server segment is matched lazily so servers whose own names contain single
 * underscores (e.g. `claude_ai_Slack`) stop at the first true `__` separator.
 */
const MCP_TOOL_REF_PATTERN =
  /\bmcp__([A-Za-z0-9][A-Za-z0-9_-]*?)__[A-Za-z0-9]/g;

/**
 * Prose mention: "the Slack MCP", "the Google Drive MCP server". The phrase
 * separators are same-line whitespace only so a capture never spans lines
 * (e.g. a heading directly above an instruction sentence).
 */
const MCP_PROSE_THE_PATTERN =
  /\b[Tt]he[ \t]+([A-Z][A-Za-z0-9]*(?:[ \t]+[A-Z][A-Za-z0-9]*){0,3})[ \t]+MCP\b/g;

/** Prose mention: "Slack MCP server" (a name immediately before "MCP server"). */
const MCP_PROSE_SERVER_PATTERN =
  /\b([A-Z][A-Za-z0-9]*(?:[ \t]+[A-Z][A-Za-z0-9]*){0,3})[ \t]+MCP[ \t]+servers?\b/g;

/**
 * Backticked slash-command plugin reference: `/superpowers:brainstorming`.
 * A bare backticked `name:value` token is NOT enough — ordinary identifiers
 * like `pr:create` or `mode:fast` would be misread as plugins — so the
 * backticked form requires either the leading slash or an invocation verb
 * immediately before it (see PLUGIN_INVOKED_BACKTICK_PATTERN).
 */
const PLUGIN_BACKTICK_SLASH_PATTERN =
  /`\/([a-z][a-z0-9-]*):([a-z][a-z0-9-]*)`/g;

/** Backticked plugin ref with invocation context: run `superpowers:brainstorming`. */
const PLUGIN_INVOKED_BACKTICK_PATTERN =
  /\b(?:run|runs|running|invoke|invokes|invoking|use|uses|using|call|calls|calling|execute|executes|executing|trigger|triggers|triggering|via)\s+`([a-z][a-z0-9-]*):([a-z][a-z0-9-]*)`/gi;

/** Slash-command plugin skill reference: /ud-linear:linear-branch. */
const PLUGIN_SLASH_PATTERN = /(?:^|\s)\/([a-z][a-z0-9-]*):([a-z][a-z0-9-]*)\b/g;

/** Codex dollar-prefixed plugin skill reference: $builtin-gh:open-pr. */
const PLUGIN_DOLLAR_PATTERN = /`?\$([a-z][a-z0-9-]*):([a-z][a-z0-9-]*)\b/g;

/**
 * Determiners/pronouns that a prose capture can start with without naming a
 * server ("Some MCP server", "Each MCP..."). Captures reduced to nothing after
 * trimming these are discarded.
 */
const PROSE_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'this',
  'that',
  'these',
  'those',
  'some',
  'any',
  'every',
  'each',
  'no',
  'all',
  'one',
  'your',
  'my',
  'our',
  'their',
  'its',
  'which',
  'another',
  'other',
  // Imperative verbs that lead setup instructions ("Connect Google Drive MCP
  // server") — part of the sentence, never part of the server name.
  'connect',
  'use',
  'install',
  'configure',
  'enable',
  'add',
  'set',
  'setup',
  'open',
  'run',
  'launch',
  'start',
  'authorize',
  'link',
  'require',
  'requires',
  'needs',
  'need',
]);

const FRONTMATTER_MCP_KEYS = [
  'mcp',
  'mcps',
  'mcp-server',
  'mcp-servers',
  'mcp_servers',
  'mcpServers',
];
const FRONTMATTER_PLUGIN_KEYS = ['plugin', 'plugins'];
const FRONTMATTER_NESTED_KEYS = ['requires', 'dependencies'];

/** Optional vendor prefix on tool-derived server ids (`claude_ai_Slack`). */
const SERVER_VENDOR_PREFIX = /^claude[-_]ai[-_]/i;

/**
 * App-managed MCP routing prefixes (`<prefix><friendly>--<opaque>`), mirroring
 * `normalizeCanopyMcpServerDisplayName` in
 * `packages/desktop-shared/src/lib/turn-utils.ts` (which apps/web must not
 * import). Only the friendly segment is a user-meaningful server name; the
 * routing prefix and opaque id are internal.
 */
const APP_MANAGED_SERVER_PREFIXES = [
  'appdyn-',
  'appproxy-',
  'appplugin-',
  // Historical persisted names from before the branded rename.
  'canopydyn-',
  'canopyproxy-',
  'canopyplugin-',
];

/**
 * Tool namespaces injected by the app itself (code-graph, ask-user, App
 * Advisor, the pipeline editor, the `_ui` ask-user surface, ...). References
 * to these are not external requirements — every brand's `tools.namespace`
 * plus the legacy namespace, in each injected-surface suffix form.
 */
function builtinToolNamespaceSet(
  namespaces: readonly string[] | undefined,
): Set<string> {
  return new Set(
    [...(namespaces ?? []), 'canopy'].flatMap((namespace) => [
      namespace,
      `${namespace}_app_advisor`,
      `${namespace}_ui`,
      `${namespace}_pipeline_editor`,
    ]),
  );
}

function stripAppManagedServerPrefix(raw: string): string {
  for (const prefix of APP_MANAGED_SERVER_PREFIXES) {
    if (raw.startsWith(prefix)) {
      const withoutPrefix = raw.slice(prefix.length);
      const separatorIndex = withoutPrefix.indexOf('--');
      return separatorIndex > 0
        ? withoutPrefix.slice(0, separatorIndex)
        : withoutPrefix;
    }
  }
  return raw;
}

function humanizeMcpServerName(raw: string): string {
  const withoutVendor = stripAppManagedServerPrefix(raw).replace(
    SERVER_VENDOR_PREFIX,
    '',
  );
  return withoutVendor
    .split(/[-_\s]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function stripLeadingStopwords(phrase: string): string {
  const words = phrase.split(/\s+/);
  let start = 0;
  while (
    start < words.length &&
    PROSE_STOPWORDS.has(words[start].toLowerCase())
  ) {
    start += 1;
  }
  return words.slice(start).join(' ');
}

function collectStringListValue(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.trim() ? [value.trim()] : [];
  }
  if (Array.isArray(value)) {
    // Names only: non-string entries (objects with urls/tokens/config) are
    // deliberately ignored rather than mined for a name field.
    const strings: string[] = [];
    for (const entry of value) {
      if (typeof entry === 'string' && entry.trim()) {
        strings.push(entry.trim());
      }
    }
    return strings;
  }
  return [];
}

interface FrontmatterDependencyNames {
  mcpNames: string[];
  pluginNames: string[];
}

function collectFrontmatterDependencies(
  frontmatter: Record<string, unknown>,
): FrontmatterDependencyNames {
  const mcpNames: string[] = [];
  const pluginNames: string[] = [];

  const collectFrom = (source: Record<string, unknown>): void => {
    for (const key of FRONTMATTER_MCP_KEYS) {
      mcpNames.push(...collectStringListValue(source[key]));
    }
    for (const key of FRONTMATTER_PLUGIN_KEYS) {
      pluginNames.push(...collectStringListValue(source[key]));
    }
  };

  collectFrom(frontmatter);
  for (const nestedKey of FRONTMATTER_NESTED_KEYS) {
    const nested = frontmatter[nestedKey];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      collectFrom(Object.fromEntries(Object.entries(nested)));
    }
  }

  return { mcpNames, pluginNames };
}

// An `exec` loop rather than `matchAll`, so this stays compatible with the
// protocol package's compile target. Every pattern here is global and module
// scoped, so `lastIndex` is reset before use to keep repeated calls
// deterministic.
function matchAllCaptures(content: string, pattern: RegExp): string[] {
  const captures: string[] = [];
  pattern.lastIndex = 0;
  let match = pattern.exec(content);
  while (match !== null) {
    const capture = match[1];
    if (capture) captures.push(capture);
    // A zero-width match would otherwise spin forever on the same index.
    if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
    match = pattern.exec(content);
  }
  pattern.lastIndex = 0;
  return captures;
}

/**
 * Extract the MCP servers and plugins a SKILL.md references, for surfacing as
 * "Requires" metadata on public skill shares. Conservative by design: explicit
 * `mcp__server__tool` refs, backtick/slash `plugin:skill` refs, frontmatter
 * name lists, and narrowly-matched prose ("the Slack MCP", "X MCP server").
 * Returns display names only, deduped case-insensitively and sorted by kind
 * then name so repeated extraction over the same content is deterministic.
 */
export function extractSkillDependencies(
  rawSkill: string,
  options: SkillDependencyExtractionOptions = {},
): SkillDependency[] {
  if (!rawSkill.trim()) {
    return [];
  }

  const builtinToolNamespaces = builtinToolNamespaceSet(
    options.builtinToolNamespaces,
  );

  const mcpNames: string[] = [];
  const pluginNames: string[] = [];

  for (const server of matchAllCaptures(rawSkill, MCP_TOOL_REF_PATTERN)) {
    if (builtinToolNamespaces.has(server)) {
      continue;
    }
    mcpNames.push(humanizeMcpServerName(server));
  }

  for (const pattern of [MCP_PROSE_THE_PATTERN, MCP_PROSE_SERVER_PATTERN]) {
    for (const phrase of matchAllCaptures(rawSkill, pattern)) {
      const name = stripLeadingStopwords(phrase);
      if (name) {
        mcpNames.push(name);
      }
    }
  }

  for (const pattern of [
    PLUGIN_BACKTICK_SLASH_PATTERN,
    PLUGIN_INVOKED_BACKTICK_PATTERN,
    PLUGIN_SLASH_PATTERN,
    PLUGIN_DOLLAR_PATTERN,
  ]) {
    pluginNames.push(...matchAllCaptures(rawSkill, pattern));
  }

  const frontmatter = options.frontmatter ?? null;
  if (frontmatter) {
    const declared = collectFrontmatterDependencies(frontmatter);
    mcpNames.push(...declared.mcpNames.map(humanizeMcpServerName));
    pluginNames.push(...declared.pluginNames);
  }

  const seen = new Set<string>();
  const dependencies: SkillDependency[] = [];
  const add = (kind: SkillDependencyKind, name: string): void => {
    if (!name || name.length > MAX_NAME_LENGTH) {
      return;
    }
    const dedupeKey = `${kind}:${name.toLowerCase()}`;
    if (seen.has(dedupeKey)) {
      return;
    }
    seen.add(dedupeKey);
    dependencies.push({ kind, name });
  };

  for (const name of mcpNames) {
    add('mcp', name);
  }
  for (const name of pluginNames) {
    add('plugin', name);
  }

  return dependencies
    .sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
    )
    .slice(0, MAX_DEPENDENCIES);
}

/**
 * Validate a stored `pinned_dependencies` JSON value back into a typed list.
 * Returns null when the value is absent or not a list — callers treat that as
 * "unknown" (legacy share rows created before extraction existed), which is
 * distinct from an empty list ("extracted, none found"). Malformed entries in
 * an otherwise valid list are dropped rather than failing the whole read.
 */
export function parseStoredSkillDependencies(
  value: unknown,
): SkillDependency[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const dependencies: SkillDependency[] = [];
  // `Array.isArray` widens to `any[]`, so the element type is restated here
  // rather than letting `any` leak through the rest of the parse.
  const entries: unknown[] = value;
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record: Record<string, unknown> = Object.fromEntries(
      Object.entries(entry),
    );
    const kind = record.kind;
    const rawName = record.name;
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (
      (kind === 'mcp' || kind === 'plugin') &&
      name &&
      name.length <= MAX_NAME_LENGTH
    ) {
      dependencies.push({ kind, name });
    }
  }
  return dependencies;
}

/**
 * Turn extracted names into capability-package environment requirements.
 *
 * The extractor is names-only by design, so a requirement carries the display
 * name and a generic setup hint and nothing else. Configuration and
 * credentials — a stdio server's command line, a remote server's URL, any env
 * value — are unportable and leak local layout or private hosts, so they never
 * travel and are deliberately not reachable from here.
 *
 * `affectedSteps` is empty: a skill has no steps, so the requirement belongs
 * to the share as a whole.
 */
export function skillDependenciesToEnvironmentRequirements(
  dependencies: readonly SkillDependency[],
): PipelinePackageEnvironmentRequirement[] {
  // Extraction dedupes case-insensitively on the display NAME, but ids are
  // slugified from it, so two spellings of one dependency ("Foo Bar" and
  // "foo-bar") survive extraction and then collide here. A duplicate id makes
  // `validatePipelinePackageManifest` reject the whole manifest, which
  // surfaces as an opaque analysis failure, so the first spelling wins.
  const seenIds = new Set<string>();
  return dependencies.flatMap((dependency) => {
    // `command` is the format's "executable probed on PATH" kind, which a
    // plugin is not. `runtime` is the honest fit: a capability the recipient's
    // environment has to provide before the skill works.
    const kind: PipelinePackageEnvironmentRequirement['kind'] =
      dependency.kind === 'mcp' ? 'mcp' : 'runtime';
    const id = `${kind}-${slugifyRequirementName(dependency.name)}`;
    if (seenIds.has(id)) return [];
    seenIds.add(id);
    return {
      id,
      kind,
      displayName: dependency.name,
      // Unmet requirements warn, they never block, so nothing extracted this
      // way is marked required: the recipient installs and is told what to
      // connect, rather than being refused the share.
      required: false,
      affectedSteps: [],
      setupHint:
        dependency.kind === 'mcp'
          ? `Connect the ${dependency.name} MCP server in Settings.`
          : `Install the ${dependency.name} plugin.`,
    };
  });
}

function slugifyRequirementName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // Requirement ids must match the manifest identifier pattern, which starts
  // with an alphanumeric. A name of only punctuation would otherwise produce
  // an id the validator rejects.
  return slug.length > 0 ? slug : 'unnamed';
}
