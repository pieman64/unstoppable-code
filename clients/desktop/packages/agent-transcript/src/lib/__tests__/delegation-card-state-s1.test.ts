import type {
  AgentDelegationSnapshot,
  AgentDelegationTranscript,
} from '@canopy/protocol/delegation';
import {
  CardStateDraftSchema,
  CardStateV2Schema,
  STREAM_CARD_CAPS,
  type CardStateDraft,
  type CardState,
} from '@canopy/protocol/canopy-core';
import {
  cardStateDraftFromSnapshot,
  fitCardStateDraft,
  persistedDelegationSnapshot,
} from '../delegation-card-state';
import {
  applyDelegationTranscriptEvent,
  overlayStreamBackedDelegationCard,
} from '../delegation-transcript';
import { createEmptyTranscriptReducerState } from '../transcript-parser';
import type { DelegatedAgentCallBlock } from '../../types';

const route: NonNullable<CardStateDraft['routeSnapshot']> = {
  selectedModelId: 'selected',
  runtimeModelId: 'runtime',
  harnessId: 'codex',
  runtimeKind: 'sdk',
  runnerRegistrationId: 'runner',
  runtimeVersion: '1',
  adapterVersion: '1',
  modelSource: 'agent',
  providerType: 'openai',
  assignmentRevision: '1',
  billingAuthority: 'local',
  aiCreditsRouted: false,
  capabilities: [],
  supportedThinkingLevels: [],
  capabilitySnapshotHash: 'hash',
  capabilityGeneration: 1,
  policyRevision: '1',
};
const base: CardStateDraft = {
  version: 2,
  status: 'running',
  outputTruncated: false,
};
const raw: DelegatedAgentCallBlock = {
  type: 'delegated_agent_call',
  delegationId: 'd',
  runGeneration: 1,
  agentBlockId: 'delegated-agent-d',
  sequence: 0,
  parentHarnessId: 'codex',
  parentTurnId: 'turn',
  parentToolCallId: 'tool',
  createdAt: 1,
  status: 'pending',
  outputTruncated: false,
  selectedModelId: '',
  runtimeModelId: '',
  targetHarnessId: '',
  description: 'Task',
  prompt: 'Original',
  executionMode: 'background',
  transcriptStore: 'chat-stream-v2',
};

function event(generation: number, sequence = 0): AgentDelegationTranscript {
  return {
    delegationId: 'd',
    runGeneration: generation,
    sequence,
    parentHarnessId: 'codex',
    parentTurnId: 'turn',
    parentToolCallId: 'tool',
    createdAt: 1,
    task: {
      description: 'Task',
      prompt: 'Original',
      executionMode: 'background',
    },
    snapshot: {
      delegationId: 'd',
      status: 'running',
      outputTruncated: false,
      routeSnapshot: route,
    },
    transcript: [],
    transcriptStore: 'chat-stream-v2',
  };
}

