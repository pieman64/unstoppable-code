import type { PersistedChatMessage } from '@canopy/agent-transcript';
import type { AgentArtifactReceiptV1 } from '@canopy/protocol/agent-artifacts';
import {
  persistedMessageToPortalMessage,
  persistedParts,
  projectPersistedChatTranscript,
} from '../persisted-chat-projection';
import { runtimeChatEventToPortalMessage } from '../runtime-chat-projection';
import { DEFAULT_MODEL, getModelDisplayName } from '../../types';
import { PORTAL_DELEGATION_SUB_BLOCKS_MAX_COUNT } from '../delegation-wire-projection';

describe('persisted restart timer outcomes (CAN-5178)', () => {
  it('keeps restart timer ownership on the root prompt across child-directed input', () => {
    const projected = projectPersistedChatTranscript({
      scope: 'worktree',
      chatId: 'chat',
      interruptedTurns: { root: {} },
      messages: [
        {
          id: 'root',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'Work' }],
        },
        {
          id: 'child',
          role: 'user',
          parentToolUseId: 'helper',
          timestamp: 2,
          blocks: [{ type: 'text', text: 'Child work' }],
        },
        {
          id: 'timer',
          role: 'system',
          timestamp: 3,
          blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 3 }],
        },
      ],
    });
    expect(
      projected.find((row) =>
        row.parts?.some((part) => part.kind === 'turn_timer'),
      ),
    ).toMatchObject({
      messageId: 'root:turn-timer',
      parts: [{ data: { endReason: 'interrupted' } }],
    });
  });

  it.each(['failed', 'cancelled'] as const)(
    'preserves unaccepted %s over restart for a legacy timer',
    (outcome) => {
      const projected = projectPersistedChatTranscript({
        scope: 'standalone',
        chatId: 'chat',
        messages: [
          {
            id: 'u',
            role: 'user',
            timestamp: 1,
            blocks: [{ type: 'text', text: 'Work' }],
          },
          {
            id: 'timer',
            role: 'system',
            timestamp: 2,
            blocks: [{ type: 'turn_timer', completedAt: 2 }],
          },
        ],
        interruptedTurns: { u: {} },
        unacceptedTurnEnds: { u: outcome },
      });
      expect(projected[1]).toMatchObject({
        messageId: 'u:turn-timer',
        parts: [{ kind: 'turn_timer', data: { endReason: outcome } }],
      });
    },
  );

  it('projects a canonical timer on a partial page using its explicit owner', () => {
    const projected = projectPersistedChatTranscript({
      scope: 'worktree',
      chatId: 'chat',
      messages: [
        {
          id: 't:timer',
          role: 'system',
          timestamp: 0,
          blocks: [
            {
              type: 'turn_timer',
              turnId: 't',
              userMessageId: 'unloaded-user',
              completedAt: 0,
            },
          ],
        },
      ],
      interruptedTurns: { 'unloaded-user': {} },
    });
    expect(projected[0]).toMatchObject({
      messageId: 't:timer',
      parts: [{ data: { completedAt: 0, endReason: 'interrupted' } }],
    });
    expect(projected[0]?.parts?.[0]).not.toHaveProperty(
      'data.startedAt',
      expect.any(Number),
    );
  });
  it.each([undefined, 'completed', 'failed', 'cancelled'] as const)(
    'projects tool-free restart evidence with recorded %s precedence, scoped across resume',
    (outcome) => {
      const messages: PersistedChatMessage[] = [
        {
          id: 'u',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'Work' }],
        },
        {
          id: 'text',
          role: 'assistant',
          timestamp: 10,
          blocks: [{ type: 'text', text: 'Partial reply' }],
        },
        {
          id: 'timer',
          role: 'system',
          timestamp: 14,
          blocks: [
            {
              type: 'turn_timer',
              turnId: 't',
              userMessageId: 'u',
              startedAt: 1,
              completedAt: 14,
            },
          ],
        },
        {
          id: 'resume',
          role: 'user',
          timestamp: 20,
          blocks: [{ type: 'text', text: 'Continue' }],
        },
        {
          id: 'live',
          role: 'system',
          timestamp: 20,
          blocks: [{ type: 'turn_timer', startedAt: 20, completedAt: null }],
        },
      ];
      const projected = projectPersistedChatTranscript({
        scope: 'worktree',
        chatId: 'chat',
        messages,
        fidelity: 'local',
        interruptedTurns: { u: { resumedBy: 'resume' }, resume: {} },
        ...(outcome ? { turnEnds: { u: { outcome, endedAt: 14 } } } : {}),
      });
      expect(
        projected.find((row) => row.messageId === 'timer')?.parts?.[0],
      ).toHaveProperty(
        'data.endReason',
        outcome === 'failed' || outcome === 'cancelled'
          ? outcome
          : 'interrupted',
      );
      expect(
        projected.find((row) => row.messageId === 'live')?.parts?.[0],
      ).not.toHaveProperty('data.endReason');
    },
  );
});

