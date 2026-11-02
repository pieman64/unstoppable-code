import {
  agentArtifactItemKeys,
  agentArtifactItemPrecedence,
  collapseAgentArtifactsByItem,
  mergeAgentArtifactsByPrecedence,
  type AgentArtifactReceiptV1,
  type AgentDefinitionArtifactReceiptV1,
  type AutomationArtifactReceiptV1,
  type AutomationRunArtifactReceiptV1,
  type CapabilityReferenceArtifactReceiptV1,
  type GitHubWorkflowRunArtifactReceiptV1,
  type PipelineArtifactReceiptV1,
  type PipelineRunArtifactReceiptV1,
  type SkillArtifactReceiptV1,
} from '..';

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

function pipelineRun(
  overrides: Partial<PipelineRunArtifactReceiptV1> = {},
): PipelineRunArtifactReceiptV1 {
  return {
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
    ...overrides,
  };
}

function createdPipeline(
  overrides: Partial<PipelineArtifactReceiptV1> = {},
): PipelineArtifactReceiptV1 {
  return {
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
    ...overrides,
  };
}

function foundPipeline(
  pipelineId: string,
  source: 'user' | 'bundled' | 'curated' | 'project' | 'shared',
  sharedRemoteId?: string,
  scope: { projectId?: string; worktreeId?: string } = source === 'project'
    ? { projectId: 'proj', worktreeId: 'wt' }
    : {},
): CapabilityReferenceArtifactReceiptV1 {
  return reference({
    operation: 'pipeline.get',
    dedupeKey: `canopy:capability_reference:${source}:pipeline:${pipelineId}`,
    itemKind: 'pipeline',
    source,
    sourceId: sharedRemoteId ?? pipelineId,
    name: 'Ship it',
    sourceLabel: source === 'shared' ? 'Shared' : 'Local',
    relation: 'found',
    reason: undefined,
    navigationTarget: {
      kind: 'pipeline_editor',
      pipelineId,
      source,
      ...(sharedRemoteId === undefined ? {} : { sharedRemoteId }),
      ...scope,
    },
  });
}

function foundAutomation(
  activityId: string,
): CapabilityReferenceArtifactReceiptV1 {
  return reference({
    operation: 'automation.get',
    dedupeKey: `canopy:capability_reference:local:automation:${activityId}`,
    itemKind: 'automation',
    source: 'local',
    sourceId: activityId,
    name: 'Nightly triage',
    sourceLabel: 'Local',
    relation: 'found',
    reason: undefined,
    navigationTarget: { kind: 'automation_editor', activityId },
  });
}

function createdAutomation(activityId: string): AutomationArtifactReceiptV1 {
  return {
    version: 1,
    kind: 'automation',
    operation: 'automation.create',
    dedupeKey: `canopy:automation:local:${activityId}`,
    createdAt: CREATED_AT,
    activityId,
    name: 'Nightly triage',
    enabled: true,
    running: false,
    schedule: '0 9 * * *',
    actionKind: 'agent',
    targetSummary: 'Agent prompt',
    ifCommandConfigured: false,
    navigationTarget: { kind: 'automation_editor', activityId },
  };
}

function installedSkill(
  skillName: string,
  operation = 'skills.update_custom',
): SkillArtifactReceiptV1 {
  return {
    version: 1,
    kind: 'skill',
    operation,
    dedupeKey: `canopy:skill:installed:custom:app/${skillName}`,
    createdAt: CREATED_AT,
    source: 'installed',
    sourceId: 'custom:app',
    installedName: skillName,
    name: skillName,
    canUpdate: true,
    navigationTarget: {
      kind: 'installed_skill',
      sourceId: 'custom:app',
      skillName,
    },
  };
}

