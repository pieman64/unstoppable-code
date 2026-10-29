import { serializeAgentArtifactReceipt as serializePortableReceipt } from '@canopy/protocol/agent-artifacts';
import { agentArtifactsForActionResult } from '../agent-artifacts';
import type {
  AgentArtifactReceiptV1,
  GitHubWorkflowRunArtifactReceiptV1,
  PipelineRunArtifactReceiptV1,
} from '../../types/agent-artifacts';
import {
  AGENT_ARTIFACT_TEXT_LIMITS,
  MAX_AGENT_ARTIFACT_CARRY_BYTES,
  buildAgentDefinitionArtifactReceipt,
  buildAutomationArtifactReceipt,
  buildCapabilityReferenceArtifactReceipt,
  buildGitHubWorkflowRunArtifactReceipt,
  buildPipelineArtifactReceipt,
  buildPipelineRunArtifactReceipt,
  isSameAgentArtifactCarryReceipt,
  buildSkillArtifactReceipt,
  createAgentArtifactDedupeKey,
  isAgentArtifactCarryReceiptV1,
  getAgentResourceRetrySemantics,
  isAgentArtifactReceiptEligibleAction,
  normalizeAgentArtifactCarryByTurn,
  normalizeAgentArtifactNavigationRequest,
  normalizeAgentResourceError,
  normalizeSkillViewerDeepLink,
  serializeAgentArtifactReceipt,
  withAgentArtifacts,
} from '../agent-artifacts';

const createdAt = '2026-08-04T20:00:00.000Z';

describe('dependency repair receipt locators', () => {
  it('retains a project pipeline locator and rejects another worktree or unsafe path', () => {
    const receipt = buildPipelineArtifactReceipt({
      operation: 'capability_package.analyze',
      source: 'project',
      localId: 'project--fix.yaml',
      name: 'Fix',
      enabled: true,
      scopes: ['worktree'],
      runModes: ['dispatch'],
      jobCount: 1,
      stepCount: 1,
      navigationTarget: {
        kind: 'pipeline_editor',
        pipelineId: 'project--fix.yaml',
        source: 'project',
        projectId: 'project',
        worktreeId: 'worktree',
      },
      shareTarget: {
        kind: 'pipeline',
        source: 'project',
        pipelineId: 'project--fix.yaml',
        projectId: 'project',
        worktreeId: 'worktree',
        relativePath: '.canopy/pipelines/fix.yaml',
      },
    });
    expect(serializeAgentArtifactReceipt(receipt)).toMatchObject({
      shareTarget: receipt.shareTarget,
    });
    expect(
      serializeAgentArtifactReceipt({
        ...receipt,
        shareTarget: { ...receipt.shareTarget, worktreeId: 'other' },
      }),
    ).toBeNull();
    expect(
      serializeAgentArtifactReceipt({
        ...receipt,
        shareTarget: { ...receipt.shareTarget, relativePath: '../escape.yaml' },
      }),
    ).toBeNull();
    expect(
      isAgentArtifactReceiptEligibleAction('capability_package.analyze'),
    ).toBe(true);
    expect(getAgentResourceRetrySemantics('capability_package.analyze')).toBe(
      'idempotent',
    );
    expect(
      serializeAgentArtifactReceipt({ ...receipt, shareTarget: undefined }),
    ).not.toBeNull();
  });
});

function pipelineRun(
  executionId = 'execution-1',
): PipelineRunArtifactReceiptV1 {
  return {
    version: 1,
    kind: 'pipeline_run',
    operation: 'pipeline.run',
    dedupeKey: createAgentArtifactDedupeKey(
      'pipeline_run',
      'worktree',
      executionId,
    ),
    createdAt,
    executionId,
    pipelineId: 'pipeline-1',
    pipelineName: 'Build',
    initialStatus: 'pending',
    queuedAt: createdAt,
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    navigationTarget: {
      kind: 'pipeline_execution',
      executionId,
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    },
  };
}

