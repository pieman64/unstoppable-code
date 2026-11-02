import {
  agentArtifactTurnRelation,
  placeAgentActivity,
  type AgentArtifactReceiptV1,
  type CapabilityReferenceArtifactReceiptV1,
  type GitHubWorkflowRunArtifactReceiptV1,
  type PipelineRunArtifactReceiptV1,
} from '..';

const AT = '2026-10-22T12:00:00.000Z';

function pipelineRun(
  operation: string,
  executionId: string,
): PipelineRunArtifactReceiptV1 {
  return {
    version: 1,
    kind: 'pipeline_run',
    operation,
    dedupeKey: `canopy:pipeline_run:execution:${executionId}`,
    createdAt: AT,
    executionId,
    pipelineId: 'pipe-1',
    pipelineName: 'Build',
    initialStatus: 'running',
    queuedAt: AT,
    projectId: 'project',
    worktreeId: 'worktree',
    navigationTarget: {
      kind: 'pipeline_execution',
      executionId,
      projectId: 'project',
      worktreeId: 'worktree',
    },
  };
}

function githubRun(runId: string): GitHubWorkflowRunArtifactReceiptV1 {
  const htmlUrl = `https://github.com/acme/api/actions/runs/${runId}`;
  return {
    version: 1,
    kind: 'github_workflow_run',
    operation: 'github.watch',
    dedupeKey: `canopy:github_workflow_run:acme/api:${runId}:1`,
    createdAt: AT,
    watcherId: 'gh-1',
    repository: 'acme/api',
    runId,
    runAttempt: 1,
    htmlUrl,
    state: { kind: 'intermediate', status: 'in_progress' },
    observedAt: AT,
    navigationTarget: {
      kind: 'github_workflow_run',
      repository: 'acme/api',
      runId,
      htmlUrl,
    },
  };
}

const skillTile: CapabilityReferenceArtifactReceiptV1 = {
  version: 1,
  kind: 'capability_reference',
  operation: 'skills.read',
  dedupeKey: 'canopy:capability_reference:local:skill:reviewer',
  createdAt: AT,
  itemKind: 'skill',
  source: 'local',
  sourceId: 'reviewer',
  sourceLabel: 'Installed',
  name: 'Reviewer',
  state: 'available',
  relation: 'found',
  navigationTarget: {
    kind: 'installed_skill',
    sourceId: 'local',
    skillName: 'reviewer',
  },
};

const launched = pipelineRun('pipeline.run', 'exec-1');
const launchedWatchCopy = pipelineRun('pipeline.watch', 'exec-1');
const watchedOnly = pipelineRun('pipeline.watch', 'exec-2');
const gitHub = githubRun('101');
const turnIds = ['turn-1', 'turn-2', 'turn-3'];
const NOTHING_LIVE: ReadonlySet<string> = new Set();

describe('agentArtifactTurnRelation', () => {
  it('derives watching from pipeline.watch and github.watch, launched otherwise', () => {
    expect(agentArtifactTurnRelation(launched)).toBe('launched');
    expect(
      agentArtifactTurnRelation(pipelineRun('pipeline.execution_retry', 'x')),
    ).toBe('launched');
    expect(agentArtifactTurnRelation(watchedOnly)).toBe('watching');
    expect(agentArtifactTurnRelation(gitHub)).toBe('watching');
    expect(agentArtifactTurnRelation(skillTile)).toBe('launched');
  });
});

describe('placeAgentActivity', () => {
  it('moves every live run out of the turns into the live list, once', () => {
    const placement = placeAgentActivity(
      {
        'turn-1': [skillTile, launched],
        'turn-2': [launchedWatchCopy, watchedOnly, gitHub],
      },
      turnIds,
      new Set([launched.dedupeKey, watchedOnly.dedupeKey, gitHub.dedupeKey]),
    );
    expect(placement.byTurn['turn-1']).toEqual([skillTile]);
    expect(placement.byTurn['turn-2']).toEqual([]);
    // The launched receipt represents its run, not the watch copy.
    expect(placement.live).toEqual([launched, watchedOnly, gitHub]);
  });

  it('lists a finished launched run once, in the latest turn that launched it', () => {
    const resumed = pipelineRun('pipeline.execution_resume', 'exec-1');
    const placement = placeAgentActivity(
      {
        'turn-1': [launched],
        'turn-2': [launchedWatchCopy],
        'turn-3': [resumed],
      },
      turnIds,
      NOTHING_LIVE,
    );
    expect(placement.byTurn['turn-1']).toEqual([]);
    expect(placement.byTurn['turn-2']).toEqual([]);
    expect(placement.byTurn['turn-3']).toEqual([resumed]);
    expect(placement.live).toEqual([]);
  });

  it('lists a finished watched-only run once, in the latest turn that lists it', () => {
    const placement = placeAgentActivity(
      {
        'turn-1': [watchedOnly],
        'turn-2': [watchedOnly, gitHub],
        'turn-3': [skillTile],
      },
      turnIds,
      NOTHING_LIVE,
    );
    expect(placement.byTurn['turn-1']).toEqual([]);
    expect(placement.byTurn['turn-2']).toEqual([watchedOnly, gitHub]);
    expect(placement.byTurn['turn-3']).toEqual([skillTile]);
  });

  it('leaves tiles in every turn that lists them', () => {
    const placement = placeAgentActivity(
      { 'turn-1': [skillTile], 'turn-2': [skillTile] },
      turnIds,
      NOTHING_LIVE,
    );
    expect(placement.byTurn['turn-1']).toEqual([skillTile]);
    expect(placement.byTurn['turn-2']).toEqual([skillTile]);
  });

  it('keeps array identity for unchanged turns and repeated placements', () => {
    const turnOne: AgentArtifactReceiptV1[] = [skillTile, launched];
    const turnTwo: AgentArtifactReceiptV1[] = [watchedOnly, gitHub];
    const byTurn = { 'turn-1': turnOne, 'turn-2': turnTwo };
    const live = new Set([gitHub.dedupeKey]);
    const first = placeAgentActivity(byTurn, turnIds, live);
    expect(first.byTurn['turn-1']).toBe(turnOne);
    expect(first.byTurn['turn-2']).toEqual([watchedOnly]);
    const second = placeAgentActivity(byTurn, turnIds, live, first);
    expect(second.byTurn['turn-2']).toBe(first.byTurn['turn-2']);
    expect(second.live).toBe(first.live);
    expect(second).toBe(first);
  });
});
