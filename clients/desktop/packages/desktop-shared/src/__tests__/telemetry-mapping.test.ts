import {
  ATTENTION_DETAIL_MAX_CHARS,
  MAX_TELEMETRY_CLIENT_ID_LENGTH,
  MAX_TELEMETRY_INGEST_BATCH_BYTES,
  MAX_TELEMETRY_NAME_LENGTH,
  MAX_TELEMETRY_PIPELINE_RUNS_PER_WORKTREE,
  MAX_TELEMETRY_PLANS_PER_WORKTREE,
  MAX_TELEMETRY_PULL_REQUESTS_PER_WORKTREE,
  MAX_TELEMETRY_SUMMARIES_PER_WORKTREE,
  MAX_TELEMETRY_TURN_DURATION_MS,
  MAX_TELEMETRY_TURNS_PER_WORKTREE,
  type TelemetryIngestRequest,
  type TelemetryPipelineRunPayload,
  type TelemetryPlanPayload,
  type TelemetryPullRequestPayload,
  type TelemetryTurnPayload,
  type TelemetryWorktreePayload,
  type TelemetryWorktreeSummarySnapshot,
} from '@canopy/protocol';
import {
  clampId,
  clampText,
  mapAuditEntryToTurnPayload,
  mapVisibilityToShareScope,
  mapPipelineRunUsageEventToPayload,
  mapTrackedPlanToPlanPayload,
  mapWorktreePrStatusToPayloads,
  mapWorktreeSummaryToText,
  buildTelemetryAttention,
  buildTelemetryAttentionDetail,
  splitTelemetryIngestRequest,
  toSparseToolCounts,
  truncateToBytes,
  utf8ByteLength,
} from '../lib/telemetry-mapping';
import type {
  AgentAuditEntry,
  AgentAuditToolCounts,
  PipelineRunUsageEvent,
} from '../types/observability';
import type { TrackedPlanData, WorktreeSummaryData } from '../types';
import type { WorktreePrStatus } from '../types/github';

function zeroToolCounts(): AgentAuditToolCounts {
  return {
    thinking: 0,
    bash: 0,
    read: 0,
    readLines: 0,
    writeEdit: 0,
    plan: 0,
    fileEdit: 0,
    fileAdd: 0,
    fileDelete: 0,
    search: 0,
    grep: 0,
    web: 0,
    agent: 0,
    workflow: 0,
    tasks: 0,
    taskStop: 0,
    skills: 0,
    monitor: 0,
    claude: 0,
    scheduleWakeup: 0,
    askUser: 0,
    scriptOutput: 0,
    watcher: 0,
    canopy: 0,
    graph: 0,
    appAdvisor: 0,
    pipelineEditor: 0,
    mcp: 0,
    other: 0,
  };
}

function makeEntry(overrides: Partial<AgentAuditEntry> = {}): AgentAuditEntry {
  return {
    id: 'turn-1',
    eventType: 'worktree_chat',
    status: 'success',
    provider: 'claude',
    label: 'Worktree chat',
    startedAt: '2026-06-16T00:00:00.000Z',
    completedAt: '2026-06-16T00:00:05.000Z',
    durationMs: 5000,
    model: 'claude-sonnet-4-6',
    totalCostUsd: 0.12,
    tokens: {
      input: 100,
      output: 50,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
    },
    messageCount: 3,
    assistantMessageCount: 2,
    toolUseCount: 4,
    subAgentCount: 1,
    toolCounts: { ...zeroToolCounts(), bash: 2, read: 3 },
    hasTranscript: true,
    projectId: 'proj-1',
    worktreeId: 'wt-1',
    repoId: 'repo-1',
    chatId: 'chat-1',
    pipelineId: 'pipe-1',
    pipelineExecutionId: 'exec-1',
    error: 'should-not-leak',
    sdkSessionId: 'sdk-1',
    pipelineName: 'My pipeline',
    repoLabel: 'repo label',
    jobId: 'job-1',
    stepId: 'step-1',
    attempt: 2,
    ...overrides,
  };
}

function expectTelemetryTurnPayload(
  payload: TelemetryTurnPayload | null,
): TelemetryTurnPayload {
  if (payload === null) {
    throw new Error('Expected a hosted telemetry turn payload');
  }
  return payload;
}

describe('mapVisibilityToShareScope', () => {
  it('maps off to null and others through 1:1', () => {
    expect(mapVisibilityToShareScope('off')).toBeNull();
    expect(mapVisibilityToShareScope('private')).toBe('private');
    expect(mapVisibilityToShareScope('team')).toBe('team');
    expect(mapVisibilityToShareScope('organization')).toBe('organization');
  });
});

describe('truncateToBytes', () => {
  it('caps by bytes without splitting multibyte chars', () => {
    expect(truncateToBytes('hello', 100)).toBe('hello');
    const out = truncateToBytes('a😀b', 2);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(2);
    expect(out).toBe('a');
  });
});

describe('toSparseToolCounts', () => {
  it('drops zero categories', () => {
    const sparse = toSparseToolCounts({
      ...zeroToolCounts(),
      bash: 2,
      read: 3,
      pipelineEditor: 4,
    });
    expect(sparse).toEqual({ bash: 2, read: 3, pipelineEditor: 4 });
  });

  it('returns undefined when all zero', () => {
    expect(toSparseToolCounts(zeroToolCounts())).toBeUndefined();
  });
});

