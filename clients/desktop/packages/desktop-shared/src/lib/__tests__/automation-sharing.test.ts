import type { AgentModelConfig, ScheduledActivity } from '../../types';
import type { ShareablePluginRef } from '@canopy/protocol/plugins';
import type { SharedAutomationModelConfig } from '@canopy/protocol/automations';
import {
  MAX_SHARED_AUTOMATION_BYTES,
  validateSharedAutomationDocument,
} from '@canopy/protocol/automations';
import type {
  PipelinePackagePackagedPipeline,
  PipelineShareInstallPin,
} from '@canopy/protocol/pipelines';
import {
  buildSharedAutomationDocument,
  automationActionUsesIfCommandOutput,
  detectRunConditionShareWarnings,
  AUTOMATION_RUN_CONDITION_SHARE_WARNING_MESSAGES,
  AUTOMATION_RUN_CONDITION_SHARE_WARNING_SHORT_LABELS,
  AUTOMATION_SHARE_BLOCK_MESSAGES,
  AUTOMATION_SHARE_NOTICE_MESSAGES,
} from '../automation-sharing';
import { AUTOMATION_IF_CMD_OUTPUT_VAR_NAMES } from '../automations';
import { buildInstallAutomationRequest } from '../automation-install';
import {
  chatAutomationToPipeline,
  ownedPipelineToChatAction,
} from '../chat-automation-conversion';
import { parsePipelineText } from '../../pipelines/parse-pipeline';
import { serializePipelineDocument } from '@canopy/pipeline-interop/serialize-pipeline';

const pluginRef: ShareablePluginRef = {
  type: 'skill',
  source: { type: 'builtin', id: 'app' },
  skill_name: 'commit-messages',
};

const SECRET_WORKSPACE_ID = 'ws-secret-1234';
const SECRET_WORKTREE_ID = 'wt-secret-5678';
const SECRET_IF_COMMAND = 'curl -H "Authorization: Bearer sk-SECRET-TOKEN"';
const SECRET_INPUT_VALUE = 'ghp_secretInputValue';
const SECRET_WORKSPACE_NAME = 'Secret Client Project';
const SHARED_PIPELINE_INSTALL_PIN: PipelineShareInstallPin = {
  pipelineContentHash: 'a'.repeat(64),
  distributionMode: 'package',
  packageDigest: `pp:v1:${'a'.repeat(43)}`,
};

function baseActivity(
  overrides: Partial<ScheduledActivity> = {},
): ScheduledActivity {
  return {
    version: 1,
    id: 'activity-1',
    name: 'Nightly triage',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
    action: {
      type: 'app_advisor_prompt',
      prompt: 'Triage the inbox.',
    },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    lastRunAt: '2026-08-17T02:00:00.000Z',
    failureCount: 3,
    lastResult: {
      status: 'failure',
      completedAt: '2026-08-17T02:00:05.000Z',
      message: `Failed in /Users/author/${SECRET_WORKSPACE_NAME}`,
    },
    ...overrides,
  };
}

function expectAbsent(serialized: string, sentinels: string[]): void {
  for (const sentinel of sentinels) {
    expect(serialized).not.toContain(sentinel);
  }
}

it('shares a Cowork session as a Cowork prompt and strips plan mode', () => {
  const options = { description: '', sessionTargetKind: 'cowork' as const };
  const result = buildSharedAutomationDocument(
    baseActivity({
      action: {
        type: 'worktree_session_prompt',
        workspaceId: 'cowork-1',
        worktreeId: 'entry-1',
        chatId: 'chat-1',
        prompt: 'Check CI',
        planMode: true,
      },
    }),
    options,
  );
  expect(result).toMatchObject({
    ok: true,
    document: {
      action: { type: 'standalone_prompt', target: { kind: 'cowork' } },
    },
  });
  if (result.ok) {
    expect(result.document.action).not.toHaveProperty('planMode');
    expect(result.notices).toContain('plan_mode_stripped');
  }
});

it('blocks session shares without a resolved kind', () => {
  expect(
    buildSharedAutomationDocument(
      baseActivity({
        action: {
          type: 'worktree_session_prompt',
          workspaceId: 'missing',
          worktreeId: 'entry',
          chatId: 'chat',
          prompt: 'Run',
        },
      }),
      { description: '' },
    ),
  ).toMatchObject({ ok: false, reasons: ['session_target_unresolved'] });
});

it.each([
  ['cowork', 'standalone_prompt'],
  ['app_advisor', 'app_advisor_prompt'],
  ['single-repo', 'worktree_prompt'],
  ['multi-repo', 'worktree_prompt'],
] as const)('maps a %s session to %s', (sessionTargetKind, type) => {
  const result = buildSharedAutomationDocument(
    baseActivity({
      action: {
        type: 'worktree_session_prompt',
        workspaceId: 'project',
        worktreeId: 'entry',
        chatId: 'chat',
        prompt: 'Run',
        planMode: true,
      },
    }),
    { description: '', sessionTargetKind },
  );
  expect(result).toMatchObject({
    ok: true,
    document: { version: 1, action: { type } },
  });
  if (result.ok) {
    expect(result.document.action).not.toHaveProperty('chatId');
    if (type === 'worktree_prompt')
      expect(result.document.action).toHaveProperty('planMode', true);
    else expect(result.notices).toContain('plan_mode_stripped');
  }
});

it('emits v3 for stored pipeline narrowing and blocks unresolved or incompatible definitions', () => {
  const activity = baseActivity({
    action: {
      type: 'worktree_pipeline',
      workspaceId: 'cowork-1',
      pipelineId: 'review',
      pipelineSource: 'bundled',
    },
    targetRequirement: { contexts: ['cowork'] },
  });
  expect(
    buildSharedAutomationDocument(activity, { description: '' }),
  ).toMatchObject({ ok: false });
  expect(
    buildSharedAutomationDocument(activity, {
      description: '',
      pipelineResolution: { status: 'resolved', scopes: 'directory' },
    }),
  ).toMatchObject({
    ok: true,
    document: { version: 3, targetRequirement: { contexts: ['cowork'] } },
  });
  expect(
    buildSharedAutomationDocument(activity, {
      description: '',
      pipelineResolution: { status: 'resolved', scopes: 'worktree' },
    }),
  ).toMatchObject({ ok: false });
  expect(
    buildSharedAutomationDocument(activity, {
      description: '',
      declaredTargetContexts: ['app_advisor'],
      pipelineResolution: { status: 'resolved', scopes: 'directory' },
    }),
  ).toMatchObject({ ok: false, reasons: ['document_invalid'] });
});

it('falls back to an unresolved ref when a curated key is unavailable', () => {
  const result = buildSharedAutomationDocument(
    baseActivity({
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'curated:review',
        pipelineSource: 'curated',
      },
    }),
    {
      description: '',
      sessionTargetKind: 'single-repo',
      pipelineResolution: { status: 'resolved', scopes: ['directory'] },
    },
  );
  expect(result.ok).toBe(true);
  if (!result.ok || result.document.action.type !== 'worktree_pipeline') return;
  expect(result.document.action.pipeline).toEqual({
    source: 'unresolved',
  });
  expect(result.notices).toContain('pipeline_reference_unresolved');
});