function sharedSkill(skillId: string): SkillArtifactReceiptV1 {
  return {
    version: 1,
    kind: 'skill',
    operation: 'skills.create_shared',
    dedupeKey: `canopy:skill:shared:${skillId}`,
    createdAt: CREATED_AT,
    source: 'shared',
    sharedSkillId: skillId,
    name: 'Release notes writer',
    canUpdate: false,
    navigationTarget: { kind: 'shared_skill', skillId },
  };
}

function agentDefinition(
  source: 'local' | 'shared',
  agentId: string,
): AgentDefinitionArtifactReceiptV1 {
  return {
    version: 1,
    kind: 'agent',
    operation: source === 'local' ? 'agents.create' : 'agents.create_shared',
    dedupeKey: `canopy:agent:${source}:${agentId}`,
    createdAt: CREATED_AT,
    source,
    agentId,
    name: 'Researcher',
    navigationTarget:
      source === 'local'
        ? { kind: 'agent_editor', agentId }
        : { kind: 'shared_agent', agentId },
  };
}

function githubWorkflowRun(): GitHubWorkflowRunArtifactReceiptV1 {
  return {
    version: 1,
    kind: 'github_workflow_run',
    operation: 'github.watch_workflow_run',
    dedupeKey: 'canopy:github_workflow_run:acme/app:42',
    createdAt: CREATED_AT,
    watcherId: 'w1',
    repository: 'acme/app',
    runId: '42',
    runAttempt: 1,
    workflowName: 'Ship',
    htmlUrl: 'https://github.com/acme/app/actions/runs/42',
    state: { kind: 'intermediate', status: 'in_progress' },
    observedAt: CREATED_AT,
    navigationTarget: {
      kind: 'github_workflow_run',
      repository: 'acme/app',
      runId: '42',
      htmlUrl: 'https://github.com/acme/app/actions/runs/42',
    },
  };
}

/** Builds a receipt that is missing a field the type requires, as persisted data can. */
function withoutNavigationTarget(
  receipt: AgentArtifactReceiptV1,
): AgentArtifactReceiptV1 {
  const copy = { ...receipt };
  Reflect.deleteProperty(copy, 'navigationTarget');
  return copy;
}