function githubRun(
  runId = '101',
  overrides: Partial<GitHubWorkflowRunArtifactReceiptV1> = {},
): GitHubWorkflowRunArtifactReceiptV1 {
  return buildGitHubWorkflowRunArtifactReceipt({
    operation: 'github.watch',
    createdAt,
    watcherId: 'watcher-1',
    repository: 'acme/api',
    runId,
    runAttempt: 1,
    workflowName: 'CI',
    runNumber: 42,
    htmlUrl: `https://github.com/acme/api/actions/runs/${runId}`,
    state: { kind: 'intermediate', status: 'in_progress' },
    startedAt: createdAt,
    observedAt: createdAt,
    jobs: [
      {
        jobId: '501',
        name: 'Build macOS',
        status: 'in_progress',
        conclusion: null,
        htmlUrl: `https://github.com/acme/api/actions/runs/${runId}/job/501`,
        createdAt,
        startedAt: createdAt,
        observedAt: createdAt,
      },
    ],
    navigationTarget: {
      kind: 'github_workflow_run',
      repository: 'acme/api',
      runId,
      htmlUrl: `https://github.com/acme/api/actions/runs/${runId}`,
    },
    ...overrides,
  });
}

describe('GitHub workflow-run receipts', () => {
  it('builds a run-scoped receipt that round-trips through serialization', () => {
    const receipt = githubRun();
    expect(receipt.dedupeKey).toBe('canopy:github_workflow_run:acme%2Fapi:101');
    expect(serializeAgentArtifactReceipt(receipt)).toEqual(receipt);
    expect(
      serializeAgentArtifactReceipt(JSON.parse(JSON.stringify(receipt))),
    ).toEqual(receipt);
    expect(receipt.jobs?.[0]?.createdAt).toBe(createdAt);
  });

  it('rejects receipts whose URLs are not GitHub.com run pages or whose navigation disagrees', () => {
    expect(
      serializeAgentArtifactReceipt({
        ...githubRun(),
        htmlUrl: 'https://evil.example/acme/api/actions/runs/101',
        navigationTarget: {
          kind: 'github_workflow_run',
          repository: 'acme/api',
          runId: '101',
          htmlUrl: 'https://evil.example/acme/api/actions/runs/101',
        },
      }),
    ).toBeNull();
    expect(
      serializeAgentArtifactReceipt({
        ...githubRun(),
        navigationTarget: {
          kind: 'github_workflow_run',
          repository: 'acme/api',
          runId: '102',
          htmlUrl: 'https://github.com/acme/api/actions/runs/101',
        },
      }),
    ).toBeNull();
    expect(
      serializeAgentArtifactReceipt({
        ...githubRun(),
        jobs: [
          {
            jobId: '501',
            name: 'Build',
            status: 'completed',
            conclusion: 'not-a-conclusion',
            htmlUrl: 'https://github.com/acme/api/actions/runs/101/job/501',
            observedAt: createdAt,
          },
        ],
      }),
    ).toBeNull();
    expect(
      serializeAgentArtifactReceipt({
        ...githubRun(),
        state: { kind: 'terminal', conclusion: 'exploded' },
      }),
    ).toBeNull();
  });

  it('bounds the embedded job list and workflow name', () => {
    const jobs = Array.from({ length: 600 }, (_, index) => ({
      jobId: String(1_000 + index),
      name: 'Job',
      status: 'queued',
      conclusion: null,
      htmlUrl: `https://github.com/acme/api/actions/runs/101/job/${1_000 + index}`,
      observedAt: createdAt,
    }));
    const serialized = serializeAgentArtifactReceipt({
      ...githubRun(),
      workflowName: 'x'.repeat(500),
      jobs,
    });
    expect(serialized?.kind).toBe('github_workflow_run');
    if (serialized?.kind !== 'github_workflow_run') return;
    expect(serialized.jobs).toHaveLength(500);
    expect(serialized.workflowName).toHaveLength(
      AGENT_ARTIFACT_TEXT_LIMITS.name,
    );
  });

  it('carries a bounded workflow definition graph and drops a malformed one', () => {
    const graph = {
      sha: 'a'.repeat(40),
      observedAt: createdAt,
      jobs: [
        {
          id: 'build',
          template: 'Build',
          names: ['Build'],
          needs: [],
          dynamic: false,
        },
        {
          id: 'test',
          template: 'Test (${{ matrix.shard }})',
          names: ['Test (1)', 'Test (2)'],
          needs: ['build'],
          dynamic: false,
        },
      ],
    };
    const serialized = serializeAgentArtifactReceipt({
      ...githubRun(),
      definition: graph,
    });
    expect(serialized?.kind).toBe('github_workflow_run');
    if (serialized?.kind !== 'github_workflow_run') return;
    expect(serialized.definition).toEqual(graph);
    // The graph is display-only: a malformed or oversized one is omitted
    // rather than rejecting the receipt.
    const malformed = serializeAgentArtifactReceipt({
      ...githubRun(),
      definition: { sha: 'x', jobs: [{ id: 'a' }] },
    });
    expect(malformed?.kind).toBe('github_workflow_run');
    expect(malformed).not.toHaveProperty('definition');
    const oversized = serializeAgentArtifactReceipt({
      ...githubRun(),
      definition: {
        ...graph,
        jobs: Array.from({ length: 201 }, (_, index) => ({
          id: `job-${index}`,
          template: 'Job',
          names: ['Job'],
          needs: [],
          dynamic: false,
        })),
      },
    });
    expect(oversized).not.toHaveProperty('definition');
    // A newly read graph counts as a refreshed carry receipt.
    const base = githubRun();
    expect(
      isSameAgentArtifactCarryReceipt(base, { ...base, definition: graph }),
    ).toBe(false);
  });

  it('recognizes only pipeline-run and GitHub-run receipts as carry kinds', () => {
    expect(isAgentArtifactCarryReceiptV1(pipelineRun())).toBe(true);
    expect(isAgentArtifactCarryReceiptV1(githubRun())).toBe(true);
    expect(isAgentArtifactCarryReceiptV1({ ...githubRun(), runId: 'x' })).toBe(
      false,
    );
    expect(
      isAgentArtifactCarryReceiptV1(
        buildAutomationArtifactReceipt({
          operation: 'automation.create',
          activityId: 'activity-1',
          name: 'Nightly',
          enabled: true,
          running: false,
          schedule: 'daily',
          actionKind: 'pipeline',
          targetSummary: 'pipeline',
          ifCommandConfigured: false,
          navigationTarget: {
            kind: 'automation_editor',
            activityId: 'activity-1',
          },
        }),
      ),
    ).toBe(false);
  });

  it('carries GitHub runs beside pipeline runs and dedupes by identity', () => {
    const run = pipelineRun();
    const github = githubRun();
    expect(
      normalizeAgentArtifactCarryByTurn(
        { 'turn-1': [run, github, { ...github, observedAt: createdAt }] },
        new Set(['turn-1']),
      ),
    ).toEqual({ 'turn-1': [run, github] });
  });

  it('treats a refreshed GitHub snapshot as a different carry receipt', () => {
    const github = githubRun();
    expect(isSameAgentArtifactCarryReceipt(github, { ...github })).toBe(true);
    expect(
      isSameAgentArtifactCarryReceipt(github, {
        ...github,
        observedAt: '2026-08-04T20:01:00.000Z',
        state: { kind: 'terminal', conclusion: 'success' },
      }),
    ).toBe(false);
    const run = pipelineRun();
    expect(isSameAgentArtifactCarryReceipt(run, { ...run })).toBe(true);
    expect(
      isSameAgentArtifactCarryReceipt(run, {
        ...run,
        createdAt: '2026-08-04T20:01:00.000Z',
      }),
    ).toBe(false);
    expect(isSameAgentArtifactCarryReceipt(run, github)).toBe(false);
  });

  it('carries a pipeline run owner and optional job through navigation', () => {
    expect(
      normalizeAgentArtifactNavigationRequest({
        kind: 'pipeline_execution',
        executionId: 'run-1',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        jobId: 'deploy',
        viewStack: [{ executionId: 'child', label: 'Child' }],
      }),
    ).toEqual({
      kind: 'pipeline_execution',
      executionId: 'run-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      jobId: 'deploy',
    });
    expect(
      normalizeAgentArtifactNavigationRequest({
        kind: 'pipeline_execution',
        executionId: 'run-1',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      }),
    ).toEqual({
      kind: 'pipeline_execution',
      executionId: 'run-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
    expect(
      normalizeAgentArtifactNavigationRequest({
        kind: 'pipeline_execution',
        executionId: 'run-1',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        jobId: 42,
      }),
    ).toBeNull();
  });

  it('accepts GitHub workflow-run navigation only for GitHub.com run URLs', () => {
    expect(
      normalizeAgentArtifactNavigationRequest({
        kind: 'github_workflow_run',
        repository: 'acme/api',
        runId: '101',
        htmlUrl: 'https://github.com/acme/api/actions/runs/101',
        focus: true,
      }),
    ).toEqual({
      kind: 'github_workflow_run',
      repository: 'acme/api',
      runId: '101',
      htmlUrl: 'https://github.com/acme/api/actions/runs/101',
    });
    expect(
      normalizeAgentArtifactNavigationRequest({
        kind: 'github_workflow_run',
        repository: 'acme/api',
        runId: '101',
        htmlUrl: 'http://github.com/acme/api/actions/runs/101',
      }),
    ).toBeNull();
    expect(
      normalizeAgentArtifactNavigationRequest({
        kind: 'github_workflow_run',
        repository: 'acme',
        runId: '101',
        htmlUrl: 'https://github.com/acme/api/actions/runs/101',
      }),
    ).toBeNull();
  });
});

describe('agent artifact receipt contracts', () => {
  it('builds source-qualified receipts for every backend artifact family', () => {
    const installed = buildSkillArtifactReceipt({
      operation: 'skills.import_shared',
      createdAt,
      source: 'installed',
      sourceId: 'custom:app',
      installedName: 'review',
      sharedSkillId: 'shared-1',
      name: 'Review',
      owner: { type: 'user', id: 'user-1', name: 'Ada' },
      canUpdate: true,
      navigationTarget: {
        kind: 'installed_skill',
        sourceId: 'custom:app',
        skillName: 'review',
      },
    });
    const shared = buildSkillArtifactReceipt({
      operation: 'skills.share_custom',
      createdAt,
      source: 'shared',
      sharedSkillId: 'shared-1',
      name: 'Review',
      owner: { type: 'user', id: 'user-1', name: 'Ada' },
      canUpdate: true,
      navigationTarget: { kind: 'shared_skill', skillId: 'shared-1' },
    });
    const pipeline = buildPipelineArtifactReceipt({
      operation: 'pipeline.create',
      createdAt,
      source: 'user',
      localId: 'pipeline-1',
      name: 'Build',
      enabled: true,
      scopes: ['directory'],
      runModes: ['dispatch'],
      jobCount: 1,
      stepCount: 1,
      navigationTarget: {
        kind: 'pipeline_editor',
        pipelineId: 'pipeline-1',
        source: 'user',
      },
    });
    const automation = buildAutomationArtifactReceipt({
      operation: 'automation.create',
      createdAt,
      activityId: 'activity-1',
      name: 'Daily review',
      enabled: true,
      running: false,
      schedule: 'cron 0 9 * * * (local)',
      actionKind: 'app_advisor_prompt',
      targetSummary: 'App Advisor',
      ifCommandConfigured: false,
      navigationTarget: {
        kind: 'automation_editor',
        activityId: 'activity-1',
      },
    });
    const run = buildPipelineRunArtifactReceipt({
      ...pipelineRun(),
      operation: 'pipeline.run',
      createdAt,
    });

    expect(installed.dedupeKey).toBe(
      createAgentArtifactDedupeKey(
        'skill',
        'installed',
        'custom:app',
        'review',
      ),
    );
    expect(shared.dedupeKey).toBe(
      createAgentArtifactDedupeKey('skill', 'shared', 'shared-1'),
    );
    expect(installed.dedupeKey).not.toBe(shared.dedupeKey);
    for (const receipt of [installed, shared, pipeline, automation, run]) {
      expect(serializeAgentArtifactReceipt(receipt)).toEqual(receipt);
    }
  });

  it('validates known versions and kinds and ignores unknown receipts', () => {
    expect(serializeAgentArtifactReceipt(pipelineRun())).toEqual(pipelineRun());
    expect(
      serializeAgentArtifactReceipt({ ...pipelineRun(), version: 2 }),
    ).toBeNull();
    expect(
      serializeAgentArtifactReceipt({ ...pipelineRun(), kind: 'secret' }),
    ).toBeNull();
    expect(
      serializeAgentArtifactReceipt({ ...pipelineRun(), createdAt: '2026' }),
    ).toBeNull();
    expect(
      serializeAgentArtifactReceipt({
        ...pipelineRun(),
        dedupeKey: 'canopy:pipeline_run::execution-1',
      }),
    ).toBeNull();
  });

  it('rejects pipeline receipts whose navigation target has a different identity', () => {
    const local = buildPipelineArtifactReceipt({
      operation: 'pipeline.create',
      createdAt,
      source: 'user',
      localId: 'pipeline-1',
      name: 'Build',
      enabled: true,
      scopes: ['directory'],
      runModes: ['dispatch'],
      jobCount: 1,
      stepCount: 1,
      navigationTarget: {
        kind: 'pipeline_editor',
        pipelineId: 'pipeline-1',
        source: 'user',
      },
    });
    const shared = buildPipelineArtifactReceipt({
      operation: 'pipeline.import_shared',
      createdAt,
      source: 'shared',
      sharedRemoteId: 'remote-1',
      name: 'Shared build',
      enabled: true,
      scopes: ['directory'],
      runModes: ['dispatch'],
      jobCount: 1,
      stepCount: 1,
      navigationTarget: {
        kind: 'pipeline_editor',
        pipelineId: 'shared:canopy-cloud:remote-1',
        source: 'shared',
        sharedRemoteId: 'remote-1',
      },
    });

    expect(
      serializeAgentArtifactReceipt({
        ...local,
        navigationTarget: {
          ...local.navigationTarget,
          pipelineId: 'pipeline-2',
        },
      }),
    ).toBeNull();
    expect(
      serializeAgentArtifactReceipt({
        ...local,
        navigationTarget: {
          ...local.navigationTarget,
          source: 'bundled',
        },
      }),
    ).toBeNull();
    expect(
      serializeAgentArtifactReceipt({
        ...shared,
        navigationTarget: {
          ...shared.navigationTarget,
          sharedRemoteId: 'remote-2',
        },
      }),
    ).toBeNull();
    expect(serializeAgentArtifactReceipt(local)).toEqual(local);
    expect(serializeAgentArtifactReceipt(shared)).toEqual(shared);
  });

  it('bounds presentation text and serializes only allowlisted fields', () => {
    const receipt = serializeAgentArtifactReceipt({
      version: 1,
      kind: 'automation',
      operation: 'automation.create',
      dedupeKey: createAgentArtifactDedupeKey(
        'automation',
        'activity',
        'activity-1',
      ),
      createdAt,
      activityId: 'activity-1',
      name: 'n'.repeat(500),
      enabled: true,
      running: false,
      schedule: 'Every weekday',
      actionKind: 'worktree_pipeline',
      targetSummary: 'Project pipeline',
      ifCommandConfigured: true,
      navigationTarget: {
        kind: 'automation_editor',
        activityId: 'activity-1',
        route: '/arbitrary',
      },
      command: 'cat ~/.ssh/id_rsa',
      prompt: 'private prompt',
      secret: 'secret value',
    });

    expect(receipt?.kind).toBe('automation');
    if (!receipt || receipt.kind !== 'automation') throw new Error('fixture');
    expect(receipt.name).toHaveLength(AGENT_ARTIFACT_TEXT_LIMITS.name);
    expect(receipt.navigationTarget).toEqual({
      kind: 'automation_editor',
      activityId: 'activity-1',
    });
    expect(JSON.stringify(receipt)).not.toMatch(
      /id_rsa|private prompt|secret value|arbitrary/,
    );
    expect(() => {
      JSON.parse(JSON.stringify(receipt));
    }).not.toThrow();
  });

  it('keeps installed and shared skill identities separate and retains rename aliases', () => {
    const oldKey = createAgentArtifactDedupeKey(
      'skill',
      'installed',
      'custom:app',
      'old-name',
    );
    const receipt = serializeAgentArtifactReceipt({
      version: 1,
      kind: 'skill',
      operation: 'skills.update_custom',
      dedupeKey: createAgentArtifactDedupeKey(
        'skill',
        'installed',
        'custom:app',
        'new-name',
      ),
      aliases: [oldKey, oldKey],
      createdAt,
      source: 'installed',
      sourceId: 'custom:app',
      installedName: 'new-name',
      sharedSkillId: 'shared-1',
      name: 'New name',
      canUpdate: true,
      navigationTarget: {
        kind: 'installed_skill',
        sourceId: 'custom:app',
        skillName: 'new-name',
      },
    });

    expect(receipt).toMatchObject({
      source: 'installed',
      sourceId: 'custom:app',
      installedName: 'new-name',
      sharedSkillId: 'shared-1',
      aliases: [oldKey],
    });
    expect(receipt?.dedupeKey).not.toContain('shared-1');
  });

  it('merges receipts additively without changing existing result fields', () => {
    const first = pipelineRun('execution-1');
    const second = pipelineRun('execution-2');
    const response = withAgentArtifacts(
      {
        ok: true as const,
        result: { executionId: 'execution-2', agentArtifacts: [first] },
      },
      [first, second, { ...second, version: 99 }],
    );

    expect(response.result.executionId).toBe('execution-2');
    expect(response.result.agentArtifacts).toEqual([first, second]);
  });

  it('deduplicates renamed receipts through their previous identity aliases', () => {
    const previous = buildSkillArtifactReceipt({
      operation: 'skills.create_custom',
      source: 'installed',
      sourceId: 'custom:app',
      installedName: 'old-name',
      name: 'Old name',
      canUpdate: true,
      navigationTarget: {
        kind: 'installed_skill',
        sourceId: 'custom:app',
        skillName: 'old-name',
      },
    });
    const renamed = buildSkillArtifactReceipt({
      operation: 'skills.update_custom',
      source: 'installed',
      sourceId: 'custom:app',
      installedName: 'new-name',
      aliases: [previous.dedupeKey],
      name: 'New name',
      canUpdate: true,
      navigationTarget: {
        kind: 'installed_skill',
        sourceId: 'custom:app',
        skillName: 'new-name',
      },
    });

    const response = withAgentArtifacts(
      { ok: true as const, result: { agentArtifacts: [previous] } },
      [renamed],
    );

    expect(response.result.agentArtifacts).toEqual([previous]);
  });

  it('defines receipt eligibility for reads and runs while excluding deletes', () => {
    expect(isAgentArtifactReceiptEligibleAction('pipeline.create')).toBe(true);
    expect(isAgentArtifactReceiptEligibleAction('pipeline.run')).toBe(true);
    expect(
      isAgentArtifactReceiptEligibleAction('pipeline.execution_retry'),
    ).toBe(true);
    expect(
      isAgentArtifactReceiptEligibleAction('pipeline.execution_resume'),
    ).toBe(true);
    expect(isAgentArtifactReceiptEligibleAction('skills.import_shared')).toBe(
      true,
    );
    expect(isAgentArtifactReceiptEligibleAction('automation.disable')).toBe(
      true,
    );
    for (const action of [
      'pipeline.list',
      'pipeline.delete',
      'skills.delete_shared',
      'watcher.create',
    ]) {
      expect(isAgentArtifactReceiptEligibleAction(action)).toBe(false);
    }
  });

  it('exposes retry semantics without adding a generic idempotency key', () => {
    expect(getAgentResourceRetrySemantics('skills.read_shared')).toBe(
      'idempotent',
    );
    expect(getAgentResourceRetrySemantics('automation.disable')).toBe(
      'idempotent',
    );
    expect(getAgentResourceRetrySemantics('skills.import_shared')).toBe(
      'reconcile_before_retry',
    );
    expect(getAgentResourceRetrySemantics('pipeline.run')).toBe(
      'distinct_execution_on_success',
    );
    expect(getAgentResourceRetrySemantics('pipeline.delete')).toBe(
      'existing_delete_semantics',
    );
  });

  it('normalizes resource errors to bounded, serializable codes', () => {
    expect(
      normalizeAgentResourceError({
        code: 'authentication_failed',
        message: 'm'.repeat(2_000),
        retryable: true,
        secret: 'not copied',
      }),
    ).toEqual({
      code: 'authentication_failed',
      message: 'm'.repeat(AGENT_ARTIFACT_TEXT_LIMITS.description),
      retryable: true,
    });
    expect(normalizeAgentResourceError({ code: 'arbitrary' })).toMatchObject({
      code: 'validation_failed',
      retryable: false,
    });
  });
});

describe('agent artifact carry and navigation compatibility', () => {
  it('drops malformed, unknown, duplicate, and orphaned carry entries', () => {
    const first = pipelineRun('execution-1');
    const normalized = normalizeAgentArtifactCarryByTurn(
      {
        'user-1': [
          first,
          first,
          { ...pipelineRun('execution-2'), version: 2 },
          { ...first, kind: 'automation' },
        ],
        orphan: [pipelineRun('execution-3')],
      },
      new Set(['user-1']),
    );

    expect(normalized).toEqual({ 'user-1': [first] });
    expect(normalizeAgentArtifactCarryByTurn(undefined)).toBeUndefined();
  });

  it('bounds accumulated GitHub snapshots while retaining the newest turn', () => {
    const largeRun = (runId: string): GitHubWorkflowRunArtifactReceiptV1 =>
      githubRun(runId, {
        jobs: Array.from({ length: 500 }, (_, index) => ({
          jobId: String(Number(runId) * 1_000 + index + 1),
          name: `${String(index).padStart(3, '0')}-${'n'.repeat(196)}`,
          status: 'in_progress',
          conclusion: null,
          htmlUrl: `https://github.com/acme/api/actions/runs/${runId}/job/${String(Number(runId) * 1_000 + index + 1)}`,
          createdAt,
          startedAt: createdAt,
          observedAt: createdAt,
        })),
      });
    const carry = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [
        `user-${index + 1}`,
        [largeRun(String(index + 101))],
      ]),
    );

    const normalized = normalizeAgentArtifactCarryByTurn(carry);
    const serializedBytes = new TextEncoder().encode(
      JSON.stringify(normalized),
    ).byteLength;

    expect(serializedBytes).toBeLessThanOrEqual(MAX_AGENT_ARTIFACT_CARRY_BYTES);
    expect(normalized?.['user-6']?.[0]).toMatchObject({
      kind: 'github_workflow_run',
      runId: '106',
    });
    expect(normalized?.['user-1']?.[0]).not.toHaveProperty('jobs');
  });

  it('accepts only allowlisted artifact navigation discriminants and strips extra state', () => {
    expect(
      normalizeAgentArtifactNavigationRequest({
        kind: 'installed_skill',
        sourceId: 'custom:app',
        skillName: 'review',
        filePath: 'references/api.md',
        route: '/plugins',
        focus: true,
      }),
    ).toEqual({
      kind: 'installed_skill',
      sourceId: 'custom:app',
      skillName: 'review',
      filePath: 'references/api.md',
    });
    expect(
      normalizeAgentArtifactNavigationRequest({
        kind: 'arbitrary_action',
        action: 'navigation.go_to_page',
      }),
    ).toBeNull();
  });

  it('preserves repository scope only for project pipeline navigation', () => {
    expect(
      normalizeAgentArtifactNavigationRequest({
        kind: 'pipeline_editor',
        pipelineId: 'project--build.yaml',
        source: 'project',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        repoId: 'child-repo',
      }),
    ).toEqual({
      kind: 'pipeline_editor',
      pipelineId: 'project--build.yaml',
      source: 'project',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      repoId: 'child-repo',
    });
    expect(
      normalizeAgentArtifactNavigationRequest({
        kind: 'pipeline_editor',
        pipelineId: 'pipeline-1',
        source: 'user',
        repoId: 'child-repo',
      }),
    ).toBeNull();
  });

  it('hydrates tagged shared links and legacy untagged installed-skill links', () => {
    expect(
      normalizeSkillViewerDeepLink({
        sourceId: 'custom:app',
        skillName: 'review',
      }),
    ).toEqual({
      kind: 'installed',
      sourceId: 'custom:app',
      skillName: 'review',
    });
    expect(
      normalizeSkillViewerDeepLink({ kind: 'shared', skillId: 'shared-1' }),
    ).toEqual({ kind: 'shared', skillId: 'shared-1' });
  });

  it('keeps every receipt JSON serializable', () => {
    const receipts: AgentArtifactReceiptV1[] = [pipelineRun()];
    expect(JSON.parse(JSON.stringify(receipts))).toEqual(receipts);
  });
});