describe('clampText', () => {
  it('leaves short strings untouched', () => {
    expect(clampText('short', 128)).toBe('short');
  });

  it('truncates an over-length string to maxLen chars', () => {
    const out = clampText('x'.repeat(300), MAX_TELEMETRY_NAME_LENGTH);
    expect(out.length).toBe(MAX_TELEMETRY_NAME_LENGTH);
    expect(out).toBe('x'.repeat(MAX_TELEMETRY_NAME_LENGTH));
  });
});

describe('clampId', () => {
  it('leaves a short id untouched', () => {
    expect(clampId('turn-1', MAX_TELEMETRY_CLIENT_ID_LENGTH)).toBe('turn-1');
  });

  it('shortens an over-128 id to <= 128 chars', () => {
    const long = 'a'.repeat(200);
    const clamped = clampId(long, MAX_TELEMETRY_CLIENT_ID_LENGTH);
    expect(clamped.length).toBe(MAX_TELEMETRY_CLIENT_ID_LENGTH);
    expect(clamped.length).toBeLessThanOrEqual(MAX_TELEMETRY_CLIENT_ID_LENGTH);
  });

  it('is deterministic for the same input', () => {
    const long = 'b'.repeat(200);
    expect(clampId(long, MAX_TELEMETRY_CLIENT_ID_LENGTH)).toBe(
      clampId(long, MAX_TELEMETRY_CLIENT_ID_LENGTH),
    );
  });

  it('gives distinct outputs for two distinct long ids that share a prefix', () => {
    const prefix = 'c'.repeat(190);
    const a = clampId(`${prefix}-alpha`, MAX_TELEMETRY_CLIENT_ID_LENGTH);
    const b = clampId(`${prefix}-omega`, MAX_TELEMETRY_CLIENT_ID_LENGTH);
    expect(a).not.toBe(b);
    expect(a.length).toBe(MAX_TELEMETRY_CLIENT_ID_LENGTH);
    expect(b.length).toBe(MAX_TELEMETRY_CLIENT_ID_LENGTH);
  });

  it('clamps a 148-char clientTurnId like the real poison turn to <= 128', () => {
    // Shape from the live queue that 400'd the batch.
    const realShape =
      'pipeline:11111111-2222-3333-4444-555555555555/ship/open_pr/0:' +
      '2026-06-01T00:00:00.000Z:manual-pr:' +
      'https-github-com-unstoppabledomains-canopy-pull-1000';
    expect(realShape.length).toBeGreaterThan(MAX_TELEMETRY_CLIENT_ID_LENGTH);
    const clamped = clampId(realShape, MAX_TELEMETRY_CLIENT_ID_LENGTH);
    expect(clamped.length).toBeLessThanOrEqual(MAX_TELEMETRY_CLIENT_ID_LENGTH);
  });

  // GOLDEN VECTOR — locks the exact FNV-1a clamp output for a fixed input.
  // The server's `clampId` (apps/web/src/lib/telemetry/telemetry-service.ts)
  // has a byte-identical golden-vector test asserting the SAME string. If a
  // future edit drifts either implementation, one of the two suites fails,
  // catching a silent client/server divergence that would otherwise produce
  // duplicate rows on re-upload.
  it('matches the cross-implementation golden vector', () => {
    const golden = clampId('x'.repeat(200), MAX_TELEMETRY_CLIENT_ID_LENGTH);
    expect(golden).toBe(`${'x'.repeat(119)}~b3e4b6e5`);
    expect(golden.length).toBe(MAX_TELEMETRY_CLIENT_ID_LENGTH);
  });

  it('degrades to plain truncation when maxLen is too small for the hash suffix', () => {
    // No bound below 9 is used in production, but the helper must not build a
    // negative/malformed slice if ever reused on a shorter-bounded field.
    expect(clampId('abcdefghijkl', 4)).toBe('abcd');
    expect(clampId('abcdefghijkl', 8)).toBe('abcdefgh');
  });
});

