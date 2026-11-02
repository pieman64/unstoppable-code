import type {
  SharedAutomationDetail,
  SharedAutomationDocument,
  SharedAutomationPipelineDependency,
} from '@canopy/protocol/automations';
import { validateSharedAutomationDocument } from '@canopy/protocol/automations';
import type { ScheduledActivity } from '../../types';
import {
  AUTOMATION_PIPELINE_LOCAL_CHANGES_MESSAGE,
  SHARED_AUTOMATION_NEWER_VERSION_MESSAGE,
  buildApplyUpdateRequest,
  buildInstallAutomationRequest,
  planAutomationPipelineUpdate,
  rewriteSharedAutomationPromptPipelines,
} from '../automation-install';

const NOW = '2026-08-20T12:00:00.000Z';

function detail(
  overrides: Partial<SharedAutomationDetail> = {},
): SharedAutomationDetail {
  return {
    id: '4f6b0f5e-2f66-4be4-9f8e-1f0a54a1c111',
    name: 'Nightly review pipeline',
    description: 'Runs the review pipeline every night.',
    triggerKind: 'cron',
    actionType: 'worktree_pipeline',
    contentHash: 'a'.repeat(64),
    shareScope: 'team',
    owner: {
      type: 'team',
      id: 'team-1',
      name: 'Platform',
      organization: { id: 'org-1', name: 'Acme' },
    },
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    createdBy: { id: 'user-1', name: 'Alex', email: 'alex@example.com' },
    canUpdate: false,
    canDelete: false,
    automation: {
      version: 1,
      name: 'Nightly review pipeline',
      description: 'Runs the review pipeline every night.',
      trigger: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        target: { kind: 'workspace' },
        pipeline: { source: 'bundled', pipelineId: 'code-review' },
        inputKeys: ['branch', 'ticket'],
      },
      hasRunCondition: true,
    },
    ...overrides,
  };
}

function promptDocument(
  action: SharedAutomationDetail['automation']['action'],
): SharedAutomationDetail {
  return detail({
    actionType: action.type,
    automation: { ...detail().automation, action },
  });
}

