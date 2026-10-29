import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstallReceipt } from '@canopy/desktop-shared/lib/resource-context-policy';
import type { AgentModelDefinition } from '@canopy/desktop-shared/types/agent-models';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import type { PipelinePackageInstallRecordV1 } from '@canopy/desktop-shared/types/pipeline';
import type { CollectionConfig } from '@canopy/desktop-shared/types/collections';

let mockSkillsRoot = '';
let mockOrgProjectsEnabled = false;
const mockListAutomations = jest.fn<Promise<ScheduledActivity[]>, []>();
const mockListCollections = jest.fn<
  Promise<
    Array<{
      id: string;
      sharedSource: NonNullable<CollectionConfig['sharedSource']>;
    }>
  >,
  []
>();
const mockListAgents = jest.fn<Promise<AgentModelDefinition[]>, []>();
const mockListPackageInstalls = jest.fn<
  Promise<PipelinePackageInstallRecordV1[]>,
  []
>();
const mockListTemplateInstalls = jest.fn<
  Promise<
    Array<{
      workspaceId: string;
      externalId: string;
      contentHash: string | null;
    }>
  >,
  []
>();
const mockListReceipts = jest.fn<Promise<InstallReceipt[]>, []>();
const mockReceiptStoreAccounts: string[] = [];
const mockReadAccount = jest.fn<Promise<unknown>, []>();
const mockListPipelines = jest.fn<unknown, []>();

