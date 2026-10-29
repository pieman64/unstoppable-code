import { initClaudeModels } from '@canopy/desktop-shared/types';
const mockList = jest.fn();
let mockRevision = 1;
let mockEnabled = true;
jest.mock('../agents/agent-model-store', () => ({
  listAgentModels: (): unknown => mockList(),
}));
jest.mock('../agents/resource-lanes', () => ({
  agentResourceContextEnabled: (): boolean => mockEnabled,
  agentContextSnapshot: (): Promise<string> =>
    Promise.resolve(JSON.stringify([1, mockRevision, { kind: 'personal' }])),
  assertAgentContextSnapshot: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): {
    accountEpoch: () => number;
    getState: () => { revision: number; context: { kind: string } };
  } => ({
    accountEpoch: (): number => 1,
    getState: (): { revision: number; context: { kind: string } } => ({
      revision: mockRevision,
      context: { kind: 'personal' },
    }),
  }),
}));
jest.mock('../ollama', () => ({
  getOllamaService: (): { getCachedModels: () => [] } => ({
    getCachedModels: (): [] => [],
  }),
}));
import { refreshAgentModelsFromStore } from '../lib/agent-models';
import { getSynchronousModelRegistrySnapshot } from '../models/model-registry';

it('never returns a previous context agent from the synchronous model picker cache', async () => {
  initClaudeModels([{ id: 'sonnet', label: 'Sonnet' }]);
  mockList.mockResolvedValue([
    {
      id: 'agent_model_org',
      name: 'Org agent',
      baseModel: 'sonnet',
      instructions: 'secret',
      pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      createdAt: '',
      updatedAt: '',
    },
  ]);
  await refreshAgentModelsFromStore();
  expect(getSynchronousModelRegistrySnapshot().agents).toHaveLength(1);
  mockRevision += 1;
  expect(getSynchronousModelRegistrySnapshot().agents).toEqual([]);
  mockList.mockResolvedValue([]);
  await refreshAgentModelsFromStore();
  expect(getSynchronousModelRegistrySnapshot().agents).toEqual([]);
});
it('preserves the flag-off model cache across context revisions', async () => {
  mockEnabled = false;
  mockList.mockResolvedValue([
    {
      id: 'agent_model_local',
      name: 'Local',
      baseModel: 'sonnet',
      instructions: '',
      pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      createdAt: '',
      updatedAt: '',
    },
  ]);
  await refreshAgentModelsFromStore();
  mockRevision += 1;
  expect(getSynchronousModelRegistrySnapshot().agents).toHaveLength(1);
});