describe('mapAuditEntryToTurnPayload', () => {
  it('renames tokens/fields, drops locals, and sparsifies tool counts', () => {
    const payload = expectTelemetryTurnPayload(
      mapAuditEntryToTurnPayload(makeEntry(), {
        transcriptBody: 'plain transcript',
      }),
    );
    expect(payload.clientTurnId).toBe('turn-1');
    expect(payload.tokens).toEqual({
      input: 100,
      output: 50,
      cacheReadInput: 10,
      cacheCreationInput: 5,
    });
    expect(payload.clientRepoId).toBe('repo-1');
    expect(payload.clientChatId).toBe('chat-1');
    expect(payload.clientPipelineId).toBe('pipe-1');
    expect(payload.clientPipelineExecutionId).toBe('exec-1');
    expect(payload.toolCounts).toEqual({ bash: 2, read: 3 });
    expect(payload.body).toBe('plain transcript');

    // Dropped local-only fields never appear on the wire payload.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('should-not-leak');
    expect(serialized).not.toContain('sdk-1');
    expect(serialized).not.toContain('My pipeline');
    expect(serialized).not.toContain('repo label');
    expect(serialized).not.toContain('job-1');
    expect(serialized).not.toContain('step-1');
  });

  it('redacts secrets in the transcript body', () => {
    const payload = expectTelemetryTurnPayload(
      mapAuditEntryToTurnPayload(makeEntry(), {
        transcriptBody: 'export TOKEN=ghp_' + 'Z'.repeat(36),
      }),
    );
    expect(payload.body).toContain('<redacted');
    expect(payload.body).not.toContain('ghp_ZZZ');
  });

  it('omits body when no transcript text is provided', () => {
    const payload = expectTelemetryTurnPayload(
      mapAuditEntryToTurnPayload(makeEntry(), {}),
    );
    expect(payload.body).toBeUndefined();
  });

  it('projects bounded Auto routing attribution without prompt text', () => {
    const modelRouting = {
      schemaVersion: 1 as const,
      selectionMode: 'auto' as const,
      outcome: 'selected' as const,
      executionLane: 'provider_subscription' as const,
      benchmarkModelId: 'default-model',
      selectedModelId: 'selected-model',
      routingCostUsd: 0.001,
      savings: { status: 'incomplete_usage' as const },
    };
    const payload = expectTelemetryTurnPayload(
      mapAuditEntryToTurnPayload(makeEntry({ modelRouting }), {}),
    );

    expect(payload.modelRouting).toEqual(modelRouting);
    expect(JSON.stringify(payload.modelRouting)).not.toContain('prompt');
  });

  it('copies subscription attribution for non-routed turns', () => {
    const payload = expectTelemetryTurnPayload(
      mapAuditEntryToTurnPayload(
        makeEntry({
          providerAccountKey: 'claude:dev@example.com',
          providerAccountEmail: 'dev@example.com',
          providerPlanType: 'max',
        }),
        {},
      ),
    );
    expect(payload.providerAccountKey).toBe('claude:dev@example.com');
    expect(payload.providerAccountEmail).toBe('dev@example.com');
    expect(payload.providerPlanType).toBe('max');
    expect(payload.aiCreditsRouted).toBeUndefined();
  });

  it('emits aiCreditsRouted and omits account fields for routed turns', () => {
    const payload = expectTelemetryTurnPayload(
      mapAuditEntryToTurnPayload(
        makeEntry({
          aiCreditsRouted: true,
          providerAccountKey: 'claude:dev@example.com',
          providerAccountEmail: 'dev@example.com',
          providerPlanType: 'max',
        }),
        {},
      ),
    );
    expect(payload.aiCreditsRouted).toBe(true);
    expect(payload.providerAccountKey).toBeUndefined();
    expect(payload.providerAccountEmail).toBeUndefined();
    expect(payload.providerPlanType).toBeUndefined();
  });

  it('omits aiCreditsRouted when the turn was not routed', () => {
    const payload = expectTelemetryTurnPayload(
      mapAuditEntryToTurnPayload(makeEntry({ aiCreditsRouted: false }), {}),
    );
    expect(payload.aiCreditsRouted).toBeUndefined();
  });

  // CAN-3106: one 4,904,774,992 ms (56.8-day) duration overflowed the INTEGER
  // `transcript_turns.duration_ms` column, so every batch carrying it failed
  // permanently and the outbox replayed it ~60x/hour forever.
  it('omits an implausible duration rather than shipping an unpersistable value', () => {
    const payload = expectTelemetryTurnPayload(
      mapAuditEntryToTurnPayload(makeEntry({ durationMs: 4_904_774_992 }), {}),
    );
    expect(payload.durationMs).toBeUndefined();
    // The rest of the turn still ships — dropping the batch would lose
    // legitimate sibling telemetry.
    expect(payload.clientTurnId).toBe('turn-1');
    expect(payload.completedAt).toBe('2026-06-16T00:00:05.000Z');
  });

  it('keeps a duration exactly at the plausibility ceiling', () => {
    const payload = expectTelemetryTurnPayload(
      mapAuditEntryToTurnPayload(
        makeEntry({ durationMs: MAX_TELEMETRY_TURN_DURATION_MS }),
        {},
      ),
    );
    expect(payload.durationMs).toBe(MAX_TELEMETRY_TURN_DURATION_MS);
  });

  it('omits negative, fractional, and non-finite durations', () => {
    expect(
      expectTelemetryTurnPayload(
        mapAuditEntryToTurnPayload(makeEntry({ durationMs: -1 }), {}),
      ).durationMs,
    ).toBeUndefined();
    expect(
      expectTelemetryTurnPayload(
        mapAuditEntryToTurnPayload(makeEntry({ durationMs: 12.5 }), {}),
      ).durationMs,
    ).toBeUndefined();
    expect(
      expectTelemetryTurnPayload(
        mapAuditEntryToTurnPayload(makeEntry({ durationMs: Number.NaN }), {}),
      ).durationMs,
    ).toBeUndefined();
  });

  it('clamps over-length id, correlation, and text fields', () => {
    const payload = expectTelemetryTurnPayload(
      mapAuditEntryToTurnPayload(
        makeEntry({
          id: 'turn-' + 'x'.repeat(200),
          label: 'L'.repeat(800),
          model: 'm'.repeat(400),
          chatId: 'chat-' + 'y'.repeat(200),
          repoId: 'repo-' + 'z'.repeat(200),
          pipelineId: 'pipe-' + 'p'.repeat(200),
          pipelineExecutionId: 'exec-' + 'e'.repeat(200),
        }),
      ),
    );
    expect(payload.clientTurnId.length).toBeLessThanOrEqual(
      MAX_TELEMETRY_CLIENT_ID_LENGTH,
    );
    expect(payload.label.length).toBeLessThanOrEqual(512);
    expect((payload.model ?? '').length).toBeLessThanOrEqual(
      MAX_TELEMETRY_NAME_LENGTH,
    );
    expect((payload.clientChatId ?? '').length).toBeLessThanOrEqual(
      MAX_TELEMETRY_CLIENT_ID_LENGTH,
    );
    expect((payload.clientRepoId ?? '').length).toBeLessThanOrEqual(
      MAX_TELEMETRY_CLIENT_ID_LENGTH,
    );
    expect((payload.clientPipelineId ?? '').length).toBeLessThanOrEqual(
      MAX_TELEMETRY_CLIENT_ID_LENGTH,
    );
    expect(
      (payload.clientPipelineExecutionId ?? '').length,
    ).toBeLessThanOrEqual(MAX_TELEMETRY_CLIENT_ID_LENGTH);
  });
});