describe('persisted primary output locator pass-through', () => {
  const row: PersistedChatMessage = {
    id: 'desktop-result-row',
    role: 'assistant',
    timestamp: 1,
    blocks: [
      { type: 'tool_use', toolUseId: 'paired', toolName: 'Read', input: '{}' },
      {
        type: 'tool_result',
        toolUseId: 'paired',
        toolName: 'Read',
        output: 'preview',
        isError: false,
        fullOutputRef: {
          version: 1,
          artifactId: 'stored-body',
          byteLength: 9000,
          sha256: '0'.repeat(64),
          encoding: 'utf-8',
          mediaType: 'text/plain',
        },
      },
      {
        type: 'tool_result',
        toolUseId: 'cross-row',
        toolName: 'Grep',
        output: 'x'.repeat(4001),
        isError: false,
      },
    ],
  };
  it.each(['worktree', 'standalone', 'app_advisor'] as const)(
    'preserves paired and standalone locators in %s persisted messages',
    (scope) => {
      const projected = persistedMessageToPortalMessage({
        scope,
        chatId: 'chat',
        message: row,
      });
      expect(projected.parts?.[0]).toHaveProperty('data.result.outputLocator', {
        messageId: 'desktop-result-row',
        blockOrdinal: 1,
        field: 'output',
      });
      expect(projected.parts?.[1]?.outputLocator).toEqual({
        messageId: 'desktop-result-row',
        blockOrdinal: 2,
        field: 'output',
      });
    },
  );
  it('preserves the same locators through the desktop parts wrapper', () => {
    const parts = persistedParts(row);
    expect(parts[0]).toHaveProperty('data.result.outputLocator', {
      messageId: 'desktop-result-row',
      blockOrdinal: 1,
      field: 'output',
    });
    expect(parts[1]?.outputLocator).toEqual({
      messageId: 'desktop-result-row',
      blockOrdinal: 2,
      field: 'output',
    });
  });
  it('explicitly suppresses both locator shapes for an in-memory row without changing previews', () => {
    const projected = persistedMessageToPortalMessage({
      scope: 'worktree',
      chatId: 'chat',
      message: row,
      outputLocators: false,
    });
    expect(projected.parts).toHaveLength(2);
    expect(projected.parts?.[0]).toHaveProperty(
      'data.result.output',
      'preview',
    );
    expect(JSON.stringify(projected)).not.toContain('outputLocator');
  });
});

