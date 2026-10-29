/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AgentDefinitionArtifactReceiptV1,
  AutomationRunArtifactReceiptV1,
} from '@canopy/protocol/agent-artifacts';
import type {
  ScheduledActivity,
  ScheduledActivityRun,
} from '@canopy/desktop-shared/types';
import type { AgentModelDefinition } from '@canopy/desktop-shared/types/agent-models';
import type { ChatShareData } from '@/hooks/useChatShareData';
import { useAgentsStore } from '@/stores/agentsStore';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useGitHubStore } from '@/stores/githubStore';
import {
  agentAvailability,
  automationAvailability,
} from '../useAgentArtifactLiveState';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

jest.mock('@/hooks/useChatShareData', () => ({
  useChatShareData: (): Partial<ChatShareData> => ({ installedSkills: null }),
}));

const mockOpenNavigation = jest.fn(() => Promise.resolve());
jest.mock('../agent-artifact-navigation', () => ({
  openAgentArtifactNavigation: (target: unknown): Promise<void> =>
    mockOpenNavigation(target),
}));

import { AgentArtifactCard } from '../AgentArtifactCard';
import { usePipelineList } from '@/hooks/usePipelineList';
import { useSkillList } from '@/hooks/useSkillList';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useAgentArtifactInventoryStore } from '@/stores/agentArtifactInventoryStore';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type { CapabilityReferenceArtifactReceiptV1 } from '@canopy/protocol/agent-artifacts';

jest.mock('@/hooks/useSharedPipelineList', () => ({
  useSharedPipelineList: (): { cloudAccount: null } => ({ cloudAccount: null }),
}));

function LocalInventoryObserver(): null {
  usePipelineList();
  useSkillList();
  return null;
}

const localPipelineReceipt: CapabilityReferenceArtifactReceiptV1 = {
  version: 1,
  kind: 'capability_reference',
  operation: 'pipeline.get',
  dedupeKey: 'canopy:capability_reference:user:pipeline:gone',
  createdAt: '2026-10-16T12:00:00.000Z',
  itemKind: 'pipeline',
  source: 'user',
  sourceId: 'gone',
  name: 'Old pipeline',
  sourceLabel: 'Local',
  state: 'installed',
  relation: 'found',
  navigationTarget: {
    kind: 'pipeline_editor',
    source: 'user',
    pipelineId: 'gone',
  },
};
const localSkillReceipt: CapabilityReferenceArtifactReceiptV1 = {
  ...localPipelineReceipt,
  itemKind: 'skill',
  source: 'installed',
  sourceId: 'custom/gone',
  name: 'Old skill',
  dedupeKey: 'canopy:capability_reference:installed:skill:gone',
  navigationTarget: {
    kind: 'installed_skill',
    sourceId: 'custom',
    skillName: 'gone',
  },
};

const CREATED_AT = '2026-10-16T12:00:00.000Z';

const runReceipt: AutomationRunArtifactReceiptV1 = {
  version: 1,
  kind: 'automation_run',
  operation: 'automation.run_now',
  dedupeKey: 'canopy:automation_run:local:run-1',
  createdAt: CREATED_AT,
  activityId: 'act-1',
  runId: 'run-1',
  name: 'Nightly triage',
  status: 'running',
  trigger: 'manual',
  scheduledFor: CREATED_AT,
  startedAt: CREATED_AT,
  navigationTarget: {
    kind: 'automation_editor',
    activityId: 'act-1',
    section: 'runs',
    runId: 'run-1',
  },
};

const agentReceipt: AgentDefinitionArtifactReceiptV1 = {
  version: 1,
  kind: 'agent',
  operation: 'agents.create',
  dedupeKey: 'canopy:agent:local:agent-1',
  createdAt: CREATED_AT,
  source: 'local',
  agentId: 'agent-1',
  name: 'Reviewer',
  navigationTarget: { kind: 'agent_editor', agentId: 'agent-1' },
};

function activity(id: string): ScheduledActivity {
  return {
    version: 1,
    id,
    name: 'Nightly triage',
    enabled: true,
    schedule: { kind: 'one_time', runAt: CREATED_AT, timezone: 'local' },
    action: { type: 'app_advisor_prompt', prompt: 'Triage.' },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    failureCount: 0,
  };
}

function run(overrides: Partial<ScheduledActivityRun>): ScheduledActivityRun {
  return {
    id: 'run-1',
    activityId: 'act-1',
    activityName: 'Nightly triage',
    scheduledFor: CREATED_AT,
    manual: true,
    status: 'running',
    startedAt: CREATED_AT,
    ...overrides,
  };
}