describe('mapTrackedPlanToPlanPayload', () => {
  function makePlan(overrides: Partial<TrackedPlanData> = {}): TrackedPlanData {
    return {
      id: 'plan-1',
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      source: 'claude',
      title: 'Implement secret handling',
      content: 'Line one\nAuthorization: Bearer secrettoken123\nLine three',
      reviewStatus: 'pending',
      createdAt: '2026-06-16T00:00:00.000Z',
      updatedAt: '2026-06-16T00:00:00.000Z',
      latestRevisionNumber: 3,
      revisions: [],
      linkedExecutionIds: [],
      ...overrides,
    };
  }

  it('maps fields and redacts the body', () => {
    const payload = mapTrackedPlanToPlanPayload(makePlan());
    expect(payload.clientPlanId).toBe('plan-1');
    expect(payload.reviewStatus).toBe('pending');
    expect(payload.planVersion).toBe(3);
    expect(payload.planLineCount).toBe(3);
    expect(payload.body).toContain('<redacted>');
    expect(payload.body).not.toContain('secrettoken123');
  });

  it('omits implementationStartedAt when neither approved nor linked', () => {
    const payload = mapTrackedPlanToPlanPayload(
      makePlan({ linkedExecutionIds: [], approvedAt: undefined }),
    );
    expect(payload.implementationStartedAt).toBeUndefined();
  });

  it('uses approvedAt for implementationStartedAt when approved without a linked execution', () => {
    const payload = mapTrackedPlanToPlanPayload(
      makePlan({
        linkedExecutionIds: [],
        approvedAt: '2026-06-16T01:00:00.000Z',
        updatedAt: '2026-06-16T02:00:00.000Z',
      }),
    );
    expect(payload.implementationStartedAt).toBe('2026-06-16T01:00:00.000Z');
  });

  it('uses approvedAt for implementationStartedAt once executions are linked', () => {
    const payload = mapTrackedPlanToPlanPayload(
      makePlan({
        linkedExecutionIds: ['exec-1'],
        approvedAt: '2026-06-16T01:00:00.000Z',
        updatedAt: '2026-06-16T02:00:00.000Z',
      }),
    );
    expect(payload.implementationStartedAt).toBe('2026-06-16T01:00:00.000Z');
  });

  it('falls back to updatedAt when no approvedAt is present', () => {
    const payload = mapTrackedPlanToPlanPayload(
      makePlan({
        linkedExecutionIds: ['exec-1'],
        approvedAt: undefined,
        updatedAt: '2026-06-16T02:00:00.000Z',
      }),
    );
    expect(payload.implementationStartedAt).toBe('2026-06-16T02:00:00.000Z');
  });

  it('clamps an over-length plan id and title', () => {
    const payload = mapTrackedPlanToPlanPayload(
      makePlan({
        id: 'plan-' + 'x'.repeat(200),
        title: 'T'.repeat(400),
      }),
    );
    expect(payload.clientPlanId.length).toBeLessThanOrEqual(
      MAX_TELEMETRY_CLIENT_ID_LENGTH,
    );
    expect(payload.title.length).toBeLessThanOrEqual(MAX_TELEMETRY_NAME_LENGTH);
  });
});

