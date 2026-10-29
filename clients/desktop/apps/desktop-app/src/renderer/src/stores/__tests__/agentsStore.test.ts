/** @jest-environment jsdom */
import type { AgentModelDefinition } from '@canopy/desktop-shared/types/agent-models';
import {
  getDefaultFeatureFlagSnapshot,
  CLIENT_FEATURE_FLAGS,
} from '@canopy/protocol/feature-flags';
import { useAgentsStore } from '../agentsStore';
import { useFeatureFlagsStore } from '../featureFlagsStore';
import { useWorkspaceContextStore } from '../workspaceContextStore';

const agent: AgentModelDefinition = {
  id: 'agent_model_reviewer',
  name: 'Reviewer',
  baseModel: 'sonnet',
  instructions: 'Review changes.',
  pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
};
const list = jest.fn();
const save = jest.fn();
const remove = jest.fn();
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(window, 'agents', {
    configurable: true,
    value: { list, save, delete: remove },
  });
  const base = getDefaultFeatureFlagSnapshot();
  useFeatureFlagsStore.setState({
    snapshot: {
      ...base,
      values: {
        ...base.values,
        [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
      },
    },
  });
  useWorkspaceContextStore.setState({ appliedGeneration: 1 });
  useAgentsStore.setState({
    agents: [agent],
    loaded: true,
    loading: false,
    error: null,
    inventoryGeneration: 1,
    inventoryComplete: false,
  });
});
afterEach(() => {
  useFeatureFlagsStore.setState({ snapshot: getDefaultFeatureFlagSnapshot() });
});

it('keeps a successful canonical save visible when inventory refresh fails', async () => {
  const saved = { ...agent, id: 'agent_model_new', name: 'New agent' };
  save.mockResolvedValue(saved);
  list.mockRejectedValue(new Error('Refresh failed'));
  await expect(
    useAgentsStore.getState().save({
      name: saved.name,
      baseModel: saved.baseModel,
      instructions: saved.instructions,
      pluginSelections: saved.pluginSelections,
    }),
  ).resolves.toEqual(saved);
  expect(useAgentsStore.getState().agents).toContainEqual(saved);
  expect(useAgentsStore.getState().error).toContain('Refresh failed');
});

it('retains same-context definitions while refreshing and on refresh failure', async () => {
  const response = deferred<{ agents: AgentModelDefinition[] }>();
  list.mockReturnValue(response.promise);
  const pending = useAgentsStore.getState().load();
  expect(useAgentsStore.getState().agents).toEqual([agent]);
  response.resolve({ agents: [agent] });
  await pending;
});

it('discards an older response in the same context', async () => {
  const older = deferred<{ agents: AgentModelDefinition[] }>();
  const newer = deferred<{ agents: AgentModelDefinition[] }>();
  list.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const first = useAgentsStore.getState().load();
  const second = useAgentsStore.getState().load();
  newer.resolve({ agents: [{ ...agent, name: 'Latest' }] });
  await second;
  older.resolve({ agents: [agent] });
  await first;
  expect(useAgentsStore.getState().agents[0]?.name).toBe('Latest');
});

it('resets settled inventory state on a context switch and discards old responses', async () => {
  const older = deferred<{ agents: AgentModelDefinition[] }>();
  const newer = deferred<{ agents: AgentModelDefinition[] }>();
  list.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const first = useAgentsStore.getState().load();
  useWorkspaceContextStore.setState({ appliedGeneration: 2 });
  const second = useAgentsStore.getState().load();
  expect(useAgentsStore.getState().agents).toEqual([]);
  expect(useAgentsStore.getState().loaded).toBe(false);
  newer.resolve({ agents: [] });
  await second;
  older.resolve({ agents: [agent] });
  await first;
  expect(useAgentsStore.getState().agents).toEqual([]);
});

it('does not publish a save response into a different context', async () => {
  const response = deferred<AgentModelDefinition>();
  save.mockReturnValue(response.promise);
  list.mockResolvedValue({ agents: [] });
  const pending = useAgentsStore.getState().save({
    id: agent.id,
    name: 'Edited',
    baseModel: agent.baseModel,
    instructions: agent.instructions,
    pluginSelections: agent.pluginSelections,
  });
  useWorkspaceContextStore.setState({ appliedGeneration: 2 });
  await useAgentsStore.getState().load();
  response.resolve({ ...agent, name: 'Edited' });
  await pending;
  expect(useAgentsStore.getState().agents).toEqual([]);
});

it('retains a canonical save made before the Marketplace has hydrated this context', async () => {
  useAgentsStore.setState({
    agents: [],
    loaded: false,
    inventoryGeneration: null,
  });
  save.mockResolvedValue(agent);
  list.mockRejectedValue(new Error('Refresh failed'));
  const store = useAgentsStore.getState();
  await store.save({
    name: agent.name,
    baseModel: agent.baseModel,
    instructions: agent.instructions,
    pluginSelections: agent.pluginSelections,
  });
  expect(useAgentsStore.getState().agents).toEqual([agent]);
});
