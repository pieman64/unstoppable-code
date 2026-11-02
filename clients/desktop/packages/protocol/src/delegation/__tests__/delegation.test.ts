import type { AgentDelegationSnapshot } from '..';
import {
  isAgentDelegationPhase,
  isAgentDelegationQueueState,
  isAgentDelegationTranscript,
  isAgentDelegationCardData,
  isDelegationCapabilitySummary,
  parseGetDelegateOutputRequest,
  parseManageDelegateWorktreeRequest,
  parseMessageDelegateRequest,
  parseRequestSteeringRequest,
  parseAgentDelegationSpawnRequest,
  isAgentDelegationTranscriptItem,
} from '..';
import {
  DEFAULT_MANAGED_DELEGATION_MAX_CONCURRENT,
  MAX_MANAGED_DELEGATION_CONCURRENCY,
  normalizeManagedDelegationMaxConcurrent,
} from '../discovery';

const capabilityId = `deferred:v1:${'a'.repeat(43)}`;

describe('delegation transcript store marker', () => {
  const snapshot = {
    delegationId: 'child-a',
    status: 'pending',
    requestedModelId: 'review-model',
    outputTruncated: false,
    parentHarnessId: 'claude',
    description: 'Review',
    prompt: 'Inspect the change.',
    executionMode: 'background',
  };

  it('accepts stream and legacy markers, rejects an unknown transcript marker, and keeps rendering cards whatever their marker', () => {
    for (const transcriptStore of [
      undefined,
      'chat-log-v1',
      'chat-stream-v2',
    ]) {
      expect(
        isAgentDelegationTranscript({
          ...transcriptWithSnapshot(snapshot),
          transcriptStore,
        }),
      ).toBe(true);
      expect(isAgentDelegationCardData({ ...snapshot, transcriptStore })).toBe(
        true,
      );
    }
    expect(
      isAgentDelegationTranscript({
        ...transcriptWithSnapshot(snapshot),
        transcriptStore: 'future-store',
      }),
    ).toBe(false);
    // Presentation never reads a child log, so a newer marker still renders as a managed card.
    expect(
      isAgentDelegationCardData({
        ...snapshot,
        transcriptStore: 'future-store',
      }),
    ).toBe(true);
  });
});

describe('delegation card stream revision', () => {
  const card = {
    delegationId: 'child-a',
    status: 'pending',
    requestedModelId: 'review-model',
    outputTruncated: false,
    parentHarnessId: 'claude',
    description: 'Review',
    prompt: 'Inspect the change.',
    executionMode: 'background',
  };

  it('accepts a card without a revision and with a safe nonnegative one', () => {
    expect(isAgentDelegationCardData(card)).toBe(true);
    for (const streamRevision of [0, 7, Number.MAX_SAFE_INTEGER]) {
      expect(isAgentDelegationCardData({ ...card, streamRevision })).toBe(true);
    }
  });

  it('keeps the revision out of the snapshot type', () => {
    // A compile-time pin: durable snapshots never carry the display hint.
    const snapshotHasNoRevision: 'streamRevision' extends keyof AgentDelegationSnapshot
      ? false
      : true = true;
    expect(snapshotHasNoRevision).toBe(true);
  });

  it('rejects a revision that is not a safe nonnegative integer', () => {
    for (const streamRevision of [
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '3',
      null,
    ]) {
      expect(isAgentDelegationCardData({ ...card, streamRevision })).toBe(
        false,
      );
    }
  });
});

function transcriptWithSnapshot(
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  return {
    delegationId: 'child-a',
    runGeneration: 1,
    sequence: 0,
    parentHarnessId: 'claude',
    parentTurnId: 'turn-a',
    parentToolCallId: 'call-a',
    createdAt: 1,
    task: {
      description: 'Review',
      prompt: 'Inspect the change.',
      executionMode: 'background',
    },
    snapshot: {
      delegationId: 'child-a',
      status: 'pending',
      requestedModelId: 'review-model',
      outputTruncated: false,
      ...snapshot,
    },
    transcript: [],
  };
}

