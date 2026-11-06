import { z } from 'zod';
import {
  MODEL_GATEWAY_MAX_ID_LENGTH,
  MODEL_GATEWAY_MAX_LABEL_LENGTH,
  MODEL_GATEWAY_MAX_MODELS,
  normalizeModelGatewayBaseUrl,
  type ModelGatewayModel,
} from '../canopy-server';

export const discoveredGatewayModelSchema = z.strictObject({
  id: z.string().min(1).max(MODEL_GATEWAY_MAX_ID_LENGTH),
  label: z.string().min(1).max(MODEL_GATEWAY_MAX_LABEL_LENGTH),
  contextWindow: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  anthropic: z.boolean(),
});
export type DiscoveredGatewayModel = z.output<
  typeof discoveredGatewayModelSchema
>;
export const aiGatewayConnectionResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('connected'),
    baseUrl: z.string(),
    models: z.array(discoveredGatewayModelSchema).max(MODEL_GATEWAY_MAX_MODELS),
  }),
  z.strictObject({
    status: z.enum([
      'unauthorized',
      'unreachable',
      'invalid_url',
      'key_required',
    ]),
  }),
]);
export type AiGatewayConnectionResult = z.output<
  typeof aiGatewayConnectionResultSchema
>;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function bounded(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' && value.trim().length > 0 && value.length <= max
  );
}

/** Provider metadata is untrusted data, never markup or agent instructions. */
export function parseGatewayModelList(
  value: unknown,
): DiscoveredGatewayModel[] {
  if (!record(value)) return [];
  const rows: unknown[] = Array.isArray(value.data)
    ? value.data
    : Array.isArray(value.models)
      ? value.models
      : [];
  const models: DiscoveredGatewayModel[] = [];
  const ids = new Set<string>();
  for (const row of rows) {
    if (!record(row)) continue;
    const info = record(row.model_info) ? row.model_info : {};
    const id = row.id ?? row.model_name ?? row.name;
    if (!bounded(id, MODEL_GATEWAY_MAX_ID_LENGTH) || ids.has(id)) continue;
    const label = row.display_name ?? row.name ?? row.model_name ?? id;
    if (!bounded(label, MODEL_GATEWAY_MAX_LABEL_LENGTH)) continue;
    const rawContext =
      row.context_window ??
      row.context_length ??
      info.max_input_tokens ??
      info.max_tokens;
    const contextWindow =
      typeof rawContext === 'number' &&
      Number.isSafeInteger(rawContext) &&
      rawContext > 0
        ? rawContext
        : undefined;
    ids.add(id);
    models.push({
      id,
      label,
      contextWindow,
      anthropic:
        (row.type === 'model' && typeof row.display_name === 'string') ||
        /(^|[/.-])claude/i.test(id),
    });
    if (models.length === MODEL_GATEWAY_MAX_MODELS) break;
  }
  return models;
}

/** Preserve a configured model's ID and overrides when rediscovered. */
export function suggestGatewayModel(
  discovered: DiscoveredGatewayModel,
  existing: readonly ModelGatewayModel[],
  ownerId: string,
): ModelGatewayModel {
  const configured = existing.find(
    (model) => model.gatewayId === discovered.id,
  );
  if (configured) return configured;
  const slug =
    discovered.label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'model';
  const prefix = `${ownerId}-`;
  const stem = `${prefix}${slug}`.slice(0, MODEL_GATEWAY_MAX_ID_LENGTH);
  const ids = new Set(existing.map((model) => model.id));
  const labels = new Set(existing.map((model) => model.label.toLowerCase()));
  let id = stem;
  let label = discovered.label;
  for (
    let suffix = 2;
    ids.has(id) || labels.has(label.toLowerCase());
    suffix++
  ) {
    const ending = `-${suffix}`;
    id = stem.slice(0, MODEL_GATEWAY_MAX_ID_LENGTH - ending.length) + ending;
    label =
      discovered.label.slice(
        0,
        MODEL_GATEWAY_MAX_LABEL_LENGTH - ending.length,
      ) + ending;
  }
  const harness =
    discovered.anthropic || /claude/i.test(discovered.id) ? 'claude' : 'codex';
  return {
    id,
    gatewayId: discovered.id,
    label,
    harness,
    contextWindow:
      discovered.contextWindow !== undefined &&
      Number.isSafeInteger(discovered.contextWindow) &&
      discovered.contextWindow > 0
        ? discovered.contextWindow
        : 200_000,
    supportedThinkingLevels:
      harness === 'claude'
        ? ['off', 'low', 'medium', 'high']
        : ['off', 'low', 'medium', 'high', 'xhigh'],
    toolSchemaProfile: 'standard',
  };
}
export function gatewayHostname(baseUrl: string): string {
  const normalized = normalizeModelGatewayBaseUrl(baseUrl);
  return normalized === null ? '' : new URL(normalized).hostname;
}
