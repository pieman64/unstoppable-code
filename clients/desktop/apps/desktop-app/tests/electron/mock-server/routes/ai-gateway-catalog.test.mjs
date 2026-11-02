import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AI_GATEWAY_MODEL_CATALOG,
  buildGatewayCatalog,
} from './ai-gateway-catalog.mjs';

const DEEPSEEK_ENTRY = {
  id: 'deepseek-v4-pro',
  gatewayId: 'deepseek/deepseek-v4-pro',
  label: 'DeepSeek V4 Pro',
  family: 'deepseek',
  familyLabel: 'DeepSeek',
  recommendedHarness: 'codex',
  contextWindow: 128_000,
  supportsPromptCaching: false,
  requiresLocalHarnessSupport: true,
  showMoreOnly: false,
  supportedThinkingLevels: [],
  toolSchemaProfile: 'standard',
};

function snapshot() {
  return JSON.parse(JSON.stringify(AI_GATEWAY_MODEL_CATALOG));
}

test('builds the default catalog when no options are given', () => {
  assert.deepEqual(buildGatewayCatalog(), snapshot());
  assert.ok(AI_GATEWAY_MODEL_CATALOG.models.length > 0);
});

test('appends an added entry with a new gateway id', () => {
  const catalog = buildGatewayCatalog({ add: [DEEPSEEK_ENTRY] });

  assert.equal(catalog.version, AI_GATEWAY_MODEL_CATALOG.version);
  assert.equal(
    catalog.models.length,
    AI_GATEWAY_MODEL_CATALOG.models.length + 1,
  );
  assert.deepEqual(catalog.models.at(-1), DEEPSEEK_ENTRY);
});

test('replaces a default entry that shares the gateway id, in place', () => {
  const target = AI_GATEWAY_MODEL_CATALOG.models[0];
  const replacement = { ...target, id: 'replaced', label: 'Replaced label' };

  const catalog = buildGatewayCatalog({ add: [replacement] });

  assert.equal(catalog.models.length, AI_GATEWAY_MODEL_CATALOG.models.length);
  assert.deepEqual(
    catalog.models.map((entry) => entry.gatewayId),
    AI_GATEWAY_MODEL_CATALOG.models.map((entry) => entry.gatewayId),
  );
  assert.equal(catalog.models[0].id, 'replaced');
  assert.equal(catalog.models[0].label, 'Replaced label');
});

test('removes every entry whose gateway id is excluded', () => {
  const removedId = AI_GATEWAY_MODEL_CATALOG.models[0].gatewayId;

  const catalog = buildGatewayCatalog({ withoutGatewayIds: [removedId] });

  assert.ok(catalog.models.every((entry) => entry.gatewayId !== removedId));
  assert.equal(
    catalog.models.length,
    AI_GATEWAY_MODEL_CATALOG.models.filter(
      (entry) => entry.gatewayId !== removedId,
    ).length,
  );
});

test('never mutates the default catalog', () => {
  const before = snapshot();

  const catalog = buildGatewayCatalog({
    add: [DEEPSEEK_ENTRY, { ...AI_GATEWAY_MODEL_CATALOG.models[0], id: 'x' }],
    withoutGatewayIds: [AI_GATEWAY_MODEL_CATALOG.models.at(-1).gatewayId],
  });
  catalog.models[0].label = 'changed';
  catalog.models[1].supportedThinkingLevels.push('high');

  assert.deepEqual(snapshot(), before);
  assert.notEqual(catalog.models, AI_GATEWAY_MODEL_CATALOG.models);
});

test('the default catalog has no DeepSeek entry (CAN-5022)', () => {
  // Adding DeepSeek by default would change the credits default model in
  // every spec. Specs that need it seed main's catalog cache instead.
  assert.ok(
    AI_GATEWAY_MODEL_CATALOG.models.every(
      (entry) => !entry.gatewayId.startsWith('deepseek/'),
    ),
  );
});