describe('buildInstallAutomationRequest', () => {
  it('blocks undeclared legacy pipelines until exact scopes are resolved', () => {
    for (const version of [1, 2, 3] as const) {
      const source = detail({
        automation: { ...detail().automation, version },
      });
      expect(
        buildInstallAutomationRequest(
          source,
          {
            workspaceId: 'workspace-1',
            targetKind: 'single-repo',
          },
          NOW,
        ),
      ).toMatchObject({ ok: false });
      expect(
        buildInstallAutomationRequest(
          source,
          {
            workspaceId: 'workspace-1',
            targetKind: 'single-repo',
            pipelineResolution: { status: 'pending' },
          },
          NOW,
        ),
      ).toMatchObject({ ok: false });
    }
  });

  it('requires a resolved project kind rather than inferring it from an ID', () => {
    expect(
      buildInstallAutomationRequest(
        detail(),
        {
          workspaceId: 'workspace-1',
          pipelineResolution: { status: 'resolved', scopes: 'directory' },
        },
        NOW,
      ),
    ).toMatchObject({ ok: false });
  });

  it('persists narrowing and fails closed on missing or incompatible resolution', () => {
    const source = detail();
    source.automation.version = 3;
    source.automation.targetRequirement = { contexts: ['cowork'] };
    expect(
      buildInstallAutomationRequest(source, { workspaceId: 'cowork-1' }, NOW),
    ).toMatchObject({ ok: false });
    const bindings = {
      workspaceId: 'cowork-1',
      targetKind: 'cowork' as const,
      pipelineResolution: { status: 'resolved' as const, scopes: 'directory' },
    };
    expect(buildInstallAutomationRequest(source, bindings, NOW)).toMatchObject({
      ok: true,
      request: { targetRequirement: { contexts: ['cowork'] } },
    });
    expect(
      buildInstallAutomationRequest(
        source,
        { ...bindings, targetKind: 'single-repo' },
        NOW,
      ),
    ).toMatchObject({ ok: false });
    expect(
      buildInstallAutomationRequest(
        source,
        {
          ...bindings,
          pipelineResolution: { status: 'resolved', scopes: 'worktree' },
        },
        NOW,
      ),
    ).toMatchObject({ ok: false });
  });
  it('maps a bundled pipeline document to a disabled create request with provenance', () => {
    const result = buildInstallAutomationRequest(
      detail(),
      {
        targetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: 'directory' },
        workspaceId: 'workspace-1',
        inputs: { branch: 'develop', ticket: 'CAN-1' },
      },
      NOW,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request).toEqual({
      name: 'Nightly review pipeline',
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'code-review',
        pipelineSource: 'bundled',
        inputs: { branch: 'develop', ticket: 'CAN-1' },
      },
      enabled: false,
      installedFrom: {
        remoteId: detail().id,
        contentHash: 'a'.repeat(64),
        installedAt: NOW,
      },
    });
  });

  it('records a required capability package in install provenance', () => {
    const capabilityPackage = {
      version: 1 as const,
      digest: `pp:v1:${'A'.repeat(43)}`,
    };
    const result = buildInstallAutomationRequest(
      detail({
        automation: {
          ...detail().automation,
          capabilityPackage,
        },
      }),
      {
        targetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: 'directory' },
        workspaceId: 'workspace-1',
      },
      NOW,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.installedFrom?.capabilityPackage).toEqual(
      capabilityPackage,
    );
  });

  it('installs a shared pipeline only after its install pin is verified', () => {
    const installPin = {
      pipelineContentHash: 'b'.repeat(64),
      distributionMode: 'package',
      packageDigest: `pp:v1:${'b'.repeat(43)}`,
    } as const;
    const sharedRefDetail = detail({
      automation: {
        ...detail().automation,
        action: {
          type: 'worktree_pipeline',
          target: { kind: 'workspace' },
          pipeline: {
            source: 'shared',
            remoteId: '5f6b0f5e-2f66-4be4-9f8e-1f0a54a1c222',
            name: 'Team review',
            installPin,
          },
          inputKeys: [],
        },
      },
    });

    const install = buildInstallAutomationRequest(
      sharedRefDetail,
      {
        targetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: 'directory' },
        workspaceId: 'workspace-1',
        verifiedSharedPipelineInstallPin: installPin,
      },
      NOW,
    );
    expect(install.ok).toBe(true);
    if (!install.ok) return;
    expect(install.request.action).toEqual({
      type: 'worktree_pipeline',
      workspaceId: 'workspace-1',
      pipelineId: 'shared:canopy-cloud:5f6b0f5e-2f66-4be4-9f8e-1f0a54a1c222',
      pipelineSource: 'shared',
      pipelineName: 'Team review',
      sharedPipeline: {
        serverId: 'canopy-cloud',
        remoteId: '5f6b0f5e-2f66-4be4-9f8e-1f0a54a1c222',
        installPin,
      },
    });

    const mismatch = buildInstallAutomationRequest(
      sharedRefDetail,
      {
        targetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: 'directory' },
        workspaceId: 'workspace-1',
        verifiedSharedPipelineInstallPin: {
          ...installPin,
          pipelineContentHash: 'c'.repeat(64),
        },
      },
      NOW,
    );
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error).toContain('Team review');
  });

  it('maps an inline pipeline to its materialized local id without a verified pin', () => {
    const inlineDetail = detail({
      automation: {
        ...detail().automation,
        action: {
          type: 'worktree_pipeline',
          target: { kind: 'workspace' },
          pipeline: {
            source: 'inline',
            name: 'Bundled review',
            rawPipeline: 'name: Review\non: dispatch\njobs: {}\n',
            pipelineContentHash: 'b'.repeat(64),
          },
          inputKeys: [],
        },
      },
    });

    const result = buildInstallAutomationRequest(
      inlineDetail,
      {
        targetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: 'directory' },
        workspaceId: 'workspace-1',
        bundledPipelineLocalId: 'installed-pipeline-1',
      },
      NOW,
      { sourceKind: 'public' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.enabled).toBe(false);
    expect(result.request.action).toEqual({
      type: 'worktree_pipeline',
      workspaceId: 'workspace-1',
      pipelineId: 'installed-pipeline-1',
      pipelineSource: 'user',
      pipelineName: 'Bundled review',
    });
    expect(result.request.installedFrom).toEqual(
      expect.objectContaining({
        sourceKind: 'public',
        bundledPipelineLocalId: 'installed-pipeline-1',
        bundledPipelineContentHash: 'b'.repeat(64),
      }),
    );
  });

  it('fails closed when an inline pipeline has not been materialized', () => {
    const inlineDetail = detail({
      automation: {
        ...detail().automation,
        action: {
          type: 'worktree_pipeline',
          target: { kind: 'workspace' },
          pipeline: {
            source: 'inline',
            rawPipeline: 'name: Review\non: dispatch\njobs: {}\n',
            pipelineContentHash: 'b'.repeat(64),
          },
          inputKeys: [],
        },
      },
    });
    const result = buildInstallAutomationRequest(
      inlineDetail,
      {
        targetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: 'directory' },
        workspaceId: 'workspace-1',
      },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toBe(
        'Install the bundled workflow definition before installing this automation.',
      );
  });

  it('stamps curated catalog provenance for the existing install path', () => {
    const curated = detail({ id: 'daily-review' });
    const result = buildInstallAutomationRequest(
      curated,
      {
        targetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: 'directory' },
        workspaceId: 'workspace-1',
      },
      NOW,
      { sourceKind: 'curated' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.installedFrom).toMatchObject({
      remoteId: curated.id,
      sourceKind: 'curated',
    });
  });

  it('fails closed without crashing for a legacy shared ref with no pin', () => {
    const legacy = detail({
      automation: {
        ...detail().automation,
        action: {
          type: 'worktree_pipeline',
          target: { kind: 'workspace' },
          pipeline: {
            source: 'shared',
            remoteId: '5f6b0f5e-2f66-4be4-9f8e-1f0a54a1c222',
            name: 'Team review',
            installPin: {
              pipelineContentHash: 'b'.repeat(64),
              distributionMode: 'definition_only',
            },
          },
          inputKeys: [],
        },
      },
    });
    if (legacy.automation.action.type !== 'worktree_pipeline') return;
    Reflect.deleteProperty(legacy.automation.action.pipeline, 'installPin');

    const result = buildInstallAutomationRequest(
      legacy,
      {
        targetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: 'directory' },
        workspaceId: 'workspace-1',
        verifiedSharedPipelineInstallPin: {
          pipelineContentHash: 'b'.repeat(64),
          distributionMode: 'definition_only',
        },
      },
      NOW,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('could not be verified');
  });

  it('requires and maps a Cowork project for standalone prompts', () => {
    const coworkDetail = detail({
      automation: {
        ...detail().automation,
        action: {
          type: 'standalone_prompt',
          target: { kind: 'cowork' },
          prompt: 'Summarize the project.',
          plugins: [],
        },
      },
    });
    const missing = buildInstallAutomationRequest(coworkDetail, {}, NOW);
    expect(missing).toEqual({
      ok: false,
      error: 'Choose a Cowork project for this automation before installing.',
    });
    const mapped = buildInstallAutomationRequest(
      coworkDetail,
      {
        targetKind: 'cowork',
        pipelineResolution: { status: 'resolved', scopes: 'directory' },
        coworkWorkspaceId: 'cowork-project-1',
      },
      NOW,
    );
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.request.action).toEqual({
      type: 'standalone_prompt',
      chatProjectId: 'cowork-project-1',
      prompt: 'Summarize the project.',
    });
  });

  it('requires recipient pipeline bindings for curated and unresolved refs', () => {
    for (const pipeline of [
      { source: 'curated', curatedKey: 'review/default', name: 'Review' },
      { source: 'unresolved', name: 'Local review' },
    ] as const) {
      const pipelineDetail = detail({
        automation: {
          ...detail().automation,
          action: {
            type: 'worktree_pipeline',
            target: { kind: 'workspace' },
            pipeline,
            inputKeys: [],
          },
        },
      });
      const missing = buildInstallAutomationRequest(
        pipelineDetail,
        {
          targetKind: 'single-repo',
          pipelineResolution: { status: 'resolved', scopes: 'directory' },
          workspaceId: 'workspace-1',
        },
        NOW,
      );
      expect(missing.ok).toBe(false);
      if (!missing.ok)
        expect(missing.error).toBe(
          pipeline.source === 'curated'
            ? 'Import or choose the "Review" workflow before installing.'
            : 'Choose a workflow for this automation before installing.',
        );

      const mapped = buildInstallAutomationRequest(
        pipelineDetail,
        {
          targetKind: 'single-repo',
          pipelineResolution: { status: 'resolved', scopes: 'directory' },
          workspaceId: 'workspace-1',
          pipelineId: 'recipient-pipeline',
          pipelineSource: pipeline.source === 'curated' ? 'curated' : 'user',
        },
        NOW,
      );
      expect(mapped.ok).toBe(true);
      if (!mapped.ok || mapped.request.action.type !== 'worktree_pipeline')
        return;
      expect(mapped.request.action.pipelineId).toBe('recipient-pipeline');
      expect(mapped.request.action).not.toHaveProperty('sharedPipeline');
    }
  });

  it('maps prompt documents, splitting portable model config into local fields', () => {
    const result = buildInstallAutomationRequest(
      detail({
        automation: {
          version: 1,
          name: 'Morning triage',
          description: '',
          trigger: {
            kind: 'one_time',
            runAt: '2027-01-01T09:00:00.000Z',
            timezone: 'local',
          },
          action: {
            type: 'worktree_prompt',
            target: { kind: 'workspace' },
            existingBranch: 'develop',
            prompt: 'Fix the flaky tests.',
            modelConfig: { model: 'sonnet', thinkingLevel: 'high' },
            plugins: [],
            planMode: true,
            interfaceMode: 'canopy',
          },
          hasRunCondition: false,
        },
      }),
      {
        targetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: 'directory' },
        workspaceId: 'workspace-1',
        // The document's existingBranch is only a suggestion; the persisted
        // value is the recipient-confirmed binding.
        existingBranch: 'develop',
        pluginSelections: {
          collectionIds: [],
          skillRefs: [{ sourceId: 'custom:app', skillName: 'visual-review' }],
          pluginRefs: [],
        },
      },
      NOW,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.enabled).toBe(false);
    expect(result.request.action).toEqual({
      type: 'worktree_prompt',
      workspaceId: 'workspace-1',
      existingBranch: 'develop',
      prompt: 'Fix the flaky tests.',
      model: 'sonnet',
      modelConfig: { thinkingLevel: 'high' },
      planMode: true,
      interfaceMode: 'canopy',
      pluginSelections: {
        collectionIds: [],
        skillRefs: [{ sourceId: 'custom:app', skillName: 'visual-review' }],
        pluginRefs: [],
      },
    });
  });

  it('restores the exact shared Codex speed into the local model config', () => {
    const result = buildInstallAutomationRequest(
      detail({
        automation: {
          version: 1,
          name: 'Morning triage',
          description: '',
          trigger: {
            kind: 'one_time',
            runAt: '2027-01-01T09:00:00.000Z',
            timezone: 'local',
          },
          action: {
            type: 'app_advisor_prompt',
            prompt: 'Triage the inbox.',
            modelConfig: {
              model: 'gpt-6-sol',
              speed: 'ultrafast',
              fastMode: false,
            },
            plugins: [],
          },
          hasRunCondition: false,
        },
      }),
      {},
      NOW,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.action).toMatchObject({
      type: 'app_advisor_prompt',
      model: 'gpt-6-sol',
      modelConfig: { speed: 'ultrafast', fastMode: false },
    });
  });

  it('never applies the document branch suggestion without recipient confirmation', () => {
    const result = buildInstallAutomationRequest(
      detail({
        automation: {
          version: 1,
          name: 'Morning triage',
          description: '',
          trigger: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
          action: {
            type: 'worktree_prompt',
            target: { kind: 'workspace' },
            existingBranch: 'authors-branch',
            prompt: 'Fix things.',
            plugins: [],
          },
          hasRunCondition: false,
        },
      }),
      {
        targetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: 'directory' },
        workspaceId: 'workspace-1',
      },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.action).not.toHaveProperty('existingBranch');
  });

  it('requires a project for worktree actions and restricts inputs to the documented keys', () => {
    const missingWorkspace = buildInstallAutomationRequest(detail(), {}, NOW);
    expect(missingWorkspace.ok).toBe(false);
    if (!missingWorkspace.ok) {
      expect(missingWorkspace.error).toContain('project');
    }

    const strayInput = buildInstallAutomationRequest(
      detail(),
      {
        targetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: 'directory' },
        workspaceId: 'workspace-1',
        inputs: { branch: 'develop', sneaky: 'value' },
      },
      NOW,
    );
    expect(strayInput.ok).toBe(false);
    if (!strayInput.ok) {
      expect(strayInput.error).toContain('sneaky');
    }
  });

  it('installs app_advisor_prompt documents without project bindings', () => {
    const result = buildInstallAutomationRequest(
      detail({
        automation: {
          version: 1,
          name: 'Inbox triage',
          description: '',
          trigger: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
          action: {
            type: 'app_advisor_prompt',
            prompt: 'Triage the inbox.',
            plugins: [],
          },
          hasRunCondition: false,
        },
      }),
      {},
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.action).toEqual({
      type: 'app_advisor_prompt',
      prompt: 'Triage the inbox.',
    });
  });
});

