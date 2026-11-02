import type {
  AgentDefinitionArtifactReceiptV1,
  AutomationArtifactReceiptV1,
  AutomationRunArtifactReceiptV1,
  CapabilityReferenceArtifactReceiptV1,
  PipelineArtifactReceiptV1,
  SkillArtifactReceiptV1,
} from '@canopy/protocol/agent-artifacts';
import {
  capabilityTileModel,
  describeCapabilityChangedFields,
  formatCapabilityRunDuration,
  isCapabilityTileReceipt,
} from '../capability-tile-model';

const CREATED_AT = '2026-10-16T12:00:00.000Z';

function automationRun(
  overrides: Partial<AutomationRunArtifactReceiptV1> = {},
): AutomationRunArtifactReceiptV1 {
  return {
    version: 1,
    kind: 'automation_run',
    operation: 'automation.run_now',
    dedupeKey: 'canopy:automation_run:local:run-1',
    createdAt: CREATED_AT,
    activityId: 'act-1',
    runId: 'run-1',
    name: 'Nightly triage',
    status: 'success',
    trigger: 'manual',
    scheduledFor: CREATED_AT,
    startedAt: CREATED_AT,
    completedAt: CREATED_AT,
    durationMs: 65_000,
    navigationTarget: {
      kind: 'automation_editor',
      activityId: 'act-1',
      section: 'runs',
      runId: 'run-1',
    },
    ...overrides,
  };
}

function reference(
  overrides: Partial<CapabilityReferenceArtifactReceiptV1> = {},
): CapabilityReferenceArtifactReceiptV1 {
  return {
    version: 1,
    kind: 'capability_reference',
    operation: 'capabilities.show',
    dedupeKey: 'canopy:capability_reference:skill:installed:src/review',
    createdAt: CREATED_AT,
    itemKind: 'skill',
    source: 'installed',
    sourceId: 'src/review',
    name: 'Code review',
    description: 'Reviews a diff',
    sourceLabel: 'Installed',
    state: 'installed',
    relation: 'recommended',
    reason: 'Matches your review request',
    navigationTarget: {
      kind: 'installed_skill',
      sourceId: 'src',
      skillName: 'review',
    },
    ...overrides,
  };
}