describe('collapseAgentArtifactsByItem', () => {
  it('keeps only the run when a local pipeline was found and run, in either order', () => {
    const found = foundPipeline('p1', 'user');
    const run = pipelineRun();
    expect(collapseAgentArtifactsByItem([found, run])).toEqual([run]);
    expect(collapseAgentArtifactsByItem([run, found])).toEqual([run]);
  });

  it('keeps only the run for a project pipeline id', () => {
    const id = 'project--.canopy/pipelines/build.yaml';
    const run = pipelineRun({ pipelineId: id });
    expect(
      collapseAgentArtifactsByItem([foundPipeline(id, 'project'), run]),
    ).toEqual([run]);
  });

  it('keeps a project pipeline found in another worktree or project', () => {
    const id = 'project--.canopy/pipelines/build.yaml';
    const run = pipelineRun({ pipelineId: id });
    const otherWorktree = foundPipeline(id, 'project', undefined, {
      projectId: 'proj',
      worktreeId: 'other-wt',
    });
    const otherProject = foundPipeline(id, 'project', undefined, {
      projectId: 'other-proj',
      worktreeId: 'wt',
    });
    expect(
      collapseAgentArtifactsByItem([otherWorktree, otherProject, run]),
    ).toEqual([otherWorktree, otherProject, run]);
  });

  it('keeps a project pipeline reference whose scope is unknown', () => {
    const id = 'project--.canopy/pipelines/build.yaml';
    const run = pipelineRun({ pipelineId: id });
    const unscoped = foundPipeline(id, 'project', undefined, {});
    expect(agentArtifactItemKeys(unscoped)).toEqual([]);
    expect(collapseAgentArtifactsByItem([unscoped, run])).toEqual([
      unscoped,
      run,
    ]);
  });

  it('keeps only the run for a shared pipeline id', () => {
    const run = pipelineRun({ pipelineId: 'shared:canopy-cloud:rid' });
    const found = foundPipeline('shared:canopy-cloud:rid', 'shared', 'rid');
    expect(collapseAgentArtifactsByItem([found, run])).toEqual([run]);
  });

  it('matches a recommended shared pipeline on its remote id', () => {
    const run = pipelineRun({ pipelineId: 'shared:canopy-cloud:rid' });
    const recommended = {
      ...foundPipeline('rid', 'shared', 'rid'),
      relation: 'recommended' as const,
    };
    expect(collapseAgentArtifactsByItem([recommended, run])).toEqual([run]);
  });

  it('keeps only the automation run for the same activity', () => {
    const run = automationRun();
    expect(
      collapseAgentArtifactsByItem([foundAutomation('act-1'), run]),
    ).toEqual([run]);
    const other = foundAutomation('act-2');
    expect(collapseAgentArtifactsByItem([other, run])).toEqual([other, run]);
  });

  it('lets a run win over a created receipt of the same item', () => {
    const automation = automationRun();
    expect(
      collapseAgentArtifactsByItem([createdAutomation('act-1'), automation]),
    ).toEqual([automation]);
    const run = pipelineRun();
    expect(collapseAgentArtifactsByItem([createdPipeline(), run])).toEqual([
      run,
    ]);
  });

  it.each<[string, AgentArtifactReceiptV1, AgentArtifactReceiptV1]>([
    ['pipeline', foundPipeline('p1', 'user'), createdPipeline()],
    [
      'installed skill',
      reference({
        relation: 'found',
        navigationTarget: {
          kind: 'installed_skill',
          sourceId: 'custom:app',
          skillName: 'review',
        },
      }),
      installedSkill('review'),
    ],
    [
      'shared skill',
      reference({
        relation: 'found',
        navigationTarget: { kind: 'shared_skill', skillId: 'sk-1' },
      }),
      sharedSkill('sk-1'),
    ],
    ['automation', foundAutomation('act-1'), createdAutomation('act-1')],
    [
      'local agent',
      reference({
        relation: 'found',
        itemKind: 'agent',
        navigationTarget: { kind: 'agent_editor', agentId: 'a1' },
      }),
      agentDefinition('local', 'a1'),
    ],
    [
      'shared agent',
      reference({
        relation: 'found',
        itemKind: 'agent',
        navigationTarget: { kind: 'shared_agent', agentId: 'a1' },
      }),
      agentDefinition('shared', 'a1'),
    ],
  ])(
    'keeps only the mutation when a %s was found and changed',
    (_, found, mutation) => {
      expect(collapseAgentArtifactsByItem([found, mutation])).toEqual([
        mutation,
      ]);
    },
  );

  it('keeps only the deleted receipt when a pipeline was found and deleted', () => {
    const deleted = createdPipeline({ operation: 'pipeline.delete' });
    expect(
      collapseAgentArtifactsByItem([foundPipeline('p1', 'user'), deleted]),
    ).toEqual([deleted]);
  });

  it('keeps the recommendation over a found reference of the same item', () => {
    const found = foundAutomation('act-1');
    const recommended = { ...found, relation: 'recommended' as const };
    expect(collapseAgentArtifactsByItem([found, recommended])).toEqual([
      recommended,
    ]);
  });

  it('applies precedence transitively', () => {
    const found = foundPipeline('p1', 'user');
    const recommended = { ...found, relation: 'recommended' as const };
    const run = pipelineRun();
    expect(collapseAgentArtifactsByItem([found, recommended, run])).toEqual([
      run,
    ]);
    expect(
      collapseAgentArtifactsByItem([found, createdPipeline(), run]),
    ).toEqual([run]);
  });

  it('keeps both runs when the same pipeline ran twice', () => {
    const first = pipelineRun();
    const second = pipelineRun({
      executionId: 'e2',
      dedupeKey: 'canopy:pipeline_run:local:e2',
    });
    expect(collapseAgentArtifactsByItem([first, second])).toEqual([
      first,
      second,
    ]);
  });

  it('preserves the order of the receipts it keeps', () => {
    const workflow = githubWorkflowRun();
    const run = pipelineRun();
    const otherFound = foundPipeline('p2', 'user');
    expect(
      collapseAgentArtifactsByItem([
        foundPipeline('p1', 'user'),
        workflow,
        run,
        otherFound,
      ]),
    ).toEqual([workflow, run, otherFound]);
  });

  it('never collapses references without an item identity', () => {
    const entry = reference({
      relation: 'found',
      itemKind: 'pipeline',
      name: 'Ship',
      navigationTarget: {
        kind: 'capability_entry',
        entry: { type: 'pipeline', pipelineId: 'p1', source: 'user' },
      },
    });
    const url = reference({
      relation: 'found',
      itemKind: 'pipeline',
      name: 'Ship',
      navigationTarget: { kind: 'external_url', url: 'https://example.com' },
    });
    const execution = reference({
      relation: 'found',
      navigationTarget: {
        kind: 'pipeline_execution',
        executionId: 'e1',
        projectId: 'proj',
        worktreeId: 'wt',
      },
    });
    const run = pipelineRun();
    expect(collapseAgentArtifactsByItem([entry, url, execution, run])).toEqual([
      entry,
      url,
      execution,
      run,
    ]);
  });

  it('always keeps GitHub workflow runs', () => {
    const workflow = githubWorkflowRun();
    const workflowReference = reference({
      relation: 'found',
      navigationTarget: workflow.navigationTarget,
    });
    expect(
      collapseAgentArtifactsByItem([
        workflowReference,
        workflow,
        pipelineRun(),
      ]),
    ).toEqual([workflowReference, workflow, pipelineRun()]);
  });

  it('never drops or causes a drop for degenerate identities', () => {
    const run = pipelineRun();
    const oddRelation: AgentArtifactReceiptV1 = {
      ...foundPipeline('p1', 'user'),
      relation: 'mentioned' as CapabilityReferenceArtifactReceiptV1['relation'],
    };
    expect(collapseAgentArtifactsByItem([oddRelation, run])).toEqual([
      oddRelation,
      run,
    ]);

    const found = foundPipeline('p1', 'user');
    const bare = withoutNavigationTarget(createdPipeline());
    expect(collapseAgentArtifactsByItem([found, bare])).toEqual([found, bare]);

    const emptyRun = pipelineRun({ pipelineId: '' });
    const emptyFound = foundPipeline('', 'user');
    expect(collapseAgentArtifactsByItem([emptyFound, emptyRun])).toEqual([
      emptyFound,
      emptyRun,
    ]);
  });

  it('keeps both sides of a skill rename because aliases are not consulted', () => {
    const found = reference({
      relation: 'found',
      navigationTarget: {
        kind: 'installed_skill',
        sourceId: 'custom:app',
        skillName: 'old',
      },
    });
    const renamed = {
      ...installedSkill('new'),
      aliases: ['canopy:skill:installed:custom:app/old'],
    };
    expect(collapseAgentArtifactsByItem([found, renamed])).toEqual([
      found,
      renamed,
    ]);
  });

  it('returns the input array when nothing drops', () => {
    const receipts = [pipelineRun(), foundPipeline('p2', 'user')];
    expect(collapseAgentArtifactsByItem(receipts)).toBe(receipts);
    const empty: AgentArtifactReceiptV1[] = [];
    expect(collapseAgentArtifactsByItem(empty)).toBe(empty);
  });
});