describe('buildApplyUpdateRequest', () => {
  it('requires a Cowork choice and disables a cross-action update with an unchanged schedule', () => {
    const incoming = detail();
    incoming.automation.action = {
      type: 'standalone_prompt',
      target: { kind: 'cowork' },
      prompt: 'Check CI',
      plugins: [],
    };
    expect(
      buildApplyUpdateRequest(
        incoming,
        installedActivity(),
        {
          targetKind: 'single-repo',
          pipelineResolution: { status: 'resolved', scopes: 'directory' },
          workspaceId: 'workspace-1',
        },
        NOW,
      ),
    ).toMatchObject({ ok: false });
    expect(
      buildApplyUpdateRequest(
        incoming,
        installedActivity(),
        {
          targetKind: 'cowork',
          pipelineResolution: { status: 'resolved', scopes: 'directory' },
          coworkWorkspaceId: 'cowork-1',
        },
        NOW,
      ),
    ).toMatchObject({
      ok: true,
      keptEnabled: false,
      request: {
        enabled: false,
        action: { type: 'standalone_prompt', chatProjectId: 'cowork-1' },
      },
    });
  });
  function installedActivity(
    overrides: Partial<ScheduledActivity> = {},
  ): ScheduledActivity {
    return {
      version: 1,
      id: 'activity-installed',
      name: 'Nightly review pipeline',
      enabled: true,
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'code-review',
        pipelineSource: 'bundled',
        inputs: { branch: 'develop', ticket: 'CAN-1' },
      },
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      failureCount: 0,
      installedFrom: {
        remoteId: detail().id,
        contentHash: 'old'.padEnd(64, '0'),
        installedAt: '2026-08-01T00:00:00.000Z',
        firstEnableReportedAt: '2026-08-02T00:00:00.000Z',
      },
      ...overrides,
    };
  }

  it('keeps the enabled state when the trigger is unchanged and refreshes provenance', () => {
    const result = buildApplyUpdateRequest(
      detail(),
      installedActivity(),
      {
        targetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: 'directory' },
        workspaceId: 'workspace-1',
        inputs: { branch: 'develop', ticket: 'CAN-1' },
      },
      NOW,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.keptEnabled).toBe(true);
    expect(result.request.id).toBe('activity-installed');
    expect(result.request.enabled).toBe(true);
    expect(result.request.installedFrom).toEqual({
      remoteId: detail().id,
      contentHash: 'a'.repeat(64),
      installedAt: '2026-08-01T00:00:00.000Z',
      firstEnableReportedAt: '2026-08-02T00:00:00.000Z',
    });
  });

  it('reuses the recorded bundled pipeline id when applying an inline update', () => {
    const inlineDetail = detail({
      automation: {
        ...detail().automation,
        action: {
          type: 'worktree_pipeline',
          target: { kind: 'workspace' },
          pipeline: {
            source: 'inline',
            rawPipeline: 'name: Review\non: dispatch\njobs: {}\n',
            pipelineContentHash: 'c'.repeat(64),
          },
          inputKeys: [],
        },
      },
    });
    const existing = installedActivity({
      installedFrom: {
        remoteId: detail().id,
        contentHash: 'old'.padEnd(64, '0'),
        installedAt: '2026-08-01T00:00:00.000Z',
        sourceKind: 'public',
        bundledPipelineLocalId: 'installed-pipeline-1',
      },
    });

    const result = buildApplyUpdateRequest(
      inlineDetail,
      existing,
      {
        targetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: 'directory' },
        workspaceId: 'workspace-1',
      },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.request.action?.type !== 'worktree_pipeline')
      return;
    expect(result.request.action.pipelineId).toBe('installed-pipeline-1');
    expect(result.request.installedFrom).toEqual(
      expect.objectContaining({
        sourceKind: 'public',
        bundledPipelineLocalId: 'installed-pipeline-1',
        bundledPipelineContentHash: 'c'.repeat(64),
      }),
    );
  });

  it('clears bundled pipeline provenance when an update is no longer inline', () => {
    const promptDetail = detail({
      automation: {
        version: 1,
        name: 'Morning triage',
        description: '',
        trigger: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
        action: {
          type: 'worktree_prompt',
          target: { kind: 'workspace' },
          prompt: 'Fix things.',
          plugins: [],
        },
        hasRunCondition: false,
      },
    });
    const existing = installedActivity({
      installedFrom: {
        remoteId: detail().id,
        contentHash: 'old'.padEnd(64, '0'),
        installedAt: '2026-08-01T00:00:00.000Z',
        sourceKind: 'public',
        bundledPipelineLocalId: 'installed-pipeline-1',
        bundledPipelineContentHash: 'c'.repeat(64),
      },
    });

    const result = buildApplyUpdateRequest(
      promptDetail,
      existing,
      {
        targetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: 'directory' },
        workspaceId: 'workspace-1',
      },
      NOW,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.installedFrom).not.toHaveProperty(
      'bundledPipelineLocalId',
    );
    expect(result.request.installedFrom).not.toHaveProperty(
      'bundledPipelineContentHash',
    );
  });

  it('preserves hand-edited machine bindings and pipeline settings when the project is unchanged', () => {
    const result = buildApplyUpdateRequest(
      detail(),
      installedActivity({
        action: {
          type: 'worktree_pipeline',
          workspaceId: 'workspace-1',
          pipelineId: 'code-review',
          pipelineSource: 'bundled',
          baseWorktreeId: 'worktree-7',
          repoId: 'repo-api',
          modelAliasPreferences: {
            reviewer: { mode: 'inline', base: 'sonnet' },
          },
          pluginCollectionPreferences: { disabledDefaultKeys: ['x'] },
          modelConfig: { thinkingLevel: 'high' },
          inputs: { branch: 'develop', ticket: 'CAN-1' },
        },
      }),
      {
        targetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: 'directory' },
        workspaceId: 'workspace-1',
        inputs: { branch: 'develop', ticket: 'CAN-1' },
      },
      NOW,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.action).toEqual(
      expect.objectContaining({
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        baseWorktreeId: 'worktree-7',
        repoId: 'repo-api',
        modelAliasPreferences: {
          reviewer: { mode: 'inline', base: 'sonnet' },
        },
        pluginCollectionPreferences: { disabledDefaultKeys: ['x'] },
        modelConfig: { thinkingLevel: 'high' },
      }),
    );
  });

  it('clears local customizations on an explicit rebind to another project', () => {
    const result = buildApplyUpdateRequest(
      detail(),
      installedActivity({
        action: {
          type: 'worktree_pipeline',
          workspaceId: 'workspace-1',
          pipelineId: 'code-review',
          pipelineSource: 'bundled',
          baseWorktreeId: 'worktree-7',
          repoId: 'repo-api',
          inputs: { branch: 'develop', ticket: 'CAN-1' },
        },
      }),
      {
        targetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: 'directory' },
        workspaceId: 'workspace-2',
        inputs: { branch: 'develop', ticket: 'CAN-1' },
      },
      NOW,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.action).not.toHaveProperty('baseWorktreeId');
    expect(result.request.action).not.toHaveProperty('repoId');
  });

  it('preserves a worktree_prompt baseWorktreeId unless a confirmed branch replaces it', () => {
    const promptDetail = detail({
      automation: {
        version: 1,
        name: 'Morning triage',
        description: '',
        trigger: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
        action: {
          type: 'worktree_prompt',
          target: { kind: 'workspace' },
          prompt: 'Fix things.',
          plugins: [],
        },
        hasRunCondition: false,
      },
    });
    const existing = installedActivity({
      action: {
        type: 'worktree_prompt',
        workspaceId: 'workspace-1',
        baseWorktreeId: 'worktree-7',
        prompt: 'Fix things.',
      },
    });

    const preserved = buildApplyUpdateRequest(
      promptDetail,
      existing,
      {
        targetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: 'directory' },
        workspaceId: 'workspace-1',
      },
      NOW,
    );
    expect(preserved.ok).toBe(true);
    if (!preserved.ok) return;
    expect(preserved.request.action).toEqual(
      expect.objectContaining({ baseWorktreeId: 'worktree-7' }),
    );

    // baseWorktreeId and existingBranch are mutually exclusive: a
    // recipient-confirmed branch wins over the retained worktree base.
    const rebased = buildApplyUpdateRequest(
      promptDetail,
      existing,
      {
        targetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: 'directory' },
        workspaceId: 'workspace-1',
        existingBranch: 'develop',
      },
      NOW,
    );
    expect(rebased.ok).toBe(true);
    if (!rebased.ok) return;
    expect(rebased.request.action).not.toHaveProperty('baseWorktreeId');
    expect(rebased.request.action).toEqual(
      expect.objectContaining({ existingBranch: 'develop' }),
    );
  });

  it('preserves local sidebar group names for unchanged prompt destinations across shared and curated updates', () => {
    type Bindings = Parameters<typeof buildApplyUpdateRequest>[2];
    const cases: Array<{
      sharedAction: SharedAutomationDetail['automation']['action'];
      localAction: ScheduledActivity['action'];
      bindings: Bindings;
    }> = [
      {
        sharedAction: {
          type: 'app_advisor_prompt',
          prompt: 'Updated App Advisor prompt',
          plugins: [],
        },
        localAction: {
          type: 'app_advisor_prompt',
          prompt: 'Original App Advisor prompt',
          sidebarGroupName: 'Operations',
        },
        bindings: {},
      },
      {
        sharedAction: {
          type: 'standalone_prompt',
          target: { kind: 'cowork' },
          prompt: 'Updated Cowork prompt',
          plugins: [],
        },
        localAction: {
          type: 'standalone_prompt',
          chatProjectId: 'cowork-one',
          prompt: 'Original Cowork prompt',
          sidebarGroupName: 'Operations',
        },
        bindings: { targetKind: 'cowork', coworkWorkspaceId: 'cowork-one' },
      },
      {
        sharedAction: {
          type: 'worktree_prompt',
          target: { kind: 'workspace' },
          prompt: 'Updated worktree prompt',
          plugins: [],
        },
        localAction: {
          type: 'worktree_prompt',
          workspaceId: 'workspace-one',
          prompt: 'Original worktree prompt',
          sidebarGroupName: 'Operations',
        },
        bindings: {
          targetKind: 'single-repo',
          pipelineResolution: { status: 'resolved', scopes: 'directory' },
          workspaceId: 'workspace-one',
        },
      },
    ];

    for (const { sharedAction, localAction, bindings } of cases) {
      for (const sourceKind of ['public', 'curated'] as const) {
        const result = buildApplyUpdateRequest(
          promptDocument(sharedAction),
          installedActivity({ action: localAction }),
          bindings,
          NOW,
          { sourceKind },
        );

        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        expect(result.request.action).toEqual(
          expect.objectContaining({ sidebarGroupName: 'Operations' }),
        );
        expect(result.request.installedFrom?.sourceKind).toBe(sourceKind);
      }
    }
  });

  it('drops a local sidebar group name when the destination or action type changes', () => {
    const worktreeDetail = promptDocument({
      type: 'worktree_prompt',
      target: { kind: 'workspace' },
      prompt: 'Updated prompt',
      plugins: [],
    });
    const worktreeExisting = installedActivity({
      action: {
        type: 'worktree_prompt',
        workspaceId: 'workspace-one',
        prompt: 'Original prompt',
        sidebarGroupName: 'Operations',
      },
    });
    const changedWorkspace = buildApplyUpdateRequest(
      worktreeDetail,
      worktreeExisting,
      {
        targetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: 'directory' },
        workspaceId: 'workspace-two',
      },
      NOW,
    );
    expect(changedWorkspace.ok).toBe(true);
    if (!changedWorkspace.ok) return;
    expect(changedWorkspace.request.action).not.toHaveProperty(
      'sidebarGroupName',
    );

    const coworkDetail = promptDocument({
      type: 'standalone_prompt',
      target: { kind: 'cowork' },
      prompt: 'Updated cowork prompt',
      plugins: [],
    });
    const coworkExisting = installedActivity({
      action: {
        type: 'standalone_prompt',
        chatProjectId: 'cowork-one',
        prompt: 'Original cowork prompt',
        sidebarGroupName: 'Operations',
      },
    });
    const changedCowork = buildApplyUpdateRequest(
      coworkDetail,
      coworkExisting,
      { targetKind: 'cowork', coworkWorkspaceId: 'cowork-two' },
      NOW,
    );
    expect(changedCowork.ok).toBe(true);
    if (!changedCowork.ok) return;
    expect(changedCowork.request.action).not.toHaveProperty('sidebarGroupName');

    const changedType = buildApplyUpdateRequest(
      worktreeDetail,
      installedActivity({
        action: {
          type: 'app_advisor_prompt',
          prompt: 'Original App Advisor prompt',
          sidebarGroupName: 'Operations',
        },
      }),
      {
        targetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: 'directory' },
        workspaceId: 'workspace-one',
      },
      NOW,
    );
    expect(changedType.ok).toBe(true);
    if (!changedType.ok) return;
    expect(changedType.request.action).not.toHaveProperty('sidebarGroupName');
  });

  it('treats blank local sidebar group names as absent', () => {
    const result = buildApplyUpdateRequest(
      promptDocument({
        type: 'worktree_prompt',
        target: { kind: 'workspace' },
        prompt: 'Updated prompt',
        plugins: [],
      }),
      installedActivity({
        action: {
          type: 'worktree_prompt',
          workspaceId: 'workspace-one',
          prompt: 'Original prompt',
          sidebarGroupName: '  \t ',
        },
      }),
      {
        targetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: 'directory' },
        workspaceId: 'workspace-one',
      },
      NOW,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.action).not.toHaveProperty('sidebarGroupName');
  });

  it('drops to disabled when the trigger changed', () => {
    const result = buildApplyUpdateRequest(
      detail({
        automation: {
          ...detail().automation,
          trigger: { kind: 'cron', expression: '0 6 * * *', timezone: 'local' },
        },
      }),
      installedActivity(),
      {
        targetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: 'directory' },
        workspaceId: 'workspace-1',
        inputs: { branch: 'develop', ticket: 'CAN-1' },
      },
      NOW,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.keptEnabled).toBe(false);
    expect(result.request.enabled).toBe(false);
    expect(result.request.schedule).toEqual({
      kind: 'cron',
      expression: '0 6 * * *',
      timezone: 'local',
    });
  });
});

