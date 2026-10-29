import { Buffer } from 'node:buffer';
import { isAgentDelegationCardData } from '@canopy/protocol/delegation';
import type { PortalChatPart } from '@canopy/protocol/portal';
import {
  PORTAL_CHAT_UNBOUNDED_LIMITS,
  type PersistedChatMessage,
} from '@canopy/agent-transcript';
import {
  projectPersistedChatTranscript,
  persistedMessageToPortalMessage,
} from '../persisted-chat-projection';
import { runtimeChatEventToPortalMessage } from '../runtime-chat-projection';
import {
  PORTAL_DELEGATION_CHILD_TEXT_MAX_CHARS,
  PORTAL_DELEGATION_PART_MAX_BYTES,
  PORTAL_DELEGATION_SNAPSHOT_MAX_BYTES,
  PORTAL_DELEGATION_SUB_BLOCKS_MAX_BYTES,
  PORTAL_DELEGATION_SUB_BLOCKS_MAX_COUNT,
  projectPortalDelegationPart,
} from '../delegation-wire-projection';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function agentPart(
  parts: PortalChatPart[] | undefined,
): PortalChatPart | undefined {
  return parts?.find((part) => part.kind === 'agent');
}

function projectedSubBlockCount(part: PortalChatPart | undefined): number {
  if (!isRecord(part?.data)) return 0;
  const data = part.data;
  return Array.isArray(data.subBlocks) ? data.subBlocks.length : 0;
}

function agentData(
  part: PortalChatPart | null | undefined,
): Record<string, unknown> | undefined {
  return isRecord(part?.data) ? part.data : undefined;
}

function subBlocks(part: PortalChatPart | null | undefined): PortalChatPart[] {
  const data = agentData(part);
  return Array.isArray(data?.subBlocks)
    ? data.subBlocks.filter(
        (child): child is PortalChatPart =>
          isRecord(child) && typeof child.kind === 'string',
      )
    : [];
}

function liveDelegationEvent(
  childCount: number,
  childTextLength: number,
): unknown {
  return {
    type: 'canopy_delegation',
    delegation: {
      delegationId: 'delegate-1',
      runGeneration: 1,
      sequence: 7,
      parentHarnessId: 'claude',
      parentTurnId: 'turn-1',
      parentToolCallId: 'tool-1',
      createdAt: 1_700_000_000_000,
      task: {
        description: 'Inspect the issue',
        prompt: 'A bounded test prompt',
        executionMode: 'foreground',
      },
      snapshot: {
        delegationId: 'delegate-1',
        status: 'failed',
        requestedModelId: 'model-1',
        outputTruncated: false,
        partialText: 'x'.repeat(childTextLength),
      },
      transcript: Array.from({ length: childCount }, (_, index) => ({
        id: `item-${index}`,
        sequence: index,
        occurredAt: 1_700_000_000_000 + index,
        type: 'text',
        text: `child-${index} ${'x'.repeat(childTextLength)}`,
      })),
    },
  };
}

function persistedDelegationInput(
  childCount: number,
  childTextLength: number,
): {
  scope: 'worktree';
  chatId: string;
  message: PersistedChatMessage;
  relatedMessages: PersistedChatMessage[];
} {
  const agentBlockId = 'delegated-agent-delegate-1';
  return {
    scope: 'worktree',
    chatId: 'chat-1',
    message: {
      id: 'parent-message',
      role: 'assistant',
      timestamp: 1_700_000_000_000,
      blocks: [
        {
          type: 'delegated_agent_call',
          agentBlockId,
          runGeneration: 1,
          sequence: 7,
          parentHarnessId: 'claude',
          parentTurnId: 'turn-1',
          parentToolCallId: 'tool-1',
          createdAt: 1_700_000_000_000,
          delegationId: 'delegate-1',
          status: 'failed',
          requestedModelId: 'model-1',
          partialText: 'x'.repeat(childTextLength),
          selectedModelId: 'model-1',
          runtimeModelId: '',
          targetHarnessId: '',
          outputTruncated: false,
          description: 'Inspect the issue',
          prompt: 'A bounded test prompt',
          executionMode: 'foreground',
        },
      ],
    },
    relatedMessages: Array.from({ length: childCount }, (_, index) => ({
      id: `delegated-agent-delegate-1:item-${index}`,
      role: 'assistant',
      timestamp: 1_700_000_000_000 + index,
      parentBlockId: agentBlockId,
      delegationSequence: index,
      blocks: [
        { type: 'text', text: `child-${index} ${'x'.repeat(childTextLength)}` },
      ],
    })),
  };
}

