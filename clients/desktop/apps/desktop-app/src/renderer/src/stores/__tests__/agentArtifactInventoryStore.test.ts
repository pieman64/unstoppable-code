/** @jest-environment jsdom */
import type { CapabilityReferenceArtifactReceiptV1 } from '@canopy/protocol/agent-artifacts';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '../featureFlagsStore';
import { useWorkspaceContextStore } from '../workspaceContextStore';
import {
  artifactInventoryScope,
  localArtifactAvailability,
  observeArtifactPipelines,
  observeArtifactProjectPipelines,
  observeArtifactSkills,
  recordArtifactAgentRemoval,
  clearArtifactAgentRemovals,
  useAgentArtifactInventoryStore,
} from '../agentArtifactInventoryStore';

const pipeline: CapabilityReferenceArtifactReceiptV1 = {
  version: 1,
  kind: 'capability_reference',
  operation: 'pipeline.get',
  dedupeKey: 'canopy:capability_reference:user:pipeline:one',
  createdAt: '2026-10-16T12:00:00.000Z',
  itemKind: 'pipeline',
  source: 'user',
  sourceId: 'one',
  name: 'Review',
  sourceLabel: 'Local',
  state: 'installed',
  relation: 'found',
  navigationTarget: {
    kind: 'pipeline_editor',
    source: 'user',
    pipelineId: 'one',
  },
};
const skill: CapabilityReferenceArtifactReceiptV1 = {
  ...pipeline,
  itemKind: 'skill',
  source: 'installed',
  sourceId: 'custom/review',
  navigationTarget: {
    kind: 'installed_skill',
    sourceId: 'custom',
    skillName: 'review',
  },
};
const originalIsEnabled = useFeatureFlagsStore.getState().isEnabled;
const originalGeneration =
  useWorkspaceContextStore.getState().appliedGeneration;
beforeEach(() => {
  useFeatureFlagsStore.setState({ isEnabled: () => false });
  useAgentArtifactInventoryStore.setState({
    pipelines: null,
    skills: null,
    projectPipelines: new Map(),
    removedAgents: new Map(),
  });
});
afterEach(() => {
  useFeatureFlagsStore.setState({ isEnabled: originalIsEnabled });
  useWorkspaceContextStore.setState({ appliedGeneration: originalGeneration });
});

it('keeps cold, failed and filtered observations unknown', () => {
  expect(localArtifactAvailability(pipeline)).toBe('unknown');
  observeArtifactPipelines([]);
  expect(localArtifactAvailability(pipeline)).toBe('removed');
  observeArtifactPipelines(null);
  expect(localArtifactAvailability(pipeline)).toBe('unknown');
  useFeatureFlagsStore.setState({
    isEnabled: (key) =>
      key === CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
  });
  observeArtifactPipelines([]);
  expect(localArtifactAvailability(pipeline)).toBe('unknown');
  // A filtered result stays non-authoritative if the flag changes later.
  useFeatureFlagsStore.setState({ isEnabled: () => false });
  expect(localArtifactAvailability(pipeline)).toBe('unknown');
});
it('matches source-qualified skill and pipeline identities', () => {
  observeArtifactPipelines([{ id: 'one', source: 'bundled' }]);
  expect(localArtifactAvailability(pipeline)).toBe('removed');
  observeArtifactSkills([{ sourceId: 'other', name: 'review' }]);
  expect(localArtifactAvailability(skill)).toBe('removed');
  observeArtifactSkills([{ sourceId: 'custom', name: 'review' }]);
  expect(localArtifactAvailability(skill)).toBe('available');
});
it('ignores stale observations after a scope change', () => {
  const scope = artifactInventoryScope();
  useWorkspaceContextStore.setState({
    appliedGeneration: scope.generation + 1,
  });
  observeArtifactPipelines([], scope);
  observeArtifactSkills([], scope);
  expect(localArtifactAvailability(pipeline)).toBe('unknown');
  expect(localArtifactAvailability(skill)).toBe('unknown');
});
it('never confuses project pipelines across workspaces, worktrees or repositories', () => {
  const projectReceipt: CapabilityReferenceArtifactReceiptV1 = {
    ...pipeline,
    navigationTarget: {
      kind: 'pipeline_editor',
      source: 'project',
      pipelineId: 'one',
      projectId: 'project-a',
      worktreeId: 'tree-a',
    },
  };
  observeArtifactProjectPipelines([], {
    projectId: 'project-b',
    worktreeId: 'tree-a',
  });
  observeArtifactProjectPipelines([], {
    projectId: 'project-a',
    worktreeId: 'tree-b',
  });
  expect(localArtifactAvailability(projectReceipt)).toBe('unknown');
  observeArtifactProjectPipelines([{ id: 'one' }], {
    projectId: 'project-a',
    worktreeId: 'tree-a',
  });
  expect(localArtifactAvailability(projectReceipt)).toBe('available');
  observeArtifactProjectPipelines([], {
    projectId: 'project-a',
    worktreeId: 'tree-a',
  });
  expect(localArtifactAvailability(projectReceipt)).toBe('removed');
  observeArtifactProjectPipelines(null, {
    projectId: 'project-a',
    worktreeId: 'tree-a',
  });
  expect(localArtifactAvailability(projectReceipt)).toBe('unknown');
});
it('uses explicit agent deletions until a list confirms reappearance', () => {
  const agent: CapabilityReferenceArtifactReceiptV1 = {
    ...pipeline,
    itemKind: 'agent',
    source: 'local',
    sourceId: 'agent-one',
    navigationTarget: { kind: 'agent_editor', agentId: 'agent-one' },
  };
  recordArtifactAgentRemoval('agent-one');
  expect(localArtifactAvailability(agent)).toBe('removed');
  clearArtifactAgentRemovals(['agent-one']);
  expect(localArtifactAvailability(agent)).toBe('unknown');
  expect(
    localArtifactAvailability({
      ...agent,
      navigationTarget: { kind: 'shared_agent', agentId: 'agent-one' },
    }),
  ).toBe('unknown');
});
