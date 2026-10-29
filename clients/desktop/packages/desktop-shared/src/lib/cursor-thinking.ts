import type {
  SessionConfigOption,
  SessionConfigSelectOption,
} from '@agentclientprotocol/sdk';
import {
  THINKING_LEVELS,
  clampThinkingLevelToDeclared,
  type ThinkingLevel,
} from '@canopy/protocol/thinking';

/** Option category the CLI assigns to reasoning, effort, and thinking selects. */
export const CURSOR_THOUGHT_LEVEL_CATEGORY = 'thought_level';

export interface CursorModelParameter {
  id: string;
  value: string;
}

/** A variants-mode identity split into the parameterized picker's parts. */
export interface CursorModelVariant {
  /** The parameterized picker's `model` value (`default` for Auto). */
  base: string;
  parameters: CursorModelParameter[];
}

/**
 * Interpret the ACP `[id=value,…]` suffix of an advertised variant ID. Only
 * a well-formed suffix is split; anything else stays the whole base so an
 * identity the runtime never advertised fails closed at selection time.
 */
export function parseCursorModelVariant(
  rawModelId: string,
): CursorModelVariant {
  const match = /^(.+)\[([^\[\]]*)\]$/.exec(rawModelId);
  if (!match || !match[1]) return { base: rawModelId, parameters: [] };
  const entries = match[2] ? match[2].split(',') : [];
  const parameters: CursorModelParameter[] = [];
  for (const entry of entries) {
    const pair = /^([\w-]+)=([^=,]+)$/.exec(entry);
    if (!pair || !pair[1] || !pair[2])
      return { base: rawModelId, parameters: [] };
    parameters.push({ id: pair[1], value: pair[2] });
  }
  return { base: match[1], parameters };
}

/**
 * Vendor graded values the shared levels can express. The vocabulary itself
 * lives in `@canopy/protocol/thinking`; this only names the vendor spellings
 * that map onto it. An option's own value order decides ties (`none` before
 * `minimal`), so nothing here is ordered.
 */
const GRADED_VALUES: Readonly<Record<string, ThinkingLevel>> = {
  none: 'off',
  minimal: 'off',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  'extra-high': 'xhigh',
  max: 'max',
};

function gradedLevel(value: string): ThinkingLevel | undefined {
  return Object.prototype.hasOwnProperty.call(GRADED_VALUES, value)
    ? GRADED_VALUES[value]
    : undefined;
}

interface ThoughtOption {
  id: string;
  values: string[];
  toggle: boolean;
}

function selectValues(option: SessionConfigOption): string[] {
  return option.type === 'select'
    ? option.options
        .flatMap((entry) => ('group' in entry ? entry.options : [entry]))
        .map((entry) => entry.value)
    : [];
}

function thoughtOptions(
  options: readonly SessionConfigOption[],
): ThoughtOption[] {
  return options
    .filter(
      (option) =>
        option.category === CURSOR_THOUGHT_LEVEL_CATEGORY &&
        option.type === 'select',
    )
    .map((option) => {
      const values = selectValues(option);
      const set = new Set(values);
      return {
        id: option.id,
        values,
        toggle: set.size === 2 && set.has('false') && set.has('true'),
      };
    });
}

/** The "on" level a lone thinking toggle exposes; every non-off level maps to it. */
const TOGGLE_ON_LEVEL: ThinkingLevel = 'medium';

/**
 * Project a model's `thought_level` options onto the shared levels, in
 * canonical ascending order. Exact per model: an empty result means the
 * model exposes no thinking control and the composer hides it.
 */
export function cursorThinkingLevelsFromConfigOptions(
  options: readonly SessionConfigOption[],
): ThinkingLevel[] {
  const thought = thoughtOptions(options);
  const graded = thought.filter((option) => !option.toggle);
  const levels = new Set<ThinkingLevel>();
  for (const option of graded)
    for (const value of option.values) {
      const level = gradedLevel(value);
      if (level) levels.add(level);
    }
  if (thought.some((option) => option.toggle)) {
    levels.add('off');
    if (graded.length === 0) levels.add(TOGGLE_ON_LEVEL);
  }
  return THINKING_LEVELS.filter((level) => levels.has(level));
}

/** Values a select option offers, or `undefined` when the option is absent. */
export function cursorConfigOptionValues(
  options: readonly SessionConfigOption[],
  id: string,
): string[] | undefined {
  const option = options.find((entry) => entry.id === id);
  return option && option.type === 'select' ? selectValues(option) : undefined;
}

/** A select option's acknowledged value, or `undefined` when absent. */
export function cursorConfigOptionValue(
  options: readonly SessionConfigOption[],
  id: string,
): string | undefined {
  const option = options.find((entry) => entry.id === id);
  return option && option.type === 'select'
    ? String(option.currentValue)
    : undefined;
}