let mockFlagStatus = 'ready';
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: (): {
    isEnabled: () => boolean;
    getSnapshot: () => { status: string };
  } => ({
    isEnabled: (): boolean => mockOrgProjectsEnabled,
    getSnapshot: (): { status: string } => ({ status: mockFlagStatus }),
  }),
}));
jest.mock('../automations/service', () => ({
  getAutomationsService: (): {
    listInstalledActivitiesForSubscriptionBackfill: () => Promise<
      ScheduledActivity[]
    >;
  } => ({
    listInstalledActivitiesForSubscriptionBackfill: () => mockListAutomations(),
  }),
}));
jest.mock('../collections/collection-store', () => ({
  listCollectionSharedSourcesForBackfill: (): ReturnType<
    typeof mockListCollections
  > => mockListCollections(),
}));
jest.mock('../agents/agent-model-store', () => ({
  listAgentModelsForInstallBackfill: (): ReturnType<typeof mockListAgents> =>
    mockListAgents(),
}));
jest.mock('../pipelines/pipeline-package-service', () => ({
  listPackageInstalls: (): ReturnType<typeof mockListPackageInstalls> =>
    mockListPackageInstalls(),
}));
jest.mock('../pipelines/pipeline-service', () => ({
  listPipelines: (): unknown => mockListPipelines(),
}));
jest.mock('../lib/cowork-workspace-crud', () => ({
  listCoworkTemplateInstallsForBackfill: (): ReturnType<
    typeof mockListTemplateInstalls
  > => mockListTemplateInstalls(),
}));
jest.mock('../lib/resource-install-receipts', () => ({
  createResourceInstallReceiptsStore: (
    accountId: string,
  ): { listForAccount: () => Promise<InstallReceipt[]> } => {
    mockReceiptStoreAccounts.push(accountId);
    return { listForAccount: () => mockListReceipts() };
  },
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  readCanopyCloudAccountWithStatus: (): Promise<unknown> => mockReadAccount(),
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));
jest.mock('../skills/paths', () => ({
  CUSTOM_SOURCE_ID: 'custom:app',
  getSkillDir: (sourceId: string, skillName: string): string =>
    join(mockSkillsRoot, sourceId, skillName),
}));

import { collectSharedItemInstallsForBackfill } from '../canopy-cloud/shared-item-subscription-backfill';

function receipt(overrides: Partial<InstallReceipt>): InstallReceipt {
  return {
    family: 'skills',
    remoteId: 'remote-skill',
    localResourceIds: [],
    shareScope: 'team',
    ownerContext: { kind: 'personal' },
    hash: 'local-hash',
    authorizedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function automation(
  id: string,
  installedFrom: ScheduledActivity['installedFrom'],
): ScheduledActivity {
  return {
    version: 1,
    id,
    name: id,
    enabled: false,
    schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
    action: { type: 'app_advisor_prompt', prompt: 'Summarize' },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    failureCount: 0,
    ...(installedFrom ? { installedFrom } : {}),
  };
}

function agent(overrides: Partial<AgentModelDefinition>): AgentModelDefinition {
  return {
    id: 'agent_model_local',
    name: 'Local',
    baseModel: 'claude-test',
    instructions: 'Help.',
    pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

async function writeCustomSkill(name: string): Promise<void> {
  const dir = join(mockSkillsRoot, 'custom:app', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), '# Skill\n', 'utf8');
}

async function collectRecords(): Promise<unknown[]> {
  const { records, complete } = await collectSharedItemInstallsForBackfill();
  expect(complete).toBe(true);
  return records;
}

describe('collectSharedItemInstallsForBackfill', () => {
  beforeEach(async () => {
    mockSkillsRoot = await mkdtemp(join(tmpdir(), 'canopy-backfill-skills-'));
    mockOrgProjectsEnabled = false;
    mockFlagStatus = 'ready';
    mockReceiptStoreAccounts.length = 0;
    mockListAutomations.mockReset().mockResolvedValue([]);
    mockListCollections.mockReset().mockResolvedValue([]);
    mockListAgents.mockReset().mockResolvedValue([]);
    mockListPackageInstalls.mockReset().mockResolvedValue([]);
    mockListTemplateInstalls.mockReset().mockResolvedValue([]);
    mockListReceipts.mockReset().mockResolvedValue([]);
    mockListPipelines.mockReset().mockReturnValue({ success: true, data: [] });
    mockReadAccount.mockReset().mockResolvedValue({
      status: 'ok',
      entry: { account: { id: 'account-a' } },
    });
  });

  afterEach(async () => {
    await rm(mockSkillsRoot, { recursive: true, force: true });
  });

  it('returns nothing when no shared item was installed', async () => {
    await expect(collectRecords()).resolves.toEqual([]);
  });

  it('collects shared and public automations with their hashes and skips curated ones', async () => {
    mockListAutomations.mockResolvedValue([
      automation('legacy-shared', {
        remoteId: 'shared-automation',
        contentHash: 'shared-hash',
        installedAt: '2026-10-01T00:00:00.000Z',
      }),
      automation('public', {
        remoteId: 'public-automation',
        contentHash: 'public-hash',
        installedAt: '2026-10-01T00:00:00.000Z',
        sourceKind: 'public',
      }),
      automation('curated', {
        remoteId: 'curated-automation',
        contentHash: 'curated-hash',
        installedAt: '2026-10-01T00:00:00.000Z',
        sourceKind: 'curated',
      }),
      automation('without-hash', {
        remoteId: 'unhashed-automation',
        contentHash: '',
        installedAt: '2026-10-01T00:00:00.000Z',
        sourceKind: 'shared',
      }),
      automation('local', undefined),
    ]);

    await expect(collectRecords()).resolves.toEqual([
      {
        kind: 'automation',
        remoteId: 'shared-automation',
        sourceKind: 'shared',
        contentHash: 'shared-hash',
        localId: 'legacy-shared',
      },
      {
        kind: 'automation',
        remoteId: 'public-automation',
        sourceKind: 'public',
        contentHash: 'public-hash',
        localId: 'public',
      },
      {
        kind: 'automation',
        remoteId: 'unhashed-automation',
        sourceKind: 'shared',
        contentHash: null,
        localId: 'without-hash',
      },
    ]);
  });

  it('collects shared and public collections, with the hash only when stored', async () => {
    mockListCollections.mockResolvedValue([
      {
        id: 'team-collection',
        sharedSource: { remoteId: 'shared-collection', fetchedAt: 'now' },
      },
      {
        id: 'public-collection',
        sharedSource: {
          remoteId: 'public-collection-id',
          fetchedAt: 'now',
          fromPublicShare: true,
          contentHash: 'collection-hash',
        },
      },
    ]);

    await expect(collectRecords()).resolves.toEqual([
      {
        kind: 'collection',
        remoteId: 'shared-collection',
        sourceKind: 'shared',
        contentHash: null,
        localId: 'team-collection',
      },
      {
        kind: 'collection',
        remoteId: 'public-collection-id',
        sourceKind: 'public',
        contentHash: 'collection-hash',
        localId: 'public-collection',
      },
    ]);
  });

  it('collects imported and public agents but not authored share links', async () => {
    mockListAgents.mockResolvedValue([
      agent({
        id: 'imported',
        importedFromRemoteId: 'shared-agent',
        remoteContentHash: 'agent-hash',
      }),
      agent({
        id: 'imported-unhashed',
        importedFromRemoteId: 'shared-agent-2',
      }),
      agent({
        id: 'public',
        publicShareExternalId: 'public-agent',
        publicShareContentHash: 'public-agent-hash',
      }),
      agent({ id: 'authored', remoteId: 'my-share', remoteContentHash: 'x' }),
    ]);

    await expect(collectRecords()).resolves.toEqual([
      {
        kind: 'agent',
        remoteId: 'shared-agent',
        sourceKind: 'shared',
        contentHash: 'agent-hash',
        localId: 'imported',
      },
      {
        kind: 'agent',
        remoteId: 'shared-agent-2',
        sourceKind: 'shared',
        contentHash: null,
        localId: 'imported-unhashed',
      },
      {
        kind: 'agent',
        remoteId: 'public-agent',
        sourceKind: 'public',
        contentHash: 'public-agent-hash',
        localId: 'public',
      },
    ]);
  });

  it('collects public pipeline installs and skips curated and team package records', async () => {
    mockListPackageInstalls.mockResolvedValue([
      {
        localPipelineId: 'public-pipeline',
        originExternalId: 'public-pipeline-share',
        pipelineContentHash: 'pipeline-hash',
        distributionMode: 'definition_only',
        installedAt: '2026-10-01T00:00:00.000Z',
      },
      {
        localPipelineId: 'curated-pipeline',
        originExternalId: 'curated:release',
        pipelineContentHash: 'curated-hash',
        packageDigest: `pp:v1:${'A'.repeat(43)}`,
        installedAt: '2026-10-01T00:00:00.000Z',
      },
      {
        localPipelineId: 'team-package',
        pipelineContentHash: 'team-hash',
        packageDigest: `pp:v1:${'B'.repeat(43)}`,
        installedAt: '2026-10-01T00:00:00.000Z',
      },
    ]);

    await expect(collectRecords()).resolves.toEqual([
      {
        kind: 'pipeline',
        remoteId: 'public-pipeline-share',
        sourceKind: 'public',
        contentHash: 'pipeline-hash',
        localId: 'public-pipeline',
      },
    ]);
  });

  it('collects installed project templates with and without a stored hash', async () => {
    mockListTemplateInstalls.mockResolvedValue([
      {
        workspaceId: 'project-a',
        externalId: 'template-a',
        contentHash: 'template-hash',
      },
      { workspaceId: 'project-b', externalId: 'template-b', contentHash: null },
    ]);

    await expect(collectRecords()).resolves.toEqual([
      {
        kind: 'workspace-template',
        remoteId: 'template-a',
        sourceKind: 'shared',
        contentHash: 'template-hash',
        localId: 'project-a',
      },
      {
        kind: 'workspace-template',
        remoteId: 'template-b',
        sourceKind: 'shared',
        contentHash: null,
        localId: 'project-b',
      },
    ]);
  });

  it('ignores team skill and pipeline receipts while organization projects are off', async () => {
    mockListReceipts.mockResolvedValue([
      receipt({ localResourceIds: ['custom:app/helper'] }),
    ]);
    await writeCustomSkill('helper');

    await expect(collectRecords()).resolves.toEqual([]);
    expect(mockListReceipts).not.toHaveBeenCalled();
  });

  it('collects receipted team skills and pipelines that still exist locally, without a hash', async () => {
    mockOrgProjectsEnabled = true;
    await writeCustomSkill('helper');
    mockListPipelines.mockReturnValue({
      success: true,
      data: [{ id: 'pipeline-kept' }],
    });
    mockListReceipts.mockResolvedValue([
      receipt({
        remoteId: 'remote-skill',
        localResourceIds: ['custom:app/helper', 'custom:app/deleted'],
      }),
      receipt({
        family: 'pipelines',
        remoteId: 'remote-pipeline',
        localResourceIds: ['pipeline-kept', 'pipeline-deleted'],
      }),
      receipt({
        family: 'collections',
        remoteId: 'remote-collection',
        localResourceIds: ['collection-a'],
      }),
      receipt({
        family: 'skills',
        remoteId: 'public-skill',
        sourceKind: 'public-share',
        localResourceIds: ['custom:app/helper'],
      }),
    ]);

    await expect(collectRecords()).resolves.toEqual([
      {
        kind: 'skill',
        remoteId: 'remote-skill',
        sourceKind: 'shared',
        contentHash: null,
        localId: 'custom:app/helper',
      },
      {
        kind: 'pipeline',
        remoteId: 'remote-pipeline',
        sourceKind: 'shared',
        contentHash: null,
        localId: 'pipeline-kept',
      },
    ]);
    expect(mockReceiptStoreAccounts).toEqual(['account-a', 'account-a']);
  });

  it('credits a reused local skill name to its latest receipt', async () => {
    mockOrgProjectsEnabled = true;
    await writeCustomSkill('helper');
    mockListReceipts.mockResolvedValue([
      receipt({
        remoteId: 'newer',
        localResourceIds: ['custom:app/helper'],
        authorizedAt: '2026-10-02T00:00:00.000Z',
      }),
      receipt({
        remoteId: 'older',
        localResourceIds: ['custom:app/helper'],
        authorizedAt: '2026-10-01T00:00:00.000Z',
      }),
    ]);

    await expect(collectRecords()).resolves.toEqual([
      expect.objectContaining({
        remoteId: 'newer',
        localId: 'custom:app/helper',
      }),
    ]);
  });

  it('skips receipts when nobody is signed in', async () => {
    mockOrgProjectsEnabled = true;
    mockReadAccount.mockResolvedValue({ status: 'ok', entry: null });
    await writeCustomSkill('helper');
    mockListReceipts.mockResolvedValue([
      receipt({ localResourceIds: ['custom:app/helper'] }),
    ]);

    await expect(collectRecords()).resolves.toEqual([]);
    expect(mockListReceipts).not.toHaveBeenCalled();
  });

  it('keeps every other source when one source fails', async () => {
    mockOrgProjectsEnabled = true;
    mockListAutomations.mockRejectedValue(new Error('automations unreadable'));
    mockListCollections.mockRejectedValue(new Error('collections unreadable'));
    mockListPackageInstalls.mockRejectedValue(new Error('store unreadable'));
    mockListReceipts.mockRejectedValue(new Error('receipts unreadable'));
    mockListAgents.mockResolvedValue([
      agent({
        id: 'public',
        publicShareExternalId: 'public-agent',
        publicShareContentHash: 'public-agent-hash',
      }),
    ]);
    mockListTemplateInstalls.mockResolvedValue([
      { workspaceId: 'project-a', externalId: 'template-a', contentHash: null },
    ]);

    await expect(collectSharedItemInstallsForBackfill()).resolves.toEqual({
      records: [
        expect.objectContaining({ kind: 'agent', localId: 'public' }),
        expect.objectContaining({
          kind: 'workspace-template',
          localId: 'project-a',
        }),
      ],
      complete: false,
    });
  });

  it('reports incomplete while feature flags are still loading', async () => {
    mockOrgProjectsEnabled = true;
    mockFlagStatus = 'initializing';
    await writeCustomSkill('helper');
    mockListReceipts.mockResolvedValue([
      receipt({ localResourceIds: ['custom:app/helper'] }),
    ]);

    await expect(collectSharedItemInstallsForBackfill()).resolves.toEqual({
      records: [],
      complete: false,
    });
    expect(mockListReceipts).not.toHaveBeenCalled();
  });
});
