import type { PersistedChatMessage } from '@canopy/agent-transcript';
import {
  persistedMessageToPortalMessage,
  projectPersistedChatTranscript,
} from '../persisted-chat-projection';
import { createPortalTurnTimer } from '../runtime-chat-projection';
import { DEFAULT_MODEL, getModelDisplayName } from '../../types';

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

  it('carries the routed model on the live portal turn timer', () => {
    const timer = createPortalTurnTimer({
      chatId: 'chat-1',
      userMessageId: 'u1',
      autoRoutedModel: {
        autoRoutedModel: 'claude-haiku-4-5',
        autoRoutedModelLabel: 'Claude Haiku 4.5',
      },
    });
    expect(timer.startMessage.parts?.[0]?.data).toMatchObject({
      autoRoutedModel: 'claude-haiku-4-5',
      autoRoutedModelLabel: 'Claude Haiku 4.5',
    });
    expect(timer.finalize()?.parts?.[0]?.data).toMatchObject({
      autoRoutedModel: 'claude-haiku-4-5',
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
