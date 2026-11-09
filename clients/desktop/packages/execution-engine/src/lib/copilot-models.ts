import { THINKING_LEVELS } from '@canopy/protocol/thinking';
import type { CopilotModelEntry } from '../types/copilot-models';
import { isSyntacticallyValidModelId } from './model-id';

const PREFIX = 'copilot:';

/** Never merge account-billed identities with native or gateway identities. */
export function toCopilotModelId(raw: string): string {
  if (!isSyntacticallyValidModelId(raw))
    throw new Error('Invalid Copilot model.');
  const id = `${PREFIX}${encodeURIComponent(raw)}`;
  if (!isSyntacticallyValidModelId(id))
    throw new Error('Invalid Copilot model.');
  return id;
}

export function getRawCopilotModelId(id: string): string | undefined {
  if (!id.startsWith(PREFIX)) return undefined;
  try {
    const raw = decodeURIComponent(id.slice(PREFIX.length));
    return toCopilotModelId(raw) === id ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function isCopilotModel(value: unknown): value is string {
  return typeof value === 'string' && getRawCopilotModelId(value) !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Validate vendor metadata at the boundary; no SDK import in browser code. */
export function copilotModelsFromSdk(value: unknown): CopilotModelEntry[] {
  if (!Array.isArray(value) || value.length > 1000)
    throw new Error('Copilot models are unavailable. Try connecting again.');
  const seen = new Set<string>();
  const models: CopilotModelEntry[] = [];
  const candidates: unknown[] = value;
  for (const candidate of candidates) {
    const model = record(candidate);
    if (typeof model.id !== 'string' || typeof model.name !== 'string')
      throw new Error('Invalid Copilot model metadata.');
    const id = toCopilotModelId(model.id);
    const label = model.name.trim();
    if (
      !label ||
      label.length > 256 ||
      Array.from(label).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      seen.has(id)
    )
      throw new Error('Invalid Copilot model metadata.');
    seen.add(id);
    if (record(model.policy).state !== 'enabled') continue;
    const capabilities = record(model.capabilities);
    const supports = record(capabilities.supports);
    const contextWindow = record(capabilities.limits).max_context_window_tokens;
    const efforts: unknown[] =
      supports.reasoningEffort === true &&
      Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts
        : [];
    models.push({
      id,
      rawModelId: model.id,
      label,
      ...(typeof contextWindow === 'number' &&
      Number.isSafeInteger(contextWindow) &&
      contextWindow > 0
        ? { contextWindow }
        : {}),
      supportsVision: supports.vision === true,
      supportedThinkingLevels: THINKING_LEVELS.filter((level) =>
        efforts.includes(level === 'off' ? 'none' : level),
      ),
    });
  }
  return models;
}