// The desktop renderer feeds this projection into the shared chat store that
// the shared transcript renders from (slice 5). Unlike the portal wire, the
// local projection must carry the whole transcript: no text truncation, and
// in-flight turn timers so a streaming turn shows its live timer row.
describe('projectPersistedChatTranscript (local desktop projection)', () => {
  const at = 1_700_000_000_000;
  const longText = 'x'.repeat(10_000);
  const messages: PersistedChatMessage[] = [
    {
      id: 'u1',
      role: 'user',
      timestamp: at,
      blocks: [{ type: 'text', text: 'go' }],
    },
    {
      id: 'a1',
      role: 'assistant',
      timestamp: at + 1,
      blocks: [
        { type: 'text', text: longText },
        {
          type: 'image',
          path: '/tmp/generated/chart.png',
          dataUrl: 'data:image/png;base64,AAAA',
          alt: 'Generated chart',
        },
        { type: 'turn_timer', startedAt: at + 1, completedAt: null },
      ],
    },
  ];

  it('keeps a normal long response within the portal wire default', () => {
    const [, assistant] = projectPersistedChatTranscript({
      scope: 'worktree',
      chatId: 'chat-1',
      messages,
    });
    expect(assistant?.text).toBe(longText);
    expect(assistant?.parts).toEqual([
      {
        kind: 'image',
        data: { alt: 'Generated chart', assetId: 'asset-a1-image-1' },
      },
    ]);
    expect(assistant?.status).toBe('complete');
  });

  it('projects the full transcript with live timers for the local renderer', () => {
    const [, assistant] = projectPersistedChatTranscript({
      scope: 'worktree',
      chatId: 'chat-1',
      messages,
      fidelity: 'local',
    });
    expect(assistant?.text).toBe(longText);
    // A live timer marks its message streaming so the shared view shows it.
    expect(assistant?.status).toBe('streaming');
    expect(assistant?.parts).toHaveLength(2);
    // The local sources travel for the local renderer, and only for it.
    expect(assistant?.parts?.[0]).toMatchObject({
      kind: 'image',
      data: {
        path: '/tmp/generated/chart.png',
        dataUrl: 'data:image/png;base64,AAAA',
      },
    });
    expect(assistant?.parts?.[1]).toMatchObject({ kind: 'turn_timer' });
  });

  it('treats a never-completed timer on an earlier turn as stale, not live', () => {
    // A crash can leave an in-flight timer persisted on an old turn. Only
    // the live turn (after the last user message) may read as streaming.
    const [, stale, , live] = projectPersistedChatTranscript({
      scope: 'worktree',
      chatId: 'chat-1',
      fidelity: 'local',
      messages: [
        messages[0],
        {
          id: 'a0',
          role: 'assistant',
          timestamp: at + 1,
          blocks: [
            { type: 'text', text: 'first answer' },
            { type: 'turn_timer', startedAt: at + 1, completedAt: null },
          ],
        },
        { ...messages[0], id: 'u2', timestamp: at + 10 },
        {
          id: 'a2',
          role: 'assistant',
          timestamp: at + 11,
          blocks: [
            { type: 'text', text: 'second answer' },
            { type: 'turn_timer', startedAt: at + 11, completedAt: null },
          ],
        },
      ],
    });
    expect(stale?.status).toBe('complete');
    expect(stale?.parts).toBeUndefined();
    expect(live?.status).toBe('streaming');
    expect(live?.parts).toEqual([
      expect.objectContaining({ kind: 'turn_timer' }),
    ]);
  });
});

