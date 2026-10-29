import { ResourceContextUnavailableError } from '../lib/resource-context-error';
jest.mock('../canopy-cloud/public-share-client', () => ({
  getPublicSkillShareSnapshot: jest.fn(),
  getPublicPipelineShareSnapshot: jest.fn(),
  getPublicPluginShareSnapshot: jest.fn(),
  getPublicAgentShareSnapshot: jest.fn(),
  getPublicAutomationShareSnapshot: jest.fn(),
  getPublicWorkspaceTemplateSnapshot: jest.fn(),
  getPublicCollectionShareSnapshot: jest.fn(),
  getScopedCollectionShareSnapshot: jest.fn(),
  getScopedPluginShareSnapshot: jest.fn(),
  getScopedSkillShareSnapshot: jest.fn(),
  getScopedAgentShareSnapshot: jest.fn(),
}));
jest.mock('../automations/canopy-server-client', () => ({
  getSharedAutomation: jest.fn(),
}));
jest.mock('../automations/curated-automation-catalog', () => ({
  getCuratedAutomation: jest.fn(),
}));

import { CanopyCloudClientError } from '../canopy-cloud/client';
import {
  getPublicPipelineShareSnapshot,
  getPublicPluginShareSnapshot,
  getPublicSkillShareSnapshot,
  getPublicAgentShareSnapshot,
  getPublicAutomationShareSnapshot,
  getPublicWorkspaceTemplateSnapshot,
  getPublicCollectionShareSnapshot,
  getScopedCollectionShareSnapshot,
  getScopedPluginShareSnapshot,
  getScopedSkillShareSnapshot,
  getScopedAgentShareSnapshot,
} from '../canopy-cloud/public-share-client';
import { getSharedAutomation } from '../automations/canopy-server-client';
import { getCuratedAutomation } from '../automations/curated-automation-catalog';
import {
  parseHandoffEventRequest,
  resolveShareSnapshot,
} from '../ipc/deep-link';

const UUID = '2f0c9a1e-4b3d-4f6a-8c2e-1d5b7a9e0c4f';
const CONTENT_HASH = 'a'.repeat(64);
const PACKAGE_DIGEST = `pp:v1:${'B'.repeat(43)}`;

const skillSnapshot = {
  entity: 'skill' as const,
  externalId: UUID,
  name: 'Skill',
  description: '',
  rawSkill: '# body',
  contentHash: 'hash',
  dependencies: [],
  authorUsername: null,
  updatedAt: '2026-08-01T00:00:00.000Z',
};