function agent(id: string): AgentModelDefinition {
  return {
    id,
    name: 'Reviewer',
    baseModel: 'claude-agents-test',
    instructions: '',
    pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

describe('agent artifact availability', () => {
  const settled = {
    hydrated: true,
    loading: false,
    error: null,
    activities: [{ id: 'act-1' }],
  };

  it('confirms removal only from a settled, error-free inventory', () => {
    expect(automationAvailability('act-1', settled)).toBe('available');
    expect(automationAvailability('gone', settled)).toBe('removed');
    expect(
      automationAvailability('gone', { ...settled, hydrated: false }),
    ).toBe('unknown');
    expect(automationAvailability('gone', { ...settled, loading: true })).toBe(
      'unknown',
    );
    expect(
      automationAvailability('gone', { ...settled, error: 'Failed' }),
    ).toBe('unknown');
    expect(automationAvailability(undefined, settled)).toBe('unknown');
  });

  it('treats a failed agent load as unknown', () => {
    const agents = { loaded: true, loading: false, error: null, agents: [] };
    expect(agentAvailability('agent-1', agents)).toBe('removed');
    expect(agentAvailability('agent-1', { ...agents, error: 'nope' })).toBe(
      'unknown',
    );
    expect(agentAvailability('agent-1', { ...agents, loaded: false })).toBe(
      'unknown',
    );
  });
});

describe('AgentArtifactCard live state', () => {
  let container: HTMLElement;
  let root: Root;
  const addToast = jest.fn();
  const originalIsEnabled = useFeatureFlagsStore.getState().isEnabled;

  beforeEach(() => {
    useFeatureFlagsStore.setState({ isEnabled: () => false });
    mockOpenNavigation.mockClear();
    addToast.mockClear();
    useGitHubStore.setState({ addToast });
    useAutomationsStore.setState({
      activities: [],
      recentRuns: [],
      hydrated: false,
      loading: false,
      error: null,
    });
    useAgentArtifactInventoryStore.setState({
      pipelines: null,
      skills: null,
      projectPipelines: new Map(),
      removedAgents: new Map(),
    });
    useAgentsStore.setState({
      inventoryComplete: true,
      inventoryGeneration:
        useWorkspaceContextStore.getState().appliedGeneration,
      agents: [],
      loaded: false,
      loading: false,
      error: null,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useFeatureFlagsStore.setState({ isEnabled: originalIsEnabled });
  });

  const tile = (testId: string): HTMLElement | null =>
    container.querySelector(`[data-testid="${testId}"]`);

  it('disables missing local pipeline and skill references after authoritative inventory loads', async () => {
    Object.defineProperty(window, 'pipelines', {
      configurable: true,
      value: {
        list: jest.fn().mockResolvedValue({ success: true, data: [] }),
      },
    });
    Object.defineProperty(window, 'skills', {
      configurable: true,
      value: {
        loadSkills: jest.fn().mockResolvedValue({ success: true, data: [] }),
      },
    });
    await act(async () => {
      root.render(
        <>
          <LocalInventoryObserver />
          <AgentArtifactCard receipt={localPipelineReceipt} />
          <AgentArtifactCard receipt={localSkillReceipt} />
        </>,
      );
      await Promise.resolve();
    });
    const cards = container.querySelectorAll(
      '[data-testid="agent-artifact-capability_reference"]',
    );
    expect(Array.from(cards).map((card) => card.tagName)).toEqual([
      'DIV',
      'DIV',
    ]);
    expect(
      Array.from(cards).every((card) => card.textContent?.includes('Removed')),
    ).toBe(true);
  });

  it('does not infer deletion from a context-filtered agent inventory', () => {
    const original = useFeatureFlagsStore.getState().isEnabled;
    useFeatureFlagsStore.setState({
      isEnabled: (key) =>
        key === CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key ||
        original(key),
    });
    try {
      useAgentsStore.setState({
        loaded: true,
        loading: false,
        error: null,
        agents: [],
      });
      act(() => root.render(<AgentArtifactCard receipt={agentReceipt} />));
      expect(tile('agent-artifact-agent')?.tagName).toBe('BUTTON');
    } finally {
      useFeatureFlagsStore.setState({ isEnabled: original });
    }
  });

  it('keeps the persisted snapshot while the inventory is cold', () => {
    act(() => root.render(<AgentArtifactCard receipt={runReceipt} />));
    const card = tile('agent-artifact-automation_run');
    expect(card?.tagName).toBe('BUTTON');
    expect(card?.textContent).toContain('Running');
    act(() => card?.click());
    expect(mockOpenNavigation).toHaveBeenCalledWith(
      runReceipt.navigationTarget,
    );
  });

  it('shows a newer outcome from the matching run only', () => {
    useAutomationsStore.setState({
      hydrated: true,
      activities: [activity('act-1')],
      recentRuns: [
        run({ id: 'run-1', activityId: 'other', status: 'success' }),
        run({ id: 'run-1', status: 'failure', durationMs: 4000 }),
      ],
    });
    act(() => root.render(<AgentArtifactCard receipt={runReceipt} />));
    const text = tile('agent-artifact-automation_run')?.textContent ?? '';
    expect(text).toContain('Failed');
    expect(text).toContain('4 s');
  });

  it('keeps a deleted automation run outcome but disables opening it', () => {
    useAutomationsStore.setState({ hydrated: true, activities: [] });
    act(() =>
      root.render(
        <AgentArtifactCard receipt={{ ...runReceipt, status: 'success' }} />,
      ),
    );
    const card = tile('agent-artifact-automation_run');
    expect(card?.tagName).toBe('DIV');
    expect(card?.textContent).toContain('Succeeded');
    expect(card?.textContent).toContain('Automation deleted');
  });

  it('rechecks availability when an item is removed after rendering', () => {
    useAgentsStore.setState({
      loaded: true,
      agents: [agent('agent-1')],
    });
    act(() => root.render(<AgentArtifactCard receipt={agentReceipt} />));
    const card = tile('agent-artifact-agent');
    expect(card?.tagName).toBe('BUTTON');
    // Removed after this render, before React hears about it: the click must
    // read the store again rather than trust the rendered state.
    useAgentsStore.getState().agents.splice(0);
    act(() => card?.click());
    expect(mockOpenNavigation).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith(
      'Reviewer is no longer available.',
      'error',
    );
  });
});