// Remote transcripts show the same per-turn "Picked by model routing" chip as the
// desktop, so each turn's timer carries the model Auto recorded for its user
// message on the tab.
describe('Auto-routing attribution on turn timers', () => {
  const at = 1_700_000_000_000;
  const model = DEFAULT_MODEL;
  const turn = (userId: string, offset: number): PersistedChatMessage[] => [
    {
      id: userId,
      role: 'user',
      timestamp: at + offset,
      blocks: [{ type: 'text', text: 'go' }],
    },
    {
      id: `${userId}-answer`,
      role: 'assistant',
      timestamp: at + offset + 1,
      blocks: [{ type: 'text', text: 'done' }],
    },
    {
      id: `${userId}-timer`,
      role: 'system',
      timestamp: at + offset + 2,
      blocks: [
        {
          type: 'turn_timer',
          startedAt: at + offset,
          completedAt: at + offset + 2,
        },
      ],
    },
  ];

  it('stamps each routed turn timer with its model and display name', () => {
    const projected = projectPersistedChatTranscript({
      scope: 'worktree',
      chatId: 'chat-1',
      messages: [...turn('u1', 0), ...turn('u2', 10)],
      autoRoutedModels: { u2: model },
    });
    const timers = projected.filter((message) =>
      message.messageId.endsWith(':turn-timer'),
    );
    expect(timers.map((timer) => timer.messageId)).toEqual([
      'u1:turn-timer',
      'u2:turn-timer',
    ]);
    // Only the routed turn carries attribution.
    expect(timers[0]?.parts?.[0]?.data).not.toHaveProperty('autoRoutedModel');
    expect(timers[1]?.parts?.[0]?.data).toMatchObject({
      autoRoutedModel: model,
      autoRoutedModelLabel: getModelDisplayName(model),
    });
  });
});

// CAN-2608 converges a Claude message persisted as `base` + `base:2` back onto
// one wire row. `persistedMessageToPortalMessage` only ever sets `createdAtMs`,
// so the merge's `Math.max(undefined ?? 0, undefined ?? 0)` stamped a literal
// `updatedAtMs: 0` on every multi-block answer. Consumers resolve a message's
// display time as `updatedAtMs ?? createdAtMs`, and `0` is not nullish, so those
// answers dated to the epoch and sorted above the entire conversation.
describe('suffixed message convergence timestamps', () => {
  const at = 1_700_000_000_000;

  function projectSuffixedPair(): ReturnType<
    typeof projectPersistedChatTranscript
  > {
    return projectPersistedChatTranscript({
      scope: 'standalone',
      chatId: 'chat-1',
      messages: [
        {
          id: 'u1',
          role: 'user',
          timestamp: at,
          blocks: [{ type: 'text', text: 'go' }],
        },
        {
          id: 'msg_1',
          role: 'assistant',
          timestamp: at + 1,
          blocks: [{ type: 'thinking', text: 'weighing it up' }],
        },
        {
          id: 'msg_1:2',
          role: 'assistant',
          timestamp: at + 2,
          blocks: [{ type: 'text', text: 'the answer' }],
        },
      ],
    });
  }

  it('never dates a converged message to the epoch', () => {
    const [, assistant] = projectSuffixedPair();

    expect(assistant?.text).toBe('the answer');
    expect(assistant?.updatedAtMs ?? assistant?.createdAtMs).toBeGreaterThan(0);
  });

  it('omits updatedAtMs when neither source carried one', () => {
    const [, assistant] = projectSuffixedPair();

    expect(assistant?.updatedAtMs).toBeUndefined();
    expect(assistant?.createdAtMs).toBe(at + 1);
  });

  it('shows the owner the account proxy switch lines', () => {
    const [line] = projectPersistedChatTranscript({
      scope: 'worktree',
      chatId: 'chat-1',
      messages: [
        {
          id: 'switch',
          role: 'system',
          timestamp: 1,
          blocks: [
            {
              type: 'account_proxy_switch',
              timestamp: 1,
              account: 'sam@example.com',
            },
          ],
        },
      ],
    });
    expect(line?.parts).toEqual([
      {
        kind: 'account_switch',
        data: { occurredAt: 1, account: 'sam@example.com' },
      },
    ]);
  });
});

