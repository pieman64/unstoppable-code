import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import type { CursorModelEntry } from '../types/cursor-models';
import {
  cursorThinkingLevelsFromConfigOptions,
  parseCursorModelVariant,
} from './cursor-thinking';
import { isSyntacticallyValidModelId } from './model-id';

const PREFIX = 'cursor:';
/** The Auto identity advertised by the pinned Cursor ACP runtime. */
export const CURSOR_AUTO_MODEL_ID = 'default[]';

function validRawModelId(value: string): boolean {
  if (!isSyntacticallyValidModelId(value)) return false;
  try {
    // The persisted namespace must also fit the shared harness-policy bound.
    // Encoding preserves arbitrary vendor punctuation and Unicode losslessly.
    return isSyntacticallyValidModelId(`${PREFIX}${encodeURIComponent(value)}`);
  } catch {
    // A lone UTF-16 surrogate cannot be encoded as a lossless UTF-8 identity.
    return false;
  }
}

/** Persist opaque ACP IDs separately from native and gateway model identities. */
export function toCursorModelId(rawModelId: string): string {
  if (!validRawModelId(rawModelId)) throw new Error('Invalid Cursor model.');
  return rawModelId === CURSOR_AUTO_MODEL_ID
    ? 'cursor-default'
    : `${PREFIX}${encodeURIComponent(rawModelId)}`;
}

export function getRawCursorModelId(model: string): string | undefined {
  if (model === 'cursor-default') return CURSOR_AUTO_MODEL_ID;
  if (!model.startsWith(PREFIX)) return undefined;
  try {
    const raw = decodeURIComponent(model.slice(PREFIX.length));
    return validRawModelId(raw) && toCursorModelId(raw) === model
      ? raw
      : undefined;
  } catch {
    return undefined;
  }
}

export function isCursorModel(model: unknown): model is string {
  return typeof model === 'string' && getRawCursorModelId(model) !== undefined;
}

function validLabel(label: string): boolean {
  return (
    label.length > 0 &&
    label.length <= 256 &&
    !Array.from(label).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}

/** Interpret only ACP parameter suffixes for display; execution IDs stay opaque. */
export function cursorModelLabelParts(raw: string): {
  base: string;
  qualifier?: string;
} {
  const match = /^(.+)\[([^\[\]]*)\]$/.exec(raw);
  if (!match) return { base: raw };
  const parameters = match[2] ? match[2].split(',') : [];
  if (parameters.some((parameter) => !/^[\w-]+=[^=,]+$/.test(parameter)))
    return { base: raw };
  return {
    base: match[1],
    qualifier: parameters
      .map((parameter) => parameter.replace('=', ': '))
      .join(', '),
  };
}

/**
 * Display-only maker for the model namespaces advertised by Cursor. Unknown
 * namespaces remain unclaimed. Never use a display label to infer identity or
 * use this classification to decide which runtime may execute a model.
 */
export function getCursorModelVendor(model: string): string | undefined {
  const raw = getRawCursorModelId(model);
  if (!raw) return undefined;
  if (model === 'cursor-default') return 'cursor';
  const { base } = cursorModelLabelParts(raw);
  const namespaces: readonly [string, string][] = [
    ['claude-', 'anthropic'],
    ['gpt-', 'openai'],
    ['gemini-', 'google'],
    ['kimi-', 'moonshot'],
    ['grok-', 'xai'],
    ['deepseek-', 'deepseek'],
    ['composer-', 'cursor'],
  ];
  return namespaces.find(([prefix]) => base.startsWith(prefix))?.[1];
}

/**
 * Model catalog extension of the pinned runtime; its model picker names every
 * variant by its bare slug, so readable names come from here. The response
 * shape (`{ models: [{ value: <base ID>, name }] }`) was observed on the pinned
 * CLI rather than documented, so anything else simply yields no names.
 */
// The same response carries each model's settable options (see
// `cursorModelConfigOptionsFromListing` in `cursor-thinking.ts`).
export const CURSOR_MODEL_NAMES_METHOD = 'cursor/list_available_models';

/** Canopy names Anthropic models by family and writes `GPT 5.5`. */
export function canopyModelName(name: string): string {
  return name
    .replace(/^Claude (?=[A-Za-z])/, '')
    .replace(/^GPT-(?=\d)/, 'GPT ');
}

/** Best-effort base-slug → display-name map; malformed metadata is dropped. */
export function cursorModelNamesFromAcp(
  response: unknown,
): Map<string, string> {
  const names = new Map<string, string>();
  const models =
    typeof response === 'object' && response !== null && 'models' in response
      ? response.models
      : undefined;
  if (!Array.isArray(models) || models.length > 1000) return names;
  const entries: unknown[] = models;
  for (const model of entries) {
    if (
      typeof model !== 'object' ||
      model === null ||
      !('value' in model) ||
      !('name' in model) ||
      typeof model.value !== 'string' ||
      typeof model.name !== 'string' ||
      names.has(model.value)
    )
      continue;
    const name = model.name.trim();
    if (validLabel(name)) names.set(model.value, canopyModelName(name));
  }
  return names;
}

/** Bound and validate vendor metadata before exposing it through IPC or UI. */
export function cursorModelsFromAcp(
  configOptions: readonly SessionConfigOption[],
  names: ReadonlyMap<string, string> = new Map(),
  listing?: ReadonlyMap<string, readonly SessionConfigOption[]>,
): CursorModelEntry[] {
  const selectors = configOptions.filter((option) => option.id === 'model');
  const selector = selectors[0];
  if (selectors.length !== 1 || selector.type !== 'select')
    throw new Error('Cursor models are unavailable. Try again.');
  const models = selector.options.flatMap((option) =>
    'group' in option ? option.options : [option],
  );
  if (models.length === 0 || models.length > 1000)
    throw new Error('Cursor models are unavailable. Try again.');
  const seen = new Set<string>();
  return models.map((model) => {
    const id = toCursorModelId(model.value);
    const label = model.name.trim();
    if (!validLabel(label) || seen.has(id)) {
      throw new Error('Cursor models are unavailable. Try again.');
    }
    seen.add(id);
    const options = listing?.get(parseCursorModelVariant(model.value).base);
    const supportedThinkingLevels = options
      ? cursorThinkingLevelsFromConfigOptions(options)
      : undefined;
    if (id === 'cursor-default')
      return {
        id,
        rawModelId: model.value,
        label: 'Cursor default',
        ...(supportedThinkingLevels ? { supportedThinkingLevels } : {}),
      };
    const catalogName = names.get(cursorModelLabelParts(model.value).base);
    return {
      id,
      rawModelId: model.value,
      label,
      ...(catalogName ? { catalogName } : {}),
      ...(supportedThinkingLevels ? { supportedThinkingLevels } : {}),
    };
  });
}
