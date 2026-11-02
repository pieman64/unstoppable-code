import {
  CardStateDraftSchema,
  CardStateV2Schema,
  CardStateV1Schema,
  TranscriptStreamDescriptorUpdateSchema,
} from '../core/chat/transcript';
import { CoreChatEventsItemSchema } from '../core/chat/events';

describe('12a E1 schema freeze', (): void => {
  const draftWith = <T extends object>(
    fields: T,
  ): T & { version: 2; status: 'running'; outputTruncated: false } => ({
    version: 2,
    status: 'running',
    outputTruncated: false,
    ...fields,
  });
  const v2With = <T extends object>(
    fields: T,
  ): T & { version: 2; cardRevision: 1 } => ({
    version: 2,
    cardRevision: 1,
    ...fields,
  });
  const encodedBytes = (value: unknown): number =>
    new TextEncoder().encode(JSON.stringify(value) ?? '').byteLength;
  const routeWith = (
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    selectedModelId: 'x',
    runtimeModelId: 'x',
    harnessId: 'x',
    runtimeKind: 'x',
    runnerRegistrationId: 'x',
    runtimeVersion: 'x',
    adapterVersion: 'x',
    modelSource: 'x',
    providerType: 'x',
    assignmentRevision: 'x',
    billingAuthority: 'x',
    aiCreditsRouted: false,
    capabilities: [],
    supportedThinkingLevels: [],
    capabilitySnapshotHash: 'x',
    capabilityGeneration: 1,
    policyRevision: 'x',
    ...overrides,
  });
  const routeAtEncodedBudget = (budget: number): Record<string, unknown> => {
    const base = routeWith();
    const addedBytes = budget - encodedBytes(base);
    const each = Math.floor(addedBytes / 13);
    const remainder = addedBytes % 13;
    const valueAt = (index: number): string =>
      'x'.repeat(1 + each + (index < remainder ? 1 : 0));
    return routeWith({
      selectedModelId: valueAt(0),
      runtimeModelId: valueAt(1),
      harnessId: valueAt(2),
      runtimeKind: valueAt(3),
      runnerRegistrationId: valueAt(4),
      runtimeVersion: valueAt(5),
      adapterVersion: valueAt(6),
      modelSource: valueAt(7),
      providerType: valueAt(8),
      assignmentRevision: valueAt(9),
      billingAuthority: valueAt(10),
      capabilitySnapshotHash: valueAt(11),
      policyRevision: valueAt(12),
    });
  };
  const capabilitiesWith = (
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    inherit: false,
    discovery: false,
    items: [],
    skipped: [],
    ...overrides,
  });
  const capabilitySummaryAtEncodedBudget = (
    budget: number,
  ): Record<string, unknown> => {
    const baseItems = Array.from({ length: 17 }, () => ({
      kind: 'skill',
      name: 'x',
      source: 'agent',
    }));
    const base = capabilitiesWith({ items: baseItems });
    const addedBytes = budget - encodedBytes(base);
    const each = Math.floor(addedBytes / baseItems.length);
    const remainder = addedBytes % baseItems.length;
    return capabilitiesWith({
      items: Array.from({ length: baseItems.length }, (_, index) => ({
        kind: 'skill',
        name: 'x'.repeat(1 + each + (index < remainder ? 1 : 0)),
        source: 'agent',
      })),
    });
  };
  const stoppedByAtEncodedBudget = (
    budget: number,
  ): Record<string, unknown> => {
    const base = {
      kind: 'agent',
      depth: 1,
      delegationId: 'x',
      description: 'x',
    };
    const addedBytes = budget - encodedBytes(base);
    const each = Math.floor(addedBytes / 2);
    const remainder = addedBytes % 2;
    return {
      kind: 'agent',
      depth: 1,
      delegationId: 'x'.repeat(1 + each + (remainder > 0 ? 1 : 0)),
      description: 'x'.repeat(1 + each),
    };
  };
  const errorAtEncodedBudget = (budget: number): Record<string, unknown> => {
    const base = {
      code: 'runtime_error',
      message: '',
      retryable: false,
      apply: { reason: 'conflict', issues: [], guidance: '' },
    };
    const addedBytes = budget - encodedBytes(base);
    const messageLength = Math.floor(addedBytes / 2);
    const guidanceLength = addedBytes - messageLength;
    return {
      code: 'runtime_error',
      message: 'x'.repeat(messageLength),
      retryable: false,
      apply: {
        reason: 'conflict',
        issues: [],
        guidance: 'x'.repeat(guidanceLength),
      },
    };
  };
  const parseDraft = (value: unknown): boolean =>
    CardStateDraftSchema.safeParse(value).success;
  const parseV2 = (value: unknown): boolean =>
    CardStateV2Schema.safeParse(value).success;
  const assertFieldBoundary = (
    field: string,
    make: (value: string) => unknown,
    atCap: string,
    overCap: string,
    parse: (value: unknown) => boolean = parseDraft,
  ): void => {
    expect({ field, success: parse(make(atCap)) }).toEqual({
      field,
      success: true,
    });
    expect({ field, success: parse(make(overCap)) }).toEqual({
      field,
      success: false,
    });
  };

  it('E7 transports the exact portable card-state event member', () => {
    const event = {
      schemaVersion: 1,
      eventId: 'event',
      occurredAt: '2026-10-19T00:00:00Z',
      projectId: 'project',
      worktreeId: 'worktree',
      baseRevision: 1,
      revision: 2,
      changes: [
        {
          type: 'delegation.card_state_updated',
          chatId: 'chat',
          delegationId: 'd',
          runGeneration: 1,
          cardRevision: 1,
          streamRevision: 2,
          cardState: {
            version: 2,
            cardRevision: 1,
            status: 'running',
            outputTruncated: false,
          },
        },
      ],
    };
    expect(CoreChatEventsItemSchema.parse(event)).toEqual(event);
  });
  it('accepts strict reference-free draft and canonical V2', () => {
    expect(
      CardStateDraftSchema.safeParse({
        version: 2,
        status: 'pending',
        outputTruncated: false,
        prompt: '\u0000'.repeat(32768),
      }).success,
    ).toBe(true);
    expect(
      CardStateV2Schema.safeParse({
        version: 2,
        cardRevision: 1,
        canonical: { status: 'completed', resultIndex: 1, finalText: '' },
      }).success,
    ).toBe(true);
    expect(
      CardStateDraftSchema.safeParse({
        version: 2,
        canonical: { status: 'completed' },
      }).success,
    ).toBe(false);
    expect(
      CardStateDraftSchema.safeParse({ version: 2, status: 'completed' })
        .success,
    ).toBe(false);
    // Amendment 3: drafts are whole, and a stored V2 draft is whole too.
    expect(
      CardStateDraftSchema.safeParse({ version: 2, status: 'running' }).success,
    ).toBe(false);
    expect(
      CardStateV2Schema.safeParse({
        version: 2,
        cardRevision: 1,
        nativeSessionId: 'native',
      }).success,
    ).toBe(false);
  });

  it('rejects escaped strings beyond encoded cap, unknown usage, invalid answer unions', () => {
    expect(
      CardStateDraftSchema.safeParse({
        version: 2,
        control: {
          operationId: 'op',
          operation: 'apply',
          status: 'failed',
          error: '\u0000'.repeat(683),
        },
      }).success,
    ).toBe(false);
    expect(
      CardStateDraftSchema.safeParse({ version: 2, prompt: 'x'.repeat(32769) })
        .success,
    ).toBe(false);
    expect(
      CardStateV2Schema.safeParse({
        version: 2,
        cardRevision: 1,
        canonical: {
          status: 'completed',
          resultIndex: 1,
          usage: { unexpected: 1 },
        },
      }).success,
    ).toBe(false);
    expect(
      CardStateV2Schema.safeParse({
        version: 2,
        cardRevision: 1,
        canonical: {
          status: 'completed',
          resultIndex: 1,
          finalText: '',
          partialText: '',
        },
      }).success,
    ).toBe(false);
    expect(
      CardStateV2Schema.safeParse({
        version: 2,
        cardRevision: 1,
        canonical: {
          status: 'completed',
          resultIndex: 1,
          finalText: '',
          answerUnavailable: true,
        },
      }).success,
    ).toBe(false);
  });

  it('accepts maximum escaped preview and rejects an over-limit collection', () => {
    expect(
      CardStateV2Schema.safeParse({
        version: 2,
        cardRevision: 9007199254740991,
        canonical: {
          status: 'completed',
          resultIndex: 9007199254740991,
          finalText: '\u0000'.repeat(8192),
        },
      }).success,
    ).toBe(true);
    expect(
      CardStateDraftSchema.safeParse({
        version: 2,
        childDelegationIds: Array.from({ length: 64 }, () => 'x'.repeat(1022)),
      }).success,
    ).toBe(false);
    // A top-level answer would fail strictness alone; over-cap answers must fail
    // inside the canonical subtree, where answers belong.
    expect(
      CardStateV2Schema.safeParse({
        version: 2,
        cardRevision: 1,
        canonical: {
          status: 'completed',
          resultIndex: 1,
          finalText: 'x'.repeat(8193),
        },
      }).success,
    ).toBe(false);
  });

  it('enforces escaped value boundaries for each bounded string field', () => {
    const idAtCap = '"'.repeat(511);
    const idOverCap = '"'.repeat(512);
    const messageAtCap = '"'.repeat(2047);
    const messageOverCap = '"'.repeat(2048);
    const routeIdFields = [
      'selectedModelId',
      'runtimeModelId',
      'harnessId',
      'runtimeKind',
      'runnerRegistrationId',
      'runtimeVersion',
      'adapterVersion',
      'modelSource',
      'providerType',
      'assignmentRevision',
      'billingAuthority',
      'capabilitySnapshotHash',
      'policyRevision',
      'routeId',
    ];

    for (const field of routeIdFields) {
      assertFieldBoundary(
        `routeSnapshot.${field}`,
        (value) => draftWith({ routeSnapshot: routeWith({ [field]: value }) }),
        idAtCap,
        idOverCap,
      );
    }
    for (const field of [
      'agentDefinitionId',
      'agentDefinitionRevision',
      'agentDefinitionHash',
      'pluginProjectionHash',
    ]) {
      assertFieldBoundary(
        `routeSnapshot.agentOverlay.${field}`,
        (value) =>
          draftWith({
            routeSnapshot: routeWith({
              agentOverlay: {
                agentDefinitionId: 'agent',
                agentDefinitionRevision: '1',
                agentDefinitionHash: 'hash',
                pluginProjectionHash: 'hash',
                [field]: value,
              },
            }),
          }),
        idAtCap,
        idOverCap,
      );
    }

    for (const field of ['requestedModelId', 'nativeSessionId']) {
      assertFieldBoundary(
        field,
        (value) => draftWith({ [field]: value }),
        idAtCap,
        idOverCap,
      );
    }
    assertFieldBoundary(
      'isolatedWorkspace.revision',
      (value) =>
        draftWith({
          isolatedWorkspace: {
            revision: value,
            dirtyParentChangesIncluded: false,
          },
        }),
      idAtCap,
      idOverCap,
    );
    assertFieldBoundary(
      'control.operationId',
      (value) =>
        draftWith({
          control: { operationId: value, operation: 'apply', status: 'failed' },
        }),
      idAtCap,
      idOverCap,
    );
    for (const field of ['attemptId', 'providerTurnId']) {
      assertFieldBoundary(
        `control.steeringDelivery.${field}`,
        (value) =>
          draftWith({
            control: {
              operationId: 'op',
              operation: 'steer',
              status: 'completed',
              steeringDelivery: {
                kind: 'accepted',
                attemptId: 'attempt',
                providerTurnId: 'turn',
                [field]: value,
              },
            },
          }),
        idAtCap,
        idOverCap,
      );
    }
    assertFieldBoundary(
      'control.applyFailure.issues[].path',
      (value) =>
        draftWith({
          control: {
            operationId: 'op',
            operation: 'apply',
            status: 'failed',
            applyFailure: {
              reason: 'conflict',
              issues: [{ path: value, reason: 'parent_changed' }],
              guidance: 'g',
            },
          },
        }),
      idAtCap,
      idOverCap,
    );
    assertFieldBoundary(
      'stoppedBy.delegationId',
      (value) =>
        draftWith({
          stoppedBy: { kind: 'agent', depth: 1, delegationId: value },
        }),
      idAtCap,
      idOverCap,
    );
    assertFieldBoundary(
      'canonical.finalTextRef.artifactId',
      (value) =>
        v2With({
          canonical: {
            status: 'completed',
            resultIndex: 1,
            finalText: 'body',
            finalTextRef: {
              version: 1,
              artifactId: value,
              byteLength: 1,
              sha256: 'a'.repeat(64),
              encoding: 'utf-8',
              mediaType: 'text/plain',
            },
          },
        }),
      idAtCap,
      idOverCap,
      parseV2,
    );

    for (const field of ['selectedModelLabel', 'runtimeModelLabel']) {
      assertFieldBoundary(
        `routeSnapshot.${field}`,
        (value) => draftWith({ routeSnapshot: routeWith({ [field]: value }) }),
        idAtCap,
        idOverCap,
      );
    }
    assertFieldBoundary(
      'routeSnapshot.capabilities[]',
      (value) =>
        draftWith({ routeSnapshot: routeWith({ capabilities: [value] }) }),
      idAtCap,
      idOverCap,
    );
    assertFieldBoundary(
      'capabilities.items[].name',
      (value) =>
        draftWith({
          capabilities: capabilitiesWith({
            items: [{ kind: 'skill', name: value, source: 'agent' }],
          }),
        }),
      idAtCap,
      idOverCap,
    );
    assertFieldBoundary(
      'capabilities.skipped[].name',
      (value) =>
        draftWith({
          capabilities: capabilitiesWith({
            skipped: [
              { kind: 'skill', name: value, reason: 'missing_selection' },
            ],
          }),
        }),
      idAtCap,
      idOverCap,
    );
    assertFieldBoundary(
      'stoppedBy.description',
      (value) =>
        draftWith({
          stoppedBy: { kind: 'agent', depth: 1, description: value },
        }),
      idAtCap,
      idOverCap,
    );

    assertFieldBoundary(
      'control.error',
      (value) =>
        draftWith({
          control: {
            operationId: 'op',
            operation: 'apply',
            status: 'failed',
            error: value,
          },
        }),
      messageAtCap,
      messageOverCap,
    );
    assertFieldBoundary(
      'control.steeringDelivery.reason',
      (value) =>
        draftWith({
          control: {
            operationId: 'op',
            operation: 'steer',
            status: 'failed',
            steeringDelivery: {
              kind: 'rejected',
              attemptId: 'a',
              reason: value,
            },
          },
        }),
      messageAtCap,
      messageOverCap,
    );
    assertFieldBoundary(
      'control.applyFailure.guidance',
      (value) =>
        draftWith({
          control: {
            operationId: 'op',
            operation: 'apply',
            status: 'failed',
            applyFailure: { reason: 'conflict', issues: [], guidance: value },
          },
        }),
      messageAtCap,
      messageOverCap,
    );
    assertFieldBoundary(
      'control.applyFailure.issues[].parentDiff',
      (value) =>
        draftWith({
          control: {
            operationId: 'op',
            operation: 'apply',
            status: 'failed',
            applyFailure: {
              reason: 'conflict',
              issues: [
                { path: 'file', reason: 'parent_changed', parentDiff: value },
              ],
              guidance: 'g',
            },
          },
        }),
      messageAtCap,
      messageOverCap,
    );
    assertFieldBoundary(
      'canonical.error.message',
      (value) =>
        v2With({
          canonical: {
            status: 'failed',
            resultIndex: 1,
            error: {
              code: 'runtime_error',
              message: value,
              retryable: false,
            },
          },
        }),
      messageAtCap,
      messageOverCap,
      parseV2,
    );

    assertFieldBoundary(
      'prompt',
      (value) => draftWith({ prompt: value }),
      '\u0000'.repeat(32768),
      '\u0000'.repeat(32769),
    );
    for (const field of ['finalText', 'partialText']) {
      assertFieldBoundary(
        `canonical.${field}`,
        (value) =>
          v2With({
            canonical: { status: 'completed', resultIndex: 1, [field]: value },
          }),
        '\u0000'.repeat(8192),
        '\u0000'.repeat(8193),
        parseV2,
      );
    }
  });

  it('enforces collection counts and exact encoded subtree budgets', () => {
    const routeAtCap = routeAtEncodedBudget(12_000);
    const routeOverCap = routeAtEncodedBudget(12_001);
    expect(encodedBytes(routeAtCap)).toBe(12_000);
    expect(parseDraft(draftWith({ routeSnapshot: routeAtCap }))).toBe(true);
    const routeOverflow = CardStateDraftSchema.safeParse(
      draftWith({ routeSnapshot: routeOverCap }),
    );
    expect(routeOverflow.success).toBe(false);
    if (!routeOverflow.success) {
      expect(
        routeOverflow.error.issues.some(
          (issue) => issue.path.join('.') === 'routeSnapshot',
        ),
      ).toBe(true);
    }

    const childIdsAtCap = [
      'x'.repeat(1022),
      'x'.repeat(1022),
      'x'.repeat(1022),
      'x'.repeat(1022),
      'x'.repeat(1022),
      'x'.repeat(871),
    ];
    const childIdsOverCap = [...childIdsAtCap.slice(0, 5), 'x'.repeat(872)];
    expect(encodedBytes(childIdsAtCap)).toBe(6_000);
    expect(parseDraft(draftWith({ childDelegationIds: childIdsAtCap }))).toBe(
      true,
    );
    const childBytesOverflow = CardStateDraftSchema.safeParse(
      draftWith({ childDelegationIds: childIdsOverCap }),
    );
    expect(childBytesOverflow.success).toBe(false);
    if (!childBytesOverflow.success) {
      expect(
        childBytesOverflow.error.issues.some(
          (issue) => issue.path.join('.') === 'childDelegationIds',
        ),
      ).toBe(true);
    }
    expect(
      parseDraft({
        ...draftWith({
          childDelegationIds: Array.from({ length: 64 }, () => 'x'),
        }),
      }),
    ).toBe(true);
    expect(
      parseDraft({
        ...draftWith({
          childDelegationIds: Array.from({ length: 65 }, () => 'x'),
        }),
      }),
    ).toBe(false);

    expect(
      parseDraft(
        draftWith({
          routeSnapshot: routeWith({
            capabilities: Array.from({ length: 64 }, () => 'x'),
          }),
        }),
      ),
    ).toBe(true);
    expect(
      parseDraft(
        draftWith({
          routeSnapshot: routeWith({
            capabilities: Array.from({ length: 65 }, () => 'x'),
          }),
        }),
      ),
    ).toBe(false);
    expect(
      parseDraft(
        draftWith({
          routeSnapshot: routeWith({
            supportedThinkingLevels: Array.from({ length: 16 }, () => 'off'),
          }),
        }),
      ),
    ).toBe(true);
    expect(
      parseDraft(
        draftWith({
          routeSnapshot: routeWith({
            supportedThinkingLevels: Array.from({ length: 17 }, () => 'off'),
          }),
        }),
      ),
    ).toBe(false);
    expect(
      parseDraft(
        draftWith({
          capabilities: capabilitiesWith({
            items: Array.from({ length: 128 }, () => ({
              kind: 'skill',
              name: 'x',
              source: 'agent',
            })),
          }),
        }),
      ),
    ).toBe(true);
    expect(
      parseDraft(
        draftWith({
          capabilities: capabilitiesWith({
            items: Array.from({ length: 129 }, () => ({
              kind: 'skill',
              name: 'x',
              source: 'agent',
            })),
          }),
        }),
      ),
    ).toBe(false);
    expect(
      parseDraft(
        draftWith({
          capabilities: capabilitiesWith({
            skipped: Array.from({ length: 64 }, () => ({
              kind: 'skill',
              name: 'x',
              reason: 'missing_selection',
            })),
          }),
        }),
      ),
    ).toBe(true);
    expect(
      parseDraft(
        draftWith({
          capabilities: capabilitiesWith({
            skipped: Array.from({ length: 65 }, () => ({
              kind: 'skill',
              name: 'x',
              reason: 'missing_selection',
            })),
          }),
        }),
      ),
    ).toBe(false);
    expect(
      parseDraft(
        draftWith({
          control: {
            operationId: 'op',
            operation: 'apply',
            status: 'failed',
            applyFailure: {
              reason: 'conflict',
              issues: Array.from({ length: 64 }, () => ({
                path: 'x',
                reason: 'parent_changed',
              })),
              guidance: 'g',
            },
          },
        }),
      ),
    ).toBe(true);
    expect(
      parseDraft(
        draftWith({
          control: {
            operationId: 'op',
            operation: 'apply',
            status: 'failed',
            applyFailure: {
              reason: 'conflict',
              issues: Array.from({ length: 65 }, () => ({
                path: 'x',
                reason: 'parent_changed',
              })),
              guidance: 'g',
            },
          },
        }),
      ),
    ).toBe(false);

    const applyFailureAtCap = {
      reason: 'conflict',
      issues: [
        ...Array.from({ length: 13 }, () => ({
          path: 'x'.repeat(1022),
          reason: 'parent_changed',
        })),
        { path: 'x'.repeat(135), reason: 'parent_changed' },
      ],
      guidance: 'g',
    };
    const applyFailureOverCap = {
      ...applyFailureAtCap,
      issues: [
        ...applyFailureAtCap.issues.slice(0, 13),
        { path: 'x'.repeat(136), reason: 'parent_changed' },
      ],
    };
    expect(encodedBytes(applyFailureAtCap)).toBe(14_000);
    expect(
      parseDraft(
        draftWith({
          control: {
            operationId: 'op',
            operation: 'apply',
            status: 'failed',
            applyFailure: applyFailureAtCap,
          },
        }),
      ),
    ).toBe(true);
    const applyFailureOverflow = CardStateDraftSchema.safeParse(
      draftWith({
        control: {
          operationId: 'op',
          operation: 'apply',
          status: 'failed',
          applyFailure: applyFailureOverCap,
        },
      }),
    );
    expect(applyFailureOverflow.success).toBe(false);
    if (!applyFailureOverflow.success) {
      expect(
        applyFailureOverflow.error.issues.some(
          (issue) => issue.path.join('.') === 'control.applyFailure',
        ),
      ).toBe(true);
    }

    const capabilitiesAtCap = capabilitySummaryAtEncodedBudget(18_000);
    const capabilitiesOverCap = capabilitySummaryAtEncodedBudget(18_001);
    expect(encodedBytes(capabilitiesAtCap)).toBe(18_000);
    expect(parseDraft(draftWith({ capabilities: capabilitiesAtCap }))).toBe(
      true,
    );
    const capabilitiesOverflow = CardStateDraftSchema.safeParse(
      draftWith({ capabilities: capabilitiesOverCap }),
    );
    expect(capabilitiesOverflow.success).toBe(false);
    if (!capabilitiesOverflow.success) {
      expect(
        capabilitiesOverflow.error.issues.some(
          (issue) => issue.path.join('.') === 'capabilities',
        ),
      ).toBe(true);
    }

    const controlBase = {
      operationId: 'x'.repeat(1022),
      operation: 'apply',
      status: 'failed',
      error: '',
      applyFailure: applyFailureAtCap,
    };
    const controlAtBudget = (budget: number): Record<string, unknown> => ({
      ...controlBase,
      error: 'x'.repeat(budget - encodedBytes(controlBase)),
    });
    const controlAtCap = controlAtBudget(18_000);
    const controlOverCap = controlAtBudget(18_001);
    expect(encodedBytes(controlAtCap)).toBe(18_000);
    expect(parseDraft(draftWith({ control: controlAtCap }))).toBe(true);
    const controlOverflow = CardStateDraftSchema.safeParse(
      draftWith({ control: controlOverCap }),
    );
    expect(controlOverflow.success).toBe(false);
    if (!controlOverflow.success) {
      expect(
        controlOverflow.error.issues.some(
          (issue) => issue.path.join('.') === 'control',
        ),
      ).toBe(true);
    }

    const stoppedByAtCap = stoppedByAtEncodedBudget(2_048);
    const stoppedByOverCap = stoppedByAtEncodedBudget(2_049);
    expect(encodedBytes(stoppedByAtCap)).toBe(2_048);
    expect(parseDraft(draftWith({ stoppedBy: stoppedByAtCap }))).toBe(true);
    const stoppedByOverflow = CardStateDraftSchema.safeParse(
      draftWith({ stoppedBy: stoppedByOverCap }),
    );
    expect(stoppedByOverflow.success).toBe(false);
    if (!stoppedByOverflow.success) {
      expect(
        stoppedByOverflow.error.issues.some(
          (issue) => issue.path.join('.') === 'stoppedBy',
        ),
      ).toBe(true);
    }

    const errorAtCap = errorAtEncodedBudget(8_192);
    const errorOverCap = errorAtEncodedBudget(8_193);
    expect(encodedBytes(errorAtCap)).toBe(8_192);
    expect(
      parseV2(
        v2With({
          canonical: { status: 'failed', resultIndex: 1, error: errorAtCap },
        }),
      ),
    ).toBe(true);
    const errorOverflow = CardStateV2Schema.safeParse(
      v2With({
        canonical: { status: 'failed', resultIndex: 1, error: errorOverCap },
      }),
    );
    expect(errorOverflow.success).toBe(false);
    if (!errorOverflow.success) {
      expect(
        errorOverflow.error.issues.some(
          (issue) => issue.path.join('.') === 'canonical.error',
        ),
      ).toBe(true);
    }
  });

  it('keeps every nested object strict', () => {
    const validReference = {
      version: 1,
      artifactId: 'artifact',
      byteLength: 1,
      sha256: 'a'.repeat(64),
      encoding: 'utf-8',
      mediaType: 'text/plain',
    };
    const strictnessCases: Array<{
      field: string;
      value: unknown;
      parse: (value: unknown) => boolean;
    }> = [
      {
        field: 'draft',
        value: { ...draftWith({}), unexpected: true },
        parse: parseDraft,
      },
      {
        field: 'routeSnapshot',
        value: draftWith({
          routeSnapshot: { ...routeWith(), unexpected: true },
        }),
        parse: parseDraft,
      },
      {
        field: 'routeSnapshot.agentOverlay',
        value: draftWith({
          routeSnapshot: routeWith({
            agentOverlay: {
              agentDefinitionId: 'agent',
              agentDefinitionRevision: '1',
              agentDefinitionHash: 'hash',
              pluginProjectionHash: 'hash',
              unexpected: true,
            },
          }),
        }),
        parse: parseDraft,
      },
      {
        field: 'control',
        value: draftWith({
          control: {
            operationId: 'op',
            operation: 'apply',
            status: 'failed',
            unexpected: true,
          },
        }),
        parse: parseDraft,
      },
      {
        field: 'control.steeringDelivery',
        value: draftWith({
          control: {
            operationId: 'op',
            operation: 'steer',
            status: 'failed',
            steeringDelivery: {
              kind: 'rejected',
              attemptId: 'a',
              reason: 'not delivered',
              unexpected: true,
            },
          },
        }),
        parse: parseDraft,
      },
      {
        field: 'control.applyFailure',
        value: draftWith({
          control: {
            operationId: 'op',
            operation: 'apply',
            status: 'failed',
            applyFailure: {
              reason: 'conflict',
              issues: [],
              guidance: 'g',
              unexpected: true,
            },
          },
        }),
        parse: parseDraft,
      },
      {
        field: 'control.applyFailure.issues[]',
        value: draftWith({
          control: {
            operationId: 'op',
            operation: 'apply',
            status: 'failed',
            applyFailure: {
              reason: 'conflict',
              issues: [
                { path: 'file', reason: 'parent_changed', unexpected: true },
              ],
              guidance: 'g',
            },
          },
        }),
        parse: parseDraft,
      },
      {
        field: 'capabilities',
        value: draftWith({
          capabilities: { ...capabilitiesWith(), unexpected: true },
        }),
        parse: parseDraft,
      },
      {
        field: 'capabilities.items[]',
        value: draftWith({
          capabilities: capabilitiesWith({
            items: [
              {
                kind: 'skill',
                name: 'skill',
                source: 'agent',
                unexpected: true,
              },
            ],
          }),
        }),
        parse: parseDraft,
      },
      {
        field: 'capabilities.skipped[]',
        value: draftWith({
          capabilities: capabilitiesWith({
            skipped: [
              {
                kind: 'skill',
                name: 'skill',
                reason: 'missing_selection',
                unexpected: true,
              },
            ],
          }),
        }),
        parse: parseDraft,
      },
      {
        field: 'isolatedWorkspace',
        value: draftWith({
          isolatedWorkspace: {
            revision: 'r',
            dirtyParentChangesIncluded: false,
            unexpected: true,
          },
        }),
        parse: parseDraft,
      },
      {
        field: 'stoppedBy',
        value: draftWith({
          stoppedBy: { kind: 'agent', depth: 1, unexpected: true },
        }),
        parse: parseDraft,
      },
      {
        field: 'canonical',
        value: v2With({
          canonical: { status: 'completed', resultIndex: 1, unexpected: true },
        }),
        parse: parseV2,
      },
      {
        field: 'canonical.error',
        value: v2With({
          canonical: {
            status: 'failed',
            resultIndex: 1,
            error: {
              code: 'runtime_error',
              message: 'error',
              retryable: false,
              unexpected: true,
            },
          },
        }),
        parse: parseV2,
      },
      {
        field: 'canonical.error.apply',
        value: v2With({
          canonical: {
            status: 'failed',
            resultIndex: 1,
            error: {
              code: 'apply_failed',
              message: 'error',
              retryable: false,
              apply: {
                reason: 'conflict',
                issues: [],
                guidance: 'g',
                unexpected: true,
              },
            },
          },
        }),
        parse: parseV2,
      },
      {
        field: 'canonical.usage',
        value: v2With({
          canonical: {
            status: 'completed',
            resultIndex: 1,
            usage: { inputTokens: 1, unexpected: 1 },
          },
        }),
        parse: parseV2,
      },
      {
        field: 'canonical.finalTextRef',
        value: v2With({
          canonical: {
            status: 'completed',
            resultIndex: 1,
            finalText: 'body',
            finalTextRef: { ...validReference, unexpected: true },
          },
        }),
        parse: parseV2,
      },
    ];

    for (const testCase of strictnessCases) {
      expect({
        field: testCase.field,
        success: testCase.parse(testCase.value),
      }).toEqual({
        field: testCase.field,
        success: false,
      });
    }
  });

  it('covers canonical reference, answer-union, and numeric edges', () => {
    const reference = {
      version: 1,
      artifactId: 'artifact',
      byteLength: Number.MAX_SAFE_INTEGER,
      sha256: 'a'.repeat(64),
      encoding: 'utf-8',
      mediaType: 'text/plain',
    };
    const canonical = (
      fields: Record<string, unknown>,
    ): Record<string, unknown> =>
      v2With({ canonical: { status: 'completed', resultIndex: 1, ...fields } });

    expect(
      parseV2(canonical({ finalText: 'body', finalTextRef: reference })),
    ).toBe(true);
    expect(
      parseV2(canonical({ partialText: 'body', partialTextRef: reference })),
    ).toBe(true);
    expect(parseV2(canonical({}))).toBe(true);
    expect(parseV2(canonical({ answerUnavailable: true }))).toBe(true);
    expect(parseV2(canonical({ finalTextRef: reference }))).toBe(false);
    expect(parseV2(canonical({ partialTextRef: reference }))).toBe(false);
    expect(
      parseV2(canonical({ finalText: 'body', answerUnavailable: true })),
    ).toBe(false);
    expect(
      parseV2(canonical({ partialText: 'body', answerUnavailable: true })),
    ).toBe(false);
    expect(
      parseV2(canonical({ finalText: 'final', partialText: 'partial' })),
    ).toBe(false);
    expect(parseV2(canonical({ answerUnavailable: false }))).toBe(false);
    expect(parseV2(canonical({ status: 'running' }))).toBe(false);
    expect(
      parseV2({
        ...v2With({ canonical: { status: 'completed', resultIndex: 1 } }),
        cardRevision: 9007199254740992,
      }),
    ).toBe(false);
    expect(
      parseV2(
        canonical({
          finalText: 'body',
          finalTextRef: { ...reference, byteLength: 9007199254740992 },
        }),
      ),
    ).toBe(false);
    expect(
      parseV2(
        canonical({
          finalText: 'body',
          finalTextRef: { ...reference, sha256: 'A'.repeat(64) },
        }),
      ),
    ).toBe(false);
    expect(
      parseV2(
        canonical({
          finalText: 'body',
          finalTextRef: { ...reference, encoding: 'utf-16' },
        }),
      ),
    ).toBe(false);
    expect(
      parseV2(
        canonical({
          finalText: 'body',
          finalTextRef: { ...reference, mediaType: 'application/json' },
        }),
      ),
    ).toBe(false);
    expect(
      parseV2(
        canonical({
          finalText: 'body',
          finalTextRef: { ...reference, version: 2 },
        }),
      ),
    ).toBe(false);
    expect(
      parseV2(
        canonical({
          usage: {
            inputTokens: Number.MAX_VALUE,
            outputTokens: 0,
            cachedInputTokens: 1,
            cacheCreationInputTokens: 2,
            costUsd: 0.5,
          },
        }),
      ),
    ).toBe(true);
    expect(parseV2(canonical({ usage: { inputTokens: -1 } }))).toBe(false);
    expect(
      parseV2(canonical({ usage: { costUsd: Number.POSITIVE_INFINITY } })),
    ).toBe(false);
  });

  it('accepts a maximum fitted draft and canonical payload without invoking the fitter', () => {
    const idAtCap = '"'.repeat(511);
    const childDelegationIds = [
      'x'.repeat(1022),
      'x'.repeat(1022),
      'x'.repeat(1022),
      'x'.repeat(1022),
      'x'.repeat(1022),
      'x'.repeat(871),
    ];
    const applyFailureAtCap = {
      reason: 'conflict',
      issues: [
        ...Array.from({ length: 13 }, () => ({
          path: 'x'.repeat(1022),
          reason: 'parent_changed',
        })),
        { path: 'x'.repeat(135), reason: 'parent_changed' },
      ],
      guidance: 'g',
    };
    const controlBase = {
      operationId: 'x'.repeat(1022),
      operation: 'apply',
      status: 'failed',
      error: '',
      applyFailure: applyFailureAtCap,
    };
    const control = {
      ...controlBase,
      error: 'x'.repeat(18_000 - encodedBytes(controlBase)),
    };
    const errorBase = {
      code: 'runtime_error',
      message: '',
      retryable: false,
      apply: { reason: 'conflict', issues: [], guidance: '' },
    };
    const addedErrorBytes = 8_192 - encodedBytes(errorBase);
    const canonicalError = {
      code: 'runtime_error',
      message: 'x'.repeat(Math.floor(addedErrorBytes / 2)),
      retryable: false,
      apply: {
        reason: 'conflict',
        issues: [],
        guidance: 'x'.repeat(addedErrorBytes - Math.floor(addedErrorBytes / 2)),
      },
    };
    const fittedDraft = {
      version: 2,
      status: 'running',
      outputTruncated: true,
      prompt: '\u0000'.repeat(32768),
      routeSnapshot: routeAtEncodedBudget(12_000),
      requestedModelId: idAtCap,
      nativeSessionId: idAtCap,
      nestedDelegation: 'enabled',
      childDelegationIds,
      capabilities: capabilitySummaryAtEncodedBudget(18_000),
      isolatedWorkspace: {
        revision: idAtCap,
        dirtyParentChangesIncluded: false,
      },
      workspaceDiscarded: true,
      control,
      cancelledByUser: true,
      stoppedBy: stoppedByAtEncodedBudget(2_048),
      detailOmitted: true,
    };
    const maximumPayload = {
      ...fittedDraft,
      cardRevision: Number.MAX_SAFE_INTEGER,
      canonical: {
        status: 'completed',
        resultIndex: Number.MAX_SAFE_INTEGER,
        error: canonicalError,
        usage: {
          inputTokens: Number.MAX_VALUE,
          outputTokens: Number.MAX_VALUE,
          cachedInputTokens: Number.MAX_VALUE,
          cacheCreationInputTokens: Number.MAX_VALUE,
          costUsd: Number.MAX_VALUE,
        },
        finalText: '\u0000'.repeat(8192),
        finalTextRef: {
          version: 1,
          artifactId: idAtCap,
          byteLength: Number.MAX_SAFE_INTEGER,
          sha256: 'a'.repeat(64),
          encoding: 'utf-8',
          mediaType: 'text/plain',
        },
      },
    };

    expect(encodedBytes(routeAtEncodedBudget(12_000))).toBe(12_000);
    expect(encodedBytes(childDelegationIds)).toBe(6_000);
    expect(encodedBytes(applyFailureAtCap)).toBe(14_000);
    expect(encodedBytes(control)).toBe(18_000);
    const { prompt, ...nonPromptFittedDraft } = fittedDraft;
    expect(prompt.length).toBe(32_768);
    expect(encodedBytes(nonPromptFittedDraft)).toBeLessThan(60_000);
    expect(encodedBytes(canonicalError)).toBe(8_192);
    expect(CardStateDraftSchema.safeParse(fittedDraft).success).toBe(true);
    expect(CardStateV2Schema.safeParse(maximumPayload).success).toBe(true);
  });

  it('retains V1 decoding and accepts V2 descriptor updates without stripping fields', () => {
    const v1 = {
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
    expect(CardStateV1Schema.parse(v1)).toEqual(v1);
    const update = {
      version: 1,
      target: {
        kind: 'delegation',
        chatId: 'chat',
        delegationId: 'd',
        runGeneration: 1,
      },
      expectedStreamRevision: 0,
      nextStreamRevision: 1,
      cardState: {
        version: 2,
        cardRevision: 1,
        status: 'running',
        outputTruncated: false,
      },
    };
    expect(TranscriptStreamDescriptorUpdateSchema.parse(update)).toEqual(
      update,
    );
  });
});