it('preserves canonical receipts before truncating tool output', () => {
  const receipt = {
    version: 1,
    kind: 'automation',
    operation: 'automation.create',
    dedupeKey: 'canopy:automation:global:a1',
    createdAt: '2026-10-16T00:00:00.000Z',
    activityId: 'a1',
    name: 'Daily check',
    enabled: true,
    running: false,
    schedule: 'daily',
    actionKind: 'app_advisor_prompt',
    targetSummary: 'App Advisor',
    ifCommandConfigured: false,
    navigationTarget: { kind: 'automation_editor', activityId: 'a1' },
  };
  const [, message] = projectPersistedChatTranscript({
    scope: 'worktree',
    chatId: 'chat',
    messages: [
      {
        id: 'u',
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'Schedule' }],
      },
      {
        id: 'a',
        role: 'assistant',
        timestamp: 2,
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 't',
            toolName: 'DispatchAction',
            isError: false,
            output: JSON.stringify({
              ok: true,
              result: { text: 'x'.repeat(200000), agentArtifacts: [receipt] },
            }),
          },
        ],
      },
    ],
  });
  expect(message?.parts?.[0]?.data).toMatchObject({
    agentArtifacts: [receipt],
  });
});

describe('artifact metadata with canonical transcript reads', () => {
  const receipt = (activityId: string): AgentArtifactReceiptV1 => ({
    version: 1,
    kind: 'automation',
    operation: 'automation.create',
    dedupeKey: `canopy:automation:global:${activityId}`,
    createdAt: '2026-10-16T00:00:00.000Z',
    activityId,
    name: activityId,
    enabled: true,
    running: false,
    schedule: 'daily',
    actionKind: 'app_advisor_prompt',
    targetSummary: 'App Advisor',
    ifCommandConfigured: false,
    navigationTarget: { kind: 'automation_editor', activityId },
  });
  const first = receipt('first');
  const second = receipt('second');
  const visual = {
    version: 1,
    visualId: 'vis_00000000-0000-0000-0000-000000000001',
    artifactId: `sha256-v1-${'a'.repeat(64)}`,
    byteLength: 12,
    sha256: 'a'.repeat(64),
    mediaType: 'text/html',
    title: 'Chart',
    maxHeight: 320,
  } as const;
  const row: PersistedChatMessage = {
    id: 'artifact-row',
    role: 'assistant',
    timestamp: 1,
    blocks: [
      { type: 'tool_use', toolUseId: 'same', toolName: 'Read', input: '{}' },
      {
        type: 'tool_result',
        toolUseId: 'same',
        toolName: 'Read',
        output: 'preview',
        isError: false,
        agentArtifacts: [first],
        visualRef: visual,
        fullOutputRef: {
          version: 1,
          artifactId: `sha256-v1-${'b'.repeat(64)}`,
          byteLength: 9000,
          sha256: 'b'.repeat(64),
          encoding: 'utf-8',
          mediaType: 'text/plain',
        },
      },
      { type: 'tool_use', toolUseId: 'same', toolName: 'Read', input: '{}' },
      {
        type: 'tool_result',
        toolUseId: 'same',
        toolName: 'Read',
        output: 'x'.repeat(4001),
        isError: false,
        agentArtifacts: [second],
      },
    ],
  };

  it.each([false, true])(
    'keeps receipts, visuals, occurrences and locators together (unfolded=%s)',
    (unfoldToolResults) => {
      const projected = persistedMessageToPortalMessage(
        { scope: 'worktree', chatId: 'chat', message: row },
        { unfoldToolResults },
      );
      const parts = projected.parts ?? [];
      if (unfoldToolResults) {
        expect(parts[1]).toMatchObject({
          blockOrdinal: 1,
          occurrence: { id: 'artifact-row#0', revision: 0 },
          outputLocator: {
            messageId: 'artifact-row',
            blockOrdinal: 1,
            field: 'output',
          },
          data: { agentArtifacts: [first], visual, messageId: row.id },
        });
        expect(parts[3]).toMatchObject({
          blockOrdinal: 3,
          occurrence: { id: 'artifact-row#2', revision: 0 },
          outputLocator: {
            messageId: 'artifact-row',
            blockOrdinal: 3,
            field: 'output',
          },
          data: { agentArtifacts: [second] },
        });
        expect(parts[0]).not.toHaveProperty('data.result');
      } else {
        expect(parts.map((part) => part.kind)).toEqual([
          'tool_use',
          'tool_result',
          'tool_use',
        ]);
        expect(parts[0]).toHaveProperty('data.result.agentArtifacts', [first]);
        expect(parts[0]).toHaveProperty(
          'data.result.outputLocator.blockOrdinal',
          1,
        );
        expect(parts[1]).toMatchObject({
          data: { visual, messageId: row.id },
        });
        expect(parts[1]).not.toHaveProperty('occurrence');
        expect(parts[1]).not.toHaveProperty('data.output');
        expect(parts[2]).toHaveProperty('data.result.agentArtifacts', [second]);
        expect(parts[2]).toHaveProperty(
          'data.result.outputLocator.blockOrdinal',
          3,
        );
      }
    },
  );

  it('can disable read locators without removing artifact metadata', () => {
    const projected = persistedMessageToPortalMessage(
      {
        scope: 'worktree',
        chatId: 'chat',
        message: row,
        outputLocators: false,
      },
      { unfoldToolResults: true },
    );
    expect(projected.parts?.[1]).toMatchObject({
      data: { agentArtifacts: [first], visual },
    });
    expect(projected.parts?.[3]).toHaveProperty('data.agentArtifacts', [
      second,
    ]);
    expect(JSON.stringify(projected)).not.toMatch(/outputLocator|occurrence/);
  });

  it('counts a folded visual result when omitting an older child row', () => {
    const parent: PersistedChatMessage = {
      id: 'parent',
      role: 'assistant',
      timestamp: 1,
      blocks: [
        {
          type: 'delegated_agent_call',
          agentBlockId: 'block',
          delegationId: 'delegate',
          parentHarnessId: 'claude',
          description: 'Inspect',
          prompt: 'Prompt',
          executionMode: 'foreground',
          status: 'completed',
          outputTruncated: false,
          runGeneration: 1,
          sequence: 0,
          parentTurnId: 'turn',
          parentToolCallId: 'call',
          createdAt: 1,
          selectedModelId: 'model',
          runtimeModelId: 'model',
          targetHarnessId: 'claude',
        },
      ],
    };
    const relatedMessages: PersistedChatMessage[] = [
      { ...row, parentBlockId: 'block' },
      ...Array.from(
        { length: PORTAL_DELEGATION_SUB_BLOCKS_MAX_COUNT },
        (_, index): PersistedChatMessage => ({
          id: `child-${index}`,
          role: 'assistant',
          timestamp: index + 2,
          parentBlockId: 'block',
          blocks: [{ type: 'text', text: 'recent child' }],
        }),
      ),
    ];
    const projected = persistedMessageToPortalMessage({
      scope: 'worktree',
      chatId: 'chat',
      message: parent,
      relatedMessages,
    });
    // A managed card drops its retained children too; the omitted older row
    // adds three parts, its folded visual included.
    expect(projected.parts?.[0]).toMatchObject({
      kind: 'agent',
      data: {
        subBlocksTruncated: true,
        omittedSubBlocks: PORTAL_DELEGATION_SUB_BLOCKS_MAX_COUNT + 3,
      },
    });
  });

  it.each(['worktree', 'standalone'] as const)(
    'preserves runtime receipts while gating admitted reads in %s',
    (scope) => {
      const projected = runtimeChatEventToPortalMessage({
        scope,
        chatId: 'chat',
        data: {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'same',
                content: JSON.stringify({
                  ok: true,
                  result: { text: 'x'.repeat(5000), agentArtifacts: [first] },
                }),
              },
            ],
          },
        },
        admission: {
          revision: 4,
          tools: [
            {
              sourceToken: '0',
              occurrenceId: 'canonical#0',
              result: { rowId: 'canonical', blockOrdinal: 1, needsRead: true },
            },
          ],
        },
      });
      const part = projected?.parts?.[0];
      expect(part).toHaveProperty('data.agentArtifacts', [first]);
      if (scope === 'worktree') {
        expect(part?.occurrence).toEqual({ id: 'canonical#0', revision: 4 });
        expect(part?.outputLocator).toEqual({
          messageId: 'canonical',
          blockOrdinal: 1,
          field: 'output',
        });
      } else {
        expect(part).not.toHaveProperty('occurrence');
        expect(part).not.toHaveProperty('outputLocator');
      }
    },
  );
});