describe('mapWorktreePrStatusToPayloads', () => {
  it('skips repos without a status and maps the rest', () => {
    const status: WorktreePrStatus = {
      lastCheckedAt: '2026-06-16T00:00:00.000Z',
      repos: [
        { repoId: 'r1', repoName: 'repo-one', status: null },
        {
          repoId: 'r2',
          repoName: 'repo-two',
          status: {
            prNumber: 42,
            prUrl: 'https://example.com/pr/42',
            state: 'open',
            title: 'Fix bug token=ghp_' + 'Q'.repeat(36),
            checkStatus: 'passing',
            checkDetails: [],
            reviewStatus: 'approved',
            reviewers: [],
            hasConflicts: false,
            commentCount: 1,
            updatedAt: '2026-06-16T00:00:01.000Z',
            openedAt: '2026-06-15T00:00:00.000Z',
            mergedAt: '2026-06-16T00:00:02.000Z',
            additions: 120,
            deletions: 30,
            changedFiles: 7,
          },
        },
      ],
    };
    const payloads = mapWorktreePrStatusToPayloads(status);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      repoId: 'r2',
      prNumber: 42,
      state: 'open',
      checkStatus: 'passing',
      reviewStatus: 'approved',
      lastCheckedAt: '2026-06-16T00:00:00.000Z',
      openedAt: '2026-06-15T00:00:00.000Z',
      mergedAt: '2026-06-16T00:00:02.000Z',
      additions: 120,
      deletions: 30,
      changedFiles: 7,
    });
    expect(payloads[0].title).toContain('<redacted>');
  });

  it('omits PR open/merge/diff fields when absent', () => {
    const status: WorktreePrStatus = {
      lastCheckedAt: '2026-06-16T00:00:00.000Z',
      repos: [
        {
          repoId: 'r2',
          repoName: 'repo-two',
          status: {
            prNumber: 7,
            prUrl: 'https://example.com/pr/7',
            state: 'open',
            title: 'No diff stats',
            checkStatus: 'passing',
            checkDetails: [],
            reviewStatus: 'none',
            reviewers: [],
            hasConflicts: false,
            commentCount: 0,
            updatedAt: '2026-06-16T00:00:01.000Z',
          },
        },
      ],
    };
    const payloads = mapWorktreePrStatusToPayloads(status);
    expect(payloads[0].openedAt).toBeUndefined();
    expect(payloads[0].mergedAt).toBeUndefined();
    expect(payloads[0].additions).toBeUndefined();
    expect(payloads[0].deletions).toBeUndefined();
    expect(payloads[0].changedFiles).toBeUndefined();
  });

  it('clamps an over-length repoId, repoName, prUrl, and title', () => {
    const status: WorktreePrStatus = {
      lastCheckedAt: '2026-06-16T00:00:00.000Z',
      repos: [
        {
          repoId: 'repo-' + 'z'.repeat(200),
          repoName: 'name-' + 'n'.repeat(400),
          status: {
            prNumber: 99,
            prUrl: 'https://example.com/pr/' + 'u'.repeat(2000),
            state: 'open',
            title: 'T'.repeat(800),
            checkStatus: 'passing',
            checkDetails: [],
            reviewStatus: 'none',
            reviewers: [],
            hasConflicts: false,
            commentCount: 0,
            updatedAt: '2026-06-16T00:00:01.000Z',
          },
        },
      ],
    };
    const payloads = mapWorktreePrStatusToPayloads(status);
    expect(payloads[0].repoId.length).toBeLessThanOrEqual(
      MAX_TELEMETRY_CLIENT_ID_LENGTH,
    );
    expect(payloads[0].repoName.length).toBeLessThanOrEqual(
      MAX_TELEMETRY_NAME_LENGTH,
    );
    expect(payloads[0].prUrl.length).toBeLessThanOrEqual(1024);
    expect(payloads[0].title.length).toBeLessThanOrEqual(512);
  });
});

describe('mapPipelineRunUsageEventToPayload', () => {
  function makeRunEvent(
    overrides: Partial<PipelineRunUsageEvent> = {},
  ): PipelineRunUsageEvent {
    return {
      version: 1,
      id: 'pipeline-run-completed:exec-9',
      type: 'pipeline_run_completed',
      timestamp: '2026-06-16T00:00:10.000Z',
      workspaceId: 'proj-1',
      worktreeId: 'wt-1',
      provider: 'pipeline',
      pipelineExecutionId: 'exec-9',
      pipeline: {
        key: 'stored:user:p1',
        id: 'p1',
        name: 'My pipeline',
        source: 'user',
      },
      pipelineId: 'p1',
      pipelineName: 'My pipeline',
      pipelineIdentityKey: 'stored:user:p1',
      runStartedAt: '2026-06-16T00:00:00.000Z',
      runCompletedAt: '2026-06-16T00:00:10.000Z',
      runDurationMs: 10_000,
      status: 'success',
      jobCount: 2,
      stepCount: 5,
      agentStepCount: 1,
      retryCount: 0,
      ...overrides,
    };
  }

  it('maps a completed run to the payload', () => {
    const payload = mapPipelineRunUsageEventToPayload(makeRunEvent());
    expect(payload).toEqual({
      clientPipelineRunId: 'exec-9',
      pipelineId: 'p1',
      pipelineName: 'My pipeline',
      status: 'success',
      startedAt: '2026-06-16T00:00:00.000Z',
      completedAt: '2026-06-16T00:00:10.000Z',
      runDurationMs: 10_000,
      jobCount: 2,
      stepCount: 5,
      agentStepCount: 1,
      retryCount: 0,
    });
  });

  it('returns null when status is missing', () => {
    expect(
      mapPipelineRunUsageEventToPayload(makeRunEvent({ status: undefined })),
    ).toBeNull();
  });

  it('clamps over-length run id, pipeline id, and name', () => {
    const payload = mapPipelineRunUsageEventToPayload(
      makeRunEvent({
        pipelineExecutionId: 'exec-' + 'e'.repeat(200),
        pipelineId: 'p-' + 'i'.repeat(200),
        pipelineName: 'N'.repeat(400),
      }),
    );
    expect(payload).not.toBeNull();
    expect((payload?.clientPipelineRunId ?? '').length).toBeLessThanOrEqual(
      MAX_TELEMETRY_CLIENT_ID_LENGTH,
    );
    expect((payload?.pipelineId ?? '').length).toBeLessThanOrEqual(
      MAX_TELEMETRY_CLIENT_ID_LENGTH,
    );
    expect((payload?.pipelineName ?? '').length).toBeLessThanOrEqual(
      MAX_TELEMETRY_NAME_LENGTH,
    );
  });

  it('omits absent optional numeric/timestamp fields', () => {
    const payload = mapPipelineRunUsageEventToPayload(
      makeRunEvent({
        runCompletedAt: undefined,
        runDurationMs: undefined,
        jobCount: undefined,
        stepCount: undefined,
        agentStepCount: undefined,
        retryCount: undefined,
      }),
    );
    expect(payload).not.toBeNull();
    expect(payload?.completedAt).toBeUndefined();
    expect(payload?.runDurationMs).toBeUndefined();
    expect(payload?.jobCount).toBeUndefined();
    expect(payload?.stepCount).toBeUndefined();
    expect(payload?.agentStepCount).toBeUndefined();
    expect(payload?.retryCount).toBeUndefined();
  });
});

