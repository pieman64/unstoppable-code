import { discoverDelegationModels } from '../discovery';
import { normalizeManagedDelegationMode } from '@canopy/protocol/delegation/discovery';
it('discovers arbitrary harness modes without exposing private route fields or recommending unavailable models', async () => {
  const result = await discoverDelegationModels({
    modelIds: ['small', 'remote', 'small'],
    preferredModelId: 'remote',
    inspect: (id) =>
      Promise.resolve({
        modelId: id,
        label: id,
        harnessId: 'third-harness',
        runtimeKind: id === 'small' ? 'local' : 'remote',
        supportedThinkingLevels: id === 'small' ? ['low'] : ['high'],
        capabilities: ['read'],
        availability: id === 'small' ? 'available' : 'unavailable',
        authState: id === 'small' ? 'ready' : 'required',
        ...(id === 'remote' ? { disabledReason: 'Sign in first' } : {}),
        authAccountKey: 'secret',
      }),
  });
  expect(result.recommendedModelId).toBe('small');
  expect(result.models).toHaveLength(2);
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(result.models[1]).toMatchObject({
    runtimeKind: 'remote',
    supportedThinkingLevels: ['high'],
    disabledReason: 'Sign in first',
  });
});
it('reserves bounded discovery capacity for the preferred model', async () => {
  const modelIds = Array.from({ length: 101 }, (_, index) => `model-${index}`);
  const preferredModelId = modelIds[100];
  const result = await discoverDelegationModels({
    modelIds,
    preferredModelId,
    inspect: (id) =>
      Promise.resolve({
        modelId: id,
        label: id,
        harnessId: 'third-harness',
        runtimeKind: 'remote',
        supportedThinkingLevels: [],
        capabilities: ['read'],
        availability: 'available',
        authState: 'ready',
      }),
  });

  expect(result.models).toHaveLength(96);
  expect(
    result.models.some((model) => model.modelId === preferredModelId),
  ).toBe(true);
  expect(result.recommendedModelId).toBe(preferredModelId);
  expect(result.truncated).toBe(true);
});
it('fails closed for unknown persisted modes', () => {
  for (const value of [null, true, 'yes', 'automatic', undefined])
    expect(normalizeManagedDelegationMode(value)).toBe('off');
  expect(normalizeManagedDelegationMode('explicit-only')).toBe('explicit-only');
  expect(normalizeManagedDelegationMode('proactive')).toBe('proactive');
});