describe('agentArtifactItemKeys', () => {
  it.each<[string, AgentArtifactReceiptV1, readonly string[]]>([
    ['local run', pipelineRun(), ['pipeline:p1']],
    [
      'shared run',
      pipelineRun({ pipelineId: 'shared:canopy-cloud:rid' }),
      ['pipeline:shared:canopy-cloud:rid', 'pipeline:remote:rid'],
    ],
    [
      'shared run with an empty remote id',
      pipelineRun({ pipelineId: 'shared:canopy-cloud:' }),
      ['pipeline:shared:canopy-cloud:'],
    ],
    ['pipeline receipt', createdPipeline(), ['pipeline:p1']],
    [
      'found shared pipeline',
      foundPipeline('shared:canopy-cloud:rid', 'shared', 'rid'),
      ['pipeline:shared:canopy-cloud:rid', 'pipeline:remote:rid'],
    ],
    ['automation run', automationRun(), ['automation:act-1']],
    ['automation receipt', createdAutomation('act-2'), ['automation:act-2']],
    ['found automation', foundAutomation('act-3'), ['automation:act-3']],
    [
      'installed skill',
      installedSkill('review'),
      ['skill:installed:custom:app/review'],
    ],
    ['shared skill', sharedSkill('sk-1'), ['skill:shared:sk-1']],
    ['local agent', agentDefinition('local', 'a1'), ['agent:local:a1']],
    ['shared agent', agentDefinition('shared', 'a1'), ['agent:shared:a1']],
    ['GitHub workflow run', githubWorkflowRun(), []],
    ['skill without a target', withoutNavigationTarget(sharedSkill('s')), []],
    ['agent with an empty id', agentDefinition('local', ''), []],
  ])('%s', (_, receipt, keys) => {
    expect(agentArtifactItemKeys(receipt)).toEqual(keys);
  });
});