function serializedPartBytes(part: PortalChatPart | undefined): number {
  return part === undefined
    ? 0
    : Buffer.byteLength(JSON.stringify(part), 'utf8');
}

describe('bounded managed delegation wire projection', () => {
  it('bounds a live runtime delegation card and its newest child parts', () => {
    const message = runtimeChatEventToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      data: liveDelegationEvent(40, 1_000),
    });
    const part = agentPart(message?.parts);

    expect(part).toBeDefined();
    expect(projectedSubBlockCount(part)).toBeLessThanOrEqual(
      PORTAL_DELEGATION_SUB_BLOCKS_MAX_COUNT,
    );
    expect(serializedPartBytes(part)).toBeLessThanOrEqual(
      PORTAL_DELEGATION_PART_MAX_BYTES,
    );
    expect(agentData(part)?.subBlocksTruncated).toBe(true);
    expect(agentData(part)?.omittedSubBlocks).toBeGreaterThan(0);
    expect(JSON.stringify(part)).toContain('child-39');
  });

  it('bounds a hydrated persisted delegation card and its newest child parts', () => {
    const input = persistedDelegationInput(40, 1_000);
    const message = persistedMessageToPortalMessage(input);
    const part = agentPart(message.parts);

    expect(part).toBeDefined();
    expect(projectedSubBlockCount(part)).toBeLessThanOrEqual(
      PORTAL_DELEGATION_SUB_BLOCKS_MAX_COUNT,
    );
    expect(serializedPartBytes(part)).toBeLessThanOrEqual(
      PORTAL_DELEGATION_PART_MAX_BYTES,
    );
    expect(agentData(part)?.subBlocksTruncated).toBe(true);
    expect(agentData(part)?.omittedSubBlocks).toBeGreaterThan(0);
    expect(JSON.stringify(part)).toContain('child-39');
  });

  it('keeps who wrote each authored child message on the wire', () => {
    const input = persistedDelegationInput(2, 10);
    const [steer, followUp] = input.relatedMessages;
    if (!steer || !followUp) throw new Error('Expected two children');
    input.relatedMessages = [
      {
        ...steer,
        role: 'user',
        delegationAuthor: { kind: 'user' },
        delegationDelivery: 'steer',
      },
      {
        ...followUp,
        role: 'user',
        delegationAuthor: { kind: 'agent', depth: 0, description: 'Parent' },
        delegationDelivery: 'follow_up',
      },
    ];
    const children = subBlocks(
      agentPart(persistedMessageToPortalMessage(input).parts),
    );

    expect(children.map((child) => child.data)).toEqual([
      expect.objectContaining({
        delegationAuthorKind: 'user',
        delegationDelivery: 'steer',
      }),
      expect.objectContaining({
        delegationAuthorKind: 'agent',
        delegationAuthorDescription: 'Parent',
        delegationDelivery: 'follow_up',
      }),
    ]);
  });

  it('keeps agent-sent attribution on user children as flat wire fields', () => {
    const input = persistedDelegationInput(3, 10);
    const [projectSent, malformed, assistant] = input.relatedMessages;
    if (!projectSent || !malformed || !assistant)
      throw new Error('Expected three children');
    input.relatedMessages = [
      {
        ...projectSent,
        role: 'user',
        agentSent: {
          sender: {
            kind: 'project',
            projectType: 'code',
            projectId: 'project-a',
            taskId: 'task-a',
            chatId: 'chat-a',
          },
          chatTitle: 'Release prep',
          projectLabel: 'Canopy',
        },
      },
      {
        ...malformed,
        role: 'user',
        agentSent: {
          sender: { kind: 'bot', taskId: 'task-b', chatId: 'chat-b' },
          chatTitle: 'Missing bot id',
          projectLabel: 'App Advisor',
        },
      },
      {
        ...assistant,
        role: 'assistant',
        agentSent: {
          sender: {
            kind: 'bot',
            botId: 'app_advisor',
            taskId: 'task-c',
            chatId: 'chat-c',
          },
          chatTitle: 'Not a user row',
          projectLabel: 'App Advisor',
        },
      },
    ];
    const children = subBlocks(
      agentPart(persistedMessageToPortalMessage(input).parts),
    );
    const byMessage = (id: string): PortalChatPart[] =>
      children.filter(
        (child) => isRecord(child.data) && child.data.messageId === id,
      );

    for (const child of byMessage(projectSent.id)) {
      expect(child.data).toEqual(
        expect.objectContaining({
          agentSentSenderKind: 'project',
          agentSentProjectType: 'code',
          agentSentProjectId: 'project-a',
          agentSentTaskId: 'task-a',
          agentSentChatId: 'chat-a',
          agentSentChatTitle: 'Release prep',
          agentSentProjectLabel: 'Canopy',
        }),
      );
      expect(child.data).not.toHaveProperty('agentSent');
      expect(child.data).not.toHaveProperty('agentSentBotId');
    }
    for (const child of [
      ...byMessage(malformed.id),
      ...byMessage(assistant.id),
    ]) {
      expect(Object.keys(isRecord(child.data) ? child.data : {})).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^agentSent/)]),
      );
    }
  });

  it('projects the same bounded delegation data live and from persisted history', () => {
    const live = runtimeChatEventToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      data: liveDelegationEvent(40, 100),
    });
    const persisted = persistedMessageToPortalMessage(
      persistedDelegationInput(40, 100),
    );

    expect(agentPart(live?.parts)).toEqual(agentPart(persisted.parts));
  });

  it('keeps valid card metadata while bounding oversized optional fields and host keys', () => {
    const base = agentPart(
      persistedMessageToPortalMessage(persistedDelegationInput(1, 10)).parts,
    );
    const data = agentData(base);
    const delegation =
      data && isRecord(data.delegation) ? data.delegation : undefined;
    expect(base).toBeDefined();
    expect(delegation).toBeDefined();
    if (!base || !data || !delegation) return;

    const hostFields: Record<string, unknown> = {};
    for (let index = 0; index < 40; index += 1) {
      hostFields[`hostConfig${index}`] = { secret: `hidden-${index}` };
    }
    const routeSnapshot: Record<string, unknown> = {
      selectedModelId: 'model-1',
      selectedModelLabel: 'label'.repeat(400),
      runtimeModelId: 'runtime-1',
      runtimeModelLabel: 'runtime'.repeat(100),
      harnessId: 'claude',
      runtimeKind: 'local',
      runnerRegistrationId: 'runner-1',
      runtimeVersion: '1',
      adapterVersion: '1',
      modelSource: 'catalog',
      providerType: 'anthropic',
      assignmentRevision: 'revision-1',
      billingAuthority: 'local',
      aiCreditsRouted: false,
      capabilities: ['text'],
      supportedThinkingLevels: ['default'],
      capabilitySnapshotHash: 'snapshot-hash',
      capabilityGeneration: 1,
      policyRevision: 'policy-1',
      agentOverlay: {
        agentDefinitionId: 'agent-definition',
        agentDefinitionRevision: 'revision-1',
        agentDefinitionHash: 'hash-1',
        pluginProjectionHash: 'plugin-hash-1',
        secretConfig: 'not-on-the-wire',
      },
      hostConfig: { token: 'not-on-the-wire' },
    };
    const largeDelegation = {
      ...delegation,
      ...hostFields,
      routeSnapshot,
      selectedModelId: 'model-1',
      runtimeModelId: 'runtime-1',
      targetHarnessId: 'claude',
      error: {
        code: 'runtime_error',
        message: 'long-error '.repeat(900),
        retryable: true,
      },
    };
    const largePart: PortalChatPart = {
      ...base,
      data: { ...data, delegation: largeDelegation, hostConfig: 'omit-me' },
    };

    expect(isAgentDelegationCardData(largeDelegation)).toBe(false);
    const projected = projectPortalDelegationPart(largePart);
    expect(projected).not.toBeNull();
    if (!projected || !isRecord(projected.data)) return;
    const projectedDelegation = projected.data.delegation;

    expect(isAgentDelegationCardData(projectedDelegation)).toBe(true);
    expect(isRecord(projectedDelegation)).toBe(true);
    if (!isRecord(projectedDelegation)) return;
    expect(projectedDelegation).not.toHaveProperty('hostConfig0');
    expect(projectedDelegation).not.toHaveProperty('hostConfig39');
    expect(projected.data).not.toHaveProperty('hostConfig');
    expect(projectedDelegation.parentTurnId).toBe('turn-1');
    expect(projectedDelegation.parentToolCallId).toBe('tool-1');
    expect(projectedDelegation.agentBlockId).toBe('delegated-agent-delegate-1');
    expect(projectedDelegation.runGeneration).toBe(1);
    expect(projectedDelegation.sequence).toBe(7);
    expect(projectedDelegation.createdAt).toBe(1_700_000_000_000);
    expect(projected.data.snapshotTruncated).toBe(true);
    expect(serializedPartBytes(projected)).toBeLessThanOrEqual(
      PORTAL_DELEGATION_PART_MAX_BYTES,
    );
    expect(
      Buffer.byteLength(JSON.stringify(projectedDelegation), 'utf8'),
    ).toBeLessThanOrEqual(PORTAL_DELEGATION_SNAPSHOT_MAX_BYTES);
  });

  it('retains the full known snapshot when shrinking an oversized card', () => {
    const base = agentPart(
      persistedMessageToPortalMessage(persistedDelegationInput(1, 10)).parts,
    );
    const data = agentData(base);
    const delegation =
      data && isRecord(data.delegation) ? data.delegation : undefined;
    expect(base).toBeDefined();
    expect(delegation).toBeDefined();
    if (!base || !data || !delegation) return;

    const longLabel = 'l'.repeat(500);
    const routeSnapshot: Record<string, unknown> = {
      selectedModelId: longLabel,
      selectedModelLabel: longLabel,
      runtimeModelId: longLabel,
      runtimeModelLabel: longLabel,
      harnessId: longLabel,
      runtimeKind: 'r'.repeat(128),
      runnerRegistrationId: 'r'.repeat(128),
      runtimeVersion: 'r'.repeat(128),
      adapterVersion: 'r'.repeat(128),
      modelSource: 'r'.repeat(128),
      providerType: 'r'.repeat(128),
      assignmentRevision: 'r'.repeat(128),
      billingAuthority: 'r'.repeat(128),
      aiCreditsRouted: false,
      capabilities: Array.from({ length: 8 }, () => 'c'.repeat(128)),
      supportedThinkingLevels: [
        'default',
        'minimal',
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
        'ultra',
      ],
      capabilitySnapshotHash: 'r'.repeat(128),
      capabilityGeneration: 1,
      policyRevision: 'r'.repeat(128),
      routeId: 'r'.repeat(128),
      agentOverlay: {
        agentDefinitionId: 'o'.repeat(128),
        agentDefinitionRevision: 'o'.repeat(128),
        agentDefinitionHash: 'o'.repeat(128),
        pluginProjectionHash: 'o'.repeat(128),
      },
    };
    const capabilities = {
      inherit: true,
      discovery: true,
      items: Array.from({ length: 8 }, (_, index) => ({
        kind: 'skill',
        source: 'agent',
        name: `item-${index}-${'i'.repeat(180)}`,
      })),
      skipped: Array.from({ length: 8 }, (_, index) => ({
        kind: 'plugin',
        reason: 'missing_selection',
        name: `skip-${index}-${'s'.repeat(180)}`,
      })),
    };
    const applyIssues = Array.from({ length: 4 }, (_, index) => ({
      path: `src/file-${index}-${'p'.repeat(110)}.tsx`,
      reason: 'parent_changed',
      parentDiff: 'd'.repeat(512),
      parentDiffTruncated: true,
    }));
    const applyFailure = {
      reason: 'conflict',
      issues: applyIssues,
      guidance: 'g'.repeat(1_024),
    };
    const largeDelegation: Record<string, unknown> = {
      ...delegation,
      parentDelegationId: longLabel,
      parentTurnId: longLabel,
      requestedModelId: longLabel,
      nativeSessionId: longLabel,
      phase: 'queued',
      queue: {
        id: 'q'.repeat(256),
        name: 'Large queue',
        running: 1,
        waiting: 2,
        limit: 3,
      },
      prompt: 'p'.repeat(2_000),
      partialText: 'a'.repeat(1_000),
      finalText: 'f'.repeat(1_000),
      routeSnapshot,
      permissions: {
        writePaths: Array.from(
          { length: 8 },
          (_, index) => `src/path-${index}-${'w'.repeat(110)}`,
        ),
      },
      capabilities,
      childDelegationIds: Array.from(
        { length: 8 },
        (_, index) => `child-${index}-${'d'.repeat(110)}`,
      ),
      control: {
        operationId: 'apply-operation',
        status: 'failed',
        operation: 'apply',
        applyFailure,
      },
      error: {
        code: 'runtime_error',
        message: 'e'.repeat(1_000),
        retryable: true,
        apply: applyFailure,
      },
    };
    expect(
      Buffer.byteLength(JSON.stringify(largeDelegation), 'utf8'),
    ).toBeGreaterThan(PORTAL_DELEGATION_SNAPSHOT_MAX_BYTES);
    const projected = projectPortalDelegationPart({
      ...base,
      data: { ...data, delegation: largeDelegation },
    });
    expect(projected).not.toBeNull();
    if (!projected || !isRecord(projected.data)) return;
    const projectedCard = projected.data.delegation;
    expect(isAgentDelegationCardData(projectedCard)).toBe(true);
    expect(isRecord(projectedCard)).toBe(true);
    if (!isRecord(projectedCard)) return;
    expect(projectedCard).toHaveProperty('description');
    expect(projectedCard).toHaveProperty('prompt');
    expect(typeof projectedCard.prompt).toBe('string');
    if (typeof projectedCard.prompt !== 'string') return;
    expect(projectedCard.prompt.length).toBeLessThanOrEqual(96);
    expect(projectedCard).toHaveProperty('executionMode', 'foreground');
    expect(projectedCard).toHaveProperty('status', 'failed');
    expect(projectedCard).toHaveProperty('outputTruncated', false);
    expect(projectedCard).toHaveProperty('parentToolCallId', 'tool-1');
    expect(projectedCard).toHaveProperty('routeSnapshot');
    expect(projectedCard).toHaveProperty('permissions');
    expect(projectedCard).toHaveProperty('capabilities');
    expect(projectedCard).toHaveProperty('childDelegationIds');
    expect(projectedCard).toHaveProperty('queue');
    expect(projectedCard).toHaveProperty(
      'control.applyFailure.reason',
      'conflict',
    );
    expect(projectedCard).toHaveProperty('error.apply.issues');
    expect(projected.data.snapshotTruncated).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(projectedCard), 'utf8'),
    ).toBeLessThanOrEqual(PORTAL_DELEGATION_SNAPSHOT_MAX_BYTES);
  });

  it('keeps nested child tool results structured while compacting tool leaves', () => {
    const base = agentPart(
      persistedMessageToPortalMessage(persistedDelegationInput(1, 10)).parts,
    );
    const data = agentData(base);
    expect(base).toBeDefined();
    expect(data).toBeDefined();
    if (!base || !data) return;
    const oversizedInput: Record<string, unknown> = {
      nested: { deeper: { text: 'deep-leaf' } },
      sanitized: 'before\0middle\ud800😀',
    };
    for (let index = 0; index < 30; index += 1) {
      oversizedInput[`key${index}`] = `value-${index}`;
    }
    const toolPart: PortalChatPart = {
      kind: 'tool_use',
      toolFamily: 'bash',
      data: {
        toolUseId: 'child-tool-1',
        toolName: 'Bash',
        input: oversizedInput,
        result: { output: 'tool-output'.repeat(900), isError: true },
      },
    };
    const rawPart: PortalChatPart = {
      ...base,
      data: { ...data, subBlocks: [toolPart] },
    };

    const projected = projectPortalDelegationPart(rawPart);
    expect(projected).not.toBeNull();
    const child = subBlocks(projected)[0];
    expect(child).toMatchObject({ kind: 'tool_use', toolFamily: 'bash' });
    if (!isRecord(child?.data)) return;
    expect(typeof child.data.input).toBe('string');
    if (typeof child.data.input !== 'string') return;
    expect(child.data.input.length).toBeLessThanOrEqual(
      PORTAL_DELEGATION_CHILD_TEXT_MAX_CHARS,
    );
    expect(child.data.input).toContain(
      '"nested":{"deeper":{"text":"deep-leaf"}}',
    );
    expect(isRecord(child.data.result)).toBe(true);
    if (!isRecord(child.data.result)) return;
    expect(child.data.result.isError).toBe(true);
    expect(typeof child.data.result.output).toBe('string');
    if (typeof child.data.result.output !== 'string') return;
    expect(child.data.result.output.length).toBeLessThanOrEqual(
      PORTAL_DELEGATION_CHILD_TEXT_MAX_CHARS,
    );
    expect(child.data.input).toContain('"sanitized":"beforemiddle�😀"');
    expect(
      Buffer.byteLength(JSON.stringify(subBlocks(projected)), 'utf8'),
    ).toBeLessThanOrEqual(PORTAL_DELEGATION_SUB_BLOCKS_MAX_BYTES);
  });

  it('does not cap local unbounded projections and keeps the helper idempotent by output identity', () => {
    const input = persistedDelegationInput(40, 5_000);
    const unbounded = persistedMessageToPortalMessage(
      input,
      PORTAL_CHAT_UNBOUNDED_LIMITS,
    );
    const unboundedPart = agentPart(unbounded.parts);
    expect(projectedSubBlockCount(unboundedPart)).toBe(40);
    const firstChild = subBlocks(unboundedPart)[0];
    expect(isRecord(firstChild?.data)).toBe(true);
    if (!isRecord(firstChild?.data)) return;
    expect(typeof firstChild.data.text).toBe('string');
    if (typeof firstChild.data.text !== 'string') return;
    expect(firstChild.data.text.length).toBeGreaterThan(
      PORTAL_DELEGATION_CHILD_TEXT_MAX_CHARS,
    );

    const local = projectPersistedChatTranscript({
      scope: 'worktree',
      chatId: 'chat-1',
      messages: [input.message, ...input.relatedMessages],
      fidelity: 'local',
    });
    expect(projectedSubBlockCount(agentPart(local[0]?.parts))).toBe(40);

    const wire = agentPart(
      persistedMessageToPortalMessage(persistedDelegationInput(2, 20)).parts,
    );
    const projected = projectPortalDelegationPart(wire);
    expect(projected).not.toBeNull();
    expect(projectPortalDelegationPart(projected)).toBe(projected);

    const wireData = agentData(wire);
    const sourceCard =
      wireData && isRecord(wireData.delegation)
        ? { ...wireData.delegation }
        : undefined;
    if (!wire || !wireData || !sourceCard) return;
    const mutableSource: PortalChatPart = {
      ...wire,
      data: { ...wireData, delegation: sourceCard },
    };
    const beforeMutation = projectPortalDelegationPart(mutableSource);
    sourceCard.status = 'interrupted';
    sourceCard.sequence = 8;
    const afterMutation = projectPortalDelegationPart(mutableSource);
    expect(afterMutation).not.toBe(beforeMutation);
    expect(agentData(beforeMutation)?.delegation).toMatchObject({
      status: 'failed',
      sequence: 7,
    });
    expect(agentData(afterMutation)?.delegation).toMatchObject({
      status: 'interrupted',
      sequence: 8,
    });
  });
});