describe('capabilityTileModel', () => {
  it('words created and updated pipelines, skills and automations', () => {
    const pipeline: PipelineArtifactReceiptV1 = {
      version: 1,
      kind: 'pipeline',
      operation: 'pipeline.create',
      dedupeKey: 'canopy:pipeline:user:p1',
      createdAt: CREATED_AT,
      source: 'user',
      localId: 'p1',
      name: 'Ship it',
      enabled: false,
      scopes: [],
      runModes: [],
      jobCount: 2,
      stepCount: 5,
      navigationTarget: {
        kind: 'pipeline_editor',
        pipelineId: 'p1',
        source: 'user',
      },
    };
    expect(capabilityTileModel(pipeline)).toMatchObject({
      iconKind: 'pipeline',
      kindLabel: 'Workflow',
      operationLabel: 'Created',
      kindPhrase: 'Created workflow',
      summary: '2 jobs · 5 steps',
      state: { label: 'Disabled', tone: 'muted' },
    });

    const skill: SkillArtifactReceiptV1 = {
      version: 1,
      kind: 'skill',
      operation: 'skills.update',
      dedupeKey: 'canopy:skill:installed:src/review',
      createdAt: CREATED_AT,
      source: 'installed',
      sourceId: 'src',
      installedName: 'review',
      name: 'Review',
      canUpdate: true,
      navigationTarget: {
        kind: 'installed_skill',
        sourceId: 'src',
        skillName: 'review',
      },
    };
    const skillModel = capabilityTileModel(skill);
    expect(skillModel).toMatchObject({
      operationLabel: 'Updated',
      kindPhrase: 'Updated skill',
    });
    // No filler summary or source: the tile names the kind once.
    expect(skillModel.summary).toBeUndefined();
    expect(skillModel.sourceLabel).toBeUndefined();
    expect(
      capabilityTileModel({ ...skill, source: 'shared' }).sourceLabel,
    ).toBe('Shared');

    const automation: AutomationArtifactReceiptV1 = {
      version: 1,
      kind: 'automation',
      operation: 'automation.update',
      dedupeKey: 'canopy:automation:local:act-1',
      createdAt: CREATED_AT,
      changedFields: ['schedule', 'name'],
      activityId: 'act-1',
      name: 'Nightly triage',
      enabled: true,
      running: true,
      schedule: 'Every day at 9:00',
      actionKind: 'worktree_chat',
      targetSummary: 'Canopy',
      ifCommandConfigured: false,
      navigationTarget: { kind: 'automation_editor', activityId: 'act-1' },
    };
    expect(capabilityTileModel(automation)).toMatchObject({
      operationLabel: 'Updated',
      summary: 'Enabled · Every day at 9:00',
      changeSummary: 'Changed schedule and name',
      state: { label: 'Running', tone: 'info' },
    });
  });

  it('shows run outcomes, including failures and skips', () => {
    expect(capabilityTileModel(automationRun())).toMatchObject({
      kindLabel: 'Automation run',
      kindPhrase: 'Automation run',
      operationLabel: 'Triggered',
      summary: 'Manual run · 1 min 5 s',
      state: { label: 'Succeeded', tone: 'success' },
    });
    expect(
      capabilityTileModel(automationRun({ status: 'failure' })).state,
    ).toEqual({ label: 'Failed', tone: 'danger' });
    expect(
      capabilityTileModel(
        automationRun({ status: 'skipped', skipReason: 'if_command_exit' }),
      ),
    ).toMatchObject({
      summary: 'Manual run · If Command skipped this run · 1 min 5 s',
      state: { label: 'Skipped', tone: 'warning' },
    });
  });

  it('takes newer live run status but never regresses a finished run', () => {
    const running = automationRun({
      status: 'running',
      completedAt: undefined,
      durationMs: undefined,
    });
    expect(
      capabilityTileModel(running, {
        runStatus: 'failure',
        runDurationMs: 3000,
      }),
    ).toMatchObject({
      state: { label: 'Failed' },
      summary: 'Manual run · 3 s',
    });
    expect(
      capabilityTileModel(automationRun(), { runStatus: 'running' }).state,
    ).toEqual({ label: 'Succeeded', tone: 'success' });
  });

  it('keeps a run outcome after its automation is deleted', () => {
    const model = capabilityTileModel(automationRun({ status: 'failure' }), {
      availability: 'removed',
    });
    expect(model.removed).toBe(true);
    expect(model.state?.label).toBe('Failed');
    expect(model.removedNote).toBe('Automation deleted');
  });

  it('marks other removed items as Removed', () => {
    const model = capabilityTileModel(reference(), { availability: 'removed' });
    expect(model).toMatchObject({
      removed: true,
      state: { label: 'Removed', tone: 'muted' },
    });
  });

  it('words agents, found and recommended references', () => {
    const agent: AgentDefinitionArtifactReceiptV1 = {
      version: 1,
      kind: 'agent',
      operation: 'agents.import_shared',
      dedupeKey: 'canopy:agent:local:agent-1',
      createdAt: CREATED_AT,
      source: 'local',
      agentId: 'agent-1',
      name: 'Reviewer',
      model: 'Opus',
      navigationTarget: { kind: 'agent_editor', agentId: 'agent-1' },
    };
    expect(capabilityTileModel(agent)).toMatchObject({
      iconKind: 'agent',
      operationLabel: 'Imported',
      kindPhrase: 'Imported agent',
      summary: 'Opus',
    });
    expect(capabilityTileModel(agent).sourceLabel).toBeUndefined();
    const found = capabilityTileModel(reference());
    expect(found).toMatchObject({
      kindLabel: 'Skill',
      kindPhrase: 'Skill',
      operationLabel: 'Recommended',
      state: { label: 'Installed', tone: 'muted' },
      reason: 'Matches your review request',
      external: false,
    });
    // "Installed" is the state; the matching source label is not repeated.
    expect(found.sourceLabel).toBeUndefined();
    expect(
      capabilityTileModel(reference({ sourceLabel: 'Local' })).sourceLabel,
    ).toBeUndefined();
    expect(
      capabilityTileModel(
        reference({ state: 'available', sourceLabel: 'Shared' }),
      ),
    ).toMatchObject({
      sourceLabel: 'Shared',
      state: { label: 'Not installed', tone: 'muted' },
    });
    expect(
      capabilityTileModel(
        reference({
          relation: 'found',
          state: 'needs-auth',
          itemKind: 'mcp-server',
        }),
      ),
    ).toMatchObject({
      kindLabel: 'MCP server',
      kindPhrase: 'MCP server',
      operationLabel: 'Found',
      state: { label: 'Needs sign-in' },
    });
  });

  it('labels external references and leaves unknown state unset', () => {
    const model = capabilityTileModel(
      reference({
        source: 'external',
        sourceId: 'https://example.com/skill',
        sourceLabel: 'example.com',
        state: 'unknown',
        navigationTarget: {
          kind: 'external_url',
          url: 'https://example.com/skill',
        },
      }),
    );
    expect(model.external).toBe(true);
    expect(model.state).toBeUndefined();
  });

  it('words plugin skills that open their parent plugin', () => {
    const model = capabilityTileModel(
      reference({
        dedupeKey:
          'canopy:capability_reference:skill:plugin:m/superpowers:writing-plans',
        source: 'plugin',
        sourceId: 'm/superpowers:writing-plans',
        name: 'superpowers:writing-plans',
        description: undefined,
        sourceLabel: 'Plugin',
        navigationTarget: {
          kind: 'capability_entry',
          entry: {
            type: 'marketplace-plugin',
            marketplaceId: 'm',
            pluginName: 'superpowers',
          },
        },
      }),
    );
    expect(model).toMatchObject({
      iconKind: 'skill',
      kindLabel: 'Skill',
      name: 'superpowers:writing-plans',
      sourceLabel: 'Plugin',
      state: { label: 'Installed', tone: 'muted' },
      external: false,
    });
    expect(model.summary).toBeUndefined();
  });

  it('leaves specialized run rows to their hosts', () => {
    expect(isCapabilityTileReceipt(automationRun())).toBe(true);
    expect(
      isCapabilityTileReceipt({
        version: 1,
        kind: 'pipeline_run',
        operation: 'pipeline.run',
        dedupeKey: 'canopy:pipeline_run:local:e1',
        createdAt: CREATED_AT,
        executionId: 'e1',
        pipelineId: 'p1',
        pipelineName: 'Ship',
        initialStatus: 'running',
        queuedAt: CREATED_AT,
        projectId: 'proj',
        worktreeId: 'wt',
        navigationTarget: {
          kind: 'pipeline_execution',
          executionId: 'e1',
          projectId: 'proj',
          worktreeId: 'wt',
        },
      }),
    ).toBe(false);
  });
});

describe('describeCapabilityChangedFields', () => {
  it('lists readable labels and caps long lists', () => {
    expect(describeCapabilityChangedFields(undefined)).toBeUndefined();
    expect(describeCapabilityChangedFields(['ifCommand'])).toBe(
      'Changed If Command',
    );
    expect(
      describeCapabilityChangedFields([
        'name',
        'schedule',
        'enabled',
        'action',
        'baseModel',
      ]),
    ).toBe('Changed name, schedule, enabled state and 2 more');
  });
});

describe('formatCapabilityRunDuration', () => {
  it('formats seconds and minutes and rejects invalid values', () => {
    expect(formatCapabilityRunDuration(400)).toBe('1 s');
    expect(formatCapabilityRunDuration(42_000)).toBe('42 s');
    expect(formatCapabilityRunDuration(120_000)).toBe('2 min');
    expect(formatCapabilityRunDuration(Number.NaN)).toBeUndefined();
    expect(formatCapabilityRunDuration(-1)).toBeUndefined();
  });
});
