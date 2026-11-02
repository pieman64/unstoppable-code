import type { AgentDelegationTranscript } from '@canopy/protocol/delegation';
import type { CardStateDraft, CardStateV2 } from '@canopy/protocol/canopy-core';
import type { DelegatedAgentCallBlock } from '../../types';
import {
  cardStateDraftFromSnapshot,
  fitCardStateDraft,
} from '../delegation-card-state';
import {
  applyDelegationTranscriptEvent,
  isDelegatedAgentCallBlock,
  overlayStreamBackedDelegationCard,
} from '../delegation-transcript';
import { createEmptyTranscriptReducerState } from '../transcript-parser';

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
  requestedModelId: 'requested',
  selectedModelId: 'requested',
  runtimeModelId: '',
  targetHarnessId: '',
  description: 'Task',
  prompt: 'Original',
  executionMode: 'background',
  transcriptStore: 'chat-stream-v2',
};

describe('12a A0 shared card contract', () => {
  it('E2 canonical-only state preserves every required creation fallback', () => {
    expect(
      overlayStreamBackedDelegationCard(raw, {
        version: 2,
        cardRevision: 0,
        canonical: { status: 'completed', resultIndex: 1, finalText: '' },
      }),
    ).toEqual({
      type: 'delegated_agent_call',
      delegationId: 'd',
      status: 'completed',
      outputTruncated: false,
      agentBlockId: 'delegated-agent-d',
      runGeneration: 1,
      sequence: 0,
      parentHarnessId: 'codex',
      parentTurnId: 'turn',
      parentToolCallId: 'tool',
      createdAt: 1,
      selectedModelId: 'requested',
      runtimeModelId: '',
      targetHarnessId: '',
      description: 'Task',
      prompt: 'Original',
      executionMode: 'background',
      transcriptStore: 'chat-stream-v2',
      resultIndex: 1,
      finalText: '',
    });
  });
  it('E2 merges the complete draft display table and preserves empty workspace revisions', () => {
    const draft: CardStateV2 = {
      version: 2,
      cardRevision: 1,
      status: 'running',
      requestedModelId: 'requested',
      nativeSessionId: 'native',
      nestedDelegation: 'enabled',
      childDelegationIds: ['child'],
      capabilities: {
        inherit: false,
        discovery: true,
        items: [{ kind: 'skill', name: 'Skill', source: 'loaded' }],
        skipped: [],
        omittedItems: 1,
      },
      isolatedWorkspace: { revision: '', dirtyParentChangesIncluded: false },
      workspaceDiscarded: true,
      control: {
        operationId: 'op',
        operation: 'apply',
        status: 'failed',
        error: 'Cannot apply',
        steeringDelivery: {
          kind: 'unknown',
          attemptId: 'attempt',
          reason: 'No receipt',
        },
        applyFailure: {
          reason: 'conflict',
          issues: [
            {
              path: 'src/a.ts',
              reason: 'parent_changed',
              parentDiff: 'diff',
              parentDiffTruncated: true,
            },
          ],
          omittedIssues: 1,
          guidance: 'Retry',
        },
      },
      cancelledByUser: true,
      stoppedBy: { kind: 'agent', depth: 0, description: 'Parent' },
      outputTruncated: true,
    };
    expect(overlayStreamBackedDelegationCard(raw, draft)).toEqual({
      ...raw,
      status: 'running',
      nativeSessionId: 'native',
      nestedDelegation: 'enabled',
      childDelegationIds: ['child'],
      capabilities: {
        inherit: false,
        discovery: true,
        items: [{ kind: 'skill', name: 'Skill', source: 'loaded' }],
        skipped: [],
        omittedItems: 1,
      },
      isolatedWorkspace: { revision: '', dirtyParentChangesIncluded: false },
      workspaceDiscarded: true,
      control: {
        operationId: 'op',
        operation: 'apply',
        status: 'failed',
        error: 'Cannot apply',
        steeringDelivery: {
          kind: 'unknown',
          attemptId: 'attempt',
          reason: 'No receipt',
        },
        applyFailure: {
          reason: 'conflict',
          issues: [
            {
              path: 'src/a.ts',
              reason: 'parent_changed',
              parentDiff: 'diff',
              parentDiffTruncated: true,
            },
          ],
          omittedIssues: 1,
          guidance: 'Retry',
        },
      },
      cancelledByUser: true,
      stoppedBy: { kind: 'agent', depth: 0, description: 'Parent' },
      outputTruncated: true,
    });
  });

  it('E2 keeps V1 null-preserves-old-field behavior with independent literals', () => {
    const card: DelegatedAgentCallBlock = {
      ...raw,
      finalText: 'Old final',
      usage: { inputTokens: 3 },
      error: { code: 'runtime_error', message: 'Old error', retryable: false },
    };
    const state = {
      version: 1 as const,
      status: 'running' as const,
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
    expect(overlayStreamBackedDelegationCard(card, state)).toEqual({
      ...raw,
      status: 'running',
      workspaceDiscarded: false,
      finalText: 'Old final',
      usage: { inputTokens: 3 },
      error: { code: 'runtime_error', message: 'Old error', retryable: false },
    });
  });

  it('E2 overlays canonical fields and removes absent fallback fields', () => {
    const card: DelegatedAgentCallBlock = {
      ...raw,
      error: {
        code: 'runtime_error' as const,
        message: 'old',
        retryable: false,
      },
      finalText: 'old',
      control: {
        operationId: 'old',
        operation: 'resume',
        status: 'failed',
        error: 'old',
      },
      finalTextRef: {
        version: 1,
        artifactId: 'old',
        sha256: 'a'.repeat(64),
        byteLength: 3,
        encoding: 'utf-8',
        mediaType: 'text/plain',
      },
    };
    const state: CardStateV2 = {
      version: 2,
      cardRevision: 1,
      status: 'running',
      outputTruncated: false,
      canonical: {
        status: 'completed',
        resultIndex: 1,
        finalText: 'New answer',
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          cachedInputTokens: 3,
          cacheCreationInputTokens: 4,
          costUsd: 0.5,
        },
      },
    };
    expect(overlayStreamBackedDelegationCard(card, state)).toEqual({
      type: 'delegated_agent_call',
      delegationId: 'd',
      runGeneration: 1,
      agentBlockId: 'delegated-agent-d',
      sequence: 0,
      parentHarnessId: 'codex',
      parentTurnId: 'turn',
      parentToolCallId: 'tool',
      createdAt: 1,
      outputTruncated: false,
      runtimeModelId: '',
      targetHarnessId: '',
      description: 'Task',
      prompt: 'Original',
      executionMode: 'background',
      transcriptStore: 'chat-stream-v2',
      status: 'completed',
      resultIndex: 1,
      finalText: 'New answer',
      selectedModelId: 'requested',
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cachedInputTokens: 3,
        cacheCreationInputTokens: 4,
        costUsd: 0.5,
      },
    });
  });

  it('E2 applies an amended queued prompt and preserves the row prompt when absent', () => {
    expect(
      overlayStreamBackedDelegationCard(raw, {
        version: 2,
        cardRevision: 1,
        status: 'pending',
        requestedModelId: 'requested',
        outputTruncated: false,
        prompt: 'Original\n\nCoalesced',
      }).prompt,
    ).toBe('Original\n\nCoalesced');
    expect(
      overlayStreamBackedDelegationCard(raw, {
        version: 2,
        cardRevision: 2,
        status: 'running',
        outputTruncated: false,
      }).prompt,
    ).toBe('Original');
  });

  it('E2 recomputes every route alias after an absent creation route', () => {
    const route = {
      selectedModelId: 'selected',
      runtimeModelId: 'runtime',
      harnessId: 'claude',
      runtimeKind: 'sdk',
      runnerRegistrationId: 'runner',
      runtimeVersion: '1',
      adapterVersion: '1',
      modelSource: 'agent',
      providerType: 'claude',
      assignmentRevision: '1',
      billingAuthority: 'local',
      aiCreditsRouted: false,
      requestedThinkingLevel: 'high' as const,
      effectiveThinkingLevel: 'medium' as const,
      capabilities: [],
      supportedThinkingLevels: [],
      capabilitySnapshotHash: 'hash',
      capabilityGeneration: 1,
      policyRevision: '1',
    };
    expect(
      overlayStreamBackedDelegationCard(raw, {
        version: 2,
        cardRevision: 2,
        routeSnapshot: route,
      }),
    ).toEqual({
      type: 'delegated_agent_call',
      delegationId: 'd',
      runGeneration: 1,
      agentBlockId: 'delegated-agent-d',
      sequence: 0,
      parentHarnessId: 'codex',
      parentTurnId: 'turn',
      parentToolCallId: 'tool',
      createdAt: 1,
      description: 'Task',
      prompt: 'Original',
      executionMode: 'background',
      transcriptStore: 'chat-stream-v2',
      status: 'pending',
      outputTruncated: false,
      routeSnapshot: route,
      selectedModelId: 'selected',
      runtimeModelId: 'runtime',
      targetHarnessId: 'claude',
      requestedThinkingLevel: 'high',
      effectiveThinkingLevel: 'medium',
    });
  });

  it('E2 projects terminal snapshots as running reference-free drafts', () => {
    expect(
      cardStateDraftFromSnapshot({
        delegationId: 'd',
        status: 'completed',
        finalText: 'canonical only',
        outputTruncated: false,
        workspaceDiscarded: true,
      }),
    ).toEqual({
      version: 2,
      status: 'running',
      outputTruncated: false,
      workspaceDiscarded: true,
    });
  });

  it('E2 fits encoded control text deterministically before settlement', () => {
    const draft: CardStateDraft = {
      version: 2,
      status: 'running',
      outputTruncated: false,
      control: {
        operationId: 'op',
        operation: 'apply',
        status: 'failed',
        error: '\u0000'.repeat(4000),
      },
    };
    const fitted = fitCardStateDraft(draft);
    expect(fitted.outputTruncated).toBe(true);
    expect(fitted.control?.error).toBe('\u0000'.repeat(682));
  });

  it('E2 post-settle fitting signals detail omission without changing execution truncation', () => {
    const fitted = fitCardStateDraft(
      {
        version: 2,
        status: 'running',
        outputTruncated: false,
        control: {
          operationId: 'op',
          operation: 'resume',
          status: 'failed',
          error: '\u0000'.repeat(4000),
        },
      },
      { settled: true },
    );
    expect(fitted).toMatchObject({
      outputTruncated: false,
      detailOmitted: true,
    });
  });

  it('E3 appends a late first stream card after unrelated rows', () => {
    const state = {
      ...createEmptyTranscriptReducerState(),
      messages: [
        {
          id: 'turn',
          role: 'user' as const,
          timestamp: 0,
          blocks: [{ type: 'text' as const, text: 'Start' }],
        },
        {
          id: 'newer',
          role: 'assistant' as const,
          timestamp: 2,
          blocks: [{ type: 'text' as const, text: 'Later' }],
        },
      ],
    };
    const transcript: AgentDelegationTranscript = {
      delegationId: 'd',
      runGeneration: 1,
      sequence: 0,
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
        status: 'pending',
        requestedModelId: 'requested',
        outputTruncated: false,
      },
      transcript: [],
      transcriptStore: 'chat-stream-v2',
    };
    expect(
      applyDelegationTranscriptEvent(state, {
        delegation: transcript,
      }).messages.map((message) => message.id),
    ).toEqual(['turn', 'newer', 'delegated-agent-d']);
  });

  it('E3 leaves existing raw row bytes unchanged on later stream events', () => {
    const state = {
      ...createEmptyTranscriptReducerState(),
      messages: [
        {
          id: raw.agentBlockId,
          role: 'assistant' as const,
          timestamp: 1,
          blocks: [raw],
        },
      ],
    };
    const transcript: AgentDelegationTranscript = {
      delegationId: 'd',
      runGeneration: 1,
      sequence: 2,
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
        status: 'pending',
        requestedModelId: 'requested',
        workspaceDiscarded: true,
        outputTruncated: false,
      },
      transcript: [],
      transcriptStore: 'chat-stream-v2',
    };
    expect(
      applyDelegationTranscriptEvent(state, { delegation: transcript }),
    ).toBe(state);
  });

  it('E9 keeps raw validation and legacy/null identity green', () => {
    expect(isDelegatedAgentCallBlock(raw)).toBe(true);
    expect(overlayStreamBackedDelegationCard(raw, null)).toBe(raw);
    const legacy = { ...raw, transcriptStore: 'chat-log-v1' as const };
    expect(
      overlayStreamBackedDelegationCard(legacy, {
        version: 2,
        cardRevision: 1,
      }),
    ).toBe(legacy);
  });
  it('E2 composes merges: a later state over a merged card equals a fresh merge of the raw row', () => {
    const route = {
      selectedModelId: 'selected',
      runtimeModelId: 'runtime',
      harnessId: 'claude',
      runtimeKind: 'sdk',
      runnerRegistrationId: 'runner',
      runtimeVersion: '1',
      adapterVersion: '1',
      modelSource: 'agent',
      providerType: 'claude',
      assignmentRevision: '1',
      billingAuthority: 'local',
      aiCreditsRouted: false,
      requestedThinkingLevel: 'high' as const,
      effectiveThinkingLevel: 'medium' as const,
      capabilities: [],
      supportedThinkingLevels: [],
      capabilitySnapshotHash: 'hash',
      capabilityGeneration: 1,
      policyRevision: '1',
    };
    const states: CardStateV2[] = [
      {
        version: 2,
        cardRevision: 1,
        status: 'pending',
        outputTruncated: false,
        prompt: 'Original\n\nCoalesced',
      },
      {
        version: 2,
        cardRevision: 2,
        status: 'running',
        outputTruncated: false,
        prompt: 'Original\n\nCoalesced',
        routeSnapshot: route,
        nativeSessionId: 'native',
      },
      {
        version: 2,
        cardRevision: 3,
        status: 'running',
        outputTruncated: true,
        prompt: 'Original\n\nCoalesced',
        routeSnapshot: route,
        canonical: {
          status: 'completed',
          resultIndex: 1,
          finalText: 'Done',
        },
      },
    ];
    let merged = raw;
    for (const state of states) {
      merged = overlayStreamBackedDelegationCard(merged, state);
      expect(merged).toEqual(overlayStreamBackedDelegationCard(raw, state));
    }
    expect(merged).toEqual({
      type: 'delegated_agent_call',
      delegationId: 'd',
      runGeneration: 1,
      agentBlockId: 'delegated-agent-d',
      sequence: 0,
      parentHarnessId: 'codex',
      parentTurnId: 'turn',
      parentToolCallId: 'tool',
      createdAt: 1,
      description: 'Task',
      prompt: 'Original\n\nCoalesced',
      executionMode: 'background',
      transcriptStore: 'chat-stream-v2',
      status: 'completed',
      outputTruncated: true,
      routeSnapshot: route,
      selectedModelId: 'selected',
      runtimeModelId: 'runtime',
      targetHarnessId: 'claude',
      requestedThinkingLevel: 'high',
      effectiveThinkingLevel: 'medium',
      resultIndex: 1,
      finalText: 'Done',
    });
  });

  it('E2 composes a canonical-only state over a hydrated null-state card', () => {
    const state: CardStateV2 = {
      version: 2,
      cardRevision: 0,
      canonical: { status: 'failed', resultIndex: 2 },
    };
    const hydrated = overlayStreamBackedDelegationCard(raw, null);
    expect(overlayStreamBackedDelegationCard(hydrated, state)).toEqual({
      ...raw,
      status: 'failed',
      resultIndex: 2,
      selectedModelId: 'requested',
      requestedModelId: undefined,
    });
  });
});