describe('capability receipt contracts', () => {
  const receipt = {
    version: 1,
    kind: 'capability_reference',
    operation: 'show_capabilities',
    dedupeKey:
      'canopy:capability_reference:external:https%3A%2F%2Fexample.com%2Fskill',
    createdAt,
    itemKind: 'skill',
    source: 'external',
    sourceId: 'https://example.com/skill',
    name: 'Research',
    sourceLabel: 'External',
    state: 'unknown',
    relation: 'recommended',
    reason: 'Useful for research',
    navigationTarget: {
      kind: 'external_url',
      url: 'https://example.com/skill',
    },
  };
  it('round trips a validated recommendation', () => {
    expect(serializeAgentArtifactReceipt(receipt)).toEqual(receipt);
  });
  it.each([
    'http://example.com',
    'https://user:secret@example.com',
    'javascript:alert(1)',
  ])('rejects unsafe external navigation %s', (url) => {
    expect(
      normalizeAgentArtifactNavigationRequest({ kind: 'external_url', url }),
    ).toBeNull();
  });
  it('preserves automation run selection', () => {
    const target = {
      kind: 'automation_editor',
      activityId: 'a1',
      section: 'runs',
      runId: 'r1',
    };
    expect(normalizeAgentArtifactNavigationRequest(target)).toEqual(target);
  });
});