describe('pipeline destinations', () => {
  function destinationDetail(kind: string): SharedAutomationDetail {
    const base = detail();
    const action = base.automation.action;
    if (action.type !== 'worktree_pipeline') throw new Error('pipeline');
    return detail({
      automation: {
        ...base.automation,
        version: 6,
        hasRunCondition: false,
        action: {
          ...action,
          target:
            kind === 'workspace'
              ? { kind: 'workspace' }
              : kind === 'global'
                ? { kind: 'global' }
                : kind === 'task'
                  ? { kind: 'task' }
                  : kind === 'project'
                    ? { kind: 'project' }
                    : { kind: 'new_worktree' },
        },
      },
    });
  }

  it('installs a global destination with no project picker', () => {
    expect(
      buildInstallAutomationRequest(
        destinationDetail('global'),
        { pipelineResolution: { status: 'resolved', scopes: ['global'] } },
        NOW,
      ),
    ).toMatchObject({
      ok: true,
      request: {
        enabled: false,
        action: {
          type: 'worktree_pipeline',
          target: { kind: 'global' },
          pipelineId: 'code-review',
        },
      },
    });
    const result = buildInstallAutomationRequest(
      destinationDetail('global'),
      { pipelineResolution: { status: 'resolved', scopes: ['global'] } },
      NOW,
    );
    if (result.ok)
      expect(result.request.action).not.toHaveProperty('workspaceId');
  });

  it('refuses a global destination whose pipeline needs a project', () => {
    expect(
      buildInstallAutomationRequest(
        destinationDetail('global'),
        { pipelineResolution: { status: 'resolved', scopes: ['directory'] } },
        NOW,
      ),
    ).toMatchObject({ ok: false });
  });

  it('requires a recipient task for a task destination', () => {
    const bindings = {
      targetKind: 'single-repo' as const,
      pipelineResolution: { status: 'resolved' as const, scopes: ['worktree'] },
      workspaceId: 'workspace-1',
    };
    expect(
      buildInstallAutomationRequest(destinationDetail('task'), bindings, NOW),
    ).toEqual({ ok: false, error: 'Pick a task to run the workflow in.' });
    expect(
      buildInstallAutomationRequest(
        destinationDetail('task'),
        { ...bindings, taskId: 'wt-9' },
        NOW,
      ),
    ).toMatchObject({
      ok: true,
      request: {
        action: {
          workspaceId: 'workspace-1',
          target: { kind: 'task', taskId: 'wt-9' },
        },
      },
    });
  });

  it('installs project and new worktree destinations on a recipient project', () => {
    expect(
      buildInstallAutomationRequest(
        destinationDetail('project'),
        {
          targetKind: 'single-repo',
          pipelineResolution: { status: 'resolved', scopes: ['directory'] },
          workspaceId: 'workspace-1',
        },
        NOW,
      ),
    ).toMatchObject({
      ok: true,
      request: {
        action: { workspaceId: 'workspace-1', target: { kind: 'project' } },
      },
    });
    expect(
      buildInstallAutomationRequest(
        destinationDetail('new_worktree'),
        {
          targetKind: 'cowork',
          pipelineResolution: { status: 'resolved', scopes: ['directory'] },
          workspaceId: 'cowork-1',
        },
        NOW,
      ),
    ).toMatchObject({ ok: false });
  });

  it('installs a portable workspace destination as a legacy action', () => {
    const result = buildInstallAutomationRequest(
      destinationDetail('workspace'),
      {
        targetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: ['directory'] },
        workspaceId: 'workspace-1',
      },
      NOW,
    );
    expect(result).toMatchObject({
      ok: true,
      request: { action: { workspaceId: 'workspace-1' } },
    });
    if (result.ok) expect(result.request.action).not.toHaveProperty('target');
  });

  it('keeps a task binding across an update and disables a kind change', () => {
    const existing: ScheduledActivity = {
      version: 1,
      id: 'activity-installed',
      name: 'Nightly review pipeline',
      enabled: true,
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        target: { kind: 'task', taskId: 'wt-9' },
        pipelineId: 'code-review',
        pipelineSource: 'bundled',
      },
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      failureCount: 0,
      installedFrom: {
        remoteId: detail().id,
        contentHash: 'old'.padEnd(64, '0'),
        installedAt: '2026-08-01T00:00:00.000Z',
      },
    };
    const bindings = {
      targetKind: 'single-repo' as const,
      pipelineResolution: { status: 'resolved' as const, scopes: ['worktree'] },
      workspaceId: 'workspace-1',
    };
    expect(
      buildApplyUpdateRequest(
        destinationDetail('task'),
        existing,
        bindings,
        NOW,
      ),
    ).toMatchObject({
      ok: true,
      keptEnabled: true,
      request: { action: { target: { kind: 'task', taskId: 'wt-9' } } },
    });
    // A kind change needs the new destination's own compatibility and
    // leaves the copy off until the recipient turns it on again.
    expect(
      buildApplyUpdateRequest(
        destinationDetail('project'),
        existing,
        bindings,
        NOW,
      ),
    ).toMatchObject({ ok: false });
    expect(
      buildApplyUpdateRequest(
        destinationDetail('project'),
        existing,
        {
          ...bindings,
          pipelineResolution: { status: 'resolved', scopes: ['directory'] },
        },
        NOW,
      ),
    ).toMatchObject({
      ok: true,
      keptEnabled: false,
      request: { enabled: false, action: { target: { kind: 'project' } } },
    });
    expect(
      buildApplyUpdateRequest(
        destinationDetail('new_worktree'),
        existing,
        bindings,
        NOW,
      ),
    ).toMatchObject({ ok: true, keptEnabled: false });
  });
});