describe('12a S1 additional pure evidence', () => {
  it.each([
    'selectedModelId',
    'selectedModelLabel',
    'runtimeModelLabel',
    'runtimeModelId',
    'harnessId',
    'runtimeKind',
    'runnerRegistrationId',
    'runtimeVersion',
    'adapterVersion',
    'modelSource',
    'providerType',
    'assignmentRevision',
    'routeId',
    'billingAuthority',
    'capabilitySnapshotHash',
    'policyRevision',
  ] as const)(
    'E2 route field fitting retains the longest encoded prefix: %s',
    (key) => {
      const fitted = fitCardStateDraft({
        ...base,
        routeSnapshot: { ...route, [key]: '"'.repeat(512) },
      });
      expect(fitted.routeSnapshot?.[key]).toBe('"'.repeat(511));
      expect(fitted.outputTruncated).toBe(true);
    },
  );

  it.each([
    'agentDefinitionId',
    'agentDefinitionRevision',
    'agentDefinitionHash',
    'pluginProjectionHash',
  ] as const)(
    'E2 overlay field fitting retains the longest encoded prefix: %s',
    (key) => {
      const overlay = {
        agentDefinitionId: 'agent',
        agentDefinitionRevision: '1',
        agentDefinitionHash: 'hash',
        pluginProjectionHash: 'projection',
        [key]: '"'.repeat(512),
      };
      const fitted = fitCardStateDraft({
        ...base,
        routeSnapshot: { ...route, agentOverlay: overlay },
      });
      expect(fitted.routeSnapshot?.agentOverlay?.[key]).toBe('"'.repeat(511));
      expect(fitted.outputTruncated).toBe(true);
    },
  );

  it('E2 fits route collections in source order and never drops thinking aliases', () => {
    const fitted = fitCardStateDraft({
      ...base,
      routeSnapshot: {
        ...route,
        capabilities: Array.from(
          { length: 70 },
          (_, index) => `cap-${String(index)}`,
        ),
        requestedThinkingLevel: 'high',
        effectiveThinkingLevel: 'medium',
        supportedThinkingLevels: Array.from({ length: 20 }, () => 'high'),
      },
    });
    expect(fitted.routeSnapshot?.capabilities).toEqual(
      Array.from({ length: 64 }, (_, index) => `cap-${String(index)}`),
    );
    expect(fitted.routeSnapshot?.supportedThinkingLevels).toHaveLength(16);
    expect(fitted.routeSnapshot?.requestedThinkingLevel).toBe('high');
    expect(fitted.routeSnapshot?.effectiveThinkingLevel).toBe('medium');
    expect(fitted.outputTruncated).toBe(true);
  });

  it('E2 fits capability names, steering details, diffs and guidance independently', () => {
    const fitted = fitCardStateDraft({
      ...base,
      capabilities: {
        inherit: true,
        discovery: true,
        items: [{ kind: 'skill', source: 'loaded', name: '"'.repeat(512) }],
        skipped: [
          {
            kind: 'plugin',
            reason: 'missing_selection',
            name: '"'.repeat(512),
          },
        ],
      },
      control: {
        operationId: 'op',
        operation: 'apply',
        status: 'failed',
        steeringDelivery: {
          kind: 'unknown',
          attemptId: 'attempt',
          reason: '"'.repeat(2048),
        },
        applyFailure: {
          reason: 'conflict',
          guidance: '"'.repeat(2048),
          issues: [
            {
              path: 'a',
              reason: 'parent_changed',
              parentDiff: '"'.repeat(2048),
            },
          ],
        },
      },
    });
    expect(fitted.capabilities?.items[0]?.name).toBe('"'.repeat(511));
    expect(fitted.capabilities?.skipped[0]?.name).toBe('"'.repeat(511));
    expect(fitted.control?.steeringDelivery).toEqual({
      kind: 'unknown',
      attemptId: 'attempt',
      reason: '"'.repeat(2047),
    });
    expect(fitted.control?.applyFailure).toEqual({
      reason: 'conflict',
      guidance: '"'.repeat(2047),
      issues: [
        {
          path: 'a',
          reason: 'parent_changed',
          parentDiff: '"'.repeat(2047),
          parentDiffTruncated: true,
        },
      ],
    });
    expect(fitted.outputTruncated).toBe(true);
  });

  it('E2 omits oversized retained identity details rather than changing their identity', () => {
    const over = '"'.repeat(512);
    const fitted = fitCardStateDraft({
      ...base,
      nativeSessionId: over,
      isolatedWorkspace: { revision: over, dirtyParentChangesIncluded: false },
      stoppedBy: {
        kind: 'agent',
        depth: 1,
        delegationId: over,
        description: '"'.repeat(512),
      },
      childDelegationIds: ['first', over, 'last'],
      control: {
        operationId: 'op',
        operation: 'apply',
        status: 'failed',
        steeringDelivery: {
          kind: 'accepted',
          attemptId: 'attempt',
          providerTurnId: over,
        },
        applyFailure: {
          reason: 'conflict',
          guidance: 'Retry',
          issues: [{ path: over, reason: 'parent_changed' }],
        },
      },
    });
    expect(fitted.nativeSessionId).toBeUndefined();
    expect(fitted.isolatedWorkspace).toBeUndefined();
    expect(fitted.stoppedBy).toEqual({
      kind: 'agent',
      depth: 1,
      description: '"'.repeat(511),
    });
    expect(fitted.childDelegationIds).toEqual(['first']);
    expect(fitted.control?.steeringDelivery).toEqual({
      kind: 'accepted',
      attemptId: 'attempt',
    });
    expect(fitted.control?.applyFailure).toEqual({
      reason: 'conflict',
      guidance: 'Retry',
      issues: [],
      omittedIssues: 1,
    });
    expect(
      fitCardStateDraft({
        ...base,
        control: { operationId: over, operation: 'steer', status: 'failed' },
      }).control,
    ).toBeUndefined();
    expect(
      fitCardStateDraft({
        ...base,
        control: {
          operationId: 'op',
          operation: 'steer',
          status: 'failed',
          steeringDelivery: {
            kind: 'rejected',
            attemptId: over,
            reason: 'reason',
          },
        },
      }).control?.steeringDelivery,
    ).toBeUndefined();
  });

  it('E2 refuses an over-admission prompt rather than truncating task content', () => {
    expect(() =>
      fitCardStateDraft({ ...base, prompt: 'p'.repeat(32769) }),
    ).toThrow('admission bound');
  });

  it('E9 moved legacy projection keeps literal ordered JSON across running and terminal snapshots', () => {
    expect(
      JSON.stringify(
        persistedDelegationSnapshot({
          delegationId: 'legacy',
          status: 'running',
          outputTruncated: false,
          requestedModelId: undefined,
          nativeSessionId: 'native',
          partialText: undefined,
          phase: 'running',
          usage: { inputTokens: 5 },
          control: {
            operationId: 'accepted',
            operation: 'steer',
            status: 'accepted',
          },
        }),
      ),
    ).toBe(
      '{"delegationId":"legacy","status":"running","outputTruncated":false,"nativeSessionId":"native"}',
    );
    expect(
      JSON.stringify(
        persistedDelegationSnapshot({
          delegationId: 'legacy',
          status: 'completed',
          usage: { inputTokens: 5, outputTokens: 2, costUsd: 1 },
          outputTruncated: true,
          finalText: '',
          partialText: 'live',
          control: {
            operationId: 'done',
            operation: 'apply',
            status: 'completed',
          },
        }),
      ),
    ).toBe(
      '{"delegationId":"legacy","status":"completed","usage":{"inputTokens":5,"outputTokens":2,"costUsd":1},"outputTruncated":true,"finalText":"","control":{"operationId":"done","operation":"apply","status":"completed"}}',
    );
  });

  it('E2 projects every draft field but no creation, canonical or live-only fields', () => {
    const snapshot: AgentDelegationSnapshot = {
      delegationId: 'd',
      status: 'failed',
      outputTruncated: true,
      depth: 1,
      parentDelegationId: 'p',
      permissions: { writePaths: ['src'] },
      runGeneration: 1,
      resultIndex: 1,
      finalText: 'not draft',
      partialText: 'live',
      error: { code: 'runtime_error', message: 'error', retryable: false },
      usage: { costUsd: 1 },
      phase: 'running',
      approvalPending: true,
      stopRequested: { operationId: 'stop', status: 'accepted' },
      routeSnapshot: route,
      requestedModelId: 'requested',
      nativeSessionId: 'native',
      nestedDelegation: 'enabled',
      childDelegationIds: ['child'],
      capabilities: { inherit: true, discovery: false, items: [], skipped: [] },
      isolatedWorkspace: {
        revision: 'revision-2',
        dirtyParentChangesIncluded: false,
      },
      workspaceDiscarded: true,
      control: {
        operationId: 'apply',
        operation: 'apply',
        status: 'failed',
        applyFailure: { reason: 'conflict', issues: [], guidance: 'Retry' },
      },
      cancelledByUser: true,
      stoppedBy: { kind: 'user' },
      stopReason: 'user_cancelled',
    };
    expect(cardStateDraftFromSnapshot(snapshot, { prompt: 'Amended' })).toEqual(
      {
        ...base,
        outputTruncated: true,
        prompt: 'Amended',
        routeSnapshot: route,
        requestedModelId: 'requested',
        nativeSessionId: 'native',
        nestedDelegation: 'enabled',
        childDelegationIds: ['child'],
        capabilities: {
          inherit: true,
          discovery: false,
          items: [],
          skipped: [],
        },
        isolatedWorkspace: {
          revision: 'revision-2',
          dirtyParentChangesIncluded: false,
        },
        workspaceDiscarded: true,
        control: {
          operationId: 'apply',
          operation: 'apply',
          status: 'failed',
          applyFailure: { reason: 'conflict', issues: [], guidance: 'Retry' },
        },
        cancelledByUser: true,
        stoppedBy: { kind: 'user' },
      },
    );
    expect(
      cardStateDraftFromSnapshot({
        ...snapshot,
        status: 'pending',
        control: { operationId: 'op', operation: 'steer', status: 'accepted' },
      }).control,
    ).toBeUndefined();
  });

  it('E2 explicitly clears old usage and every live-only field', () => {
    const card: DelegatedAgentCallBlock = {
      ...raw,
      usage: { inputTokens: 5 },
      partialText: 'live',
      phase: 'running',
      approvalPending: true,
      stopRequested: { operationId: 'stop', status: 'accepted' },
      queue: { id: 'default', name: 'Default', position: 1 },
      workspaceObservation: {
        consistency: 'live_shared_worktree',
        headRevision: 'head',
        dirty: false,
        observedAt: 1,
      },
    };
    const merged = overlayStreamBackedDelegationCard(card, {
      ...base,
      cardRevision: 1,
    });
    expect(merged).toEqual({ ...raw, status: 'running' });
    for (const key of [
      'usage',
      'partialText',
      'phase',
      'approvalPending',
      'stopRequested',
      'queue',
      'workspaceObservation',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(merged, key)).toBe(false);
    }
  });

  it.each([
    ['nativeSessionId', { nativeSessionId: '\u0000'.repeat(200) }],
    ['requestedModelId', { requestedModelId: '\u0000'.repeat(200) }],
    [
      'workspace revision',
      {
        isolatedWorkspace: {
          revision: '\u0000'.repeat(200),
          dirtyParentChangesIncluded: false,
        },
      },
    ],
    [
      'stopped attribution',
      {
        stoppedBy: {
          kind: 'agent',
          depth: 1,
          description: '\u0000'.repeat(500),
          delegationId: 'p',
        },
      },
    ],
    [
      'route strings',
      {
        routeSnapshot: {
          ...route,
          selectedModelId: '\u0000'.repeat(500),
          selectedModelLabel: '\u0000'.repeat(500),
        },
      },
    ],
    [
      'control and steering',
      {
        control: {
          operationId: '\u0000'.repeat(300),
          operation: 'steer',
          status: 'failed',
          error: '\u0000'.repeat(1000),
          steeringDelivery: {
            kind: 'unknown',
            attemptId: 'attempt',
            reason: '\u0000'.repeat(1000),
          },
        },
      },
    ],
    [
      'apply failure',
      {
        control: {
          operationId: 'op',
          operation: 'apply',
          status: 'failed',
          applyFailure: {
            reason: 'conflict',
            guidance: '\u0000'.repeat(1000),
            issues: [
              {
                path: '\u0000'.repeat(300),
                reason: 'parent_changed',
                parentDiff: '\u0000'.repeat(1000),
              },
            ],
          },
        },
      },
    ],
  ] satisfies readonly [string, Partial<CardStateDraft>][])(
    'E2 fits %s encoded strings and signals omission without mutating input',
    (_name, fields) => {
      const input = { ...base, ...fields };
      const before = JSON.stringify(input);
      const fitted = fitCardStateDraft(input);
      expect(CardStateDraftSchema.safeParse(fitted).success).toBe(true);
      expect(fitted.outputTruncated).toBe(true);
      expect(JSON.stringify(input)).toBe(before);
      expect(fitCardStateDraft(fitted)).toEqual(fitted);
    },
  );

  it('E2 keeps exact child IDs as a longest fitting prefix and counts collection omissions', () => {
    const ids = Array.from(
      { length: 80 },
      (_, index) => `${String(index).padStart(2, '0')}${'x'.repeat(100)}`,
    );
    const fitted = fitCardStateDraft({
      ...base,
      childDelegationIds: ids,
      capabilities: {
        inherit: true,
        discovery: false,
        items: Array.from({ length: 140 }, () => ({
          kind: 'skill',
          name: 'x',
          source: 'loaded',
        })),
        skipped: Array.from({ length: 70 }, () => ({
          kind: 'plugin',
          name: 'x',
          reason: 'missing_selection',
        })),
      },
    });
    expect(fitted.childDelegationIds).toEqual(ids.slice(0, 57));
    expect(fitted.capabilities?.items).toHaveLength(128);
    expect(fitted.capabilities?.skipped).toHaveLength(64);
    expect(fitted.capabilities?.omittedItems).toBe(12);
    expect(fitted.capabilities?.omittedSkipped).toBe(6);
    expect(fitted.outputTruncated).toBe(true);
  });

  it('E2 fits aggregate pressure without dropping fallback sources, or changing a prompt', () => {
    const input: CardStateDraft = {
      ...base,
      prompt: '\u0000'.repeat(32768),
      requestedModelId: 'model',
      routeSnapshot: {
        ...route,
        selectedModelId: 's'.repeat(1022),
        capabilities: Array.from({ length: 64 }, () => 'x'.repeat(1022)),
      },
      childDelegationIds: Array.from({ length: 64 }, () => 'x'.repeat(1022)),
      capabilities: {
        inherit: true,
        discovery: true,
        items: Array.from({ length: 128 }, () => ({
          kind: 'skill',
          name: 'x'.repeat(1022),
          source: 'loaded',
        })),
        skipped: [],
      },
      control: {
        operationId: 'op',
        operation: 'apply',
        status: 'failed',
        error: 'x'.repeat(4094),
        applyFailure: {
          reason: 'conflict',
          guidance: 'x'.repeat(4094),
          issues: Array.from({ length: 64 }, () => ({
            path: 'x'.repeat(1022),
            reason: 'parent_changed',
            parentDiff: 'x'.repeat(4094),
          })),
        },
      },
    };
    const fitted = fitCardStateDraft(input);
    expect(CardStateDraftSchema.safeParse(fitted).success).toBe(true);
    expect(fitted.routeSnapshot?.selectedModelId).toBe('s'.repeat(1022));
    expect(fitted.requestedModelId).toBe('model');
    expect(fitted.prompt).toBe(input.prompt);
    const { prompt: _prompt, ...bounded } = fitted;
    void _prompt;
    expect(
      new TextEncoder().encode(JSON.stringify(bounded)).length,
    ).toBeLessThanOrEqual(STREAM_CARD_CAPS.draft);
    expect(
      CardStateV2Schema.safeParse({
        ...fitted,
        cardRevision: Number.MAX_SAFE_INTEGER,
        canonical: {
          status: 'completed',
          resultIndex: Number.MAX_SAFE_INTEGER,
          finalText: '\u0000'.repeat(8192),
        },
      }).success,
    ).toBe(true);
  });

  it('E2 marks shortened diffs and counts omitted apply issues', () => {
    const fitted = fitCardStateDraft({
      ...base,
      control: {
        operationId: 'op',
        operation: 'apply',
        status: 'failed',
        applyFailure: {
          reason: 'conflict',
          guidance: 'Retry',
          issues: Array.from({ length: 70 }, () => ({
            path: 'a',
            reason: 'parent_changed',
            parentDiff: '\u0000'.repeat(1000),
          })),
        },
      },
    });
    const failure = fitted.control?.applyFailure;
    expect(
      failure?.issues.every(
        (issue) =>
          issue.parentDiff === undefined || issue.parentDiffTruncated === true,
      ),
    ).toBe(true);
    expect((failure?.issues.length ?? 0) + (failure?.omittedIssues ?? 0)).toBe(
      70,
    );
    expect(CardStateDraftSchema.safeParse(fitted).success).toBe(true);
  });

  it('E3 appends generation two after unrelated and child rows, preserving generation one bytes', () => {
    const first = applyDelegationTranscriptEvent(
      createEmptyTranscriptReducerState(),
      { delegation: event(1) },
    );
    const before = JSON.stringify(first.messages[0]);
    const state = {
      ...first,
      messages: [
        ...first.messages,
        {
          id: 'child',
          role: 'assistant' as const,
          timestamp: 2,
          parentBlockId: 'delegated-agent-d',
          blocks: [{ type: 'text' as const, text: 'child' }],
        },
        {
          id: 'later',
          role: 'user' as const,
          timestamp: 3,
          blocks: [{ type: 'text' as const, text: 'later' }],
        },
      ],
    };
    const next = applyDelegationTranscriptEvent(state, {
      delegation: event(2),
    });
    expect(next.messages.map((row) => row.id)).toEqual([
      'delegated-agent-d',
      'child',
      'later',
      'delegated-agent-d-run-2',
    ]);
    expect(JSON.stringify(next.messages[0])).toBe(before);
    const restarted = { ...next, messages: structuredClone(next.messages) };
    expect(
      applyDelegationTranscriptEvent(restarted, { delegation: event(1, 100) }),
    ).toBe(restarted);
    const paged = { ...next, messages: [next.messages[3]] };
    expect(
      applyDelegationTranscriptEvent(paged, { delegation: event(2, 100) }),
    ).toBe(paged);
  });

  it('E3 appends an old first generation after newer generations and active-parent later rows', () => {
    const first = applyDelegationTranscriptEvent(
      createEmptyTranscriptReducerState(),
      { delegation: event(2) },
    );
    const state = {
      ...first,
      messages: [
        ...first.messages,
        {
          id: 'active-parent',
          role: 'assistant' as const,
          timestamp: 3,
          blocks: [{ type: 'text' as const, text: 'later' }],
        },
      ],
    };
    expect(
      applyDelegationTranscriptEvent(state, {
        delegation: event(1),
      }).messages.map((row) => row.id),
    ).toEqual([
      'delegated-agent-d-run-2',
      'active-parent',
      'delegated-agent-d',
    ]);
  });
});

