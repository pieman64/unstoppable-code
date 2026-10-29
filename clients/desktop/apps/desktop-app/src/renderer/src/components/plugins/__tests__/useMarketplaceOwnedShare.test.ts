import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import type { AgentModelDefinition } from '@canopy/desktop-shared/types/agent-models';
import type { CollectionIndexEntry } from '@canopy/desktop-shared/types/collections';
import type { PipelineInfo } from '@canopy/desktop-shared/types/pipeline';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';

jest.mock('@/components/automations/ShareAutomationModal', () => ({
  ShareAutomationModal: (): null => null,
}));
jest.mock('@/components/collections/ShareCollectionModal', () => ({
  ShareCollectionModal: (): null => null,
}));
jest.mock('@/components/pipeline/SharePipelineModal', () => ({
  SharePipelineModal: (): null => null,
}));
jest.mock('@/components/skills/ShareSkillModal', () => ({
  ShareSkillModal: (): null => null,
}));

import {
  ownedShareTargetForEntry,
  type OwnedShareSources,
} from '../useMarketplaceOwnedShare';

function skill(overrides: Partial<InstalledSkillInfo>): InstalledSkillInfo {
  return {
    name: 'helper',
    sourceId: 'custom:app',
    description: '',
    installedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function collection(
  overrides: Partial<CollectionIndexEntry> = {},
): CollectionIndexEntry {
  return {
    id: 'review-kit',
    name: 'Review kit',
    description: '',
    updatedAt: '2026-09-01T00:00:00.000Z',
    skillCount: 1,
    pluginCount: 0,
    mcpServerCount: 0,
    ...overrides,
  };
}

function pipeline(overrides: Partial<PipelineInfo>): PipelineInfo {
  return {
    id: 'release',
    name: 'Release',
    description: '',
    icon: '',
    version: '1',
    source: 'user',
    ...overrides,
  };
}

function automation(
  overrides: Partial<ScheduledActivity> = {},
): ScheduledActivity {
  return {
    version: 1,
    id: 'standup',
    name: 'Standup',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action: { type: 'app_advisor_prompt', prompt: 'Summarize the day' },
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    failureCount: 0,
    ...overrides,
  };
}

const organizationContext = {
  kind: 'organization',
  organizationId: 'org-1',
} as const;

function sources(
  overrides: Partial<OwnedShareSources> = {},
): OwnedShareSources {
  return {
    skills: [],
    localCollections: [],
    pipelines: [],
    automationActivities: [],
    context: organizationContext,
    ...overrides,
  };
}

describe('ownedShareTargetForEntry', () => {
  describe('skills', () => {
    const ref = {
      type: 'skill',
      sourceId: 'custom:app',
      skillName: 'helper',
    } as const;

    it('shares a custom skill, carrying its existing cloud share', () => {
      const remote = {
        remoteId: 'shared-1',
        contentHash: 'hash',
        shareScope: 'team',
        sharedAt: '2026-09-01T00:00:00.000Z',
      } as const;
      expect(
        ownedShareTargetForEntry(
          { ref },
          sources({ skills: [skill({ custom: true, remote })] }),
        ),
      ).toEqual({
        kind: 'skill',
        skill: { sourceId: 'custom:app', name: 'helper', remote },
      });
    });

    it('shares a bundled built-in as a snapshot', () => {
      expect(
        ownedShareTargetForEntry(
          {
            ref: { type: 'skill', sourceId: 'builtin:app', skillName: 'plan' },
          },
          sources({
            skills: [
              skill({ name: 'plan', sourceId: 'builtin:app', builtIn: true }),
            ],
          }),
        ),
      ).toEqual({
        kind: 'skill',
        skill: { sourceId: 'builtin:app', name: 'plan' },
      });
    });

    it('never shares a skill a plugin or an external source owns', () => {
      expect(
        ownedShareTargetForEntry(
          {
            ref: {
              type: 'skill',
              sourceId: 'github:acme/skills',
              skillName: 'helper',
            },
          },
          sources({ skills: [skill({ sourceId: 'github:acme/skills' })] }),
        ),
      ).toBeNull();
    });

    it('has nothing to share once the skill is gone', () => {
      expect(ownedShareTargetForEntry({ ref }, sources())).toBeNull();
    });
  });

  describe('local agents (CAN-4266)', () => {
    const agent: AgentModelDefinition = {
      id: 'agent_model_reviewer',
      name: 'iOS Reviewer',
      baseModel: 'claude-sonnet-4-5',
      instructions: '',
      pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    const ref = { type: 'local-agent' as const, agentId: agent.id };

    it('shares a local agent through its own dialog', () => {
      expect(
        ownedShareTargetForEntry(
          { ref },
          { ...sources(), localAgents: [agent] },
        ),
      ).toEqual({ kind: 'agent', agent });
    });

    it('has nothing to share once the agent is gone or agents are off', () => {
      expect(ownedShareTargetForEntry({ ref }, sources())).toBeNull();
      expect(
        ownedShareTargetForEntry({ ref }, { ...sources(), localAgents: [] }),
      ).toBeNull();
    });
  });

  describe('collections', () => {
    const ref = {
      type: 'local-collection',
      collectionId: 'review-kit',
    } as const;

    it('shares a local collection inside an organization', () => {
      expect(
        ownedShareTargetForEntry(
          { ref },
          sources({ localCollections: [collection()] }),
        ),
      ).toEqual({ kind: 'collection', collectionId: 'review-kit' });
    });

    it('offers Public sharing for a new collection in Personal', () => {
      expect(
        ownedShareTargetForEntry(
          { ref },
          sources({
            localCollections: [collection()],
            context: { kind: 'personal' },
          }),
        ),
      ).toEqual({ kind: 'collection', collectionId: 'review-kit' });
    });

    it('still reaches an existing share from Personal', () => {
      expect(
        ownedShareTargetForEntry(
          { ref },
          sources({
            localCollections: [collection({ hasExistingShare: true })],
            context: { kind: 'personal' },
          }),
        ),
      ).toEqual({ kind: 'collection', collectionId: 'review-kit' });
    });
  });

  describe('pipelines', () => {
    it('shares stored and bundled pipelines', () => {
      const user = pipeline({ source: 'user' });
      const bundled = pipeline({ id: 'review', source: 'bundled' });
      const all = sources({ pipelines: [user, bundled] });
      expect(
        ownedShareTargetForEntry(
          { ref: { type: 'pipeline', pipelineId: 'release', source: 'user' } },
          all,
        ),
      ).toEqual({ kind: 'pipeline', info: user });
      expect(
        ownedShareTargetForEntry(
          {
            ref: { type: 'pipeline', pipelineId: 'review', source: 'bundled' },
          },
          all,
        ),
      ).toEqual({ kind: 'pipeline', info: bundled });
    });

    it('leaves project and shared pipelines to the Pipelines page', () => {
      const all = sources({
        pipelines: [
          pipeline({ source: 'project', filePath: '.canopy/release.yml' }),
          pipeline({ id: 'team', source: 'shared', remoteId: 'remote-1' }),
        ],
      });
      expect(
        ownedShareTargetForEntry(
          {
            ref: {
              type: 'pipeline',
              pipelineId: 'release',
              source: 'project',
              filePath: '.canopy/release.yml',
            },
          },
          all,
        ),
      ).toBeNull();
      expect(
        ownedShareTargetForEntry(
          {
            ref: {
              type: 'pipeline',
              pipelineId: 'team',
              source: 'shared',
              remoteId: 'remote-1',
            },
          },
          all,
        ),
      ).toBeNull();
    });
  });

  describe('automations', () => {
    const ref = { type: 'automation', activityId: 'standup' } as const;

    it('shares a local automation', () => {
      const activity = automation();
      expect(
        ownedShareTargetForEntry(
          { ref },
          sources({ automationActivities: [activity] }),
        ),
      ).toEqual({ kind: 'automation', activity });
    });

    it('never shares a usage-limit resume bound to one local run', () => {
      expect(
        ownedShareTargetForEntry(
          { ref },
          sources({
            automationActivities: [
              automation({
                action: {
                  type: 'pipeline_execution_resume',
                  executionId: 'run-1',
                },
              }),
            ],
          }),
        ),
      ).toBeNull();
    });
  });

  it('has no target for an entry the viewer does not own', () => {
    for (const ref of [
      { type: 'shared-skill', skillId: 'shared-1' },
      { type: 'shared-collection', collectionId: 'shared-1' },
      { type: 'shared-automation', automationId: 'shared-1' },
      { type: 'shared-agent', agentId: 'agent-1' },
      { type: 'curated-plugin', key: 'acme' },
    ] as const) {
      expect(ownedShareTargetForEntry({ ref }, sources())).toBeNull();
    }
  });
});