describe('approved run conditions', () => {
  const SHARED_COMMAND = 'test -f ready';

  /** `null` builds a v4 document without a run condition. */
  function gatedDetail(
    runCondition: { command: string } | null = {
      command: SHARED_COMMAND,
    },
  ): SharedAutomationDetail {
    return detail({
      actionType: 'app_advisor_prompt',
      automation: {
        version: 4,
        name: 'Inbox triage',
        description: '',
        trigger: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
        action: {
          type: 'app_advisor_prompt',
          prompt: 'Triage the inbox.',
          plugins: [],
        },
        hasRunCondition: true,
        ...(runCondition !== null ? { runCondition } : {}),
      },
    });
  }

  function gatedActivity(ifCommand?: string): ScheduledActivity {
    return {
      version: 1,
      id: 'activity-installed',
      name: 'Inbox triage',
      enabled: true,
      schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
      action: { type: 'app_advisor_prompt', prompt: 'Triage the inbox.' },
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      failureCount: 0,
      ...(ifCommand !== undefined ? { ifCommand } : {}),
      installedFrom: {
        remoteId: detail().id,
        contentHash: 'old'.padEnd(64, '0'),
        installedAt: '2026-08-01T00:00:00.000Z',
      },
    };
  }

  it('installs the approved command trimmed', () => {
    const result = buildInstallAutomationRequest(
      gatedDetail(),
      { approvedRunCondition: `  ${SHARED_COMMAND} && echo edited\n` },
      NOW,
    );
    expect(result).toMatchObject({
      ok: true,
      request: { ifCommand: `${SHARED_COMMAND} && echo edited` },
    });
  });

  it.each([undefined, '', '   '])(
    'installs with no gate when the approval is %j',
    (approvedRunCondition) => {
      const result = buildInstallAutomationRequest(
        gatedDetail(),
        approvedRunCondition === undefined ? {} : { approvedRunCondition },
        NOW,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.request).not.toHaveProperty('ifCommand');
    },
  );

  it('never stores the shared command without an approval', () => {
    const result = buildInstallAutomationRequest(gatedDetail(), {}, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.request)).not.toContain(SHARED_COMMAND);
  });

  it('replaces the local gate with an approved command on update', () => {
    const result = buildApplyUpdateRequest(
      gatedDetail(),
      gatedActivity('exit 1'),
      { approvedRunCondition: ` ${SHARED_COMMAND} ` },
      NOW,
    );
    expect(result).toMatchObject({
      ok: true,
      keptEnabled: false,
      request: {
        ifCommand: SHARED_COMMAND,
        enabled: false,
        installedFrom: { approvedRunCondition: SHARED_COMMAND },
      },
    });
  });

  it('records the approved command as install provenance', () => {
    const result = buildInstallAutomationRequest(
      gatedDetail(),
      { approvedRunCondition: ` ${SHARED_COMMAND} ` },
      NOW,
    );
    expect(result).toMatchObject({
      ok: true,
      request: { installedFrom: { approvedRunCondition: SHARED_COMMAND } },
    });
  });

  it.each([
    ['adds', undefined],
    ['changes', 'exit 1'],
  ])('lands disabled when an approved update %s the gate', (_label, gate) => {
    const result = buildApplyUpdateRequest(
      gatedDetail(),
      gatedActivity(gate),
      { approvedRunCondition: SHARED_COMMAND },
      NOW,
    );
    expect(result).toMatchObject({
      ok: true,
      keptEnabled: false,
      request: { enabled: false },
    });
  });

  it('stays enabled when the approved command matches the current gate', () => {
    const result = buildApplyUpdateRequest(
      gatedDetail(),
      gatedActivity(`${SHARED_COMMAND}\n`),
      { approvedRunCondition: SHARED_COMMAND },
      NOW,
    );
    expect(result).toMatchObject({
      ok: true,
      keptEnabled: true,
      request: { enabled: true },
    });
  });

  function shareApprovedActivity(ifCommand: string): ScheduledActivity {
    const activity = gatedActivity(ifCommand);
    return {
      ...activity,
      installedFrom: {
        remoteId: detail().id,
        contentHash: 'old'.padEnd(64, '0'),
        installedAt: '2026-08-01T00:00:00.000Z',
        approvedRunCondition: SHARED_COMMAND,
      },
    };
  }

  /** A revision whose author removed the gate entirely. */
  function ungatedDetail(version: 3 | 4): SharedAutomationDetail {
    const source = gatedDetail(null);
    return {
      ...source,
      automation: { ...source.automation, version, hasRunCondition: false },
    };
  }

  it.each([
    ['a v4 revision', ungatedDetail(4)],
    ['a v3 revision', ungatedDetail(3)],
  ])('clears a share-approved gate on %s without a gate', (_label, source) => {
    const result = buildApplyUpdateRequest(
      source,
      shareApprovedActivity(SHARED_COMMAND),
      {},
      NOW,
    );
    expect(result).toMatchObject({ ok: true, request: { ifCommand: '' } });
    if (!result.ok) return;
    expect(result.request.installedFrom).not.toHaveProperty(
      'approvedRunCondition',
    );
  });

  it.each([
    ['a v4 revision', gatedDetail(null)],
    [
      'a v3 revision',
      {
        ...gatedDetail(null),
        automation: { ...gatedDetail(null).automation, version: 3 as const },
      },
    ],
  ])(
    'keeps a share-approved gate when %s stays gated but keeps the command private',
    (_label, source) => {
      const result = buildApplyUpdateRequest(
        source,
        shareApprovedActivity(SHARED_COMMAND),
        {},
        NOW,
      );
      expect(result).toMatchObject({
        ok: true,
        keptEnabled: true,
        request: { installedFrom: { approvedRunCondition: SHARED_COMMAND } },
      });
      if (!result.ok) return;
      expect(result.request).not.toHaveProperty('ifCommand');
    },
  );

  it('keeps a share-approved gate the recipient has since changed', () => {
    const result = buildApplyUpdateRequest(
      ungatedDetail(4),
      shareApprovedActivity('exit 1'),
      {},
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request).not.toHaveProperty('ifCommand');
    expect(result.request.installedFrom).not.toHaveProperty(
      'approvedRunCondition',
    );
  });

  it('keeps a share-approved gate and its provenance when a new command is declined', () => {
    const result = buildApplyUpdateRequest(
      gatedDetail({ command: 'test -f other' }),
      shareApprovedActivity(SHARED_COMMAND),
      {},
      NOW,
    );
    expect(result).toMatchObject({
      ok: true,
      keptEnabled: true,
      request: { installedFrom: { approvedRunCondition: SHARED_COMMAND } },
    });
    if (!result.ok) return;
    expect(result.request).not.toHaveProperty('ifCommand');
  });

  it.each([
    ['a declined shared command', gatedDetail()],
    ['a document without a run condition', gatedDetail(null)],
  ])('keeps the local gate on update for %s', (_label, source) => {
    const result = buildApplyUpdateRequest(
      source,
      gatedActivity('exit 1'),
      {},
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request).not.toHaveProperty('ifCommand');
  });
});

