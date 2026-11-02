import {
  MAX_SHARED_PLAN_CONTENT_BYTES,
  MAX_SHARED_PLAN_DIAGRAMS_BYTES,
  MAX_SHARED_PLAN_REPOSITORIES,
  MAX_SHARED_PLAN_REPOSITORY_FIELD_BYTES,
  PLAN_DIAGRAM_SCHEMA_VERSION,
  PLAN_SHARE_SCOPES,
  SHARED_PLAN_API_VERSION,
  buildSharedPlanSnapshotInput,
  isLogicDiffDiagram,
  isParsedPlanGraph,
  isPlanDiagramArtifacts,
  stableStringify,
  type PlanDiagramArtifacts,
  type SharedPlanCreateRequest,
  type SharedPlanDetail,
  type SharedPlanSnapshotInput,
  type SharedPlanSummary,
  type SharedPlanUpdateRequest,
  type WirePlanCommentThread,
} from '../index';

describe('shared-plan API contract', () => {
  it('pins version, scopes, and byte ceilings', () => {
    expect(SHARED_PLAN_API_VERSION).toBe(1);
    expect(PLAN_SHARE_SCOPES).toEqual(['private', 'team', 'organization']);
    expect(MAX_SHARED_PLAN_CONTENT_BYTES).toBe(1024 * 1024);
    expect(MAX_SHARED_PLAN_DIAGRAMS_BYTES).toBe(5 * 1024 * 1024);
    expect(MAX_SHARED_PLAN_REPOSITORIES).toBe(100);
    expect(MAX_SHARED_PLAN_REPOSITORY_FIELD_BYTES).toBe(2048);
  });

  it('exports canonical stable JSON serialization', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
    expect(stableStringify({ a: 2, aa: 1 })).toBe('{"a":2,"aa":1}');
  });

  it('re-homes the plan diagram schema exports into the protocol module', () => {
    expect(PLAN_DIAGRAM_SCHEMA_VERSION).toBe(1);
    expect(typeof isPlanDiagramArtifacts).toBe('function');
    expect(typeof isParsedPlanGraph).toBe('function');
    expect(typeof isLogicDiffDiagram).toBe('function');

    const artifacts: PlanDiagramArtifacts = {
      sequence: {
        data: { schemaVersion: 1, nodes: [], edges: [] },
        derivedFromRevision: 2,
        status: 'ready',
      },
    };
    expect(isPlanDiagramArtifacts(artifacts)).toBe(true);
    expect(isParsedPlanGraph(artifacts.sequence?.data)).toBe(true);
    expect(
      isLogicDiffDiagram({
        schemaVersion: 1,
        current: { nodes: [], edges: [] },
        planned: { nodes: [], edges: [] },
        changes: [],
      }),
    ).toBe(true);
  });

  it('keeps create / update / response DTOs serializable through JSON', () => {
    const create: SharedPlanCreateRequest = {
      clientLocalPlanId: 'plan-1',
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      title: 'Transport plan',
      content: '# Transport plan\n',
      source: 'claude',
      reviewStatus: 'approved',
      localRevisionNumber: 3,
      localCreatedAt: '2026-06-09T00:00:00Z',
      localUpdatedAt: '2026-06-09T01:00:00Z',
      repositories: [
        {
          repoId: 'repo-1',
          repoName: 'antelope',
          remoteUrl: 'https://example.com/acme/antelope.git',
          branch: 'main',
          commitSha: 'abc123',
          defaultBranch: 'main',
        },
      ],
      snapshotHash: 'sha256:snapshot',
      shareScope: 'team',
      teamId: 'team-1',
    };
    expect(JSON.parse(JSON.stringify(create))).toEqual(create);

    // The update request drops ownership fields and requires expectedSnapshotHash.
    const update: SharedPlanUpdateRequest = {
      clientLocalPlanId: create.clientLocalPlanId,
      workspaceLocalId: create.workspaceLocalId,
      worktreeLocalId: create.worktreeLocalId,
      title: create.title,
      content: create.content,
      source: create.source,
      reviewStatus: create.reviewStatus,
      localRevisionNumber: 4,
      localCreatedAt: create.localCreatedAt,
      localUpdatedAt: '2026-06-09T02:00:00Z',
      repositories: create.repositories,
      snapshotHash: 'sha256:snapshot-2',
      expectedSnapshotHash: 'sha256:snapshot',
    };
    expect(JSON.parse(JSON.stringify(update))).toEqual(update);

    const summary: SharedPlanSummary = {
      id: 'shared-1',
      title: 'Transport plan',
      contentHash: 'sha256:content',
      diagramsHash: 'sha256:diagrams',
      snapshotHash: 'sha256:snapshot',
      localRevisionNumber: 3,
      remoteRevisionNumber: 1,
      repositories: create.repositories,
      shareScope: 'team',
      owner: {
        type: 'team',
        id: 'team-1',
        name: 'Platform',
        slug: 'platform',
        organization: { id: 'org-1', name: 'Canopy' },
      },
      createdBy: { id: 'u-1', name: 'Alice', email: 'alice@example.com' },
      createdAt: '2026-06-09T00:00:00Z',
      updatedAt: '2026-06-09T02:00:00Z',
      canUpdate: true,
      canDelete: false,
    };
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);

    const detail: SharedPlanDetail = {
      ...summary,
      content: '# Transport plan\n',
      diagrams: {
        sequence: {
          data: { schemaVersion: 1, nodes: [], edges: [] },
          derivedFromRevision: 3,
          status: 'ready',
        },
      },
      commentThreads: [],
    };
    expect(JSON.parse(JSON.stringify(detail))).toEqual(detail);
  });

  it('round-trips comment threads with local and remote authors (CAN-393)', () => {
    const threads: WirePlanCommentThread[] = [
      {
        id: 'thread-1',
        status: 'open',
        createdAt: '2026-06-09T00:00:00Z',
        anchor: {
          quote: '## Phase 1',
          renderedText: 'Phase 1',
          lineStart: 4,
          lineEnd: 4,
          source: 'document',
        },
        anchorState: 'matched',
        comments: [
          {
            id: 'comment-1',
            author: 'user',
            body: 'Should we split this phase?',
            createdAt: '2026-06-09T00:00:00Z',
          },
          {
            id: 'comment-2',
            author: 'remote',
            remoteAuthor: { userId: 'u-2', displayName: 'Bob' },
            body: 'Agreed, two phases reads cleaner.',
            createdAt: '2026-06-09T00:05:00Z',
          },
        ],
      },
      {
        id: 'thread-2',
        status: 'resolved',
        createdAt: '2026-06-09T00:10:00Z',
        anchor: { quote: '', unanchored: true },
        anchorState: 'matched',
        comments: [
          {
            id: 'comment-3',
            author: 'agent',
            body: 'Done — split into setup and rollout.',
            createdAt: '2026-06-09T00:11:00Z',
          },
        ],
      },
    ];

    const create: SharedPlanCreateRequest = {
      clientLocalPlanId: 'plan-1',
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      title: 'Transport plan',
      content: '# Transport plan\n',
      source: 'claude',
      reviewStatus: 'approved',
      localRevisionNumber: 3,
      localCreatedAt: '2026-06-09T00:00:00Z',
      localUpdatedAt: '2026-06-09T01:00:00Z',
      repositories: [],
      snapshotHash: 'sha256:snapshot',
      commentThreads: threads,
    };
    expect(JSON.parse(JSON.stringify(create))).toEqual(create);
    expect(create.commentThreads?.[0]?.comments[1]?.remoteAuthor).toEqual({
      userId: 'u-2',
      displayName: 'Bob',
    });
  });

  it('builds a stable, key-ordered snapshot input regardless of caller key order', () => {
    const ordered: SharedPlanSnapshotInput = {
      contentHash: 'sha256:content',
      diagramsHash: 'sha256:diagrams',
      repositoriesHash: 'sha256:repos',
      title: 'Transport plan',
      source: 'claude',
      reviewStatus: 'approved',
      localRevisionNumber: 3,
    };

    // Same logical input, populated in a different key order.
    const shuffled: SharedPlanSnapshotInput = {
      localRevisionNumber: 3,
      reviewStatus: 'approved',
      source: 'claude',
      title: 'Transport plan',
      repositoriesHash: 'sha256:repos',
      diagramsHash: 'sha256:diagrams',
      contentHash: 'sha256:content',
    };

    const expected = JSON.stringify({
      contentHash: 'sha256:content',
      diagramsHash: 'sha256:diagrams',
      repositoriesHash: 'sha256:repos',
      title: 'Transport plan',
      source: 'claude',
      reviewStatus: 'approved',
      localRevisionNumber: 3,
    });

    expect(buildSharedPlanSnapshotInput(ordered)).toBe(expected);
    expect(buildSharedPlanSnapshotInput(shuffled)).toBe(expected);
    // Determinism: same input → byte-identical output.
    expect(buildSharedPlanSnapshotInput(ordered)).toBe(
      buildSharedPlanSnapshotInput(ordered),
    );
  });

  it('keeps snapshot input construction environment-neutral', () => {
    expect(typeof buildSharedPlanSnapshotInput).toBe('function');
  });
});