describe('resolveShareSnapshot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps scoped automation policy denial to unavailable without a public fallback', async () => {
    jest
      .mocked(getSharedAutomation)
      .mockRejectedValueOnce(
        new ResourceContextUnavailableError('context-mismatch'),
      );
    await expect(
      resolveShareSnapshot({
        entity: 'automation',
        externalId: UUID,
        audience: 'ORGANIZATION',
      }),
    ).resolves.toEqual({ ok: false, reason: 'not-found' });
    expect(getPublicAutomationShareSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    [
      'collection',
      getScopedCollectionShareSnapshot,
      getPublicCollectionShareSnapshot,
    ],
    ['plugin', getScopedPluginShareSnapshot, getPublicPluginShareSnapshot],
    // A legacy team or organization skill can still have a public link; the
    // scoped handoff must not resolve through that older pinned snapshot.
    ['skill', getScopedSkillShareSnapshot, getPublicSkillShareSnapshot],
    ['agent', getScopedAgentShareSnapshot, getPublicAgentShareSnapshot],
  ] as const)(
    'resolves scoped %s through membership authorization',
    async (entity, scoped, anonymous) => {
      jest
        .mocked(scoped)
        .mockRejectedValueOnce(
          new CanopyCloudClientError('http-error', 'Not found', 404),
        );
      await expect(
        resolveShareSnapshot({ entity, externalId: UUID, audience: 'TEAM' }),
      ).resolves.toEqual({ ok: false, reason: 'not-found' });
      expect(scoped).toHaveBeenCalledWith(UUID);
      expect(anonymous).not.toHaveBeenCalled();
    },
  );

  it('rejects changed collection content before returning an install snapshot', async () => {
    jest.mocked(getPublicCollectionShareSnapshot).mockResolvedValue({
      entity: 'collection',
      externalId: UUID,
      contentHash: 'b'.repeat(64),
      collection: { version: 1, name: 'Kit', description: '', items: [] },
      itemCounts: { skills: 0, plugins: 0, customSkills: 0 },
      customSkills: [],
      authorUsername: null,
      updatedAt: '2026-10-02T00:00:00Z',
    });
    await expect(
      resolveShareSnapshot({
        entity: 'collection',
        externalId: UUID,
        expectedCollectionContentHash: CONTENT_HASH,
      }),
    ).resolves.toEqual({ ok: false, reason: 'share-changed' });
  });

  it('rejects a collection package added after definition-only review', async () => {
    jest.mocked(getPublicCollectionShareSnapshot).mockResolvedValue({
      entity: 'collection',
      externalId: UUID,
      contentHash: CONTENT_HASH,
      collection: { version: 1, name: 'Kit', description: '', items: [] },
      itemCounts: { skills: 0, plugins: 0, customSkills: 0 },
      customSkills: [],
      authorUsername: null,
      updatedAt: '2026-10-02T00:00:00Z',
      distributionMode: 'package',
      package: {
        digest: PACKAGE_DIGEST,
        version: 1,
        resources: [],
        environmentRequirements: [],
        totalFiles: 0,
        totalBytes: 0,
      },
    });
    await expect(
      resolveShareSnapshot({
        entity: 'collection',
        externalId: UUID,
        expectedCollectionContentHash: CONTENT_HASH,
        expectedDistributionMode: 'definition_only',
      }),
    ).resolves.toEqual({ ok: false, reason: 'share-changed' });
  });

  it.each(['TEAM', 'ORGANIZATION'] as const)(
    'rejects a changed %s collection package pin',
    async (audience) => {
      jest.mocked(getScopedCollectionShareSnapshot).mockResolvedValue({
        entity: 'collection',
        externalId: UUID,
        contentHash: CONTENT_HASH,
        collection: { version: 1, name: 'Kit', description: '', items: [] },
        itemCounts: { skills: 0, plugins: 0, customSkills: 0 },
        customSkills: [],
        authorUsername: null,
        updatedAt: '2026-10-02T00:00:00Z',
        distributionMode: 'package',
        package: {
          digest: `pp:v1:${'C'.repeat(43)}`,
          version: 3,
          resources: [],
          environmentRequirements: [],
          totalFiles: 0,
          totalBytes: 0,
        },
      });
      await expect(
        resolveShareSnapshot({
          entity: 'collection',
          externalId: UUID,
          audience,
          expectedCollectionContentHash: CONTENT_HASH,
          expectedDistributionMode: 'package',
          expectedPackageDigest: PACKAGE_DIGEST,
          packageVersion: 3,
        }),
      ).resolves.toEqual({ ok: false, reason: 'share-changed' });
      expect(getPublicCollectionShareSnapshot).not.toHaveBeenCalled();
    },
  );
  it.each(['TEAM', 'ORGANIZATION'] as const)(
    'rejects changed %s collection content after browser review',
    async (audience) => {
      jest.mocked(getScopedCollectionShareSnapshot).mockResolvedValue({
        entity: 'collection',
        externalId: UUID,
        contentHash: 'b'.repeat(64),
        collection: { version: 1, name: 'Kit', description: '', items: [] },
        itemCounts: { skills: 0, plugins: 0, customSkills: 0 },
        customSkills: [],
        authorUsername: null,
        updatedAt: '2026-10-02T00:00:00Z',
      });
      await expect(
        resolveShareSnapshot({
          entity: 'collection',
          externalId: UUID,
          audience,
          expectedCollectionContentHash: CONTENT_HASH,
          expectedDistributionMode: 'definition_only',
        }),
      ).resolves.toEqual({ ok: false, reason: 'share-changed' });
      expect(getPublicCollectionShareSnapshot).not.toHaveBeenCalled();
    },
  );

  it('resolves a skill snapshot', async () => {
    (getPublicSkillShareSnapshot as jest.Mock).mockResolvedValue(skillSnapshot);
    await expect(
      resolveShareSnapshot({ entity: 'skill', externalId: UUID }),
    ).resolves.toEqual({ ok: true, snapshot: skillSnapshot });
    expect(getPublicSkillShareSnapshot).toHaveBeenCalledWith(UUID);
  });

  it('routes workspace requests to the workspace-template client', async () => {
    // The renderer's landing hook has a `snapshot.entity === 'workspace'`
    // branch and the deep link parses `share/workspaces/<uuid>`, so a
    // workspace entity that fell through to `not-found` here would leave that
    // whole install path unreachable from a real deep link.
    const workspaceSnapshot = {
      entity: 'workspace' as const,
      externalId: UUID,
      template: {
        version: 1 as const,
        name: 'Course workspace',
        description: '',
        instructions: '',
        plugins: [],
        customSkills: [],
      },
      contentHash: CONTENT_HASH,
      authorUsername: null,
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    (getPublicWorkspaceTemplateSnapshot as jest.Mock).mockResolvedValue(
      workspaceSnapshot,
    );
    await expect(
      resolveShareSnapshot({
        entity: 'workspace',
        externalId: UUID,
        expectedWorkspaceTemplateContentHash: CONTENT_HASH,
      }),
    ).resolves.toEqual({ ok: true, snapshot: workspaceSnapshot });
    expect(getPublicWorkspaceTemplateSnapshot).toHaveBeenCalledWith(
      UUID,
      CONTENT_HASH,
    );
    expect(getPublicAgentShareSnapshot).not.toHaveBeenCalled();
  });

  it('routes Collection requests to the Collection snapshot client', async () => {
    const collectionSnapshot = {
      entity: 'collection' as const,
      externalId: UUID,
      collection: {
        version: 1 as const,
        name: 'Review tools',
        description: '',
        items: [],
      },
      contentHash: CONTENT_HASH,
      itemCounts: { skills: 0, plugins: 0, customSkills: 0 },
      customSkills: [],
      authorUsername: null,
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    jest
      .mocked(getPublicCollectionShareSnapshot)
      .mockResolvedValue(collectionSnapshot);

    await expect(
      resolveShareSnapshot({ entity: 'collection', externalId: UUID }),
    ).resolves.toEqual({ ok: true, snapshot: collectionSnapshot });
    expect(getPublicCollectionShareSnapshot).toHaveBeenCalledWith(UUID);
  });

  it('maps a workspace_template_share_changed 409 to share-changed', async () => {
    (getPublicWorkspaceTemplateSnapshot as jest.Mock).mockRejectedValue(
      new CanopyCloudClientError(
        'http-error',
        'This workspace template changed.',
        409,
        'workspace_template_share_changed',
      ),
    );
    await expect(
      resolveShareSnapshot({
        entity: 'workspace',
        externalId: UUID,
        expectedWorkspaceTemplateContentHash: CONTENT_HASH,
      }),
    ).resolves.toEqual({ ok: false, reason: 'share-changed' });
  });

  it('routes pipeline requests to the pipeline client', async () => {
    (getPublicPipelineShareSnapshot as jest.Mock).mockResolvedValue({
      ...skillSnapshot,
      entity: 'pipeline',
    });
    const result = await resolveShareSnapshot({
      entity: 'pipeline',
      externalId: UUID,
    });
    expect(result.ok).toBe(true);
    expect(getPublicPipelineShareSnapshot).toHaveBeenCalledWith(UUID, {});
    expect(getPublicSkillShareSnapshot).not.toHaveBeenCalled();
  });

  it('forwards the reviewed install pin to the pipeline resolve', async () => {
    (getPublicPipelineShareSnapshot as jest.Mock).mockResolvedValue({
      ...skillSnapshot,
      entity: 'pipeline',
    });
    await resolveShareSnapshot({
      entity: 'pipeline',
      externalId: UUID,
      packageVersion: 1,
      expectedPipelineContentHash: CONTENT_HASH,
      expectedDistributionMode: 'package',
      expectedPackageDigest: PACKAGE_DIGEST,
    });
    expect(getPublicPipelineShareSnapshot).toHaveBeenCalledWith(UUID, {
      expectedPipelineContentHash: CONTENT_HASH,
      expectedDistributionMode: 'package',
      expectedPackageDigest: PACKAGE_DIGEST,
    });
  });

  it('drops malformed pin fields instead of forwarding them', async () => {
    (getPublicPipelineShareSnapshot as jest.Mock).mockResolvedValue({
      ...skillSnapshot,
      entity: 'pipeline',
    });
    await resolveShareSnapshot({
      entity: 'pipeline',
      externalId: UUID,
      expectedPipelineContentHash: 'not-a-hash',
      expectedDistributionMode: 'sideloaded',
      expectedPackageDigest: 'pp:v9:nope',
    });
    expect(getPublicPipelineShareSnapshot).toHaveBeenCalledWith(UUID, {});
  });

  it('maps 426 to client-upgrade-required rather than a YAML-only install', async () => {
    (getPublicPipelineShareSnapshot as jest.Mock).mockRejectedValue(
      new CanopyCloudClientError(
        'http-error',
        'Update the desktop app to install this pipeline package.',
        426,
        'pipeline_package_client_upgrade_required',
      ),
    );
    await expect(
      resolveShareSnapshot({ entity: 'pipeline', externalId: UUID }),
    ).resolves.toEqual({ ok: false, reason: 'client-upgrade-required' });
  });

  it('maps a pipeline_share_changed 409 to share-changed', async () => {
    (getPublicPipelineShareSnapshot as jest.Mock).mockRejectedValue(
      new CanopyCloudClientError(
        'http-error',
        'This shared pipeline changed.',
        409,
        'pipeline_share_changed',
      ),
    );
    await expect(
      resolveShareSnapshot({ entity: 'pipeline', externalId: UUID }),
    ).resolves.toEqual({ ok: false, reason: 'share-changed' });
  });

  it('keeps an unrelated 409 on cloud-unreachable', async () => {
    (getPublicPipelineShareSnapshot as jest.Mock).mockRejectedValue(
      new CanopyCloudClientError('http-error', 'conflict', 409, 'other_code'),
    );
    await expect(
      resolveShareSnapshot({ entity: 'pipeline', externalId: UUID }),
    ).resolves.toEqual({ ok: false, reason: 'cloud-unreachable' });
  });

  it('routes plugin requests to the plugin client', async () => {
    const pluginSnapshot = {
      entity: 'plugin' as const,
      externalId: UUID,
      name: 'Browser',
      description: 'Browser tools',
      ref: {
        type: 'plugin' as const,
        marketplace: { type: 'github' as const, repo: 'acme/plugins' },
        plugin_name: 'browser',
      },
      refKey: 'plugin:github:acme/plugins:browser',
      marketplaceOrigin: 'github:acme/plugins',
      authorUsername: null,
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    (getPublicPluginShareSnapshot as jest.Mock).mockResolvedValue(
      pluginSnapshot,
    );
    await expect(
      resolveShareSnapshot({ entity: 'plugin', externalId: UUID }),
    ).resolves.toEqual({ ok: true, snapshot: pluginSnapshot });
    expect(getPublicPluginShareSnapshot).toHaveBeenCalledWith(UUID);
  });

  it('routes Agent requests to the Agent snapshot client', async () => {
    const agentSnapshot = {
      entity: 'agent' as const,
      externalId: UUID,
      agent: {
        version: 1 as const,
        id: 'agent_model_reviewer',
        name: 'Reviewer',
        baseModel: 'sonnet',
        instructions: 'Review carefully.',
        plugins: [],
      },
      contentHash: 'hash',
      authorUsername: null,
      updatedAt: '2026-08-31T00:00:00.000Z',
    };
    jest.mocked(getPublicAgentShareSnapshot).mockResolvedValue(agentSnapshot);
    await expect(
      resolveShareSnapshot({ entity: 'agent', externalId: UUID }),
    ).resolves.toEqual({ ok: true, snapshot: agentSnapshot });
    expect(getPublicAgentShareSnapshot).toHaveBeenCalledWith(UUID);
  });

  it('routes automation requests to the automation snapshot client', async () => {
    const automationSnapshot = {
      entity: 'automation' as const,
      externalId: UUID,
      automation: {
        version: 1 as const,
        name: 'Nightly review',
        description: '',
        trigger: {
          kind: 'cron' as const,
          expression: '0 2 * * *',
          timezone: 'local' as const,
        },
        action: {
          type: 'worktree_pipeline' as const,
          target: { kind: 'workspace' as const },
          pipeline: {
            source: 'bundled' as const,
            pipelineId: 'code-review',
          },
          inputKeys: ['branch'],
        },
        hasRunCondition: false,
      },
      contentHash: 'hash',
      authorUsername: null,
      updatedAt: '2026-09-15T00:00:00.000Z',
    };
    jest
      .mocked(getPublicAutomationShareSnapshot)
      .mockResolvedValue(automationSnapshot);
    await expect(
      resolveShareSnapshot({
        entity: 'automation',
        externalId: UUID,
        expectedAutomationContentHash: CONTENT_HASH,
      }),
    ).resolves.toEqual({ ok: true, snapshot: automationSnapshot });
    expect(getPublicAutomationShareSnapshot).toHaveBeenCalledWith(
      UUID,
      CONTENT_HASH,
    );
  });

  it('maps an automation_share_changed 409 to share-changed', async () => {
    jest
      .mocked(getPublicAutomationShareSnapshot)
      .mockRejectedValue(
        new CanopyCloudClientError(
          'http-error',
          'This shared automation changed.',
          409,
          'automation_share_changed',
        ),
      );
    await expect(
      resolveShareSnapshot({
        entity: 'automation',
        externalId: UUID,
        expectedAutomationContentHash: CONTENT_HASH,
      }),
    ).resolves.toEqual({ ok: false, reason: 'share-changed' });
  });

  it('resolves a pinned curated automation through the catalog client', async () => {
    const automation = {
      version: 1 as const,
      name: 'Daily review',
      description: 'Review open work',
      trigger: {
        kind: 'cron' as const,
        expression: '0 9 * * 1-5',
        timezone: 'local' as const,
      },
      action: {
        type: 'app_advisor_prompt' as const,
        prompt: 'Review',
        plugins: [],
      },
      hasRunCondition: false,
    };
    jest.mocked(getCuratedAutomation).mockResolvedValue({
      key: 'daily-review',
      name: automation.name,
      shortDescription: automation.description,
      icon: '',
      triggerKind: 'cron',
      cronExpression: automation.trigger.expression,
      actionType: automation.action.type,
      pipelineSource: null,
      referencedCuratedPipelineKey: null,
      pluginCount: 0,
      contentHash: CONTENT_HASH,
      contentSizeBytes: 100,
      categories: [],
      popular: false,
      sortOrder: 0,
      revision: 1,
      authorName: null,
      authorUrl: null,
      docsUrl: null,
      createdAt: '2026-09-30T00:00:00.000Z',
      updatedAt: '2026-09-30T01:00:00.000Z',
      automation,
    });

    await expect(
      resolveShareSnapshot({
        entity: 'automation',
        externalId: 'daily-review',
        automationSource: 'curated',
        expectedAutomationContentHash: CONTENT_HASH,
      }),
    ).resolves.toEqual({
      ok: true,
      snapshot: {
        entity: 'automation',
        externalId: 'daily-review',
        sourceKind: 'curated',
        automation,
        contentHash: CONTENT_HASH,
        distributionMode: 'definition_only',
        authorUsername: null,
        updatedAt: '2026-09-30T01:00:00.000Z',
      },
    });
    expect(getCuratedAutomation).toHaveBeenCalledWith('daily-review');
    expect(getPublicAutomationShareSnapshot).not.toHaveBeenCalled();
    expect(getSharedAutomation).not.toHaveBeenCalled();
  });

  it('resolves scoped automation links through the authenticated endpoint', async () => {
    const detail = {
      id: UUID,
      name: 'Team automation',
      description: 'Shared with the team',
      triggerKind: 'cron' as const,
      actionType: 'app_advisor_prompt' as const,
      contentHash: CONTENT_HASH,
      shareScope: 'team' as const,
      owner: { type: 'team' as const, id: 'team-1', name: 'Platform' },
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-16T00:00:00.000Z',
      createdBy: { id: 'user-1', name: 'Alex', email: null },
      canUpdate: false,
      canDelete: false,
      automation: {
        version: 1 as const,
        name: 'Team automation',
        description: 'Shared with the team',
        trigger: {
          kind: 'cron' as const,
          expression: '0 2 * * *',
          timezone: 'local' as const,
        },
        action: {
          type: 'app_advisor_prompt' as const,
          prompt: 'Check the queue',
        },
        hasRunCondition: false,
      },
    };
    jest.mocked(getSharedAutomation).mockResolvedValue(detail);

    await expect(
      resolveShareSnapshot({
        entity: 'automation',
        externalId: UUID,
        audience: 'TEAM',
        expectedAutomationContentHash: CONTENT_HASH,
      }),
    ).resolves.toEqual({
      ok: true,
      snapshot: {
        entity: 'automation',
        externalId: UUID,
        automation: detail.automation,
        contentHash: CONTENT_HASH,
        distributionMode: 'definition_only',
        authorUsername: null,
        updatedAt: detail.updatedAt,
      },
    });
    expect(getSharedAutomation).toHaveBeenCalledWith(UUID);
    expect(getPublicAutomationShareSnapshot).not.toHaveBeenCalled();
  });

  it('rejects malformed requests without touching the network', async () => {
    const malformed: unknown[] = [
      { entity: 'skill', externalId: 'not-a-uuid' },
      { entity: 'skill', externalId: UUID.toUpperCase() },
      { entity: 'unknown', externalId: UUID },
      { entity: 'skill' },
      null,
      'string',
    ];
    for (const request of malformed) {
      await expect(resolveShareSnapshot(request)).resolves.toEqual({
        ok: false,
        reason: 'not-found',
      });
    }
    expect(getPublicSkillShareSnapshot).not.toHaveBeenCalled();
    expect(getPublicPipelineShareSnapshot).not.toHaveBeenCalled();
    expect(getPublicPluginShareSnapshot).not.toHaveBeenCalled();
    expect(getPublicAutomationShareSnapshot).not.toHaveBeenCalled();
  });

  it('maps a 404 to not-found', async () => {
    (getPublicSkillShareSnapshot as jest.Mock).mockRejectedValue(
      new CanopyCloudClientError('http-error', 'Share not found', 404),
    );
    await expect(
      resolveShareSnapshot({ entity: 'skill', externalId: UUID }),
    ).resolves.toEqual({ ok: false, reason: 'not-found' });
  });

  it('maps transport failures to cloud-unreachable', async () => {
    for (const error of [
      new CanopyCloudClientError('network-error', 'offline'),
      new CanopyCloudClientError('http-error', 'boom', 500),
      new Error('unexpected'),
    ]) {
      (getPublicSkillShareSnapshot as jest.Mock).mockRejectedValue(error);
      await expect(
        resolveShareSnapshot({ entity: 'skill', externalId: UUID }),
      ).resolves.toEqual({ ok: false, reason: 'cloud-unreachable' });
    }
  });
});

describe('parseHandoffEventRequest', () => {
  it('accepts automation install and try events', () => {
    expect(
      parseHandoffEventRequest({
        entity: 'automation',
        externalId: UUID,
        eventType: 'INSTALLED',
      }),
    ).toEqual({
      entity: 'automation',
      externalId: UUID,
      eventType: 'INSTALLED',
    });
  });
});