describe('document versions', () => {
  it('still installs version 1 through 4 prompt documents', () => {
    for (const version of [1, 2, 3, 4] as const) {
      const source = promptDocument({
        type: 'app_advisor_prompt',
        prompt: 'Triage the inbox.',
        plugins: [],
      });
      source.automation.version = version;
      expect(buildInstallAutomationRequest(source, {}, NOW)).toMatchObject({
        ok: true,
        request: { action: { prompt: 'Triage the inbox.' } },
      });
    }
  });

  it('asks for a newer app instead of showing validator text for an unknown version', () => {
    const source = promptDocument({
      type: 'app_advisor_prompt',
      prompt: 'Triage the inbox.',
      plugins: [],
    });
    Reflect.set(source.automation, 'version', 7);
    Reflect.set(source.automation.action, 'futureField', true);
    expect(buildInstallAutomationRequest(source, {}, NOW)).toEqual({
      ok: false,
      error: SHARED_AUTOMATION_NEWER_VERSION_MESSAGE,
    });
    const existing: ScheduledActivity = {
      version: 1,
      id: 'activity-installed',
      name: 'Inbox triage',
      enabled: true,
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: { type: 'app_advisor_prompt', prompt: 'Triage the inbox.' },
      createdAt: NOW,
      updatedAt: NOW,
      failureCount: 0,
    };
    expect(buildApplyUpdateRequest(source, existing, {}, NOW)).toEqual({
      ok: false,
      error: SHARED_AUTOMATION_NEWER_VERSION_MESSAGE,
    });
    expect(SHARED_AUTOMATION_NEWER_VERSION_MESSAGE).toMatch(
      /^This share needs a newer version/,
    );
  });
});