it('keeps the compatibility serializer identical to the portable implementation', () => {
  expect(serializeAgentArtifactReceipt).toBe(serializePortableReceipt);
});
it('emits actual agent identities and only confirmed import aliases', () => {
  const saved = {
    id: 'local-agent',
    name: 'Researcher',
    baseModel: 'model-1',
    instructions: 'private instructions',
    importedFromRemoteId: 'remote-agent',
  };
  const imported = agentArtifactsForActionResult(
    { type: 'agents.import_shared', agentId: 'remote-agent' },
    { agent: saved },
  );
  expect(imported).toEqual([
    expect.objectContaining({
      kind: 'agent',
      agentId: 'local-agent',
      aliases: ['canopy:agent:shared:remote-agent'],
    }),
  ]);
  expect(JSON.stringify(imported)).not.toContain('private instructions');
  const unlinked = agentArtifactsForActionResult(
    { type: 'agents.import_shared', agentId: 'different' },
    { agent: saved },
  );
  expect(unlinked).toHaveLength(1);
  expect(unlinked[0]).not.toHaveProperty('aliases');
  expect(agentArtifactsForActionResult({ type: 'agents.get' }, saved)).toEqual([
    expect.objectContaining({
      kind: 'capability_reference',
      relation: 'found',
    }),
  ]);
  expect(
    agentArtifactsForActionResult({ type: 'agents.delete' }, saved),
  ).toEqual([]);
});

it('treats blank optional producer text as absent instead of rejecting the receipt', () => {
  expect(
    buildCapabilityReferenceArtifactReceipt({
      operation: 'skills.read_shared',
      itemKind: 'skill',
      source: 'shared',
      sourceId: 'skill-1',
      name: 'Review',
      description: '',
      sourceLabel: 'Shared',
      state: 'available',
      relation: 'found',
      reason: '  ',
      navigationTarget: { kind: 'shared_skill', skillId: 'skill-1' },
    }),
  ).not.toHaveProperty('description');
  const [agent] = agentArtifactsForActionResult(
    { type: 'agents.create' },
    { agent: { id: 'agent-1', name: 'Helper', baseModel: '' } },
  );
  expect(agent).toMatchObject({ kind: 'agent', agentId: 'agent-1' });
  expect(agent).not.toHaveProperty('model');
  expect(
    buildAgentDefinitionArtifactReceipt({
      operation: 'agents.update',
      source: 'local',
      agentId: 'agent-1',
      name: 'Helper',
      description: '',
      navigationTarget: { kind: 'agent_editor', agentId: 'agent-1' },
    }),
  ).not.toHaveProperty('description');
});
