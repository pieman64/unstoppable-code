import {
  copilotModelsFromSdk,
  getRawCopilotModelId,
  isCopilotModel,
  toCopilotModelId,
} from '../lib/copilot-models';

const model = {
  id: 'claude-sonnet-4.5',
  name: 'Claude Sonnet 4.5',
  capabilities: {
    supports: { vision: true, reasoningEffort: true },
    limits: { max_context_window_tokens: 200_000 },
  },
  policy: { state: 'enabled', terms: '' },
  supportedReasoningEfforts: ['none', 'low', 'medium', 'high'],
};

describe('Copilot account model projection', () => {
  it.each([undefined, null, {}, { state: 'unknown' }, { state: true }])(
    'excludes models without an explicitly enabled policy: %p',
    (policy) =>
      expect(copilotModelsFromSdk([{ ...model, policy }])).toEqual([]),
  );
  it.each(['claude-sonnet-4.5', 'gpt-5.4', 'vendor/model+variant', 'auto'])(
    'keeps the runtime identity opaque and distinct: %s',
    (raw) => {
      const persisted = toCopilotModelId(raw);
      expect(persisted).toBe(`copilot:${encodeURIComponent(raw)}`);
      expect(isCopilotModel(persisted)).toBe(true);
      expect(getRawCopilotModelId(persisted)).toBe(raw);
      expect(isCopilotModel(raw)).toBe(false);
    },
  );

  it.each([
    '',
    'copilot:',
    'copilot:%zz',
    'copilot:%61uto',
    'copilot:a b',
    'cursor-default',
  ])('rejects malformed or noncanonical stored identities: %s', (id) =>
    expect(getRawCopilotModelId(id)).toBeUndefined(),
  );

  it('projects only advertised capabilities and excludes disabled account models', () => {
    expect(
      copilotModelsFromSdk([
        model,
        { ...model, id: 'disabled', policy: { state: 'disabled', terms: '' } },
        { ...model, id: 'plain', supportedReasoningEfforts: undefined },
      ]),
    ).toEqual([
      {
        id: 'copilot:claude-sonnet-4.5',
        rawModelId: model.id,
        label: model.name,
        contextWindow: 200_000,
        supportsVision: true,
        supportedThinkingLevels: ['off', 'low', 'medium', 'high'],
      },
      {
        id: 'copilot:plain',
        rawModelId: 'plain',
        label: model.name,
        contextWindow: 200_000,
        supportsVision: true,
        supportedThinkingLevels: [],
      },
    ]);
  });

  it('does not invent reasoning capabilities or token prices', () => {
    const [entry] = copilotModelsFromSdk([
      {
        ...model,
        supportedReasoningEfforts: ['minimal', 'high', 'future-effort'],
        billing: { multiplier: 3 },
      },
    ]);
    expect(entry.supportedThinkingLevels).toEqual(['high']);
    expect(entry).not.toHaveProperty('costPerInputToken');
  });

  it.each([
    null,
    {},
    [model, model],
    [{ ...model, name: 'bad\u0000label' }],
    [{ ...model, id: 'bad id' }],
  ])('refuses an invalid catalog instead of substituting a default', (value) =>
    expect(() => copilotModelsFromSdk(value)).toThrow(),
  );
});
