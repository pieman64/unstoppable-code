import { readFileSync } from 'node:fs';
import { AI_GATEWAY_MODEL_CATALOG_VERSION } from '../../ai-gateway-catalog-versions.mjs';

const packageConfig = JSON.parse(
  readFileSync(
    new URL('../../../../../../package.json', import.meta.url),
    'utf8',
  ),
);

// `family` is required on catalog version 2 and the client rejects the whole
// response if any model omits it, so derive it from the gateway prefix rather
// than hard-coding a value per model.
const FAMILY_BY_GATEWAY_PREFIX = {
  anthropic: 'anthropic',
  openai: 'openai',
  deepseek: 'deepseek',
  moonshotai: 'moonshot',
  minimax: 'minimax',
  zai: 'zai',
};
const FAMILY_LABELS = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  moonshot: 'Moonshot AI',
  minimax: 'MiniMax',
  zai: 'Z.ai',
};

function familyForGatewayId(gatewayId) {
  const family = FAMILY_BY_GATEWAY_PREFIX[gatewayId.split('/')[0] ?? ''];
  if (!family) {
    throw new Error(`unmapped gateway prefix in E2E fixture: ${gatewayId}`);
  }
  return family;
}

function gatewayCatalogModels(section, recommendedHarness) {
  return (section?.models ?? []).flatMap((model, index) => {
    if (typeof model.gatewayId !== 'string') return [];
    return [
      {
        id: `e2e-${recommendedHarness}-${index}`,
        gatewayId: model.gatewayId,
        label: model.label,
        family: familyForGatewayId(model.gatewayId),
        familyLabel: FAMILY_LABELS[familyForGatewayId(model.gatewayId)],
        recommendedHarness,
        contextWindow: model.contextWindow ?? 200_000,
        supportsPromptCaching: recommendedHarness === 'claude',
        requiresLocalHarnessSupport: true,
        showMoreOnly: false,
        supportedThinkingLevels: model.supportedThinkingLevels ?? [],
        toolSchemaProfile: 'standard',
      },
    ];
  });
}

// Mirror every package-owned gateway ID so normal E2E startup exercises the
// live catalog merge instead of silently making native models non-routable.
// Reading package.json keeps this fixture aligned when the model list changes.
// It serves the wire version a current server returns to this build.
export const AI_GATEWAY_MODEL_CATALOG = Object.freeze({
  version: AI_GATEWAY_MODEL_CATALOG_VERSION,
  models: Object.freeze([
    ...gatewayCatalogModels(packageConfig['claude-code'], 'claude'),
    ...gatewayCatalogModels(packageConfig.codex, 'codex'),
  ]),
});

/**
 * Returns a fresh catalog based on the mock's default. Each `add` entry
 * replaces the default entry with the same `gatewayId` in place, or is
 * appended when no default entry has it. `withoutGatewayIds` removes every
 * entry with one of those ids. The default catalog is never mutated.
 */
export function buildGatewayCatalog({ add = [], withoutGatewayIds = [] } = {}) {
  const removed = new Set(withoutGatewayIds);
  const additions = new Map(add.map((entry) => [entry.gatewayId, entry]));
  const models = [];
  for (const entry of AI_GATEWAY_MODEL_CATALOG.models) {
    if (removed.has(entry.gatewayId)) continue;
    const replacement = additions.get(entry.gatewayId);
    if (replacement) {
      models.push(cloneEntry(replacement));
      additions.delete(entry.gatewayId);
    } else {
      models.push(cloneEntry(entry));
    }
  }
  for (const entry of additions.values()) {
    models.push(cloneEntry(entry));
  }
  return { version: AI_GATEWAY_MODEL_CATALOG.version, models };
}

function cloneEntry(entry) {
  return {
    ...entry,
    supportedThinkingLevels: [...(entry.supportedThinkingLevels ?? [])],
  };
}
