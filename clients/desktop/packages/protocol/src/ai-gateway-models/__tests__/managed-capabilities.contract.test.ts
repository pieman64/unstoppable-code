import { parseAiGatewayModelCatalogResponse } from '../index';
import { parseAutoModelRoutingRequestV1 } from '../../model-routing';

const model = {
  id: 'fixture',
  gatewayId: 'fixture/model',
  label: 'Fixture',
  family: 'fixture',
  familyLabel: 'Fixture',
  recommendedHarness: 'codex',
  contextWindow: 100000,
  supportsPromptCaching: false,
  requiresLocalHarnessSupport: false,
  showMoreOnly: false,
  supportedThinkingLevels: [],
  toolSchemaProfile: 'flat',
};
const request = {
  schemaVersion: 1,
  requestId: 'fixture',
  surface: 'desktop',
  fallbackModelId: 'fixture/model',
  executionLane: 'ai_credits',
  capturedHarness: 'opencode',
  candidates: [
    {
      modelId: 'fixture/model',
      label: 'Fixture',
      description: 'Fixture',
      harness: 'opencode',
      executionLane: 'ai_credits',
    },
  ],
  state: {
    prompt: 'Fixture',
    recentMessages: [],
    attachmentCounts: { files: 0, images: 0, documents: 0 },
    mode: { task: 'execute', fast: false, workspace: 'cowork' },
  },
};

it('preserves explicit v10 image capability and defaults older catalogs to unsupported', () => {
  expect(
    parseAiGatewayModelCatalogResponse({
      version: 10,
      models: [{ ...model, supportsImages: true }],
    }).models[0]?.supportsImages,
  ).toBe(true);
  for (const version of [6, 7, 8, 9])
    expect(
      parseAiGatewayModelCatalogResponse({ version, models: [model] }).models[0]
        ?.supportsImages ?? false,
    ).toBe(false);
  expect(() =>
    parseAiGatewayModelCatalogResponse({
      version: 9,
      models: [{ ...model, supportsImages: true }],
    }),
  ).toThrow();
  expect(() =>
    parseAiGatewayModelCatalogResponse({
      version: 10,
      models: [{ ...model, supportsImages: 'yes' }],
    }),
  ).toThrow();
});
it('admits captured desktop managed OpenCode Auto and refuses other billing and execution scopes', () => {
  expect(parseAutoModelRoutingRequestV1(request).capturedHarness).toBe(
    'opencode',
  );
  expect(() =>
    parseAutoModelRoutingRequestV1({ ...request, surface: 'cloud' }),
  ).toThrow();
  expect(() =>
    parseAutoModelRoutingRequestV1({ ...request, capturedHarness: undefined }),
  ).toThrow();
  expect(() =>
    parseAutoModelRoutingRequestV1({
      ...request,
      executionLane: 'provider_subscription',
      candidates: request.candidates.map((candidate) => ({
        ...candidate,
        executionLane: 'provider_subscription',
      })),
    }),
  ).toThrow();
  expect(() =>
    parseAutoModelRoutingRequestV1({
      ...request,
      candidates: request.candidates.map((candidate) => ({
        ...candidate,
        harness: 'codex',
      })),
    }),
  ).toThrow();
});
