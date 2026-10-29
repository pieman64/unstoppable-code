import {
  normalizeShareablePluginRef,
  type ShareablePluginRef,
} from '../plugins';

/** A durable occurrence in a configured prompt. Offsets count UTF-16 code units. */
export type ConfiguredPromptReference = {
  textStart: number;
  displayText: string;
} & (
  | {
      kind: 'file';
      root: { kind: 'workspace' } | { kind: 'repo'; repoId: string };
      relativePath: string;
    }
  | {
      kind: 'plugin';
      plugin:
        | { kind: 'portable'; ref: ShareablePluginRef }
        | { kind: 'installed'; marketplaceId: string; pluginName: string };
    }
);

export interface ConfiguredPrompt {
  prompt: string;
  promptReferences?: ConfiguredPromptReference[];
}

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function hasNoUnknownNestedKeys(value: unknown, normalized: unknown): boolean {
  const source = record(value);
  const target = record(normalized);
  if (!source || !target) return true;
  return Object.keys(source).every(
    (key) =>
      Object.prototype.hasOwnProperty.call(target, key) &&
      hasNoUnknownNestedKeys(source[key], target[key]),
  );
}

function validRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.includes('\\') || value.includes('\0') || value.startsWith('/')) {
    return false;
  }
  if (/^[A-Za-z]:/.test(value) || value.startsWith('//')) return false;
  return value
    .split('/')
    .every((part) => part !== '' && part !== '.' && part !== '..');
}

/** Validate the serialized prompt and exact pill occurrences without filesystem access. */
export function validateConfiguredPromptReferences(
  prompt: string,
  references: unknown,
  options: { portableOnly?: boolean; knownRepoIds?: readonly string[] } = {},
): string | null {
  if (references === undefined) return null;
  if (!Array.isArray(references)) return 'promptReferences must be an array.';
  const values: unknown[] = references;
  let previousEnd = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value: unknown = values[index];
    const ref = record(value);
    const label = `promptReferences[${index}]`;
    if (!ref) return `${label} must be an object.`;
    const textStart = ref.textStart;
    if (
      typeof textStart !== 'number' ||
      !Number.isSafeInteger(textStart) ||
      textStart < previousEnd
    ) {
      return `${label}.textStart must be a non-overlapping nonnegative integer in document order.`;
    }
    if (typeof ref.displayText !== 'string' || ref.displayText.length === 0) {
      return `${label}.displayText must be nonempty.`;
    }
    if (
      prompt.slice(textStart, textStart + ref.displayText.length) !==
      ref.displayText
    ) {
      return `${label} does not match the prompt at textStart.`;
    }
    previousEnd = textStart + ref.displayText.length;
    if (ref.kind === 'file') {
      if (
        !hasOnlyKeys(ref, [
          'kind',
          'textStart',
          'displayText',
          'root',
          'relativePath',
        ])
      ) {
        return `${label} contains unsupported fields.`;
      }
      const root = record(ref.root);
      if (!root || (root.kind !== 'workspace' && root.kind !== 'repo')) {
        return `${label}.root is invalid.`;
      }
      if (root.kind === 'repo') {
        if (!hasOnlyKeys(root, ['kind', 'repoId']))
          return `${label}.root contains unsupported fields.`;
        if (typeof root.repoId !== 'string' || !root.repoId.trim()) {
          return `${label}.root.repoId is invalid.`;
        }
        if (
          options.knownRepoIds &&
          !options.knownRepoIds.includes(root.repoId)
        ) {
          return `${label}.root.repoId is unknown for the selected project.`;
        }
      }
      if (root.kind === 'workspace' && !hasOnlyKeys(root, ['kind'])) {
        return `${label}.root contains unsupported fields.`;
      }
      if (!validRelativePath(ref.relativePath)) {
        return `${label}.relativePath must be a normalized root-relative path.`;
      }
    } else if (ref.kind === 'plugin') {
      if (!hasOnlyKeys(ref, ['kind', 'textStart', 'displayText', 'plugin'])) {
        return `${label} contains unsupported fields.`;
      }
      const plugin = record(ref.plugin);
      if (!plugin) return `${label}.plugin is invalid.`;
      if (plugin.kind === 'installed') {
        if (!hasOnlyKeys(plugin, ['kind', 'marketplaceId', 'pluginName'])) {
          return `${label}.plugin contains unsupported fields.`;
        }
        if (options.portableOnly)
          return `${label}.plugin installed references are not portable.`;
        if (
          typeof plugin.marketplaceId !== 'string' ||
          !plugin.marketplaceId.trim() ||
          typeof plugin.pluginName !== 'string' ||
          !plugin.pluginName.trim()
        ) {
          return `${label}.plugin installed identity is invalid.`;
        }
      } else if (plugin.kind === 'portable') {
        if (!hasOnlyKeys(plugin, ['kind', 'ref']))
          return `${label}.plugin contains unsupported fields.`;
        try {
          const normalized = normalizeShareablePluginRef(plugin.ref);
          if (!hasNoUnknownNestedKeys(plugin.ref, normalized)) {
            return `${label}.plugin portable reference contains unsupported fields.`;
          }
        } catch {
          return `${label}.plugin portable reference is invalid.`;
        }
      } else {
        return `${label}.plugin kind is invalid.`;
      }
    } else {
      return `${label}.kind is invalid.`;
    }
  }
  return null;
}

/** Narrow serialized references only after the complete wire validation succeeds. */
export function isValidatedConfiguredPromptReferences(
  prompt: string,
  references: unknown,
  options: { portableOnly?: boolean; knownRepoIds?: readonly string[] } = {},
): references is ConfiguredPromptReference[] {
  return (
    Array.isArray(references) &&
    validateConfiguredPromptReferences(prompt, references, options) === null
  );
}

/** Trim once and shift structured offsets by the exact removed prefix. */
export function normalizeConfiguredPrompt(
  prompt: string,
  references: readonly ConfiguredPromptReference[] | undefined,
): ConfiguredPrompt {
  const leading = prompt.length - prompt.trimStart().length;
  const normalizedPrompt = prompt.trim();
  const normalizedReferences = references?.map((reference) => ({
    ...reference,
    textStart: reference.textStart - leading,
  }));
  const error = validateConfiguredPromptReferences(
    normalizedPrompt,
    normalizedReferences,
  );
  if (error) throw new Error(error);
  return {
    prompt: normalizedPrompt,
    ...(normalizedReferences !== undefined
      ? { promptReferences: normalizedReferences }
      : {}),
  };
}

/** Apply variable expansion only to plain-text segments, preserving pill identity. */
export function mapConfiguredPromptText(
  prompt: string,
  references: readonly ConfiguredPromptReference[] | undefined,
  mapText: (text: string) => string,
): ConfiguredPrompt {
  const error = validateConfiguredPromptReferences(prompt, references);
  if (error) throw new Error(error);
  if (!references?.length)
    return {
      prompt: mapText(prompt),
      ...(references ? { promptReferences: [] } : {}),
    };
  const parts: string[] = [];
  const mapped: ConfiguredPromptReference[] = [];
  let cursor = 0;
  let length = 0;
  for (const reference of references) {
    const prefix = mapText(prompt.slice(cursor, reference.textStart));
    parts.push(prefix, reference.displayText);
    length += prefix.length;
    mapped.push({ ...reference, textStart: length });
    length += reference.displayText.length;
    cursor = reference.textStart + reference.displayText.length;
  }
  parts.push(mapText(prompt.slice(cursor)));
  return { prompt: parts.join(''), promptReferences: mapped };
}