export interface CursorConfigSet {
  configId: string;
  value: string;
}

export interface CursorThinkingPlan {
  /** The declared level the runtime will run at after `sets` apply. */
  applied: ThinkingLevel;
  /** Option values to set, in order; a set may already hold. */
  sets: CursorConfigSet[];
}

/**
 * Resolve a requested level against a selected model's options. `undefined`
 * when the model declares no thinking control at all.
 */
export function planCursorThinking(
  options: readonly SessionConfigOption[],
  level: ThinkingLevel,
): CursorThinkingPlan | undefined {
  const declared = cursorThinkingLevelsFromConfigOptions(options);
  if (declared.length === 0) return undefined;
  const applied = clampThinkingLevelToDeclared(level, declared);
  const thought = thoughtOptions(options);
  const toggles = thought.filter((option) => option.toggle);
  const graded = thought.filter((option) => !option.toggle);
  const sets: CursorConfigSet[] = toggles.map((option) => ({
    configId: option.id,
    value: applied === 'off' ? 'false' : 'true',
  }));
  // A toggle turns thinking off by itself; the graded effort keeps its value
  // for the next time thinking is on. Without a toggle, "off" is the weakest
  // graded value the model offers.
  if (applied !== 'off' || toggles.length === 0)
    for (const option of graded) {
      const value = option.values.find((raw) => gradedLevel(raw) === applied);
      if (value !== undefined) sets.push({ configId: option.id, value });
    }
  return { applied, sets };
}

function isSelectOption(value: unknown): value is SessionConfigSelectOption {
  return (
    typeof value === 'object' &&
    value !== null &&
    'value' in value &&
    typeof value.value === 'string' &&
    'name' in value &&
    typeof value.name === 'string'
  );
}

function isOptionGroup(value: unknown): value is { options: unknown[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'group' in value &&
    'options' in value &&
    Array.isArray(value.options)
  );
}

function selectConfigOption(value: unknown): SessionConfigOption | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (!('type' in value) || value.type !== 'select') return undefined;
  if (!('id' in value) || typeof value.id !== 'string') throw invalidListing();
  if (!('name' in value) || typeof value.name !== 'string')
    throw invalidListing();
  if (!('currentValue' in value) || typeof value.currentValue !== 'string')
    throw invalidListing();
  if (!('options' in value) || !Array.isArray(value.options))
    throw invalidListing();
  // Grouped options (`{ group, name, options }`) are flattened: a turn sets
  // and verifies values, never groups, and `selectValues` reads the same shape.
  const options: SessionConfigSelectOption[] = [];
  const entries: unknown[] = value.options;
  for (const entry of entries) {
    const members: unknown[] = isOptionGroup(entry) ? entry.options : [entry];
    for (const member of members) {
      if (!isSelectOption(member)) throw invalidListing();
      options.push({ value: member.value, name: member.name });
    }
  }
  const category =
    'category' in value && typeof value.category === 'string'
      ? value.category
      : undefined;
  return {
    id: value.id,
    name: value.name,
    type: 'select',
    currentValue: value.currentValue,
    options,
    ...(category !== undefined ? { category } : {}),
  };
}

function invalidListing(): Error {
  return new Error('Cursor model options are unavailable. Try again.');
}

/**
 * Validate a `cursor/list_available_models` result into base model ID →
 * settable options. Only select options survive: they are the ones a turn
 * can apply through `session/set_config_option`. A response without a model
 * list is rejected; a malformed row (or a duplicate) is skipped so one odd
 * model leaves only its own support unknown, and the list is bounded like
 * the names parser that reads the same response.
 */
export function cursorModelConfigOptionsFromListing(
  result: unknown,
): Map<string, SessionConfigOption[]> {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('models' in result) ||
    !Array.isArray(result.models)
  )
    throw invalidListing();
  const listing = new Map<string, SessionConfigOption[]>();
  const models: unknown[] = result.models;
  if (models.length > 1000) return listing;
  for (const model of models) {
    if (
      typeof model !== 'object' ||
      model === null ||
      !('value' in model) ||
      typeof model.value !== 'string' ||
      !('configOptions' in model) ||
      !Array.isArray(model.configOptions) ||
      listing.has(model.value)
    )
      continue;
    const entries: unknown[] = model.configOptions;
    const options: SessionConfigOption[] = [];
    try {
      for (const entry of entries) {
        const option = selectConfigOption(entry);
        if (option) options.push(option);
      }
    } catch {
      continue;
    }
    listing.set(model.value, options);
  }
  return listing;
}