describe('16d display-only stream revision', () => {
  // Optional trailing arguments are backwards-compatible before implementation.
  const overlay: (
    card: DelegatedAgentCallBlock,
    state: CardState | null,
    streamRevision?: number,
  ) => DelegatedAgentCallBlock = overlayStreamBackedDelegationCard;
  const v1State: CardState = {
    version: 1,
    status: 'running',
    resultIndex: null,
    error: null,
    usage: null,
    workspaceRevision: null,
    workspaceDiscarded: false,
    stopOutcome: null,
    controlOutcome: null,
    attribution: null,
    capabilitySummary: null,
    nestedChildSummary: null,
    partialPreview: null,
    finalPreview: null,
  };
  const states: (CardState | null)[] = [
    null,
    v1State,
    { ...base, cardRevision: 4 },
  ];
  it.each(states)(
    'stamps a known stream card at revision 17 with state %j',
    (state) => {
      expect(overlay(raw, state, 17)).toHaveProperty('streamRevision', 17);
    },
  );
  it('keeps two-argument V1 and V2 overlay bytes and property order unchanged', () => {
    const expectedBytes =
      '{"type":"delegated_agent_call","delegationId":"d","runGeneration":1,"agentBlockId":"delegated-agent-d","sequence":0,"parentHarnessId":"codex","parentTurnId":"turn","parentToolCallId":"tool","createdAt":1,"status":"running","outputTruncated":false,"selectedModelId":"","runtimeModelId":"","targetHarnessId":"","description":"Task","prompt":"Original","executionMode":"background","transcriptStore":"chat-stream-v2"}';
    const expectedKeys = [
      'type',
      'delegationId',
      'runGeneration',
      'agentBlockId',
      'sequence',
      'parentHarnessId',
      'parentTurnId',
      'parentToolCallId',
      'createdAt',
      'status',
      'outputTruncated',
      'selectedModelId',
      'runtimeModelId',
      'targetHarnessId',
      'description',
      'prompt',
      'executionMode',
      'transcriptStore',
    ];
    const v1 = overlayStreamBackedDelegationCard(raw, v1State);
    const v2 = overlayStreamBackedDelegationCard(raw, {
      ...base,
      cardRevision: 4,
    });
    expect(JSON.stringify(v1)).toBe(
      '{"type":"delegated_agent_call","delegationId":"d","runGeneration":1,"agentBlockId":"delegated-agent-d","sequence":0,"parentHarnessId":"codex","parentTurnId":"turn","parentToolCallId":"tool","createdAt":1,"status":"running","outputTruncated":false,"selectedModelId":"","runtimeModelId":"","targetHarnessId":"","description":"Task","prompt":"Original","executionMode":"background","transcriptStore":"chat-stream-v2","workspaceDiscarded":false}',
    );
    expect(JSON.stringify(v2)).toBe(expectedBytes);
    expect(Object.keys(v1)).toEqual([...expectedKeys, 'workspaceDiscarded']);
    expect(Object.keys(v2)).toEqual(expectedKeys);
  });
  it('preserves a real zero and never synthesizes an absent hint', () => {
    expect(overlay(raw, null, 0)).toHaveProperty('streamRevision', 0);
    expect(overlay(raw, null)).toBe(raw);
    expect(overlay(raw, { ...base, cardRevision: 4 })).not.toHaveProperty(
      'streamRevision',
    );
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN])(
    'ignores invalid revision %s in every state branch',
    (revision) => {
      for (const state of states)
        expect(overlay(raw, state, revision)).not.toHaveProperty(
          'streamRevision',
        );
    },
  );
  it('does not stamp a legacy card', () => {
    const legacy: DelegatedAgentCallBlock = {
      ...raw,
      transcriptStore: 'chat-log-v1',
    };
    expect(overlay(legacy, states[1], 17)).toBe(legacy);
    expect(legacy).not.toHaveProperty('streamRevision');
  });
  it('strips a leaked hint from legacy durable snapshot bytes without reordering', () => {
    const leaked = {
      delegationId: 'd',
      streamRevision: 17,
      status: 'running' as const,
      outputTruncated: false,
    };
    expect(JSON.stringify(persistedDelegationSnapshot(leaked))).toBe(
      '{"delegationId":"d","status":"running","outputTruncated":false}',
    );
    expect(Object.keys(persistedDelegationSnapshot(leaked))).toEqual([
      'delegationId',
      'status',
      'outputTruncated',
    ]);
  });
  it('keeps the descriptor draft allowlist hint-free and its property order unchanged', () => {
    const leaked = { ...raw, streamRevision: 17 };
    expect(JSON.stringify(cardStateDraftFromSnapshot(leaked))).toBe(
      '{"version":2,"status":"pending","outputTruncated":false}',
    );
    expect(Object.keys(cardStateDraftFromSnapshot(leaked))).toEqual([
      'version',
      'status',
      'outputTruncated',
    ]);
  });
  const durableKeys = [
    'delegationId',
    'status',
    'outputTruncated',
    'requestedModelId',
    'type',
    'agentBlockId',
    'runGeneration',
    'sequence',
    'parentHarnessId',
    'parentTurnId',
    'parentToolCallId',
    'createdAt',
    'selectedModelId',
    'runtimeModelId',
    'targetHarnessId',
    'requestedThinkingLevel',
    'effectiveThinkingLevel',
    'description',
    'prompt',
    'executionMode',
    'transcriptStore',
  ];
  const creationBytes =
    '{"delegationId":"d","status":"pending","outputTruncated":false,"requestedModelId":"model","type":"delegated_agent_call","agentBlockId":"delegated-agent-d","runGeneration":1,"sequence":0,"parentHarnessId":"codex","parentTurnId":"turn","parentToolCallId":"tool","createdAt":1,"selectedModelId":"model","runtimeModelId":"","targetHarnessId":"","description":"Task","prompt":"Original","executionMode":"background","transcriptStore":"STORE"}';
  it.each(['chat-stream-v2', 'chat-log-v1'] as const)(
    'strips a leaked hint in %s creation',
    (transcriptStore) => {
      const clean = {
        ...event(1),
        transcriptStore,
        snapshot: {
          delegationId: 'd',
          status: 'pending' as const,
          outputTruncated: false,
          requestedModelId: 'model',
        },
      };
      const leaked = {
        ...clean,
        snapshot: { ...clean.snapshot, streamRevision: 17 },
      };
      for (const value of [clean, leaked]) {
        const actual = applyDelegationTranscriptEvent(
          createEmptyTranscriptReducerState(),
          { delegation: value },
        );
        expect(JSON.stringify(actual.messages[0].blocks[0])).toBe(
          creationBytes.replace('STORE', transcriptStore),
        );
        expect(Object.keys(actual.messages[0].blocks[0])).toEqual(durableKeys);
      }
    },
  );
  it.each([false, true])(
    'strips prior and incoming legacy rewrite hints (incoming=%s)',
    (leakIncoming) => {
      const value = {
        ...event(1),
        transcriptStore: 'chat-log-v1' as const,
        snapshot: {
          delegationId: 'd',
          status: 'pending' as const,
          outputTruncated: false,
          requestedModelId: 'model',
        },
      };
      const creation = applyDelegationTranscriptEvent(
        createEmptyTranscriptReducerState(),
        { delegation: value },
      );
      const prior = {
        ...creation,
        messages: creation.messages.map((message) => ({
          ...message,
          blocks: message.blocks.map((block) => ({
            ...block,
            streamRevision: 99,
          })),
        })),
      };
      const rewrite = {
        ...value,
        sequence: 1,
        snapshot: {
          ...value.snapshot,
          ...(leakIncoming ? { streamRevision: 18 } : {}),
        },
      };
      const actual = applyDelegationTranscriptEvent(prior, {
        delegation: rewrite,
      });
      expect(JSON.stringify(actual.messages[0].blocks[0])).toBe(
        '{"delegationId":"d","status":"pending","outputTruncated":false,"requestedModelId":"model","type":"delegated_agent_call","agentBlockId":"delegated-agent-d","runGeneration":1,"sequence":1,"parentHarnessId":"codex","parentTurnId":"turn","parentToolCallId":"tool","createdAt":1,"selectedModelId":"model","runtimeModelId":"","targetHarnessId":"","description":"Task","prompt":"Original","executionMode":"background","transcriptStore":"chat-log-v1"}',
      );
      expect(Object.keys(actual.messages[0].blocks[0])).toEqual(durableKeys);
    },
  );
});