describe('mapWorktreeSummaryToText', () => {
  it('flattens and redacts the summary', () => {
    const summary: WorktreeSummaryData = {
      title: 'Telemetry sync',
      description: 'Adds the sync service. Contact admin@example.com.',
      highlights: ['Redaction utility', 'Durable queue'],
      generatedAt: '2026-06-16T00:00:00.000Z',
      turnCountAtGeneration: 5,
      lastFullRefreshAt: '2026-06-16T00:00:00.000Z',
      lastFullRefreshTurnCount: 5,
    };
    const text = mapWorktreeSummaryToText(summary);
    expect(text).toContain('Telemetry sync');
    expect(text).toContain('- Redaction utility');
    expect(text).toContain('<redacted-email>');
    expect(text).not.toContain('admin@example.com');
  });
});

describe('splitTelemetryIngestRequest', () => {
  function makeTurn(id: string, bodySize = 0): TelemetryTurnPayload {
    const payload: TelemetryTurnPayload = {
      clientTurnId: id,
      eventType: 'worktree_chat',
      status: 'success',
      provider: 'claude',
      label: 'Chat',
      startedAt: '2026-06-16T00:00:00.000Z',
    };
    if (bodySize > 0) {
      payload.body = 'x'.repeat(bodySize);
    }
    return payload;
  }

  function makePlan(id: string): TelemetryPlanPayload {
    return { clientPlanId: id, title: 'Plan', reviewStatus: 'pending' };
  }

  function makePr(prNumber: number): TelemetryPullRequestPayload {
    return {
      repoId: 'repo',
      repoName: 'repo',
      prNumber,
      prUrl: 'https://example.test/pr',
      title: 'PR',
      state: 'open',
      checkStatus: 'passing',
      reviewStatus: 'approved',
      hasConflicts: false,
      commentCount: 0,
    };
  }

  function makeRun(id: string): TelemetryPipelineRunPayload {
    return {
      clientPipelineRunId: id,
      pipelineId: 'pipeline',
      pipelineName: 'Pipeline',
      status: 'success',
      startedAt: '2026-06-16T00:00:00.000Z',
    };
  }

  function makeSummary(id: string): TelemetryWorktreeSummarySnapshot {
    return {
      clientSnapshotId: id,
      generatedAt: '2026-06-16T00:00:00.000Z',
      summary: 'snapshot',
    };
  }

  function makeRequest(
    worktree: Partial<TelemetryWorktreePayload> = {},
    top: Partial<TelemetryIngestRequest> = {},
  ): TelemetryIngestRequest {
    return {
      ...top,
      workspace: {
        clientLocalId: 'ws',
        name: 'Workspace',
        workspaceType: 'single-repo',
        worktrees: [{ clientLocalId: 'wt', branchName: 'main', ...worktree }],
      },
    };
  }

  function firstWorktree(
    piece: TelemetryIngestRequest,
  ): TelemetryWorktreePayload | undefined {
    return piece.workspace.worktrees?.[0];
  }

  function turnIds(pieces: TelemetryIngestRequest[]): string[] {
    return pieces.flatMap(
      (piece) => firstWorktree(piece)?.turns?.map((t) => t.clientTurnId) ?? [],
    );
  }

  it('emits exactly one envelope-only piece for empty collections', () => {
    const request = makeRequest({ summary: 'hello' });
    const pieces = splitTelemetryIngestRequest(
      request,
      MAX_TELEMETRY_INGEST_BATCH_BYTES,
    );
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toEqual(request);
  });

  it('returns a single piece equal to the input when everything fits', () => {
    const request = makeRequest(
      { turns: [makeTurn('t1'), makeTurn('t2')], plans: [makePlan('p1')] },
      { shareScope: 'private' },
    );
    const pieces = splitTelemetryIngestRequest(
      request,
      MAX_TELEMETRY_INGEST_BATCH_BYTES,
    );
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toEqual(request);
  });

  it('splits over the byte budget: union preserved, order kept, no dups, every piece within budget', () => {
    const turns = Array.from({ length: 20 }, (_, i) => makeTurn(`t${i}`, 500));
    const request = makeRequest({ turns });
    const maxBytes = 2000;
    const pieces = splitTelemetryIngestRequest(request, maxBytes);

    expect(pieces.length).toBeGreaterThan(1);
    expect(turnIds(pieces)).toEqual(turns.map((t) => t.clientTurnId));
    for (const piece of pieces) {
      expect(piece.workspace).not.toHaveProperty('sourceProjectId');
      expect(piece.workspace).not.toHaveProperty('sourceOrganizationId');
      expect(utf8ByteLength(JSON.stringify(piece))).toBeLessThanOrEqual(
        maxBytes,
      );
    }
  });

  it('splits turns at the per-request count cap under a generous byte budget', () => {
    const turns = Array.from({ length: 250 }, (_, i) => makeTurn(`t${i}`));
    const request = makeRequest({ turns });
    const pieces = splitTelemetryIngestRequest(
      request,
      MAX_TELEMETRY_INGEST_BATCH_BYTES,
    );
    expect(pieces).toHaveLength(3);
    expect(firstWorktree(pieces[0])?.turns).toHaveLength(
      MAX_TELEMETRY_TURNS_PER_WORKTREE,
    );
    expect(firstWorktree(pieces[1])?.turns).toHaveLength(
      MAX_TELEMETRY_TURNS_PER_WORKTREE,
    );
    expect(firstWorktree(pieces[2])?.turns).toHaveLength(
      250 - 2 * MAX_TELEMETRY_TURNS_PER_WORKTREE,
    );
  });

  it('keeps every collection within its own count cap on every piece for a mixed oversized request', () => {
    const request = makeRequest({
      turns: Array.from({ length: 150 }, (_, i) => makeTurn(`t${i}`)),
      plans: Array.from({ length: 40 }, (_, i) => makePlan(`p${i}`)),
      pullRequests: Array.from({ length: 40 }, (_, i) => makePr(i)),
      pipelineRuns: Array.from({ length: 80 }, (_, i) => makeRun(`r${i}`)),
      summaries: Array.from({ length: 80 }, (_, i) => makeSummary(`s${i}`)),
    });
    const pieces = splitTelemetryIngestRequest(
      request,
      MAX_TELEMETRY_INGEST_BATCH_BYTES,
    );

    for (const piece of pieces) {
      const wt = firstWorktree(piece);
      expect((wt?.turns ?? []).length).toBeLessThanOrEqual(
        MAX_TELEMETRY_TURNS_PER_WORKTREE,
      );
      expect((wt?.plans ?? []).length).toBeLessThanOrEqual(
        MAX_TELEMETRY_PLANS_PER_WORKTREE,
      );
      expect((wt?.pullRequests ?? []).length).toBeLessThanOrEqual(
        MAX_TELEMETRY_PULL_REQUESTS_PER_WORKTREE,
      );
      expect((wt?.pipelineRuns ?? []).length).toBeLessThanOrEqual(
        MAX_TELEMETRY_PIPELINE_RUNS_PER_WORKTREE,
      );
      expect((wt?.summaries ?? []).length).toBeLessThanOrEqual(
        MAX_TELEMETRY_SUMMARIES_PER_WORKTREE,
      );
    }

    // Union across pieces is complete and order-preserving for each collection.
    expect(turnIds(pieces)).toEqual(
      Array.from({ length: 150 }, (_, i) => `t${i}`),
    );
    const planIds = pieces.flatMap(
      (p) => firstWorktree(p)?.plans?.map((x) => x.clientPlanId) ?? [],
    );
    expect(planIds).toEqual(Array.from({ length: 40 }, (_, i) => `p${i}`));
    const prNumbers = pieces.flatMap(
      (p) => firstWorktree(p)?.pullRequests?.map((x) => x.prNumber) ?? [],
    );
    expect(prNumbers).toEqual(Array.from({ length: 40 }, (_, i) => i));
    const runIds = pieces.flatMap(
      (p) =>
        firstWorktree(p)?.pipelineRuns?.map((x) => x.clientPipelineRunId) ?? [],
    );
    expect(runIds).toEqual(Array.from({ length: 80 }, (_, i) => `r${i}`));
    const snapshotIds = pieces.flatMap(
      (p) => firstWorktree(p)?.summaries?.map((x) => x.clientSnapshotId) ?? [],
    );
    expect(snapshotIds).toEqual(Array.from({ length: 80 }, (_, i) => `s${i}`));
  });

  it('emits a single over-budget item alone without looping', () => {
    const request = makeRequest({
      turns: [
        makeTurn('small', 10),
        makeTurn('big', 5000),
        makeTurn('small2', 10),
      ],
    });
    const maxBytes = 1000;
    const pieces = splitTelemetryIngestRequest(request, maxBytes);

    expect(turnIds(pieces)).toEqual(['small', 'big', 'small2']);
    const bigPiece = pieces.find((piece) =>
      firstWorktree(piece)?.turns?.some((t) => t.clientTurnId === 'big'),
    );
    if (!bigPiece) {
      throw new Error('expected a piece containing the big turn');
    }
    expect(firstWorktree(bigPiece)?.turns).toHaveLength(1);
  });

  it('repeats the envelope + scope on every piece and the summary on piece 0 only', () => {
    const turns = Array.from({ length: 250 }, (_, i) => makeTurn(`t${i}`));
    const request = makeRequest(
      {
        summary: 'latest',
        status: 'active',
        clientCreatedAt: '2026-06-16T00:00:00.000Z',
        turns,
      },
      {
        shareScope: 'organization',
        teamId: 'team-1',
        organizationId: 'org-1',
        fullSession: true,
      },
    );
    request.workspace.sourceProjectId = 'source-project-1';
    request.workspace.sourceOrganizationId = 'source-org-1';
    const pieces = splitTelemetryIngestRequest(
      request,
      MAX_TELEMETRY_INGEST_BATCH_BYTES,
    );
    expect(pieces.length).toBeGreaterThan(1);

    pieces.forEach((piece, index) => {
      expect(piece.workspace.sourceProjectId).toBe('source-project-1');
      expect(piece.workspace.sourceOrganizationId).toBe('source-org-1');
      expect(piece.shareScope).toBe('organization');
      expect(piece.teamId).toBe('team-1');
      expect(piece.organizationId).toBe('org-1');
      expect(piece.fullSession).toBe(true);
      const wt = firstWorktree(piece);
      expect(wt?.clientLocalId).toBe('wt');
      expect(wt?.branchName).toBe('main');
      expect(wt?.status).toBe('active');
      expect(wt?.clientCreatedAt).toBe('2026-06-16T00:00:00.000Z');
      if (index === 0) {
        expect(wt?.summary).toBe('latest');
      } else {
        expect(wt?.summary).toBeUndefined();
      }
    });
  });

  it('is deterministic for the same input', () => {
    const request = makeRequest({
      turns: Array.from({ length: 12 }, (_, i) => makeTurn(`t${i}`, 300)),
      plans: Array.from({ length: 6 }, (_, i) => makePlan(`p${i}`)),
    });
    const maxBytes = 1500;
    expect(splitTelemetryIngestRequest(request, maxBytes)).toEqual(
      splitTelemetryIngestRequest(request, maxBytes),
    );
  });

  it('returns the request unchanged when there is not exactly one worktree', () => {
    const noWorktree: TelemetryIngestRequest = {
      workspace: {
        clientLocalId: 'ws',
        name: 'Workspace',
        workspaceType: 'single-repo',
        worktrees: [],
      },
    };
    expect(
      splitTelemetryIngestRequest(noWorktree, MAX_TELEMETRY_INGEST_BATCH_BYTES),
    ).toEqual([noWorktree]);
  });

  it('rides userActiveAt on every piece and attention on piece 0 only', () => {
    // Presence is envelope-shaped (one timestamp, last-write-wins server-side)
    // so it must reach every piece exactly like `status`. Attention is a
    // last-write-wins per-chat STATE, not an accumulating collection, so
    // repeating it per piece would re-submit the same transition N times.
    const turns = Array.from({ length: 20 }, (_, i) => makeTurn(`t${i}`, 500));
    const request = makeRequest(
      {
        turns,
        userActiveAt: '2026-09-19T21:00:00.000Z',
        sourceClientLocalId: 'producer-wt',
      },
      {
        attention: [
          {
            clientChatId: 'chat-1',
            clientWorktreeId: 'wt',
            state: 'needs_input',
            reason: 'tool_approval',
            since: '2026-09-19T21:00:00.000Z',
          },
        ],
      },
    );
    const pieces = splitTelemetryIngestRequest(request, 2000);

    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(firstWorktree(piece)?.userActiveAt).toBe(
        '2026-09-19T21:00:00.000Z',
      );
      expect(firstWorktree(piece)?.sourceClientLocalId).toBe('producer-wt');
    }
    expect(pieces[0]?.attention).toHaveLength(1);
    for (const piece of pieces.slice(1)) {
      expect(piece.attention).toBeUndefined();
    }
  });
});

