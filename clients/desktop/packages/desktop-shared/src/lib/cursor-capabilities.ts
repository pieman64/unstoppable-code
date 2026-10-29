/**
 * Skills and slash commands projected into a Cursor chat.
 *
 * The pinned Cursor CLI discovers skills as `<root>/.cursor/skills/<id>/SKILL.md`
 * and commands as `<root>/.cursor/commands/<id>.md`, and matches a typed
 * `/name` token with `[a-zA-Z0-9_-]+`. The id is therefore a filesystem name
 * AND the invocation token, and it has to be computed identically by the
 * resolver that materializes the files and by the inventory that inserts the
 * token into the composer. This module is that single source of truth. It is
 * browser-safe: no filesystem, no Node.
 */

/**
 * Which of the user's home-folder skill roots an inherited skill came from.
 * `cursor-plugin` is a member of a plugin the Cursor app downloaded to
 * `~/.cursor/plugins/cache`; its `plugin` names `<marketplace>/<plugin>`.
 */
export type InheritedCursorOrigin =
  | 'cursor'
  | 'claude'
  | 'codex'
  | 'grok'
  | 'agents'
  | 'cursor-plugin';

/** Which of the user's home-folder command roots an inherited command came from. */
export type InheritedCursorCommandOrigin =
  | 'cursor'
  | 'claude'
  | 'cursor-plugin';

export type CursorInvocationSource =
  | { kind: 'skill'; sourceId: string; skillName: string }
  | {
      kind: 'plugin_skill';
      marketplaceId: string;
      pluginName: string;
      memberName: string;
    }
  | {
      kind: 'plugin_command';
      marketplaceId: string;
      pluginName: string;
      memberName: string;
    }
  /**
   * A skill from the user's own home folders (design:
   * 2026-10-05-cursor-inherited-capabilities). `plugin` is set for a member
   * of a cached Cursor plugin, `<marketplace>/<plugin>`, and takes part in
   * the identity: two plugins may ship a skill of the same name.
   */
  | {
      kind: 'inherited_skill';
      origin: InheritedCursorOrigin;
      name: string;
      plugin?: string;
    }
  /** A command file from the user's own home folders or a cached Cursor plugin. */
  | {
      kind: 'inherited_command';
      origin: InheritedCursorCommandOrigin;
      name: string;
      plugin?: string;
    };

export type InheritedCursorSource = Extract<
  CursorInvocationSource,
  { kind: 'inherited_skill' | 'inherited_command' }
>;

const INHERITED_SKILL_ROOT_LABELS: Record<InheritedCursorOrigin, string> = {
  cursor: '~/.cursor/skills',
  claude: '~/.claude/skills',
  codex: '~/.codex/skills',
  grok: '~/.grok/skills',
  agents: '~/.agents/skills',
  'cursor-plugin': '~/.cursor/plugins',
};

const INHERITED_COMMAND_ROOT_LABELS: Record<
  InheritedCursorCommandOrigin,
  string
> = {
  cursor: '~/.cursor/commands',
  claude: '~/.claude/commands',
  'cursor-plugin': '~/.cursor/plugins',
};

/**
 * The folder an inherited entry came from, as the user knows it. A relocated
 * Claude or Codex configuration directory is not spelled out; the label names
 * the root's role, not its path. A cached Cursor plugin member is labeled by
 * its plugin, `~/.cursor/plugins/<marketplace>/<plugin>`. The parameter is an
 * explicit two-member union rather than a `Pick` over the source union, which
 * would not distribute and would lose the `kind`/`origin` correlation the
 * indexing relies on.
 */
export function inheritedCursorRootLabel(
  source:
    | {
        kind: 'inherited_skill';
        origin: InheritedCursorOrigin;
        plugin?: string;
      }
    | {
        kind: 'inherited_command';
        origin: InheritedCursorCommandOrigin;
        plugin?: string;
      },
): string {
  const root =
    source.kind === 'inherited_skill'
      ? INHERITED_SKILL_ROOT_LABELS[source.origin]
      : INHERITED_COMMAND_ROOT_LABELS[source.origin];
  return source.origin === 'cursor-plugin' && source.plugin
    ? `${root}/${source.plugin}`
    : root;
}

/** `~/.claude/skills/<name>`: the label notices and inventory rows show. */
export function inheritedCursorEntryLabel(
  source: InheritedCursorSource,
): string {
  return `${inheritedCursorRootLabel(source)}/${source.name}`;
}

/** A skill directory to copy into the chat's Cursor root. */
export interface CursorProjectedSkill {
  id: string;
  /** Host resolution provenance, used when freezing home inheritance. */
  source?: CursorInvocationSource;
  /**
   * Canonical absolute source directory containing `SKILL.md` — every
   * symbolic link already resolved by the resolver's containment check. The
   * materializer refuses a path that resolves anywhere else.
   */
  sourceDir: string;
  description: string;
  /** What the selection was called, for notices. */
  label: string;
  /** False keeps the skill available to the model but out of slash commands. */
  userInvocable?: boolean;
}

/** A command file to write into the chat's Cursor root. */
export interface CursorProjectedCommand {
  id: string;
  source?: CursorInvocationSource;
  /** Complete file content in the shape the CLI parses. */
  markdown: string;
  description: string;
  label: string;
}

export interface CursorCapabilityProjection {
  skills: CursorProjectedSkill[];
  commands: CursorProjectedCommand[];
}

export function emptyCursorCapabilityProjection(): CursorCapabilityProjection {
  return { skills: [], commands: [] };
}

/**
 * What a Cursor session loads from a plugin's catalog facets lives in
 * `@canopy/plugin-interop`, which web may import too; it is re-exported here
 * beside the invocation ids so desktop callers read one module.
 */