describe('managed delegation input boundary', () => {
  const input = {
    modelId: 'logical-review-model',
    description: 'Review cancellation ownership',
    prompt: 'Inspect the runtime tests and report cancellation gaps.',
  };

  it('defaults to a fresh, background, read-only worktree consultation', () => {
    expect(parseAgentDelegationSpawnRequest(input)).toEqual({
      ok: true,
      value: {
        ...input,
        executionMode: 'background',
        contextPolicy: 'task_only',
        isolation: 'shared_worktree',
      },
    });
  });

  it.each([
    'harnessId',
    'runtimeModelId',
    'projectId',
    'worktreeId',
    'chatId',
    'cwd',
    'executable',
    'authAccountKey',
    'billingAuthority',
    'permission',
    'deadlineMs',
    'toolCallId',
    'runtimeGeneration',
  ])(
    'rejects model-supplied %s instead of silently stripping authority',
    (key) => {
      expect(
        parseAgentDelegationSpawnRequest({ ...input, [key]: 'override' }),
      ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    },
  );

  it('preserves explicit low effort without applying a UI-level clamp', () => {
    expect(
      parseAgentDelegationSpawnRequest({
        ...input,
        thinkingLevel: 'low',
        executionMode: 'foreground',
      }),
    ).toMatchObject({
      ok: true,
      value: { thinkingLevel: 'low', executionMode: 'foreground' },
    });
  });

  it('normalizes directory grants with trailing separators on spawn and follow-up', () => {
    const permissions = { writePaths: ['src/', '.mini-swarm/slice-a/'] };
    const normalized = { writePaths: ['src', '.mini-swarm/slice-a'] };
    expect(
      parseAgentDelegationSpawnRequest({ ...input, permissions }),
    ).toMatchObject({
      ok: true,
      value: { permissions: normalized },
    });
    expect(
      parseMessageDelegateRequest({
        delegationId: 'child-a',
        operation: 'follow_up',
        message: 'Continue within these grants.',
        permissions,
      }),
    ).toMatchObject({ ok: true, value: { permissions: normalized } });
  });

  it.each([
    '../src/',
    '/src/',
    'src//nested/',
    './',
    './/',
    'src/../nested/',
    'src\\nested/',
    '/',
  ])('rejects unsafe grant %s with an actionable field error', (grant) => {
    const permissions = { writePaths: ['safe', grant] };
    const fieldMatcher: unknown = expect.stringContaining(
      'permissions.writePaths[1]',
    );
    const expected = {
      ok: false,
      error: {
        code: 'invalid_request',
        message: fieldMatcher,
      },
    };
    expect(
      parseAgentDelegationSpawnRequest({ ...input, permissions }),
    ).toMatchObject(expected);
    expect(
      parseMessageDelegateRequest({
        delegationId: 'child-a',
        operation: 'follow_up',
        message: 'Continue',
        permissions,
      }),
    ).toMatchObject(expected);
  });

  it('explains the grant count limit', () => {
    const countMatcher: unknown = expect.stringContaining('at most 64');
    expect(
      parseAgentDelegationSpawnRequest({
        ...input,
        permissions: { writePaths: Array(65).fill('src') },
      }),
    ).toMatchObject({
      ok: false,
      error: { message: countMatcher },
    });
  });

  it.each(['auto', 'default', 'unlimited'])(
    'rejects unknown effort %s',
    (thinkingLevel) => {
      expect(
        parseAgentDelegationSpawnRequest({ ...input, thinkingLevel }),
      ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    },
  );

  it.each([
    { contextPolicy: 'native_fork' },
    { contextPolicy: 'normalized_history' },
    { isolation: 'isolated_worktree' },
    { isolation: 'remote' },
  ])('rejects reserved execution controls: %j', (control) => {
    expect(
      parseAgentDelegationSpawnRequest({ ...input, ...control }),
    ).toMatchObject({ ok: false, error: { code: 'capability_unavailable' } });
  });

  it.each([
    null,
    [],
    { ...input, modelId: '' },
    { ...input, modelId: 'x'.repeat(257) },
    { ...input, modelId: 'model\nother' },
    { ...input, description: ' ' },
    { ...input, description: 'x'.repeat(201) },
    { ...input, prompt: '' },
    { ...input, prompt: 'x'.repeat(32_769) },
    { ...input, executionMode: 'detached' },
    { ...input, executionMode: null },
    { ...input, name: 5 },
  ])('rejects malformed or oversized spawn input', (value) => {
    expect(parseAgentDelegationSpawnRequest(value)).toMatchObject({
      ok: false,
    });
  });

  it('separates worktree mutation from delegate messaging and rejects resume', () => {
    expect(
      parseManageDelegateWorktreeRequest({
        delegationId: 'child-a',
        operation: 'apply',
      }),
    ).toMatchObject({ ok: true });
    expect(
      parseMessageDelegateRequest({
        delegationId: 'child-a',
        operation: 'follow_up',
        message: 'Continue with the focused review.',
        permissions: { writePaths: ['src'] },
      }),
    ).toMatchObject({ ok: true });
    expect(
      parseMessageDelegateRequest({
        delegationId: 'child-a',
        operation: 'steer',
        message: 'Check the cancellation race first.',
        if_busy: 'reject',
      }),
    ).toMatchObject({
      ok: true,
      value: { operation: 'steer', ifBusy: 'reject' },
    });
    expect(
      parseMessageDelegateRequest({
        delegationId: 'child-a',
        operation: 'follow_up',
        message: 'Continue with the focused review.',
        if_busy: 'queue',
      }),
    ).toMatchObject({
      ok: true,
      value: { operation: 'follow_up', ifBusy: 'queue' },
    });
    expect(
      parseMessageDelegateRequest({
        delegationId: 'child-a',
        operation: 'interrupt',
      }),
    ).toMatchObject({ ok: true });

    for (const invalid of [
      { delegationId: 'child-a', operation: 'resume', message: 'Continue' },
      { delegationId: 'child-a', operation: 'apply' },
      {
        delegationId: 'child-a',
        operation: 'steer',
        message: 'Do this',
        permissions: { writePaths: ['src'] },
      },
      { delegationId: 'child-a', operation: 'follow_up', message: '  ' },
      { delegationId: 'child-a', operation: 'interrupt', message: 'stop' },
      { delegationId: 'child-a', operation: 'interrupt', if_busy: 'queue' },
      {
        delegationId: 'child-a',
        operation: 'follow_up',
        message: 'Continue',
        if_busy: 'later',
      },
      {
        delegationId: 'child-a',
        operation: 'steer',
        message: 'Continue',
        if_busy: false,
      },
    ])
      expect(parseMessageDelegateRequest(invalid)).toMatchObject({
        ok: false,
        error: { code: 'invalid_request' },
      });
  });

  it('accepts its own normalized Message Delegate request, so a second parse keeps if_busy', () => {
    for (const request of [
      {
        delegationId: 'child-a',
        operation: 'steer',
        message: 'Check the cancellation race first.',
        if_busy: 'reject',
      },
      {
        delegationId: 'child-a',
        operation: 'follow_up',
        message: 'Continue with the focused review.',
        permissions: { writePaths: ['src'] },
        if_busy: 'queue',
      },
    ]) {
      const first = parseMessageDelegateRequest(request);
      if (!first.ok) throw new Error('Expected the tool input to parse');
      expect(parseMessageDelegateRequest(first.value)).toEqual(first);
    }
    // Both spellings at once are ambiguous.
    expect(
      parseMessageDelegateRequest({
        delegationId: 'child-a',
        operation: 'steer',
        message: 'Continue',
        if_busy: 'queue',
        ifBusy: 'reject',
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });

  it('parses explicit latest/historical output reads and child steering requests', () => {
    expect(parseGetDelegateOutputRequest({ delegationId: 'child-a' })).toEqual({
      ok: true,
      value: { delegationId: 'child-a' },
    });
    expect(
      parseGetDelegateOutputRequest({
        delegationId: 'child-a',
        resultIndex: 2,
      }),
    ).toEqual({
      ok: true,
      value: { delegationId: 'child-a', resultIndex: 2 },
    });
    for (const resultIndex of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(
        parseGetDelegateOutputRequest({
          delegationId: 'child-a',
          resultIndex,
        }),
      ).toMatchObject({ ok: false });

    expect(
      parseRequestSteeringRequest({ message: 'Please clarify the priority.' }),
    ).toEqual({
      ok: true,
      value: { message: 'Please clarify the priority.' },
    });
    expect(parseRequestSteeringRequest({ message: '\0' })).toMatchObject({
      ok: false,
    });
  });

  it('accepts optional capability grants and queue admission with strict bounds', () => {
    expect(
      parseAgentDelegationSpawnRequest({
        ...input,
        inheritCapabilities: false,
        capabilities: [capabilityId],
        allowCapabilityDiscovery: true,
        ifBusy: 'reject',
      }),
    ).toMatchObject({
      ok: true,
      value: {
        inheritCapabilities: false,
        capabilities: [capabilityId],
        allowCapabilityDiscovery: true,
        ifBusy: 'reject',
      },
    });
    const emptyCapabilities = parseAgentDelegationSpawnRequest({
      ...input,
      capabilities: [],
    });
    expect(emptyCapabilities).toMatchObject({ ok: true });
    expect(emptyCapabilities.ok && emptyCapabilities.value).not.toHaveProperty(
      'capabilities',
    );
    expect(
      parseAgentDelegationSpawnRequest({
        ...input,
        capabilities: ['not-an-id'],
      }).ok,
    ).toBe(false);
    expect(
      parseAgentDelegationSpawnRequest({
        ...input,
        capabilities: [`deferred:v1:${'a'.repeat(64)}`],
      }).ok,
    ).toBe(false);
    expect(
      parseAgentDelegationSpawnRequest({
        ...input,
        capabilities: [`${capabilityId}\n`],
      }).ok,
    ).toBe(false);
    expect(
      parseAgentDelegationSpawnRequest({
        ...input,
        capabilities: [capabilityId, capabilityId],
      }).ok,
    ).toBe(false);
    expect(
      parseAgentDelegationSpawnRequest({
        ...input,
        capabilities: Array.from(
          { length: 65 },
          (_, index) => `deferred:v1:${index.toString(36).padStart(43, '0')}`,
        ),
      }).ok,
    ).toBe(false);
    for (const field of ['inheritCapabilities', 'allowCapabilityDiscovery'])
      expect(
        parseAgentDelegationSpawnRequest({ ...input, [field]: 'true' }).ok,
      ).toBe(false);
    expect(
      parseAgentDelegationSpawnRequest({ ...input, ifBusy: 'wait' }).ok,
    ).toBe(false);
  });

  it('keeps new optional spawn keys absent when omitted', () => {
    const parsed = parseAgentDelegationSpawnRequest(input);
    expect(parsed).toEqual({
      ok: true,
      value: {
        ...input,
        executionMode: 'background',
        contextPolicy: 'task_only',
        isolation: 'shared_worktree',
      },
    });
    if (parsed.ok) {
      expect(parsed.value).not.toHaveProperty('inheritCapabilities');
      expect(parsed.value).not.toHaveProperty('capabilities');
      expect(parsed.value).not.toHaveProperty('allowCapabilityDiscovery');
      expect(parsed.value).not.toHaveProperty('ifBusy');
    }
  });

  it('validates capability summaries and queue values directly', () => {
    const summary = {
      inherit: true,
      discovery: false,
      items: [{ kind: 'plugin', name: 'Formatter', source: 'inherited' }],
      skipped: [{ kind: 'mcp', name: 'Local DB', reason: 'unavailable_asset' }],
    };
    expect(isDelegationCapabilitySummary(summary)).toBe(true);
    expect(
      isDelegationCapabilitySummary({ ...summary, futureField: true }),
    ).toBe(true);
    expect(
      isDelegationCapabilitySummary({
        ...summary,
        items: [{ kind: 'plugin', name: 'Formatter', source: 'unknown' }],
      }),
    ).toBe(false);
    expect(
      isDelegationCapabilitySummary({
        ...summary,
        skipped: [{ kind: 'mcp', name: 'Local DB', reason: 'unknown' }],
      }),
    ).toBe(false);
    expect(
      isDelegationCapabilitySummary({
        ...summary,
        items: Array.from({ length: 129 }, () => summary.items[0]),
      }),
    ).toBe(false);

    expect(isAgentDelegationPhase('queued')).toBe(true);
    expect(isAgentDelegationPhase('waiting')).toBe(false);
    expect(
      isAgentDelegationQueueState({
        id: 'default',
        name: 'Default',
        position: 1,
        waitingFor: 'queue',
        running: 2,
        waiting: 3,
        limit: 4,
        futureField: true,
      }),
    ).toBe(true);
    expect(
      isAgentDelegationQueueState({ id: 'default', name: 'D'.repeat(65) }),
    ).toBe(false);
    expect(
      isAgentDelegationQueueState({ id: 'default\n', name: 'Default' }),
    ).toBe(false);
    expect(
      isAgentDelegationQueueState({
        id: 'default',
        name: 'Default',
        position: 0,
      }),
    ).toBe(false);
  });

  it('validates optional capability and queue snapshot fields without breaking old records', () => {
    const oldSnapshot = {
      delegationId: 'child-a',
      status: 'pending',
      requestedModelId: 'review-model',
      outputTruncated: false,
    };
    expect(
      isAgentDelegationTranscript(transcriptWithSnapshot(oldSnapshot)),
    ).toBe(true);
    // Earlier versions retained full file text; those snapshots still load.
    expect(
      isAgentDelegationTranscript(
        transcriptWithSnapshot({
          ...oldSnapshot,
          fileChanges: [
            {
              id: 'change-1',
              path: 'first.txt',
              before: 'x'.repeat(65_536),
              after: null,
              status: 'applied',
            },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      isAgentDelegationTranscript(
        transcriptWithSnapshot({
          ...oldSnapshot,
          capabilities: {
            inherit: true,
            discovery: false,
            items: [{ kind: 'plugin', name: 'Formatter', source: 'agent' }],
            skipped: [],
          },
          phase: 'queued',
          queue: { id: 'default', name: 'Default', position: 1 },
        }),
      ),
    ).toBe(true);

    for (const nestedDelegation of ['enabled', 'not_enabled', 'depth_limit'])
      expect(
        isAgentDelegationTranscript(
          transcriptWithSnapshot({ ...oldSnapshot, nestedDelegation }),
        ),
      ).toBe(true);

    const invalidSnapshots = [
      { nestedDelegation: 'unlimited' },
      {
        capabilities: {
          inherit: true,
          discovery: false,
          items: [{ kind: 'plugin', name: 'Formatter', source: 'future' }],
          skipped: [],
        },
      },
      {
        capabilities: {
          inherit: true,
          discovery: false,
          items: [],
          skipped: [{ kind: 'mcp', name: 'Local DB', reason: 'future' }],
        },
      },
      {
        capabilities: {
          inherit: true,
          discovery: false,
          items: Array.from({ length: 129 }, () => ({
            kind: 'plugin',
            name: 'Formatter',
            source: 'agent',
          })),
          skipped: [],
        },
      },
      { phase: 'waiting' },
      { queue: { id: 'default', name: 'D'.repeat(65) } },
    ];
    for (const invalidSnapshot of invalidSnapshots)
      expect(
        isAgentDelegationTranscript(
          transcriptWithSnapshot({ ...oldSnapshot, ...invalidSnapshot }),
        ),
      ).toBe(false);
  });

  it('caps managed concurrent delegations at 64 and defaults invalid settings', () => {
    expect(MAX_MANAGED_DELEGATION_CONCURRENCY).toBe(64);
    expect(normalizeManagedDelegationMaxConcurrent(64)).toBe(64);
    expect(normalizeManagedDelegationMaxConcurrent(65)).toBe(
      DEFAULT_MANAGED_DELEGATION_MAX_CONCURRENT,
    );
  });
});

describe('compatibility transcript item truncation flag', () => {
  const item = {
    id: 'row',
    sequence: 1,
    occurredAt: 2,
    type: 'text',
    text: 'hi',
  };

  it('accepts legacy items without the flag and projections marked truncated', () => {
    expect(isAgentDelegationTranscriptItem(item)).toBe(true);
    expect(isAgentDelegationTranscriptItem({ ...item, truncated: true })).toBe(
      true,
    );
  });

  it.each([false, 'yes', 1, null])('rejects truncated: %p', (truncated) => {
    expect(isAgentDelegationTranscriptItem({ ...item, truncated })).toBe(false);
  });
});

describe('Get Delegate Output byte-range parser (11c2)', () => {
  it.each([
    { delegationId: 'child', offset: 0 },
    { delegationId: 'child', limit: 4 },
    { delegationId: 'child', resultIndex: 1, offset: 4, limit: 65_536 },
  ])('accepts and retains a bounded range %j', (request) => {
    expect(parseGetDelegateOutputRequest(request)).toEqual({
      ok: true,
      value: request,
    });
  });
  it.each([
    { offset: -1 },
    { offset: 0.5 },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { offset: NaN },
    { offset: Infinity },
    { offset: '0' },
    { offset: null },
    { limit: 0 },
    { limit: 1 },
    { limit: 2 },
    { limit: 3 },
    { limit: 65_537 },
    { limit: 4.5 },
    { limit: NaN },
    { limit: '4' },
    { limit: null },
    { offset: 1 },
    { unknown: 0 },
  ])('rejects invalid or unpinned range %j', (fields) => {
    expect(
      parseGetDelegateOutputRequest({ delegationId: 'child', ...fields }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });
});