describe('agentArtifactItemPrecedence', () => {
  it('ranks runs, mutations and references', () => {
    expect(agentArtifactItemPrecedence(pipelineRun())).toBe('run');
    expect(agentArtifactItemPrecedence(automationRun())).toBe('run');
    expect(agentArtifactItemPrecedence(createdPipeline())).toBe('mutation');
    expect(agentArtifactItemPrecedence(installedSkill('x'))).toBe('mutation');
    expect(agentArtifactItemPrecedence(createdAutomation('a'))).toBe(
      'mutation',
    );
    expect(agentArtifactItemPrecedence(agentDefinition('local', 'a'))).toBe(
      'mutation',
    );
    expect(agentArtifactItemPrecedence(foundAutomation('a'))).toBe('found');
    expect(agentArtifactItemPrecedence(reference())).toBe('recommended');
  });

  it('has no precedence for GitHub workflow runs or unknown relations', () => {
    expect(agentArtifactItemPrecedence(githubWorkflowRun())).toBeUndefined();
    expect(
      agentArtifactItemPrecedence({
        ...reference(),
        relation:
          'mentioned' as CapabilityReferenceArtifactReceiptV1['relation'],
      }),
    ).toBeUndefined();
  });
});

describe('mergeAgentArtifactsByPrecedence', () => {
  const recommended = reference();
  const found = reference({
    operation: 'skills.read',
    relation: 'found',
    reason: undefined,
  });

  it('keeps a recommendation that a later Found of the same item would replace', () => {
    expect(found.dedupeKey).toBe(recommended.dedupeKey);
    expect(mergeAgentArtifactsByPrecedence([recommended], [found])).toEqual([
      recommended,
    ]);
    expect(mergeAgentArtifactsByPrecedence([], [recommended, found])).toEqual([
      recommended,
    ]);
  });

  it('lets a later recommendation replace a Found of the same item', () => {
    expect(mergeAgentArtifactsByPrecedence([found], [recommended])).toEqual([
      recommended,
    ]);
  });

  it('keeps latest-wins for receipts of equal precedence', () => {
    const renamed = reference({ name: 'Code review v2' });
    const run = pipelineRun();
    expect(
      mergeAgentArtifactsByPrecedence([recommended, run], [renamed]),
    ).toEqual([run, renamed]);
  });
});
