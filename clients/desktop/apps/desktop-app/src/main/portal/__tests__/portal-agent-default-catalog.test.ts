/**
 * A loaded Portal catalog's Default-model Agent row follows a Settings change
 * (CAN-3999): the real catalog default resolver and the real projection, with
 * only the lane resolution, policy and Portal bus stubbed.
 */
import type { ModelCatalogOption } from '@canopy/protocol/models';
import type * as ModelPolicyModule from '@canopy/desktop-shared/lib/model-policy';
import {
  initAgentModels,
  initClaudeModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import {
  refreshCatalogAgentDefaults,
  resetCatalogAgentDefaultModelsForTests,
  resolveCatalogAgentDefaultModel,
} from '../../agents/agent-default-model';
import { requireLaneAwareDefaultSelection } from '../../lib/default-model-lane-resolver';
import { buildProjectedModelCatalog } from '../model-catalog-projection';

jest.mock('../../lib/default-model-lane-resolver', () => ({
  requireLaneAwareDefaultSelection: jest.fn(),
  resolveAppAdvisorDefaultModel: jest.fn(),
  getLastProjectedDefaultModel: (): undefined => undefined,
}));
jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<object> => Promise.resolve({}),
}));
jest.mock('../../lib/workspace-registry', () => ({
  isCoworkWorkspace: (): boolean => false,
}));
const mockBlockedModels = new Set<string>();
// The shared policy check, so a route is judged by its unwrapped base model.
jest.mock('../../lib/model-policy-state', () => ({
  isModelBlockedByCurrentPolicy: (modelId: string | undefined): boolean =>
    jest
      .requireActual<
        typeof ModelPolicyModule
      >('@canopy/desktop-shared/lib/model-policy')
      .isModelBlocked(modelId, mockBlockedModels),
}));
jest.mock('../../lib/model-gateway-state', () => ({
  isModelExcludedByCurrentGatewayRequirement: (): boolean => false,
}));
jest.mock('../../cursor/feature-flag', () => ({
  isCursorHarnessEnabled: (): boolean => false,
}));
const mockNotifyCatalogChanged = jest.fn<Promise<void>, []>(() =>
  Promise.resolve(),
);
jest.mock('../portal-event-bus', () => ({
  notifyPortalModelCatalogChanged: (): Promise<void> =>
    mockNotifyCatalogChanged(),
}));

const mockLaneDefault = jest.mocked(requireLaneAwareDefaultSelection);

function laneDefault(
  model: string,
): Awaited<ReturnType<typeof requireLaneAwareDefaultSelection>> {
  return { model, thinkingLevel: 'high' };
}

async function projectedAgentRow(): Promise<ModelCatalogOption | undefined> {
  return buildProjectedModelCatalog(undefined, {
    agentDefaultModel: await resolveCatalogAgentDefaultModel('workspace-1'),
  }).find((option) => option.id === 'agent_model_inherit');
}

beforeAll(() => {
  initClaudeModels([{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }]);
  initCodexModels([{ id: 'gpt-5.5', label: 'GPT-5.5' }]);
});

beforeEach(() => {
  jest.clearAllMocks();
  mockBlockedModels.clear();
  resetCatalogAgentDefaultModelsForTests();
  initAgentModels([
    {
      id: 'agent_model_inherit',
      name: 'Inherit',
      baseModel: 'default',
      instructions: '',
      pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      createdAt: '2026-10-14T00:00:00.000Z',
      updatedAt: '2026-10-14T00:00:00.000Z',
      available: true,
    },
  ]);
});

afterEach(() => {
  initAgentModels([]);
});

it('re-projects the Agent row onto the new default after a default-model setting changes', async () => {
  mockLaneDefault.mockResolvedValue(laneDefault('gpt-5.5'));
  await expect(projectedAgentRow()).resolves.toMatchObject({
    provider: 'codex',
    harness: 'codex',
    available: true,
  });

  mockLaneDefault.mockResolvedValue(laneDefault('claude-sonnet-4-6'));
  await refreshCatalogAgentDefaults({ defaultWorktreeProvider: 'claude' });

  expect(mockNotifyCatalogChanged).toHaveBeenCalledTimes(1);
  await expect(projectedAgentRow()).resolves.toMatchObject({
    provider: 'claude',
    harness: 'claude',
    available: true,
  });
});

it('marks the Agent row unavailable once the new default is one it cannot run on', async () => {
  mockLaneDefault.mockResolvedValue(laneDefault('gpt-5.5'));
  await expect(projectedAgentRow()).resolves.toMatchObject({
    available: true,
  });

  mockLaneDefault.mockResolvedValue(laneDefault('removed-model'));
  await refreshCatalogAgentDefaults({
    defaultWorktreeModelByProvider: {
      claude: laneDefault('claude-sonnet-4-6'),
      codex: laneDefault('removed-model'),
      ollama: null,
    },
  });

  await expect(projectedAgentRow()).resolves.toMatchObject({
    available: false,
  });
});

it('leaves the Agent row out when organization policy blocks the default it would run on', async () => {
  mockLaneDefault.mockResolvedValue(laneDefault('gpt-5.5'));
  mockBlockedModels.add('gpt-5.5');

  await expect(projectedAgentRow()).resolves.toBeUndefined();
});

it('keeps the Agent row when policy blocks a model other than the default', async () => {
  mockLaneDefault.mockResolvedValue(laneDefault('gpt-5.5'));
  mockBlockedModels.add('claude-sonnet-4-6');

  await expect(projectedAgentRow()).resolves.toMatchObject({
    provider: 'codex',
    available: true,
  });
});