describe('persistedMessageToPortalMessage watcher attribution', () => {
  const watcherFired = {
    kind: 'Multiple watchers fired (2)',
    combinedWatchers: [
      { kind: 'Pipeline completion (Deploy)', text: 'Deploy succeeded' },
      { kind: 'Chat completion', text: 'Review finished' },
    ],
  };

  it('carries a merged watcher delivery on the wire and in the cached part', () => {
    const projected = persistedMessageToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      message: {
        id: 'watcher',
        role: 'user',
        timestamp: 1,
        userMessageSource: 'watcher',
        watcherFired,
        blocks: [{ type: 'text', text: 'Deploy succeeded\n\nReview finished' }],
      },
    });
    expect(projected.watcherFired).toEqual(watcherFired);
    expect(projected.parts).toContainEqual({
      kind: 'prompt_source',
      data: { source: 'automated', watcherFired },
    });
  });

  it.each(['human', 'hook'] as const)(
    'leaves %s prompts without watcher attribution',
    (userMessageSource) => {
      const projected = persistedMessageToPortalMessage({
        scope: 'worktree',
        chatId: 'chat-1',
        message: {
          id: 'prompt',
          role: 'user',
          timestamp: 1,
          userMessageSource,
          blocks: [{ type: 'text', text: 'Plain text' }],
        },
      });
      expect(projected).not.toHaveProperty('watcherFired');
      expect(JSON.stringify(projected.parts)).not.toContain('watcherFired');
    },
  );
});

