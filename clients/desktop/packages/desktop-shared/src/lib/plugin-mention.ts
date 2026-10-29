/**
 * Plugin mentions — the composer's whole-plugin `@` pill.
 *
 * Picking a plugin from the composer `+` / `@` menu enables it for the chat
 * AND inserts an inline mention pill, the same way a picked file becomes a
 * file-reference pill. The pill rides the existing opaque mention `kind`
 * (`FileReference.kind`, see `prompt-mention-expansion.ts` for the prompt
 * kind) so it flows through the editor, the wire, and the persisted
 * transcript without a parallel element type. What differs is the target:
 * `absolutePath` carries a `plugin://` locator instead of a filesystem path,
 * so every path-oriented consumer (cwd rewriting, the "Referenced files"
 * preamble, the transcript file-chip scanner) must skip plugin mentions and
 * a dedicated consumer lists / renders them instead.
 *
 * Environment-neutral (browser-safe, no Node imports): shared by the desktop
 * renderer, desktop main, and any portal send path.
 */

/** Mention `kind` marking a whole-plugin pill. */
export const PLUGIN_MENTION_KIND = 'plugin';

const PLUGIN_MENTION_SCHEME = 'plugin://';

/** Identity of the mentioned plugin — mirrors `ChatTabPluginSelections.pluginRefs[number]`. */
export interface PluginMentionRef {
  marketplaceId: string;
  pluginName: string;
}

/**
 * Structural subset of a file reference the plugin-mention helpers need. Both
 * the renderer's `SerializedFileReference` (`@canopy/ui-rich`) and the wire
 * Host-side `FileReference` shapes satisfy it.
 */
export interface PluginMentionReference {
  displayPath: string;
  absolutePath: string;
  kind?: string;
}

/**
 * Build the `absolutePath` locator for a plugin mention. Both ids are
 * URI-encoded because marketplace ids routinely contain `/`
 * (`demo/market`), which would otherwise be ambiguous with the separator.
 */
export function buildPluginMentionAbsolutePath(ref: PluginMentionRef): string {
  return `${PLUGIN_MENTION_SCHEME}${encodeURIComponent(ref.marketplaceId)}/${encodeURIComponent(ref.pluginName)}`;
}

/** Inverse of {@link buildPluginMentionAbsolutePath}; `null` for anything else. */
export function parsePluginMentionAbsolutePath(
  absolutePath: string,
): PluginMentionRef | null {
  if (!absolutePath.startsWith(PLUGIN_MENTION_SCHEME)) return null;
  const rest = absolutePath.slice(PLUGIN_MENTION_SCHEME.length);
  const separator = rest.indexOf('/');
  if (separator <= 0 || separator === rest.length - 1) return null;
  try {
    return {
      marketplaceId: decodeURIComponent(rest.slice(0, separator)),
      pluginName: decodeURIComponent(rest.slice(separator + 1)),
    };
  } catch {
    return null;
  }
}

export function isPluginMentionReference(
  reference: PluginMentionReference,
): boolean {
  return reference.kind === PLUGIN_MENTION_KIND;
}

/**
 * Split a reference list into the filesystem references path-oriented code
 * may rewrite and the plugin mentions it must leave alone. Order within each
 * group is preserved so inline-occurrence rewriting keeps working.
 */
export function partitionPluginMentions<T extends PluginMentionReference>(
  references: readonly T[],
): { fileReferences: T[]; pluginMentions: T[] } {
  const fileReferences: T[] = [];
  const pluginMentions: T[] = [];
  for (const reference of references) {
    if (isPluginMentionReference(reference)) {
      pluginMentions.push(reference);
    } else {
      fileReferences.push(reference);
    }
  }
  return { fileReferences, pluginMentions };
}

// The locator already escapes both ids, so `demo` + `market/x` and
// `demo/market` + `x` stay distinct keys.
function pluginMentionKey(ref: PluginMentionRef): string {
  return buildPluginMentionAbsolutePath(ref);
}

/** Every distinct plugin mentioned by the given references, in first-seen order. */
export function collectMentionedPluginRefs(
  references: readonly PluginMentionReference[],
): PluginMentionRef[] {
  const seen = new Set<string>();
  const refs: PluginMentionRef[] = [];
  for (const reference of references) {
    if (!isPluginMentionReference(reference)) continue;
    const ref = parsePluginMentionAbsolutePath(reference.absolutePath);
    if (!ref) continue;
    const key = pluginMentionKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

/**
 * Mentioned plugins that are not currently enabled for the chat. Mentioning a
 * plugin means "use it", so a send re-enables anything the user removed after
 * dropping the pill — the agent must never be told about a plugin it cannot
 * load.
 */
export function missingMentionedPluginRefs(
  references: readonly PluginMentionReference[],
  enabledRefs: readonly PluginMentionRef[],
): PluginMentionRef[] {
  const enabled = new Set(enabledRefs.map(pluginMentionKey));
  return collectMentionedPluginRefs(references).filter(
    (ref) => !enabled.has(pluginMentionKey(ref)),
  );
}