describe('packaged pipelines (shared document v5)', () => {
  const capabilityPackage = {
    version: 1 as const,
    digest: `pp:v1:${'A'.repeat(43)}`,
  };
  const AUTHOR_ENTRY = 'C9F0F895-FB98-4B91-8C6E-2A5C1D0E4B22';
  const AUTHOR_WORKER = '8f14e45f-ceea-467a-9575-0b5b4b2b1c11';
  const ENTRY_KEY = AUTHOR_ENTRY.toLowerCase();
  const WORKER_KEY = AUTHOR_WORKER;
  const LOCAL_ENTRY = 'A1B2C3D4-0000-4000-8000-00000000000A';
  const LOCAL_WORKER = 'b1b2c3d4-0000-4000-8000-00000000000b';
  const PROMPT = `See notes.md. Run ${AUTHOR_ENTRY} with ${AUTHOR_WORKER}; if ${AUTHOR_ENTRY} fails, retry.`;

  function spansOf(
    prompt: string,
    text: string,
  ): Array<{ textStart: number; text: string }> {
    const spans: Array<{ textStart: number; text: string }> = [];
    for (
      let index = prompt.indexOf(text);
      index !== -1;
      index = prompt.indexOf(text, index + text.length)
    ) {
      spans.push({ textStart: index, text });
    }
    return spans;
  }

  function dependency(
    key: string,
    spanText: string,
    pipelineContentHash: string,
    prompt = PROMPT,
  ): SharedAutomationPipelineDependency {
    return {
      key,
      pipeline: { source: 'packaged', key, pipelineContentHash, name: key },
      promptSpans: spansOf(prompt, spanText),
    };
  }

  function promptShare(
    dependencies: SharedAutomationPipelineDependency[],
    prompt = PROMPT,
  ): SharedAutomationDetail {
    const automation: SharedAutomationDocument = {
      version: 5,
      name: 'Specialists',
      description: '',
      trigger: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
      action: {
        type: 'app_advisor_prompt',
        prompt,
        ...(prompt.startsWith('See notes.md')
          ? {
              promptReferences: [
                {
                  kind: 'file' as const,
                  textStart: 4,
                  displayText: 'notes.md',
                  root: { kind: 'workspace' as const },
                  relativePath: 'notes.md',
                },
              ],
            }
          : {}),
        pipelineDependencies: dependencies,
        plugins: [],
      },
      capabilityPackage,
      hasRunCondition: false,
    };
    expect(validateSharedAutomationDocument(automation)).toMatchObject({
      ok: true,
    });
    return detail({ actionType: 'app_advisor_prompt', automation });
  }

  function pipelineShare(pipelineContentHash: string): SharedAutomationDetail {
    const automation: SharedAutomationDocument = {
      version: 5,
      name: 'Nightly review pipeline',
      description: '',
      trigger: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        target: { kind: 'workspace' },
        pipeline: {
          source: 'packaged',
          key: 'action',
          pipelineContentHash,
          name: 'Review',
        },
        inputKeys: [],
      },
      capabilityPackage,
      hasRunCondition: false,
    };
    expect(validateSharedAutomationDocument(automation)).toMatchObject({
      ok: true,
    });
    return detail({ automation });
  }

  const pipelineBindings = {
    targetKind: 'single-repo' as const,
    pipelineResolution: { status: 'resolved' as const, scopes: 'directory' },
    workspaceId: 'workspace-1',
  };

  function installedPromptActivity(
    overrides: Partial<ScheduledActivity> = {},
  ): ScheduledActivity {
    const rewrittenPrompt = PROMPT.split(AUTHOR_ENTRY)
      .join(LOCAL_ENTRY.toLowerCase())
      .split(AUTHOR_WORKER)
      .join(LOCAL_WORKER);
    return {
      version: 1,
      id: 'activity-installed',
      name: 'Specialists',
      enabled: true,
      schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
      action: { type: 'app_advisor_prompt', prompt: rewrittenPrompt },
      createdAt: NOW,
      updatedAt: NOW,
      failureCount: 0,
      installedFrom: {
        remoteId: detail().id,
        contentHash: 'old'.padEnd(64, '0'),
        installedAt: '2026-08-01T00:00:00.000Z',
        capabilityPackage,
        pipelineDependencies: [
          {
            key: ENTRY_KEY,
            localPipelineId: LOCAL_ENTRY,
            pipelineContentHash: '1'.repeat(64),
          },
          {
            key: WORKER_KEY,
            localPipelineId: LOCAL_WORKER,
            pipelineContentHash: '2'.repeat(64),
          },
        ],
      },
      ...overrides,
    };
  }

  it('maps a packaged action pipeline like an inline one and records its provenance', () => {
    const result = buildInstallAutomationRequest(
      pipelineShare('b'.repeat(64)),
      {
        ...pipelineBindings,
        pipelineDependencies: [
          {
            key: 'action',
            localPipelineId: 'installed-pipeline-1',
            pipelineContentHash: 'b'.repeat(64),
          },
        ],
      },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.action).toEqual({
      type: 'worktree_pipeline',
      workspaceId: 'workspace-1',
      pipelineId: 'installed-pipeline-1',
      pipelineSource: 'user',
      pipelineName: 'Review',
    });
    expect(result.request.installedFrom).toEqual(
      expect.objectContaining({
        bundledPipelineLocalId: 'installed-pipeline-1',
        bundledPipelineContentHash: 'b'.repeat(64),
        capabilityPackage,
      }),
    );
    expect(result.request.installedFrom).not.toHaveProperty(
      'pipelineDependencies',
    );
  });

  it('refuses a packaged action pipeline that was not installed or does not match', () => {
    expect(
      buildInstallAutomationRequest(
        pipelineShare('b'.repeat(64)),
        pipelineBindings,
        NOW,
      ),
    ).toEqual({
      ok: false,
      error: 'Install the pipelines this automation uses before installing it.',
    });
    expect(
      buildInstallAutomationRequest(
        pipelineShare('b'.repeat(64)),
        {
          ...pipelineBindings,
          pipelineDependencies: [
            {
              key: 'action',
              localPipelineId: 'installed-pipeline-1',
              pipelineContentHash: 'c'.repeat(64),
            },
          ],
        },
        NOW,
      ),
    ).toMatchObject({ ok: false });
  });

  it('rewrites interleaved and repeated prompt mentions to lower-case local IDs', () => {
    const result = buildInstallAutomationRequest(
      promptShare([
        dependency(ENTRY_KEY, AUTHOR_ENTRY, '1'.repeat(64)),
        dependency(WORKER_KEY, AUTHOR_WORKER, '2'.repeat(64)),
      ]),
      {
        pipelineDependencies: [
          {
            key: WORKER_KEY,
            localPipelineId: LOCAL_WORKER,
            pipelineContentHash: '2'.repeat(64),
          },
          {
            key: ENTRY_KEY,
            localPipelineId: LOCAL_ENTRY,
            pipelineContentHash: '1'.repeat(64),
          },
        ],
      },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.request.action.type !== 'app_advisor_prompt')
      return;
    const prompt = result.request.action.prompt;
    expect(prompt).toBe(
      `See notes.md. Run ${LOCAL_ENTRY.toLowerCase()} with ${LOCAL_WORKER}; if ${LOCAL_ENTRY.toLowerCase()} fails, retry.`,
    );
    expect(prompt).toHaveLength(PROMPT.length);
    // Configured references keep their offsets.
    expect(result.request.action.promptReferences).toEqual([
      expect.objectContaining({ textStart: 4, displayText: 'notes.md' }),
    ]);
    expect(prompt.slice(4, 12)).toBe('notes.md');
    expect(result.request.installedFrom?.pipelineDependencies).toEqual([
      {
        key: ENTRY_KEY,
        localPipelineId: LOCAL_ENTRY,
        pipelineContentHash: '1'.repeat(64),
      },
      {
        key: WORKER_KEY,
        localPipelineId: LOCAL_WORKER,
        pipelineContentHash: '2'.repeat(64),
      },
    ]);
  });

  it('refuses a replacement that would change the prompt length', () => {
    const result = buildInstallAutomationRequest(
      promptShare([dependency(WORKER_KEY, AUTHOR_WORKER, '2'.repeat(64))]),
      {
        pipelineDependencies: [
          {
            key: WORKER_KEY,
            localPipelineId: 'installed-pipeline-1',
            pipelineContentHash: '2'.repeat(64),
          },
        ],
      },
      NOW,
    );
    expect(result).toEqual({
      ok: false,
      error: `The prompt's mention of the "${WORKER_KEY}" pipeline could not be updated to its local ID.`,
    });
  });

  it('refuses spans that no longer match or overlap a configured reference', () => {
    const localIds = new Map([[WORKER_KEY, LOCAL_WORKER]]);
    expect(
      rewriteSharedAutomationPromptPipelines(
        `Use ${AUTHOR_WORKER}.`,
        [
          {
            key: WORKER_KEY,
            pipeline: {
              source: 'packaged',
              key: WORKER_KEY,
              pipelineContentHash: '2'.repeat(64),
            },
            promptSpans: [{ textStart: 0, text: AUTHOR_WORKER }],
          },
        ],
        localIds,
      ),
    ).toMatchObject({ ok: false });
    const prompt = `Open ${AUTHOR_WORKER}.md now.`;
    expect(
      rewriteSharedAutomationPromptPipelines(
        prompt,
        [dependency(WORKER_KEY, AUTHOR_WORKER, '2'.repeat(64), prompt)],
        localIds,
        [
          {
            kind: 'file',
            textStart: 5,
            displayText: `${AUTHOR_WORKER}.md`,
            root: { kind: 'workspace' },
            relativePath: `${AUTHOR_WORKER}.md`,
          },
        ],
      ),
    ).toMatchObject({ ok: false });
  });

  it('refuses to install a prompt whose packaged dependency was not installed', () => {
    expect(
      buildInstallAutomationRequest(
        promptShare([dependency(WORKER_KEY, AUTHOR_WORKER, '2'.repeat(64))]),
        {},
        NOW,
      ),
    ).toEqual({
      ok: false,
      error: 'Install the pipelines this automation uses before installing it.',
    });
  });

  it('prefills Stage A with the recorded pipelines the update still lists', () => {
    const existing = installedPromptActivity();
    const incoming = promptShare([
      dependency(ENTRY_KEY, AUTHOR_ENTRY, '3'.repeat(64)),
      dependency(WORKER_KEY, AUTHOR_WORKER, '2'.repeat(64)),
    ]);
    expect(
      planAutomationPipelineUpdate(existing.installedFrom, incoming.automation),
    ).toEqual({
      ok: true,
      value: {
        existingPipelines: [
          {
            key: ENTRY_KEY,
            localPipelineId: LOCAL_ENTRY,
            expectedContentHash: '1'.repeat(64),
          },
          {
            key: WORKER_KEY,
            localPipelineId: LOCAL_WORKER,
            expectedContentHash: '2'.repeat(64),
          },
        ],
        dropped: [],
      },
    });
  });

  it('reuses recorded local IDs on update and rewrites the new prompt', () => {
    const existing = installedPromptActivity();
    const nextPrompt = `Now: ${AUTHOR_WORKER} first, then ${AUTHOR_ENTRY}.`;
    const incoming = promptShare(
      [
        dependency(ENTRY_KEY, AUTHOR_ENTRY, '3'.repeat(64), nextPrompt),
        dependency(WORKER_KEY, AUTHOR_WORKER, '2'.repeat(64), nextPrompt),
      ],
      nextPrompt,
    );
    // The entry pipeline changed upstream, so Stage A re-materialized it under
    // the same local ID; the unchanged worker reuses its recorded binding.
    const result = buildApplyUpdateRequest(
      incoming,
      existing,
      {
        pipelineDependencies: [
          {
            key: ENTRY_KEY,
            localPipelineId: LOCAL_ENTRY,
            pipelineContentHash: '3'.repeat(64),
          },
        ],
      },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.request.action?.type !== 'app_advisor_prompt')
      return;
    expect(result.request.action.prompt).toBe(
      `Now: ${LOCAL_WORKER} first, then ${LOCAL_ENTRY.toLowerCase()}.`,
    );
    expect(result.request.installedFrom?.pipelineDependencies).toEqual([
      {
        key: ENTRY_KEY,
        localPipelineId: LOCAL_ENTRY,
        pipelineContentHash: '3'.repeat(64),
      },
      {
        key: WORKER_KEY,
        localPipelineId: LOCAL_WORKER,
        pipelineContentHash: '2'.repeat(64),
      },
    ]);
    expect(result.droppedPipelineDependencies).toEqual([]);
  });

  it('needs a Stage A result for a dependency that changed upstream', () => {
    const result = buildApplyUpdateRequest(
      promptShare([
        dependency(ENTRY_KEY, AUTHOR_ENTRY, '3'.repeat(64)),
        dependency(WORKER_KEY, AUTHOR_WORKER, '2'.repeat(64)),
      ]),
      installedPromptActivity(),
      {},
      NOW,
    );
    expect(result).toEqual({
      ok: false,
      error: 'Install the pipelines this automation uses before installing it.',
    });
  });

  it('reports a dependency the new share no longer lists as dropped', () => {
    const prompt = `Run ${AUTHOR_WORKER}.`;
    const result = buildApplyUpdateRequest(
      promptShare(
        [dependency(WORKER_KEY, AUTHOR_WORKER, '2'.repeat(64), prompt)],
        prompt,
      ),
      installedPromptActivity(),
      {},
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.droppedPipelineDependencies).toEqual([
      {
        key: ENTRY_KEY,
        localPipelineId: LOCAL_ENTRY,
        pipelineContentHash: '1'.repeat(64),
      },
    ]);
    expect(result.request.installedFrom?.pipelineDependencies).toEqual([
      {
        key: WORKER_KEY,
        localPipelineId: LOCAL_WORKER,
        pipelineContentHash: '2'.repeat(64),
      },
    ]);
  });

  it('refuses the whole update when a recorded dependency was edited locally', () => {
    const incoming = promptShare([
      dependency(ENTRY_KEY, AUTHOR_ENTRY, '3'.repeat(64)),
      dependency(WORKER_KEY, AUTHOR_WORKER, '2'.repeat(64)),
    ]);
    const localPipelineContentHashes = {
      [LOCAL_ENTRY]: '1'.repeat(64),
      [LOCAL_WORKER]: 'f'.repeat(64),
    };
    expect(
      buildApplyUpdateRequest(
        incoming,
        installedPromptActivity(),
        {
          localPipelineContentHashes,
          pipelineDependencies: [
            {
              key: ENTRY_KEY,
              localPipelineId: LOCAL_ENTRY,
              pipelineContentHash: '3'.repeat(64),
            },
          ],
        },
        NOW,
      ),
    ).toEqual({ ok: false, error: AUTOMATION_PIPELINE_LOCAL_CHANGES_MESSAGE });
    expect(
      planAutomationPipelineUpdate(
        installedPromptActivity().installedFrom,
        incoming.automation,
        localPipelineContentHashes,
      ),
    ).toEqual({ ok: false, error: AUTOMATION_PIPELINE_LOCAL_CHANGES_MESSAGE });
    // A deleted local copy is left for Stage A to create again.
    expect(
      planAutomationPipelineUpdate(
        installedPromptActivity().installedFrom,
        incoming.automation,
        { [LOCAL_ENTRY]: '1'.repeat(64), [LOCAL_WORKER]: null },
      ),
    ).toMatchObject({
      ok: true,
      value: {
        existingPipelines: [expect.objectContaining({ key: ENTRY_KEY })],
      },
    });
  });

  it('carries an inline action pipeline over to a packaged update under the same local ID', () => {
    const existing: ScheduledActivity = {
      ...installedPromptActivity(),
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'installed-pipeline-1',
        pipelineSource: 'user',
      },
      installedFrom: {
        remoteId: detail().id,
        contentHash: 'old'.padEnd(64, '0'),
        installedAt: '2026-08-01T00:00:00.000Z',
        bundledPipelineLocalId: 'installed-pipeline-1',
        bundledPipelineContentHash: 'b'.repeat(64),
      },
    };
    const incoming = pipelineShare('b'.repeat(64));
    expect(
      planAutomationPipelineUpdate(existing.installedFrom, incoming.automation),
    ).toMatchObject({
      ok: true,
      value: {
        existingPipelines: [
          {
            key: 'action',
            localPipelineId: 'installed-pipeline-1',
            expectedContentHash: 'b'.repeat(64),
          },
        ],
        dropped: [],
      },
    });
    const result = buildApplyUpdateRequest(
      incoming,
      existing,
      pipelineBindings,
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.action).toMatchObject({
      pipelineId: 'installed-pipeline-1',
    });
    expect(result.request.installedFrom).toEqual(
      expect.objectContaining({
        bundledPipelineLocalId: 'installed-pipeline-1',
        bundledPipelineContentHash: 'b'.repeat(64),
      }),
    );
  });
});