export {
  CURSOR_LOADABLE_PLUGIN_MEMBER_KINDS,
  cursorLoadsPluginMemberKind,
  cursorPluginFacetProvider,
  cursorPluginFacetSupport,
  type CursorLoadablePluginDetails,
  type CursorLoadablePluginMemberKind,
  type CursorPluginFacetSupport,
  type CursorPluginProvider,
} from '@canopy/plugin-interop/cursor-support';

/** The exact shape the CLI accepts as a skill folder, command file, or `/name` token. */
export const CURSOR_INVOCATION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export function sanitizeCursorInvocationSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
}

/**
 * The order a plugin's members take part in id assignment: skills before
 * commands, then by name in code-point order. Both the chat root and the
 * inventory sort with this before assigning ids, so a collision resolves to
 * the same suffix wherever the members were listed from (a cached facet, a
 * directory walk) and in whatever order that listing came.
 */
export function sortCursorPluginMembers<
  T extends { kind: 'plugin_skill' | 'plugin_command'; name: string },
>(members: readonly T[]): T[] {
  return [...members].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'plugin_skill' ? -1 : 1;
    if (left.name === right.name) return 0;
    return left.name < right.name ? -1 : 1;
  });
}

/** Stable identity of a source, independent of the id it ends up with. */
export function cursorInvocationKey(source: CursorInvocationSource): string {
  switch (source.kind) {
    case 'skill':
      return `skill\u0000${source.sourceId}\u0000${source.skillName}`;
    case 'plugin_skill':
    case 'plugin_command':
      return `${source.kind}\u0000${source.marketplaceId}\u0000${source.pluginName}\u0000${source.memberName}`;
    case 'inherited_skill':
    case 'inherited_command':
      return `${source.kind}\u0000${source.origin}\u0000${source.plugin ?? ''}\u0000${source.name}`;
  }
}

function baseId(source: CursorInvocationSource): string {
  if (source.kind === 'skill') {
    return sanitizeCursorInvocationSegment(source.skillName) || 'skill';
  }
  if (
    source.kind === 'inherited_skill' ||
    source.kind === 'inherited_command'
  ) {
    return (
      sanitizeCursorInvocationSegment(source.name) ||
      (source.kind === 'inherited_skill' ? 'skill' : 'command')
    );
  }
  const plugin = sanitizeCursorInvocationSegment(source.pluginName);
  const member = sanitizeCursorInvocationSegment(source.memberName);
  const joined = [plugin, member].filter((part) => part.length > 0).join('-');
  if (joined.length > 0) return joined;
  return source.kind === 'plugin_skill' ? 'skill' : 'command';
}

/**
 * Assigns every source its invocation id, in input order. A later source whose
 * base collides with an earlier one gets a numeric suffix, the same way the
 * Claude skill plugin deduplicates folder names.
 */
export function assignCursorInvocationIds(
  sources: readonly CursorInvocationSource[],
): Map<string, string> {
  const used = new Map<string, number>();
  const ids = new Map<string, string>();
  for (const source of sources) {
    const key = cursorInvocationKey(source);
    if (ids.has(key)) continue;
    const base = baseId(source);
    let id = base;
    let counter = used.get(base) ?? 0;
    while (counter > 0 && used.has(id)) {
      id = `${base}-${counter}`;
      counter += 1;
    }
    if (counter === 0) {
      used.set(base, 1);
    } else {
      used.set(base, counter);
      used.set(id, 1);
    }
    ids.set(key, id);
  }
  return ids;
}

/**
 * Renders a command in the shape the pinned CLI reads: no frontmatter, the
 * description as the first-line heading (its only metadata), then the body.
 * `$ARGUMENTS` and `$1…$99` in the body are substituted by the CLI itself.
 */
export function renderCursorCommandMarkdown(command: {
  id: string;
  description: string;
  body: string;
}): string {
  const heading = command.description.replace(/\s+/g, ' ').trim() || command.id;
  const body = command.body.replace(/\r\n/g, '\n').trim();
  return body.length > 0 ? `# ${heading}\n\n${body}\n` : `# ${heading}\n`;
}

/**
 * Expands a message that starts with a materialized command, the way the
 * pinned CLI expands a leading `/name args` prompt: `$ARGUMENTS` takes the
 * whole argument string, `$1`…`$99` take one word each (missing ones blank),
 * and a body with no placeholder gets the arguments appended after a blank
 * line. The host does this itself because its per-turn instructions precede
 * the user text in the ACP prompt, so the CLI's own leading-command parser
 * never sees the command at the start. Anything else is returned unchanged.
 */
export function expandLeadingCursorCommand(
  text: string,
  commands: readonly { id: string; markdown: string }[],
): string {
  const match = /^\/([a-z0-9][a-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return text;
  const command = commands.find((candidate) => candidate.id === match[1]);
  if (!command) return text;
  const argumentText = (match[2] ?? '').trim();
  const words = argumentText.length > 0 ? argumentText.split(/\s+/) : [];
  const body = command.markdown.replace(/\r\n/g, '\n').trim();
  let expanded = body;
  let substituted = false;
  if (expanded.includes('$ARGUMENTS')) {
    substituted = true;
    expanded = expanded.replace(/\$ARGUMENTS/g, () => argumentText);
  }
  // `$1`…`$99` only: a literal `$0` (a shell example, say) is not a
  // placeholder and passes through unchanged.
  const positional = /(?<!\w)\$([1-9]\d?)\b/g;
  if (positional.test(expanded)) {
    substituted = true;
    expanded = expanded.replace(positional, (_whole, index: string) => {
      const position = Number.parseInt(index, 10);
      return position <= words.length ? (words[position - 1] ?? '') : '';
    });
  }
  if (substituted || argumentText.length === 0) return expanded;
  return `${expanded}\n\n${argumentText}`;
}