describe('buildSharedAutomationDocument', () => {
  it('carries logical file references in a versioned portable document', () => {
    const references = [
      {
        kind: 'file' as const,
        textStart: 5,
        displayText: 'src/a.ts',
        root: { kind: 'workspace' as const },
        relativePath: 'src/a.ts',
      },
    ];
    const result = buildSharedAutomationDocument(
      baseActivity({
        action: {
          type: 'worktree_prompt',
          workspaceId: 'workspace-1',
          prompt: 'Read src/a.ts',
          promptReferences: references,
        } satisfies ScheduledActivity['action'],
      }),
      {
        description: '',
        sessionTargetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: ['directory'] },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.document.action.type !== 'worktree_prompt') return;
    expect(result.document.version).toBe(2);
    expect(result.document.action.promptReferences).toEqual(references);
  });

  it('builds a portable app_advisor_prompt document and strips run state', () => {
    const result = buildSharedAutomationDocument(
      baseActivity({
        action: {
          type: 'app_advisor_prompt',
          prompt: 'Triage the inbox.',
          sidebarGroupName: 'Local only',
        },
      }),
      {
        description: 'Runs a triage prompt every night.',
        resolvedPlugins: [pluginRef],
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document).toEqual({
      version: 1,
      name: 'Nightly triage',
      description: 'Runs a triage prompt every night.',
      trigger: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: {
        type: 'app_advisor_prompt',
        prompt: 'Triage the inbox.',
        plugins: [pluginRef],
      },
      hasRunCondition: false,
    });
    expect(result.notices).toEqual([]);
    const serialized = JSON.stringify(result.document);
    expectAbsent(serialized, [
      'activity-1',
      'lastRunAt',
      'failureCount',
      SECRET_WORKSPACE_NAME,
    ]);
  });

  it('never shares the owner or the agent that wrote the automation', () => {
    const result = buildSharedAutomationDocument(
      baseActivity({
        executionContext: 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        agentAuthor: {
          chat: {
            projectId: SECRET_WORKSPACE_ID,
            worktreeId: SECRET_WORKTREE_ID,
            chatId: 'chat-secret-9012',
          },
          recordedAt: '2026-10-19T00:00:00.000Z',
        },
      }),
      { description: '' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expectAbsent(JSON.stringify(result.document), [
      'executionContext',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'agentAuthor',
      SECRET_WORKSPACE_ID,
      SECRET_WORKTREE_ID,
      'chat-secret-9012',
    ]);
  });

  it('rebinds worktree_prompt to an abstract project target and strips machine ids', () => {
    const result = buildSharedAutomationDocument(
      baseActivity({
        action: {
          type: 'worktree_prompt',
          workspaceId: SECRET_WORKSPACE_ID,
          baseWorktreeId: SECRET_WORKTREE_ID,
          existingBranch: 'develop',
          prompt: 'Fix the flaky tests.',
          sidebarGroupName: 'Local only',
          modelConfig: { thinkingLevel: 'high', fastMode: false },
          model: 'sonnet',
          planMode: true,
          interfaceMode: 'canopy',
          workspaceName: SECRET_WORKSPACE_NAME,
        },
      }),
      {
        description: '',
        resolvedPlugins: [],
        pipelineResolution: { status: 'resolved', scopes: 'directory' },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.action).toEqual({
      type: 'worktree_prompt',
      target: { kind: 'workspace' },
      existingBranch: 'develop',
      prompt: 'Fix the flaky tests.',
      modelConfig: { model: 'sonnet', thinkingLevel: 'high', fastMode: false },
      plugins: [],
      planMode: true,
      interfaceMode: 'canopy',
    });
    expect(result.notices).toContain('workspace_binding_stripped');
    expectAbsent(JSON.stringify(result.document), [
      SECRET_WORKSPACE_ID,
      SECRET_WORKTREE_ID,
      SECRET_WORKSPACE_NAME,
    ]);
  });

  it('shares the exact Codex speed with its derived legacy boolean', () => {
    const shared = (
      modelConfig: AgentModelConfig,
    ): SharedAutomationModelConfig | undefined => {
      const result = buildSharedAutomationDocument(
        baseActivity({
          action: {
            type: 'app_advisor_prompt',
            prompt: 'Triage the inbox.',
            model: 'gpt-6-sol',
            modelConfig,
          },
        }),
        { description: '', resolvedPlugins: [] },
      );
      expect(result.ok).toBe(true);
      return result.ok && result.document.action.type === 'app_advisor_prompt'
        ? result.document.action.modelConfig
        : undefined;
    };
    expect(shared({ speed: 'ultrafast', fastMode: false })).toEqual({
      model: 'gpt-6-sol',
      speed: 'ultrafast',
      fastMode: false,
    });
    // A legacy-only boolean keeps its meaning without inventing a speed.
    expect(shared({ fastMode: true })).toEqual({
      model: 'gpt-6-sol',
      fastMode: true,
    });
  });

  it('maps a shared pipeline action to a portable ref and strips input values', () => {
    const result = buildSharedAutomationDocument(
      baseActivity({
        action: {
          type: 'worktree_pipeline',
          workspaceId: SECRET_WORKSPACE_ID,
          pipelineId: 'local-pipeline-id',
          pipelineSource: 'shared',
          pipelineName: 'Team review',
          sharedPipeline: {
            serverId: 'srv-local-id',
            remoteId: '4f6b0f5e-2f66-4be4-9f8e-1f0a54a1c111',
          },
          inputs: { ticket: SECRET_INPUT_VALUE, branch: 'develop' },
          modelAliasPreferences: { reviewer: { mode: 'inline' } },
        },
      }),
      {
        description: '',
        sessionTargetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: ['directory'] },
        resolvedPlugins: [],
        sharedPipelineInstallPin: SHARED_PIPELINE_INSTALL_PIN,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.action).toEqual({
      type: 'worktree_pipeline',
      target: { kind: 'workspace' },
      pipeline: {
        source: 'shared',
        remoteId: '4f6b0f5e-2f66-4be4-9f8e-1f0a54a1c111',
        name: 'Team review',
        installPin: SHARED_PIPELINE_INSTALL_PIN,
      },
      inputKeys: ['branch', 'ticket'],
    });
    expect(result.notices).toEqual(
      expect.arrayContaining([
        'input_values_stripped',
        'model_alias_preferences_stripped',
        'workspace_binding_stripped',
      ]),
    );
    expectAbsent(JSON.stringify(result.document), [
      SECRET_WORKSPACE_ID,
      SECRET_INPUT_VALUE,
      'srv-local-id',
      'local-pipeline-id',
      'modelAliasPreferences',
    ]);
  });

  it.each(['user', 'project'] as const)(
    'bundles a %s pipeline definition inline',
    (pipelineSource) => {
      const rawPipeline = 'name: Local\non: dispatch\njobs: {}\n';
      const result = buildSharedAutomationDocument(
        baseActivity({
          action: {
            type: 'worktree_pipeline',
            workspaceId: SECRET_WORKSPACE_ID,
            pipelineId: 'mine',
            pipelineSource,
            pipelineName: 'Local review',
          },
        }),
        {
          description: '',
          sessionTargetKind: 'single-repo',
          pipelineResolution: { status: 'resolved', scopes: ['directory'] },
          pipelineRawContent: rawPipeline,
          pipelineContentHash: 'b'.repeat(64),
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok || result.document.action.type !== 'worktree_pipeline')
        return;
      expect(result.document.action.pipeline).toEqual({
        source: 'inline',
        name: 'Local review',
        rawPipeline,
        pipelineContentHash: 'b'.repeat(64),
      });
      expect(result.notices).not.toContain('pipeline_reference_unresolved');
      expect(result.notices).toContain('pipeline_definition_bundled');
    },
  );

  it('bundles a shared pipeline inline with origin provenance', () => {
    const rawPipeline = 'name: Shared\non: dispatch\njobs: {}\n';
    const result = buildSharedAutomationDocument(
      baseActivity({
        action: {
          type: 'worktree_pipeline',
          workspaceId: SECRET_WORKSPACE_ID,
          pipelineId: 'shared',
          pipelineSource: 'shared',
          pipelineName: 'Team review',
          sharedPipeline: {
            serverId: 'server-1',
            remoteId: '4f6b0f5e-2f66-4be4-9f8e-1f0a54a1c111',
          },
        },
      }),
      {
        description: '',
        sessionTargetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: ['directory'] },
        pipelineRawContent: rawPipeline,
        pipelineContentHash: 'b'.repeat(64),
        sharedPipelineInstallPin: SHARED_PIPELINE_INSTALL_PIN,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.document.action.type !== 'worktree_pipeline')
      return;
    expect(result.document.action.pipeline).toEqual({
      source: 'inline',
      name: 'Team review',
      rawPipeline,
      pipelineContentHash: 'b'.repeat(64),
      origin: {
        remoteId: '4f6b0f5e-2f66-4be4-9f8e-1f0a54a1c111',
        installPin: SHARED_PIPELINE_INSTALL_PIN,
      },
    });
  });

  it('maps a bundled pipeline action without requiring a remote ref', () => {
    const result = buildSharedAutomationDocument(
      baseActivity({
        action: {
          type: 'worktree_pipeline',
          workspaceId: SECRET_WORKSPACE_ID,
          pipelineId: 'code-review',
          pipelineSource: 'bundled',
        },
      }),
      {
        description: '',
        resolvedPlugins: [],
        pipelineResolution: { status: 'resolved', scopes: 'directory' },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.action).toEqual({
      type: 'worktree_pipeline',
      target: { kind: 'workspace' },
      pipeline: { source: 'bundled', pipelineId: 'code-review' },
      inputKeys: [],
    });
  });

  it('strips the ifCommand value but records its existence', () => {
    const result = buildSharedAutomationDocument(
      baseActivity({ ifCommand: SECRET_IF_COMMAND }),
      { description: '', resolvedPlugins: [] },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.hasRunCondition).toBe(true);
    expect(result.notices).toContain('run_condition_stripped');
    expectAbsent(JSON.stringify(result.document), [
      SECRET_IF_COMMAND,
      'SECRET-TOKEN',
      'ifCommand',
    ]);
  });

  it('falls back to the deprecated portable plugins when no resolution is provided', () => {
    const result = buildSharedAutomationDocument(
      baseActivity({
        action: {
          type: 'app_advisor_prompt',
          prompt: 'Go.',
          plugins: [pluginRef],
        },
      }),
      {
        description: '',
        sessionTargetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: ['directory'] },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.document.action.type === 'app_advisor_prompt' &&
        result.document.action.plugins,
    ).toEqual([pluginRef]);
  });

  it('downgrades a session-bound prompt to an abstract workspace target', () => {
    const sessionBound = buildSharedAutomationDocument(
      baseActivity({
        action: {
          type: 'worktree_session_prompt',
          workspaceId: SECRET_WORKSPACE_ID,
          worktreeId: SECRET_WORKTREE_ID,
          chatId: 'chat-1',
          prompt: 'Continue.',
          attachmentPaths: ['/Users/author/secret.txt'],
          fileReferences: [
            {
              displayPath: 'src/index.ts',
              absolutePath: '/Users/author/src/index.ts',
            },
          ],
          inputMode: 'typed',
          workspaceName: SECRET_WORKSPACE_NAME,
          chatTitle: 'Review',
        },
      }),
      {
        description: '',
        sessionTargetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: ['directory'] },
      },
    );
    expect(sessionBound.ok).toBe(true);
    if (!sessionBound.ok) return;
    expect(sessionBound.document.action).toEqual({
      type: 'worktree_prompt',
      target: { kind: 'workspace' },
      prompt: 'Continue.',
      plugins: [],
    });
    expectAbsent(JSON.stringify(sessionBound.document), [
      SECRET_WORKSPACE_ID,
      SECRET_WORKTREE_ID,
      'chat-1',
      'secret.txt',
      'src/index.ts',
    ]);
    expect(sessionBound.notices).toEqual(
      expect.arrayContaining([
        'session_target_downgraded',
        'workspace_binding_stripped',
        'attachments_stripped',
      ]),
    );
  });

  it('omits the attachment notice when a session-bound prompt has none', () => {
    const result = buildSharedAutomationDocument(
      baseActivity({
        action: {
          type: 'worktree_session_prompt',
          workspaceId: SECRET_WORKSPACE_ID,
          worktreeId: SECRET_WORKTREE_ID,
          chatId: 'chat-1',
          prompt: 'Continue.',
        },
      }),
      {
        description: '',
        sessionTargetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: ['directory'] },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notices).not.toContain('attachments_stripped');
  });

  it('keeps execution-resume actions blocked', () => {
    const executionBound = buildSharedAutomationDocument(
      baseActivity({
        action: {
          type: 'pipeline_execution_resume',
          executionId: 'exec-1',
          statusReasonIds: ['usage'],
          provider: 'claude',
          purpose: 'usage_limit_resume',
          pipelineName: 'Review',
        },
      }),
      {
        description: '',
        sessionTargetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: ['directory'] },
      },
    );
    expect(executionBound).toEqual({
      ok: false,
      reasons: ['action_execution_bound'],
    });
  });

  it('shares Cowork prompts against an abstract project target', () => {
    const cowork = buildSharedAutomationDocument(
      baseActivity({
        action: {
          type: 'standalone_prompt',
          chatProjectId: 'cowork-1',
          prompt: 'Go.',
          sidebarGroupName: 'Local only',
        },
      }),
      {
        description: '',
        sessionTargetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: ['directory'] },
      },
    );
    expect(cowork.ok).toBe(true);
    if (!cowork.ok) return;
    expect(cowork.document.action).toEqual({
      type: 'standalone_prompt',
      target: { kind: 'cowork' },
      prompt: 'Go.',
      plugins: [],
    });
    expect(JSON.stringify(cowork.document)).not.toContain('cowork-1');
    expect(cowork.notices).toContain('cowork_project_binding_stripped');
  });

  it('downgrades local and unresolvable pipeline sources', () => {
    for (const pipelineSource of ['user', 'project', undefined] as const) {
      const result = buildSharedAutomationDocument(
        baseActivity({
          action: {
            type: 'worktree_pipeline',
            workspaceId: SECRET_WORKSPACE_ID,
            pipelineId: 'mine',
            ...(pipelineSource ? { pipelineSource } : {}),
          },
        }),
        {
          description: '',
          sessionTargetKind: 'single-repo',
          pipelineResolution: { status: 'resolved', scopes: ['directory'] },
        },
      );
      expect(result.ok).toBe(true);
      if (!result.ok || result.document.action.type !== 'worktree_pipeline')
        return;
      expect(result.document.action.pipeline).toEqual({
        source: 'unresolved',
      });
      expect(result.notices).toContain('pipeline_reference_unresolved');
      expect(JSON.stringify(result.document)).not.toContain('mine');
    }

    const sharedWithoutRemote = buildSharedAutomationDocument(
      baseActivity({
        action: {
          type: 'worktree_pipeline',
          workspaceId: SECRET_WORKSPACE_ID,
          pipelineId: 'mine',
          pipelineSource: 'shared',
        },
      }),
      {
        description: '',
        sessionTargetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: ['directory'] },
      },
    );
    expect(sharedWithoutRemote.ok).toBe(true);
    if (!sharedWithoutRemote.ok) return;
    expect(sharedWithoutRemote.notices).toContain(
      'pipeline_reference_unresolved',
    );
  });

  it('uses curated pipeline keys when available', () => {
    const result = buildSharedAutomationDocument(
      baseActivity({
        action: {
          type: 'worktree_pipeline',
          workspaceId: SECRET_WORKSPACE_ID,
          pipelineId: 'curated:review',
          pipelineSource: 'curated',
          pipelineName: 'Review',
        },
      }),
      {
        description: '',
        curatedPipelineKey: 'review/default',
        pipelineResolution: { status: 'resolved', scopes: 'directory' },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.document.action.type !== 'worktree_pipeline')
      return;
    expect(result.document.action.pipeline).toEqual({
      source: 'curated',
      curatedKey: 'review/default',
      name: 'Review',
    });
    expect(result.notices).not.toContain('pipeline_reference_unresolved');
  });

  it('strips unresolvable plugin selections and local Agent models', () => {
    const blockedPlugins = buildSharedAutomationDocument(
      baseActivity({
        action: {
          type: 'app_advisor_prompt',
          prompt: 'Go.',
          pluginSelections: {
            collectionIds: ['local-collection'],
            skillRefs: [],
            pluginRefs: [],
          },
        },
      }),
      {
        description: '',
        sessionTargetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: ['directory'] },
        resolvedPlugins: { plugins: [], dropped: ['Local collection'] },
      },
    );
    expect(blockedPlugins.ok).toBe(true);
    if (!blockedPlugins.ok) return;
    expect(blockedPlugins.notices).toContain('local_plugins_stripped');

    const agentModel = buildSharedAutomationDocument(
      baseActivity({
        action: {
          type: 'app_advisor_prompt',
          prompt: 'Go.',
          model: 'agent_model_code_reviewer',
        },
      }),
      { description: '', resolvedPlugins: [] },
    );
    expect(agentModel.ok).toBe(true);
    if (!agentModel.ok) return;
    expect(agentModel.notices).toContain('local_agent_model_stripped');
    expect(JSON.stringify(agentModel.document)).not.toContain(
      'agent_model_code_reviewer',
    );
  });

  it('strips non-empty plugin collection preferences', () => {
    const result = buildSharedAutomationDocument(
      baseActivity({
        action: {
          type: 'worktree_pipeline',
          workspaceId: SECRET_WORKSPACE_ID,
          pipelineId: 'mine',
          pipelineSource: 'user',
          pluginCollectionPreferences: { disabledDefaultKeys: ['x'] },
          modelConfig: { thinkingLevel: 'high' },
        },
      }),
      {
        description: '',
        sessionTargetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: ['directory'] },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notices).toEqual(
      expect.arrayContaining([
        'pipeline_reference_unresolved',
        'plugin_collection_preferences_stripped',
      ]),
    );
  });

  it('attaches a resolved capability package to the document', () => {
    const capabilityPackage = {
      version: 1,
      digest: `pp:v1:${'c'.repeat(43)}`,
    } as const;
    const result = buildSharedAutomationDocument(baseActivity(), {
      description: '',
      sessionTargetKind: 'single-repo',
      pipelineResolution: { status: 'resolved', scopes: ['directory'] },
      resolvedPlugins: [],
      capabilityPackage,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.capabilityPackage).toEqual(capabilityPackage);
  });

  it('exposes all fail-closed share reasons', () => {
    expect(Object.keys(AUTOMATION_SHARE_BLOCK_MESSAGES)).toEqual([
      'action_execution_bound',
      'document_invalid',
      'installed_prompt_reference',
      'session_target_unresolved',
      'pipeline_target_unresolved',
      'pipeline_dependencies_stale',
      'installed_pipeline_dependencies',
    ]);
  });

  describe('approval mode', () => {
    const approvalModeActions: ScheduledActivity['action'][] = [
      {
        type: 'app_advisor_prompt',
        prompt: 'Review',
        approvalMode: 'full-access',
      },
      {
        type: 'standalone_prompt',
        chatProjectId: 'cowork',
        prompt: 'Review',
        approvalMode: 'full-access',
      },
      {
        type: 'worktree_prompt',
        workspaceId: 'workspace',
        prompt: 'Review',
        approvalMode: 'full-access',
      },
      {
        type: 'worktree_session_prompt',
        workspaceId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat',
        prompt: 'Review',
        approvalMode: 'full-access',
      },
    ];

    it.each(approvalModeActions.map((action) => [action.type, action]))(
      'shares a %s automation without its approval mode',
      (_type, action) => {
        const activity = baseActivity({ action });
        const untouched = structuredClone(activity);
        const result = buildSharedAutomationDocument(activity, {
          description: '',
          sessionTargetKind: 'single-repo',
          pipelineResolution: { status: 'resolved', scopes: ['directory'] },
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.document.action).not.toHaveProperty('approvalMode');
        expectAbsent(JSON.stringify(result.document), [
          'approvalMode',
          'full-access',
        ]);
        expect(result.notices).toContain('approval_mode_stripped');
        // The share is a snapshot: the publisher keeps the mode they chose.
        expect(activity).toEqual(untouched);
      },
    );

    it.each(['ask', 'auto', 'full-access'] as const)(
      'drops the %s approval mode rather than carrying it',
      (approvalMode) => {
        const result = buildSharedAutomationDocument(
          baseActivity({
            action: {
              type: 'standalone_prompt',
              chatProjectId: 'cowork',
              prompt: 'Review',
              approvalMode,
            },
          }),
          {
            description: '',
            sessionTargetKind: 'single-repo',
            pipelineResolution: { status: 'resolved', scopes: ['directory'] },
          },
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.document.action).toEqual({
          type: 'standalone_prompt',
          target: { kind: 'cowork' },
          prompt: 'Review',
          plugins: [],
        });
        expect(result.notices).toContain('approval_mode_stripped');
      },
    );

    it('says nothing about approval mode when none is set', () => {
      const result = buildSharedAutomationDocument(
        baseActivity({
          action: {
            type: 'standalone_prompt',
            chatProjectId: 'cowork',
            prompt: 'Review',
          },
        }),
        {
          description: '',
          sessionTargetKind: 'single-repo',
          pipelineResolution: { status: 'resolved', scopes: ['directory'] },
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.notices).not.toContain('approval_mode_stripped');
    });

    it('installs a recipient copy that follows their own approval default', () => {
      const built = buildSharedAutomationDocument(
        baseActivity({
          action: {
            type: 'standalone_prompt',
            chatProjectId: 'cowork',
            prompt: 'Review',
            approvalMode: 'full-access',
          },
        }),
        {
          description: '',
          sessionTargetKind: 'single-repo',
          pipelineResolution: { status: 'resolved', scopes: ['directory'] },
        },
      );
      expect(built.ok).toBe(true);
      if (!built.ok) return;

      const installed = buildInstallAutomationRequest(
        {
          id: '4f6b0f5e-2f66-4be4-9f8e-1f0a54a1c111',
          contentHash: 'a'.repeat(64),
          automation: built.document,
        },
        { coworkWorkspaceId: 'recipient-cowork', targetKind: 'cowork' },
        '2026-09-30T00:00:00.000Z',
      );

      expect(installed.ok).toBe(true);
      if (!installed.ok) return;
      expect(installed.request.action).toEqual({
        type: 'standalone_prompt',
        chatProjectId: 'recipient-cowork',
        prompt: 'Review',
      });
      expect(installed.request.enabled).toBe(false);
    });
  });

  describe('plan mode', () => {
    it.each([
      [
        'app_advisor_prompt',
        { type: 'app_advisor_prompt', prompt: 'Review', planMode: true },
      ],
      [
        'standalone_prompt',
        {
          type: 'standalone_prompt',
          chatProjectId: 'cowork',
          prompt: 'Review',
          planMode: true,
        },
      ],
    ] satisfies [string, ScheduledActivity['action']][])(
      'drops plan mode from a %s share, whose format has no field for it',
      (_type, action) => {
        const result = buildSharedAutomationDocument(baseActivity({ action }), {
          description: '',
          sessionTargetKind: 'single-repo',
          pipelineResolution: { status: 'resolved', scopes: ['directory'] },
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.document.action).not.toHaveProperty('planMode');
        expect(result.notices).toContain('plan_mode_stripped');
      },
    );

    it('says nothing when plan mode is off, which is what recipients get anyway', () => {
      const result = buildSharedAutomationDocument(
        baseActivity({
          action: {
            type: 'app_advisor_prompt',
            prompt: 'Review',
            planMode: false,
          },
        }),
        {
          description: '',
          sessionTargetKind: 'single-repo',
          pipelineResolution: { status: 'resolved', scopes: ['directory'] },
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.action).not.toHaveProperty('planMode');
      expect(result.notices).not.toContain('plan_mode_stripped');
    });

    it('keeps plan mode on a worktree_prompt share, which can carry it', () => {
      const result = buildSharedAutomationDocument(
        baseActivity({
          action: {
            type: 'worktree_prompt',
            workspaceId: 'workspace',
            prompt: 'Review',
            planMode: true,
          },
        }),
        {
          description: '',
          sessionTargetKind: 'single-repo',
          pipelineResolution: { status: 'resolved', scopes: ['directory'] },
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.action).toMatchObject({ planMode: true });
      expect(result.notices).not.toContain('plan_mode_stripped');
    });
  });

  describe('session prompt chat settings', () => {
    function sessionPrompt(
      overrides: Partial<
        Extract<
          ScheduledActivity['action'],
          { type: 'worktree_session_prompt' }
        >
      >,
    ): ScheduledActivity {
      return baseActivity({
        action: {
          type: 'worktree_session_prompt',
          workspaceId: SECRET_WORKSPACE_ID,
          worktreeId: SECRET_WORKTREE_ID,
          chatId: 'chat-1',
          prompt: 'Continue.',
          ...overrides,
        },
      });
    }

    it('carries the model, model tuning, and plan mode on the downgraded prompt', () => {
      const result = buildSharedAutomationDocument(
        sessionPrompt({
          model: 'sonnet',
          modelConfig: { thinkingLevel: 'low', fastMode: true },
          planMode: true,
        }),
        {
          description: '',
          sessionTargetKind: 'single-repo',
          pipelineResolution: { status: 'resolved', scopes: ['directory'] },
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.action).toEqual({
        type: 'worktree_prompt',
        target: { kind: 'workspace' },
        prompt: 'Continue.',
        modelConfig: { model: 'sonnet', thinkingLevel: 'low', fastMode: true },
        plugins: [],
        planMode: true,
      });
      expect(result.notices).not.toContain('plan_mode_stripped');
    });

    it('strips a local custom Agent model the same way other prompts do', () => {
      const result = buildSharedAutomationDocument(
        sessionPrompt({ model: 'agent_model_code_reviewer' }),
        {
          description: '',
          sessionTargetKind: 'single-repo',
          pipelineResolution: { status: 'resolved', scopes: ['directory'] },
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.notices).toContain('local_agent_model_stripped');
      expectAbsent(JSON.stringify(result.document), [
        'agent_model_code_reviewer',
      ]);
    });

    const localSelections = {
      collectionIds: ['local-collection'],
      skillRefs: [],
      pluginRefs: [],
    };

    it('shares plugin selections resolved against the plugin catalog', () => {
      const result = buildSharedAutomationDocument(
        sessionPrompt({ pluginSelections: localSelections }),
        {
          description: '',
          sessionTargetKind: 'single-repo',
          pipelineResolution: { status: 'resolved', scopes: ['directory'] },
          resolvedPlugins: {
            plugins: [pluginRef],
            dropped: ['Local collection'],
          },
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.action.type).toBe('worktree_prompt');
      if (result.document.action.type !== 'worktree_prompt') return;
      expect(result.document.action.plugins).toEqual([pluginRef]);
      expect(result.notices).toContain('local_plugins_stripped');
      expectAbsent(JSON.stringify(result.document), ['local-collection']);
    });

    it('never carries plugin selections that were not resolved', () => {
      const result = buildSharedAutomationDocument(
        sessionPrompt({ pluginSelections: localSelections }),
        {
          description: '',
          sessionTargetKind: 'single-repo',
          pipelineResolution: { status: 'resolved', scopes: ['directory'] },
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.action.type).toBe('worktree_prompt');
      if (result.document.action.type !== 'worktree_prompt') return;
      expect(result.document.action.plugins).toEqual([]);
      expect(result.notices).toContain('local_plugins_stripped');
      expectAbsent(JSON.stringify(result.document), [
        'local-collection',
        'pluginSelections',
      ]);
    });
  });

  it('surfaces protocol validation failures as document_invalid', () => {
    const result = buildSharedAutomationDocument(
      baseActivity({
        schedule: {
          kind: 'cron',
          expression: '5/2 * * * *',
          timezone: 'local',
        },
      }),
      { description: '', resolvedPlugins: [] },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain('document_invalid');
      expect(result.detail).toContain('cron');
    }
  });

  it('exposes user-facing copy for every block reason and notice', () => {
    for (const message of Object.values(AUTOMATION_SHARE_BLOCK_MESSAGES)) {
      expect(typeof message).toBe('string');
      expect(message.length).toBeGreaterThan(10);
    }
    for (const message of Object.values(AUTOMATION_SHARE_NOTICE_MESSAGES)) {
      expect(typeof message).toBe('string');
      expect(message.length).toBeGreaterThan(10);
    }
  });
});

describe('ScheduledActivity share metadata passthrough', () => {
  it('round-trips remote and installedFrom metadata through a JSON clone', () => {
    const activity = baseActivity({
      remote: {
        remoteId: '4f6b0f5e-2f66-4be4-9f8e-1f0a54a1c111',
        contentHash: 'a'.repeat(64),
        shareScope: 'team',
        sharedAt: '2026-08-18T00:00:00.000Z',
      },
      installedFrom: {
        remoteId: '5f6b0f5e-2f66-4be4-9f8e-1f0a54a1c222',
        contentHash: 'b'.repeat(64),
        installedAt: '2026-08-18T00:00:00.000Z',
        firstEnableReportedAt: '2026-08-18T01:00:00.000Z',
      },
    });

    const cloned: ScheduledActivity = structuredClone(activity);

    expect(cloned.remote?.shareScope).toBe('team');
    expect(cloned.installedFrom?.firstEnableReportedAt).toBe(
      '2026-08-18T01:00:00.000Z',
    );
  });
});

describe('pipeline destinations', () => {
  function pipelineActivity(
    target: Extract<
      ScheduledActivity['action'],
      { type: 'worktree_pipeline' }
    >['target'],
  ): ScheduledActivity {
    return baseActivity({
      action: {
        type: 'worktree_pipeline',
        ...(target?.kind === 'global'
          ? {}
          : { workspaceId: SECRET_WORKSPACE_ID }),
        ...(target ? { target } : {}),
        pipelineId: 'bundled-review',
        pipelineSource: 'bundled',
      },
    });
  }

  it('keeps a legacy action at the portable workspace kind and version', () => {
    const result = buildSharedAutomationDocument(pipelineActivity(undefined), {
      description: '',
      pipelineResolution: { status: 'resolved', scopes: ['directory'] },
      resolvedPlugins: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.document.action.type !== 'worktree_pipeline')
      return;
    expect(result.document.version).toBe(1);
    expect(result.document.action.target).toEqual({ kind: 'workspace' });
    expect(result.notices).toContain('workspace_binding_stripped');
  });

  it.each([
    ['new_worktree', { kind: 'new_worktree' as const }, ['worktree']],
    [
      'task',
      { kind: 'task' as const, taskId: SECRET_WORKTREE_ID },
      ['worktree'],
    ],
    ['project', { kind: 'project' as const }, ['directory']],
  ])(
    'shares a %s destination as v6 without local ids',
    (kind, target, scopes) => {
      const result = buildSharedAutomationDocument(pipelineActivity(target), {
        description: '',
        pipelineResolution: { status: 'resolved', scopes },
        resolvedPlugins: [],
      });
      expect(result.ok).toBe(true);
      if (!result.ok || result.document.action.type !== 'worktree_pipeline')
        return;
      expect(result.document.version).toBe(6);
      expect(result.document.action.target).toEqual({ kind });
      expect(result.notices).toContain('workspace_binding_stripped');
      expectAbsent(JSON.stringify(result.document), [
        SECRET_WORKSPACE_ID,
        SECRET_WORKTREE_ID,
      ]);
    },
  );

  it('shares a global destination with no binding notice', () => {
    const result = buildSharedAutomationDocument(
      pipelineActivity({ kind: 'global' }),
      {
        description: '',
        pipelineResolution: { status: 'resolved', scopes: ['global'] },
        resolvedPlugins: [],
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.document.action.type !== 'worktree_pipeline')
      return;
    expect(result.document.version).toBe(6);
    expect(result.document.action.target).toEqual({ kind: 'global' });
    expect(result.notices).not.toContain('workspace_binding_stripped');
  });

  it('refuses a global destination whose pipeline cannot run without a project', () => {
    const result = buildSharedAutomationDocument(
      pipelineActivity({ kind: 'global' }),
      {
        description: '',
        pipelineResolution: { status: 'resolved', scopes: ['directory'] },
        resolvedPlugins: [],
      },
    );
    expect(result).toMatchObject({
      ok: false,
      reasons: ['pipeline_target_unresolved'],
      detail:
        "This workflow can't run without a project. Choose a workflow that runs with no project, or choose a project.",
    });
  });

  it('carries an included run condition on a v6 destination', () => {
    const result = buildSharedAutomationDocument(
      baseActivity({
        action: {
          type: 'worktree_pipeline',
          workspaceId: SECRET_WORKSPACE_ID,
          target: { kind: 'new_worktree' },
          pipelineId: 'bundled-review',
          pipelineSource: 'bundled',
        },
        ifCommand: '  test -f ready  ',
      }),
      {
        description: '',
        pipelineResolution: { status: 'resolved', scopes: ['worktree'] },
        resolvedPlugins: [],
        includeRunCondition: true,
      },
    );
    expect(result).toMatchObject({
      ok: true,
      document: {
        version: 6,
        action: { target: { kind: 'new_worktree' } },
        runCondition: { command: 'test -f ready' },
      },
    });
  });
});

describe('run-condition sharing', () => {
  const narrowedPipeline = baseActivity({
    action: {
      type: 'worktree_pipeline',
      workspaceId: 'cowork-1',
      pipelineId: 'review',
      pipelineSource: 'bundled',
    },
    targetRequirement: { contexts: ['cowork'] },
    ifCommand: '  test -f ready  ',
  });

  it('includes the trimmed command as a v4 run condition when asked', () => {
    const result = buildSharedAutomationDocument(
      baseActivity({ ifCommand: `  ${SECRET_IF_COMMAND}\n` }),
      { description: '', resolvedPlugins: [], includeRunCondition: true },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.version).toBe(4);
    expect(result.document.hasRunCondition).toBe(true);
    expect(result.document.runCondition).toEqual({
      command: SECRET_IF_COMMAND,
    });
    expect(result.document).not.toHaveProperty('targetRequirement');
    expect(result.notices).not.toContain('run_condition_stripped');
  });

  it('keeps a narrowed target requirement on a v4 document', () => {
    expect(
      buildSharedAutomationDocument(narrowedPipeline, {
        description: '',
        pipelineResolution: { status: 'resolved', scopes: 'directory' },
        includeRunCondition: true,
      }),
    ).toMatchObject({
      ok: true,
      document: {
        version: 4,
        targetRequirement: { contexts: ['cowork'] },
        runCondition: { command: 'test -f ready' },
      },
    });
  });

  it('strips the command by default, exactly as before', () => {
    const result = buildSharedAutomationDocument(narrowedPipeline, {
      description: '',
      pipelineResolution: { status: 'resolved', scopes: 'directory' },
    });
    expect(result).toMatchObject({ ok: true, document: { version: 3 } });
    if (!result.ok) return;
    expect(result.document).not.toHaveProperty('runCondition');
    expect(result.notices).toContain('run_condition_stripped');
  });

  it.each([undefined, '', '   '])(
    'stays on v1-3 with no run condition when ifCommand is %j',
    (ifCommand) => {
      const result = buildSharedAutomationDocument(
        baseActivity(ifCommand === undefined ? {} : { ifCommand }),
        { description: '', resolvedPlugins: [], includeRunCondition: true },
      );
      expect(result).toMatchObject({
        ok: true,
        document: { version: 1, hasRunCondition: false },
      });
      if (!result.ok) return;
      expect(result.document).not.toHaveProperty('runCondition');
      expect(result.notices).not.toContain('run_condition_stripped');
    },
  );

  it.each([
    ['test -f ~/.config/x', ['local_file']],
    ['./scripts/check.sh', ['local_file']],
    ['python3 /opt/check.py', ['local_file']],
    ['curl -H "Authorization: Bearer abc123"', ['possible_secret']],
    [
      'TOKEN=ghp_abcdefghijklmnopqrstuvwxyz012345 ./x',
      ['possible_secret', 'local_file'],
    ],
    ['API_KEY=foo', ['possible_secret']],
    ['exit 0', []],
    ['git status --porcelain | grep -q .', []],
    ['curl -s https://example.test/health', []],
    ['test $(date +%u) -lt 6', []],
    ['ls task-*', []],
    ['echo ok', []],
  ])('flags %j with %j', (command, expected) => {
    expect(detectRunConditionShareWarnings(command)).toEqual(expected);
  });

  it('deduplicates warnings and lists them in declaration order', () => {
    expect(
      detectRunConditionShareWarnings(
        '/opt/a.sh ~/b.py password=x sk-abc Bearer y',
      ),
    ).toEqual(['possible_secret', 'local_file']);
    expect(
      Object.keys(AUTOMATION_RUN_CONDITION_SHARE_WARNING_MESSAGES),
    ).toEqual(['possible_secret', 'local_file']);
    expect(AUTOMATION_RUN_CONDITION_SHARE_WARNING_SHORT_LABELS).toEqual({
      possible_secret: 'May contain a secret',
      local_file: 'References a local file',
    });
  });

  it('finds the If Command output variable a prompt uses', () => {
    const name = AUTOMATION_IF_CMD_OUTPUT_VAR_NAMES[0];
    expect(name).toBeDefined();
    expect(
      automationActionUsesIfCommandOutput({
        type: 'app_advisor_prompt',
        prompt: `Summarize {{ ${name ?? ''} }} please.`,
      }),
    ).toBe(name);
    expect(
      automationActionUsesIfCommandOutput({
        type: 'standalone_prompt',
        chatProjectId: 'cowork-1',
        prompt: 'Summarize {{UNRELATED}} and the inbox.',
      }),
    ).toBeNull();
    expect(
      automationActionUsesIfCommandOutput({
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'review',
      }),
    ).toBeNull();
  });
});

describe('packaged pipelines (shared document v5)', () => {
  const capabilityPackage = {
    version: 1,
    digest: `pp:v1:${'d'.repeat(43)}`,
  } as const;
  const WORKER_ID = '8f14e45f-ceea-467a-9575-0b5b4b2b1c11';
  const ENTRY_ID = 'C9F0F895-FB98-4B91-8C6E-2A5C1D0E4B22';

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

  function packaged(
    overrides: Partial<PipelinePackagePackagedPipeline> &
      Pick<PipelinePackagePackagedPipeline, 'key'>,
  ): PipelinePackagePackagedPipeline {
    return {
      resourceId: `automation-pipeline-${overrides.key}`,
      name: 'Pipeline',
      pipelineContentHash: 'e'.repeat(64),
      source: 'user',
      isActionPipeline: false,
      optional: false,
      promptSpans: [],
      ...overrides,
    };
  }

  function expectStrictlyValid(document: unknown): void {
    expect(validateSharedAutomationDocument(document)).toMatchObject({
      ok: true,
    });
  }

  it.each(['user', 'project'] as const)(
    'references a packaged %s action pipeline instead of an inline copy',
    (pipelineSource) => {
      const rawPipeline = 'name: Local\non: dispatch\njobs: {}\n';
      const result = buildSharedAutomationDocument(
        baseActivity({
          action: {
            type: 'worktree_pipeline',
            workspaceId: SECRET_WORKSPACE_ID,
            pipelineId: 'mine',
            pipelineSource,
            pipelineName: 'Local review',
          },
        }),
        {
          description: '',
          sessionTargetKind: 'single-repo',
          pipelineRawContent: rawPipeline,
          pipelineContentHash: 'b'.repeat(64),
          capabilityPackage,
          packagedPipelines: [
            packaged({
              key: 'action',
              isActionPipeline: true,
              pipelineContentHash: 'b'.repeat(64),
              source: pipelineSource,
            }),
          ],
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok || result.document.action.type !== 'worktree_pipeline')
        return;
      expect(result.document.version).toBe(5);
      expect(result.document.action.pipeline).toEqual({
        source: 'packaged',
        key: 'action',
        pipelineContentHash: 'b'.repeat(64),
        name: 'Local review',
      });
      expect(JSON.stringify(result.document)).not.toContain('jobs: {}');
      expect(result.notices).toContain('pipeline_definition_bundled');
      expectStrictlyValid(result.document);
    },
  );

  it('publishes a packaged action pipeline with a destination at version 6', () => {
    const result = buildSharedAutomationDocument(
      baseActivity({
        action: {
          type: 'worktree_pipeline',
          workspaceId: SECRET_WORKSPACE_ID,
          target: { kind: 'new_worktree' },
          pipelineId: 'mine',
          pipelineSource: 'user',
          pipelineName: 'Local review',
        },
      }),
      {
        description: '',
        pipelineRawContent:
          'name: Local\non: dispatch\nscope: worktree\njobs: {}\n',
        pipelineContentHash: 'b'.repeat(64),
        capabilityPackage,
        packagedPipelines: [
          packaged({
            key: 'action',
            isActionPipeline: true,
            pipelineContentHash: 'b'.repeat(64),
          }),
        ],
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.document.action.type !== 'worktree_pipeline')
      return;
    expect(result.document.version).toBe(6);
    expect(result.document.action.target).toEqual({ kind: 'new_worktree' });
    expect(result.document.action.pipeline).toMatchObject({
      source: 'packaged',
      key: 'action',
    });
    expectStrictlyValid(result.document);
  });

  it('keeps bundled pipeline refs and their version when packaged pipelines are offered', () => {
    const result = buildSharedAutomationDocument(
      baseActivity({
        action: {
          type: 'worktree_pipeline',
          workspaceId: SECRET_WORKSPACE_ID,
          pipelineId: 'code-review',
          pipelineSource: 'bundled',
        },
      }),
      {
        description: '',
        sessionTargetKind: 'single-repo',
        pipelineResolution: { status: 'resolved', scopes: ['directory'] },
        capabilityPackage,
        packagedPipelines: [
          packaged({ key: 'action', isActionPipeline: true }),
        ],
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.document.action.type !== 'worktree_pipeline')
      return;
    expect(result.document.version).toBe(1);
    expect(result.document.action.pipeline).toEqual({
      source: 'bundled',
      pipelineId: 'code-review',
    });
  });

  it('refuses a packaged action pipeline whose local bytes changed after analysis', () => {
    const result = buildSharedAutomationDocument(
      baseActivity({
        action: {
          type: 'worktree_pipeline',
          workspaceId: SECRET_WORKSPACE_ID,
          pipelineId: 'mine',
          pipelineSource: 'user',
        },
      }),
      {
        description: '',
        sessionTargetKind: 'single-repo',
        pipelineRawContent: 'name: Local\non: dispatch\njobs: {}\n',
        pipelineContentHash: 'c'.repeat(64),
        capabilityPackage,
        packagedPipelines: [
          packaged({
            key: 'action',
            isActionPipeline: true,
            pipelineContentHash: 'b'.repeat(64),
          }),
        ],
      },
    );
    expect(result).toMatchObject({
      ok: false,
      reasons: ['pipeline_dependencies_stale'],
    });
  });

  it('emits prompt pipeline dependencies with interleaved and repeated spans at version 5', () => {
    const prompt = `Run ${ENTRY_ID} with ${WORKER_ID}; when ${ENTRY_ID} fails, retry.`;
    const result = buildSharedAutomationDocument(
      baseActivity({
        action: { type: 'app_advisor_prompt', prompt },
      }),
      {
        description: '',
        resolvedPlugins: [],
        capabilityPackage,
        packagedPipelines: [
          packaged({
            key: ENTRY_ID.toLowerCase(),
            name: 'Entry',
            pipelineContentHash: '1'.repeat(64),
            promptSpans: spansOf(prompt, ENTRY_ID),
          }),
          packaged({
            key: WORKER_ID,
            name: 'Worker',
            pipelineContentHash: '2'.repeat(64),
            promptSpans: spansOf(prompt, WORKER_ID),
          }),
        ],
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.document.action.type !== 'app_advisor_prompt')
      return;
    expect(result.document.version).toBe(5);
    expect(result.document.action.prompt).toBe(prompt);
    expect(result.document.action.pipelineDependencies).toEqual([
      {
        key: ENTRY_ID.toLowerCase(),
        pipeline: {
          source: 'packaged',
          key: ENTRY_ID.toLowerCase(),
          pipelineContentHash: '1'.repeat(64),
          name: 'Entry',
        },
        promptSpans: [
          { textStart: 4, text: ENTRY_ID },
          { textStart: prompt.lastIndexOf(ENTRY_ID), text: ENTRY_ID },
        ],
      },
      {
        key: WORKER_ID,
        pipeline: {
          source: 'packaged',
          key: WORKER_ID,
          pipelineContentHash: '2'.repeat(64),
          name: 'Worker',
        },
        promptSpans: [
          { textStart: prompt.indexOf(WORKER_ID), text: WORKER_ID },
        ],
      },
    ]);
    expectStrictlyValid(result.document);
  });

  it('refuses to re-share an installed copy whose prompt points at packaged pipelines', () => {
    const result = buildSharedAutomationDocument(
      baseActivity({
        action: { type: 'app_advisor_prompt', prompt: `Run ${WORKER_ID}.` },
        installedFrom: {
          remoteId: 'remote-1',
          contentHash: 'a'.repeat(64),
          installedAt: '2026-10-01T00:00:00.000Z',
          capabilityPackage,
          pipelineDependencies: [
            {
              key: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
              localPipelineId: WORKER_ID,
              pipelineContentHash: '2'.repeat(64),
            },
          ],
        },
      }),
      { description: '', resolvedPlugins: [], capabilityPackage },
    );

    expect(result).toEqual({
      ok: false,
      reasons: ['installed_pipeline_dependencies'],
    });
  });

  it('carries prompt dependencies for every shareable prompt shape', () => {
    const prompt = `Use ${WORKER_ID}.`;
    const packagedPipelines = [
      packaged({ key: WORKER_ID, promptSpans: spansOf(prompt, WORKER_ID) }),
    ];
    const actions: ScheduledActivity['action'][] = [
      { type: 'standalone_prompt', chatProjectId: 'cowork-1', prompt },
      { type: 'worktree_prompt', workspaceId: SECRET_WORKSPACE_ID, prompt },
      {
        type: 'worktree_session_prompt',
        workspaceId: SECRET_WORKSPACE_ID,
        worktreeId: SECRET_WORKTREE_ID,
        chatId: 'chat-1',
        prompt,
      },
    ];
    for (const action of actions) {
      const result = buildSharedAutomationDocument(baseActivity({ action }), {
        description: '',
        sessionTargetKind: 'single-repo',
        resolvedPlugins: [],
        capabilityPackage,
        packagedPipelines,
      });
      expect(result.ok).toBe(true);
      if (!result.ok || result.document.action.type === 'worktree_pipeline')
        continue;
      expect(result.document.version).toBe(5);
      expect(result.document.action.pipelineDependencies).toHaveLength(1);
      expectStrictlyValid(result.document);
    }
  });

  it('keeps the current version for an automation without packaged pipelines', () => {
    const plain = buildSharedAutomationDocument(baseActivity(), {
      description: '',
      resolvedPlugins: [],
      packagedPipelines: [],
    });
    expect(plain).toMatchObject({ ok: true, document: { version: 1 } });
    if (plain.ok) {
      expect(plain.document.action).not.toHaveProperty('pipelineDependencies');
    }
    const gated = buildSharedAutomationDocument(
      baseActivity({ ifCommand: 'test -f ready' }),
      { description: '', resolvedPlugins: [], includeRunCondition: true },
    );
    expect(gated).toMatchObject({ ok: true, document: { version: 4 } });
  });

  it('refuses spans that no longer match the prompt instead of shifting them', () => {
    const prompt = `Use ${WORKER_ID}.`;
    const result = buildSharedAutomationDocument(
      baseActivity({ action: { type: 'app_advisor_prompt', prompt } }),
      {
        description: '',
        resolvedPlugins: [],
        capabilityPackage,
        packagedPipelines: [
          packaged({
            key: WORKER_ID,
            promptSpans: [{ textStart: 0, text: WORKER_ID }],
          }),
        ],
      },
    );
    expect(result).toMatchObject({
      ok: false,
      reasons: ['pipeline_dependencies_stale'],
    });
    if (!result.ok) {
      expect(result.detail).toMatch(/does not match the prompt/);
    }
    expect(AUTOMATION_SHARE_BLOCK_MESSAGES.pipeline_dependencies_stale).toBe(
      'This automation changed after its workflows were checked. Check them again before sharing.',
    );
  });

  it('builds a small document when the packaged pipelines exceed the document cap', () => {
    const description = 'x'.repeat(300 * 1024);
    const rawPipeline = `name: Big\ndescription: ${description}\non: dispatch\njobs: {}\n`;
    const activity = baseActivity({
      action: {
        type: 'worktree_pipeline',
        workspaceId: SECRET_WORKSPACE_ID,
        pipelineId: 'mine',
        pipelineSource: 'user',
      },
    });
    const options = {
      description: '',
      sessionTargetKind: 'single-repo' as const,
      pipelineRawContent: rawPipeline,
      pipelineContentHash: 'b'.repeat(64),
      capabilityPackage,
    };
    const inline = buildSharedAutomationDocument(activity, options);
    expect(inline).toMatchObject({ ok: false, reasons: ['document_invalid'] });

    const result = buildSharedAutomationDocument(activity, {
      ...options,
      packagedPipelines: [
        packaged({
          key: 'action',
          isActionPipeline: true,
          pipelineContentHash: 'b'.repeat(64),
        }),
        // A worker pipeline the action reaches through a child ref is
        // packaged too, but only the package carries its YAML.
        packaged({ key: WORKER_ID, pipelineContentHash: '2'.repeat(64) }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bytes = new TextEncoder().encode(
      JSON.stringify(result.document),
    ).length;
    expect(bytes).toBeLessThan(4 * 1024);
    expect(bytes).toBeLessThan(MAX_SHARED_AUTOMATION_BYTES);
    expectStrictlyValid(result.document);
  });
});

// CAN-4551: a converted chat automation shares as a v6 document with its
// owned pipeline inline, and installs back with only its destination rebound.
describe('a converted chat automation', () => {
  it('keeps its prompt and references through share and install', () => {
    const prompt = 'Review @notes.md for ${{ github.ref }}';
    const references = [
      {
        kind: 'file' as const,
        textStart: 7,
        displayText: '@notes.md',
        root: { kind: 'workspace' as const },
        relativePath: 'notes.md',
      },
    ];
    const { pipeline, inputs } = chatAutomationToPipeline({
      name: 'Notes digest',
      action: {
        type: 'standalone_prompt',
        chatProjectId: SECRET_WORKSPACE_ID,
        prompt,
        promptReferences: references,
      },
    });
    const rawPipeline = serializePipelineDocument(pipeline);
    const built = buildSharedAutomationDocument(
      baseActivity({
        name: 'Notes digest',
        executionContext: 'personal',
        action: {
          type: 'worktree_pipeline',
          target: { kind: 'global' },
          pipelineId: 'owned-1',
          pipelineSource: 'user',
          pipelineName: pipeline.name,
          inputs,
        },
      }),
      {
        description: '',
        pipelineRawContent: rawPipeline,
        pipelineContentHash: 'c'.repeat(64),
      },
    );
    expect(built.ok).toBe(true);
    if (!built.ok || built.document.action.type !== 'worktree_pipeline') return;
    expect(built.document.version).toBe(6);
    expect(built.document.action.pipeline).toMatchObject({
      source: 'inline',
      rawPipeline,
    });
    expect(built.document.action.inputKeys).toEqual(['project_id']);
    // The destination is the recipient's to choose; only its key travels.
    expect(JSON.stringify(built.document)).not.toContain(SECRET_WORKSPACE_ID);

    const installed = buildInstallAutomationRequest(
      {
        id: '4f6b0f5e-2f66-4be4-9f8e-1f0a54a1c111',
        contentHash: 'a'.repeat(64),
        automation: built.document,
      },
      {
        inputs: { project_id: 'recipient-cowork' },
        bundledPipelineLocalId: 'local-1',
        // The install dialog reads the bundled pipeline's scope.
        pipelineResolution: { status: 'resolved', scopes: pipeline.scope },
      },
      '2026-10-29T00:00:00.000Z',
    );
    if (!installed.ok) throw new Error(installed.error);
    const action = installed.request.action;
    if (action.type !== 'worktree_pipeline') throw new Error('not a pipeline');
    expect(action).toMatchObject({
      target: { kind: 'global' },
      pipelineId: 'local-1',
      inputs: { project_id: 'recipient-cowork' },
    });
    // Nobody re-enters the prompt: the installed copy maps back to it.
    expect(
      ownedPipelineToChatAction(
        parsePipelineText(rawPipeline),
        action.inputs ?? {},
        () => true,
      ),
    ).toEqual({
      type: 'standalone_prompt',
      chatProjectId: 'recipient-cowork',
      prompt,
      promptReferences: references,
    });
  });
});