describe('buildTelemetryAttentionDetail', () => {
  it('drops absent and blank details rather than sending an empty string', () => {
    expect(buildTelemetryAttentionDetail(undefined)).toBeUndefined();
    expect(buildTelemetryAttentionDetail('   \n ')).toBeUndefined();
  });

  it('redacts secrets before the value can enter a payload', () => {
    const detail = buildTelemetryAttentionDetail(
      'run deploy with sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    );
    expect(detail).toBeDefined();
    expect(detail).not.toContain('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  });

  it('truncates on a word boundary within the cap', () => {
    const detail = buildTelemetryAttentionDetail(`${'word '.repeat(80)}tail`);
    expect(detail).toBeDefined();
    expect(detail?.length).toBeLessThanOrEqual(ATTENTION_DETAIL_MAX_CHARS);
    expect(detail?.endsWith('\u2026')).toBe(true);
    // Word boundary honored: the truncation point is not mid-token.
    expect(detail).not.toContain('wor\u2026');
  });

  it('cuts a single over-long token rather than emptying the detail', () => {
    // A lone unbroken token (a path, a URL) has no usable word boundary; the
    // fallback must still produce something legible instead of just an
    // ellipsis.
    const detail = buildTelemetryAttentionDetail('x'.repeat(400));
    expect(detail?.length).toBe(ATTENTION_DETAIL_MAX_CHARS);
  });
});

describe('buildTelemetryAttention', () => {
  it('applies the id clamps and the detail scrub in one place', () => {
    const entry = buildTelemetryAttention({
      clientChatId: 'c'.repeat(MAX_TELEMETRY_CLIENT_ID_LENGTH + 40),
      clientWorktreeId: 'wt',
      state: 'blocked',
      reason: 'usage_limit',
      since: '2026-09-19T21:00:00.000Z',
      detail: '  resets   soon  ',
    });
    expect(entry.clientChatId.length).toBe(MAX_TELEMETRY_CLIENT_ID_LENGTH);
    expect(entry.detail).toBe('resets soon');
  });

  it('omits detail entirely when there is nothing to send', () => {
    const entry = buildTelemetryAttention({
      clientChatId: 'c1',
      clientWorktreeId: 'wt',
      state: 'needs_input',
      reason: 'plan_review',
      since: '2026-09-19T21:00:00.000Z',
    });
    expect(entry).not.toHaveProperty('detail');
  });
});