describe('Portal managed-card fail-closed hydration', () => {
  it.each(['chat-stream-v2', 'future-store', 'invalid-card'])(
    'never re-emits stale children for %s',
    (marker) => {
      const messages: PersistedChatMessage[] = [
        {
          id: 'parent',
          role: 'assistant',
          timestamp: 1,
          blocks: [
            {
              type: 'delegated_agent_call',
              agentBlockId: 'block',
              delegationId: '界\\"'.repeat(300),
              parentHarnessId: 'claude',
              description: 'Inspect',
              prompt: 'Prompt',
              finalText: 'Retained answer',
              executionMode: 'foreground',
              status: 'failed',
              outputTruncated: false,
              requestedModelId: 'model',
              runGeneration: 1,
              sequence: 0,
              parentTurnId: 'turn',
              parentToolCallId: 'call',
              createdAt: 1,
              selectedModelId: 'model',
              runtimeModelId: '',
              targetHarnessId: '',
            },
          ],
        },
        {
          id: 'child',
          role: 'assistant',
          timestamp: 2,
          parentBlockId: 'block',
          blocks: [{ type: 'text', text: 'STALE_SENTINEL' }],
        },
      ];
      const block = messages[0]?.blocks[0];
      if (!block) throw new Error('Missing fixture');
      // Deliberately inject unsupported persisted data without a type assertion.
      Object.assign(
        block,
        marker === 'invalid-card'
          ? { routeSnapshot: {} }
          : { transcriptStore: marker },
      );
      const projected = projectPersistedChatTranscript({
        scope: 'worktree',
        chatId: 'chat',
        messages,
      });
      const wire = JSON.stringify(projected);
      expect(wire).not.toContain('STALE_SENTINEL');
      if (marker === 'future-store') {
        expect(wire).toContain('Retained answer');
        expect(wire).toContain('Inspect');
        expect(wire).not.toContain('future-store');
      }
      expect(wire).toContain('subBlocksTruncated');
      expect(wire).toContain('snapshotTruncated');
      expect(Buffer.byteLength(wire, 'utf8')).toBeLessThanOrEqual(24 * 1024);
    },
  );
});
