import { isThinkingLevel } from '@canopy/protocol/thinking';
import type { OpenCodeModelEntry } from '../types/opencode-models';
import { isSyntacticallyValidModelId } from './model-id';

const PREFIX = 'opencode:';

export function toOpenCodeModelId(raw: string): string {
  if (!isSyntacticallyValidModelId(raw) || !/^[^/]+\/.+$/.test(raw))
    throw new Error('Invalid OpenCode model.');
  const id = `${PREFIX}${encodeURIComponent(raw)}`;
  if (!isSyntacticallyValidModelId(id))
    throw new Error('Invalid OpenCode model.');
  return id;
}

export function getRawOpenCodeModelId(id: string): string | undefined {
  if (!id.startsWith(PREFIX)) return undefined;
  try {
    const raw = decodeURIComponent(id.slice(PREFIX.length));
    return toOpenCodeModelId(raw) === id ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function isOpenCodeModel(value: unknown): value is string {
  return (
    typeof value === 'string' && getRawOpenCodeModelId(value) !== undefined
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** ACP supplies the connected providers' catalog; never invent native aliases. */
export function openCodeModelsFromConfig(value: unknown): OpenCodeModelEntry[] {
  if (!Array.isArray(value))
    throw new Error('OpenCode models are unavailable.');
  const options: unknown[] = value;
  const model = options.find((item) => isRecord(item) && item.id === 'model');
  if (
    !isRecord(model) ||
    model.type !== 'select' ||
    !Array.isArray(model.options)
  )
    throw new Error('OpenCode did not advertise a model selector.');
  const entries: unknown[] = model.options;
  const choices: unknown[] = entries.flatMap((entry): unknown[] =>
    isRecord(entry) && Array.isArray(entry.options) ? entry.options : [entry],
  );
  if (choices.length > 5000)
    throw new Error('OpenCode model catalog is too large.');
  const seen = new Set<string>();
  return choices.map((choice): OpenCodeModelEntry => {
    if (
      !isRecord(choice) ||
      typeof choice.value !== 'string' ||
      typeof choice.name !== 'string'
    )
      throw new Error('Invalid OpenCode model metadata.');
    const id = toOpenCodeModelId(choice.value);
    const label = choice.name.trim();
    if (
      !label ||
      label.length > 256 ||
      Array.from(label).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      seen.has(id)
    )
      throw new Error('Invalid OpenCode model metadata.');
    seen.add(id);
    return {
      id,
      rawModelId: choice.value,
      label,
      supportsVision: false,
      supportedThinkingLevels: [],
    };
  });
}

/** Enrich the advertised ACP choices; API metadata never introduces extra models. */
export function enrichOpenCodeModels(
  entries: readonly OpenCodeModelEntry[],
  value: unknown,
): OpenCodeModelEntry[] {
  const models = new Map<string, Record<string, unknown>>();
  if (Array.isArray(value)) {
    for (const model of value) {
      if (
        isRecord(model) &&
        typeof model.providerID === 'string' &&
        typeof model.id === 'string'
      )
        models.set(`${model.providerID}/${model.id}`, model);
    }
  }
  for (const provider of isRecord(value) && Array.isArray(value.all)
    ? value.all
    : []) {
    if (
      !isRecord(provider) ||
      typeof provider.id !== 'string' ||
      !isRecord(provider.models)
    )
      continue;
    for (const [id, model] of Object.entries(provider.models))
      if (isRecord(model)) models.set(`${provider.id}/${id}`, model);
  }
  return entries.map((entry) => {
    const model = models.get(entry.rawModelId);
    if (!model) return entry;
    const context = isRecord(model.limit) ? model.limit.context : undefined;
    const input = isRecord(model.capabilities)
      ? model.capabilities.input
      : undefined;
    const variants = Array.isArray(model.variants)
      ? model.variants.flatMap((variant) =>
          isRecord(variant) && isThinkingLevel(variant.id) ? [variant.id] : [],
        )
      : isRecord(model.variants)
        ? Object.keys(model.variants).filter(isThinkingLevel)
        : [];
    return {
      ...entry,
      ...(typeof context === 'number' &&
      Number.isSafeInteger(context) &&
      context > 0
        ? { contextWindow: context }
        : {}),
      supportsVision: Array.isArray(input)
        ? input.includes('image')
        : isRecord(input) && input.image === true,
      supportedThinkingLevels: variants,
    };
  });
}
