import {
  CANOPY_AUTH_FAILURE_EVENT_TYPE,
  type AuthDependencyFailure,
} from '@canopy/protocol';
import {
  applyClaudeTranscriptEvent,
  applyCodexTranscriptEvent,
  createEmptyTranscriptReducerState,
  parseAgentTranscriptLines,
  type TranscriptReducerOptions,
  type TranscriptReducerState,
} from '../transcript-parser';
import type { PersistedChatMessage } from '../../types';

const mcpFailure: AuthDependencyFailure = {
  dependencyClass: 'mcp',
  dependencyId: 'srv-1:cfg-1',
  displayName: 'Prod MCP server',
  failureClass: 'expired',
  recovery: { kind: 'mcp_oauth', serverId: 'srv-1', configId: 'cfg-1' },
};

const providerFailure: AuthDependencyFailure = {
  dependencyClass: 'provider',
  dependencyId: 'claude',
  displayName: 'Claude',
  failureClass: 'unauthenticated',
  recovery: { kind: 'provider_terminal', provider: 'claude' },
};

const options: TranscriptReducerOptions = {
  now: 1_700_000_000_000,
  createMessageId: () => 'generated-id',
};

function stateWith(messages: PersistedChatMessage[]): TranscriptReducerState {
  return { ...createEmptyTranscriptReducerState(), messages };
}

describe('applyClaudeTranscriptEvent canopy_auth_failure', () => {
  it('writes authFailure onto the matching tool_result block', () => {
    // The reducer is the persistence path: main reduces provider events into
    // durable chat state, so without this branch nothing was ever written with
    // the field and the renderer-only attach was lost on reload (CAN-1814).
    const next = applyClaudeTranscriptEvent(
      stateWith([
        {
          id: 'msg-1',
          role: 'assistant',
          timestamp: 1,
          blocks: [
            {
              type: 'tool_result',
              toolUseId: 'tu-1',
              toolName: 'mcp__prod__query',
              output: 'MCP error -32001: MCP server authorization required',
              isError: true,
            },
          ],
        },
      ]),
      {
        type: CANOPY_AUTH_FAILURE_EVENT_TYPE,
        toolUseId: 'tu-1',
        failure: mcpFailure,
      },
      options,
    );

    const block = next.messages[0].blocks[0];
    expect(block.type === 'tool_result' && block.authFailure).toEqual(
      mcpFailure,
    );
  });

  it("writes a provider failure onto the turn's system notice when there is no toolUseId", () => {
    const next = applyClaudeTranscriptEvent(
      stateWith([
        {
          id: 'msg-1',
          role: 'assistant',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'Working on it.' }],
        },
        {
          id: 'msg-2',
          role: 'system',
          timestamp: 2,
          blocks: [
            { type: 'text', text: 'Error: Claude is not authenticated.' },
          ],
        },
      ]),
      { type: CANOPY_AUTH_FAILURE_EVENT_TYPE, failure: providerFailure },
      options,
    );

    const earlier = next.messages[0].blocks[0];
    const target = next.messages[1].blocks[0];
    expect(earlier.type === 'text' && earlier.authFailure).toBeUndefined();
    expect(target.type === 'text' && target.authFailure).toEqual(
      providerFailure,
    );
  });

  // The three tests below drive the REAL terminal provider events that make
  // `buildProviderAuthFailureEvent` fire, instead of pre-seeding a convenient
  // `system` text message. Two of the three shapes create no block at all, and
  // the anchor they used to fall back to is durably persisted (CAN-1814
  // review).

  it('attaches to the system notice a recognized Claude auth result creates', () => {
    let state = createEmptyTranscriptReducerState();
    state = applyClaudeTranscriptEvent(
      state,
      {
        type: 'canopy_user_prompt',
        original_text: 'Look up the account records.',
        provider: 'claude',
      },
      options,
    );
    state = applyClaudeTranscriptEvent(
      state,
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Sure, one moment.' }] },
      },
      options,
    );
    // Emission ordering: main emits the auth-failure event AFTER this terminal
    // event, so the system notice this event writes already exists.
    state = applyClaudeTranscriptEvent(
      state,
      {
        type: 'result',
        is_error: true,
        api_error_status: 401,
        result:
          'Please run /login - API Error: 401 Invalid authentication credentials',
      },
      options,
    );
    const next = applyClaudeTranscriptEvent(
      state,
      { type: CANOPY_AUTH_FAILURE_EVENT_TYPE, failure: providerFailure },
      options,
    );

    const notice = next.messages[next.messages.length - 1];
    expect(notice.role).toBe('system');
    const noticeBlock = notice.blocks[0];
    expect(noticeBlock.type === 'text' && noticeBlock.authFailure).toEqual(
      providerFailure,
    );
    for (const message of next.messages.slice(0, -1)) {
      for (const block of message.blocks) {
        expect(block.type === 'text' && block.authFailure).toBeFalsy();
      }
    }
  });

  it('never lands a provider failure on the user prompt bubble', () => {
    // `{ type: 'result', is_error: true }` with an UNrecognized message writes
    // no block, so the only text block in the transcript is the user's own
    // prompt. Attaching there would pin 'Reconnect Claude' to what the user
    // typed.
    let state = createEmptyTranscriptReducerState();
    state = applyClaudeTranscriptEvent(
      state,
      {
        type: 'canopy_user_prompt',
        original_text: 'Look up the account records.',
        provider: 'claude',
      },
      options,
    );
    state = applyClaudeTranscriptEvent(
      state,
      {
        type: 'result',
        is_error: true,
        api_error_status: 401,
        result: 'Invalid API key \u00b7 Please run /login',
      },
      options,
    );
    const next = applyClaudeTranscriptEvent(
      state,
      { type: CANOPY_AUTH_FAILURE_EVENT_TYPE, failure: providerFailure },
      options,
    );

    expect(next).toBe(state);
    const prompt = next.messages[0];
    expect(prompt.role).toBe('user');
    const promptBlock = prompt.blocks[0];
    expect(promptBlock.type === 'text' && promptBlock.authFailure).toBeFalsy();
  });

  it('never lands a provider failure on an unrelated mid-turn system message', () => {
    // The 401-status shape with an UNrecognized `result` body writes no
    // notice, so the newest `system` text message in the turn was whatever
    // happened to be there — a helper diagnostic here. Anchoring on 'any
    // system message with a text block' silently pinned 'Reconnect Claude' to
    // it, and that anchor is durably persisted (CAN-1814 review round 2).
    let state = createEmptyTranscriptReducerState();
    state = applyClaudeTranscriptEvent(
      state,
      {
        type: 'canopy_user_prompt',
        original_text: 'Look up the account records.',
        provider: 'claude',
      },
      options,
    );
    state = applyClaudeTranscriptEvent(
      state,
      {
        type: 'canopy_helper_diagnostic',
        helper: 'branch_naming',
        outcome: 'skipped',
      },
      options,
    );
    state = applyClaudeTranscriptEvent(
      state,
      {
        type: 'result',
        is_error: true,
        api_error_status: 401,
        result: 'Invalid API key \u00b7 Please run /login',
      },
      options,
    );

    const next = applyClaudeTranscriptEvent(
      state,
      { type: CANOPY_AUTH_FAILURE_EVENT_TYPE, failure: providerFailure },
      options,
    );

    expect(next).toBe(state);
    for (const message of next.messages) {
      for (const block of message.blocks) {
        expect(block.type === 'text' && block.authFailure).toBeFalsy();
      }
    }
  });

  it('attaches to the system notice a Claude `error` event creates', () => {
    // `handleClaudeErrorEvent` writes `Error: <message>`; that IS an anchor the
    // reducer authored for this failure, so it must keep attaching.
    let state = createEmptyTranscriptReducerState();
    state = applyClaudeTranscriptEvent(
      state,
      {
        type: 'canopy_user_prompt',
        original_text: 'Look up the account records.',
        provider: 'claude',
      },
      options,
    );
    state = applyClaudeTranscriptEvent(
      state,
      {
        type: 'canopy_helper_diagnostic',
        helper: 'branch_naming',
        outcome: 'skipped',
      },
      options,
    );
    state = applyClaudeTranscriptEvent(
      state,
      { type: 'error', error: 'Claude is not authenticated.' },
      options,
    );

    const next = applyClaudeTranscriptEvent(
      state,
      { type: CANOPY_AUTH_FAILURE_EVENT_TYPE, failure: providerFailure },
      options,
    );

    const notice = next.messages[next.messages.length - 1];
    expect(notice.role).toBe('system');
    const noticeBlock = notice.blocks[0];
    expect(noticeBlock.type === 'text' && noticeBlock.text).toBe(
      'Error: Claude is not authenticated.',
    );
    expect(noticeBlock.type === 'text' && noticeBlock.authFailure).toEqual(
      providerFailure,
    );
    for (const message of next.messages.slice(0, -1)) {
      for (const block of message.blocks) {
        expect(block.type === 'text' && block.authFailure).toBeFalsy();
      }
    }
  });

  it('never lands a provider failure on an unrelated mid-turn assistant message', () => {
    // `{ type: 'assistant', error: 'authentication_failed' }` is one of the
    // shapes `classifyAgentFailure` accepts, and it too writes no block.
    let state = createEmptyTranscriptReducerState();
    state = applyClaudeTranscriptEvent(
      state,
      {
        type: 'canopy_user_prompt',
        original_text: 'Look up the account records.',
        provider: 'claude',
      },
      options,
    );
    state = applyClaudeTranscriptEvent(
      state,
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Sure, one moment.' }] },
      },
      options,
    );
    state = applyClaudeTranscriptEvent(
      state,
      { type: 'assistant', error: 'authentication_failed' },
      options,
    );
    const next = applyClaudeTranscriptEvent(
      state,
      { type: CANOPY_AUTH_FAILURE_EVENT_TYPE, failure: providerFailure },
      options,
    );

    expect(next).toBe(state);
    for (const message of next.messages) {
      for (const block of message.blocks) {
        expect(block.type === 'text' && block.authFailure).toBeFalsy();
      }
    }
  });

  it("anchors past a mid-turn Codex error item onto the turn's terminal notice", () => {
    // `upsertCodexItem`'s `case 'error'` is a FOURTH writer of a `system`
    // message whose text starts with `Error: ` — one
    // `isAuthoredFailureNoticeText` accepts and `findProviderFailureAnchor`
    // would match (CAN-1814 review round 3). It is not an intended anchor.
    // What keeps it from winning is ordering: the walk is newest-first, and a
    // Codex turn that fails writes its terminal notice AFTER any mid-turn item
    // error. Pin that, because the safety of the fourth writer rests on it.
    const codexProviderFailure: AuthDependencyFailure = {
      dependencyClass: 'provider',
      dependencyId: 'codex',
      displayName: 'Codex',
      failureClass: 'unauthenticated',
      recovery: { kind: 'provider_terminal', provider: 'codex' },
    };
    let state = createEmptyTranscriptReducerState();
    state = applyCodexTranscriptEvent(
      state,
      {
        type: 'canopy_user_prompt',
        original_text: 'Look up the account records.',
        provider: 'codex',
      },
      options,
    );
    state = applyCodexTranscriptEvent(
      state,
      {
        type: 'item.completed',
        item: { id: 'item-1', type: 'error', message: 'mid-turn hiccup' },
      },
      options,
    );
    state = applyCodexTranscriptEvent(
      state,
      {
        type: 'turn.failed',
        error: { message: 'Unauthorized' },
      },
      options,
    );

    const next = applyCodexTranscriptEvent(
      state,
      { type: CANOPY_AUTH_FAILURE_EVENT_TYPE, failure: codexProviderFailure },
      options,
    );

    // Guard the guard: the mid-turn item error must really have written a
    // matching notice, or this test would pass on an absent message.
    expect(
      state.messages.some(
        (message) =>
          message.role === 'system' &&
          message.blocks.some(
            (block) =>
              block.type === 'text' && block.text === 'Error: mid-turn hiccup',
          ),
      ),
    ).toBe(true);

    const anchored = next.messages.filter((message) =>
      message.blocks.some(
        (block) => block.type === 'text' && block.authFailure !== undefined,
      ),
    );
    expect(anchored).toHaveLength(1);
    const anchoredBlock = anchored[0].blocks.find(
      (block) => block.type === 'text' && block.authFailure !== undefined,
    );
    expect(anchoredBlock?.type).toBe('text');
    if (anchoredBlock?.type !== 'text') {
      throw new Error('Expected the anchor to be a text block');
    }
    expect(anchoredBlock.text).toBe('Error: Unauthorized');
    expect(anchoredBlock.text).not.toContain('mid-turn hiccup');
  });

  it('lets a mid-turn Codex error item take the anchor when nothing newer wrote one', () => {
    // The residue the corrected comment names. Reachable only if a terminal
    // Codex shape that writes NO notice is ever classified as an auth failure;
    // today `turn.failed` / `error` both write one, so this configuration does
    // not occur in production. Pinned so the fourth writer's behavior is
    // visible rather than an unstated assumption.
    const codexProviderFailure: AuthDependencyFailure = {
      dependencyClass: 'provider',
      dependencyId: 'codex',
      displayName: 'Codex',
      failureClass: 'unauthenticated',
      recovery: { kind: 'provider_terminal', provider: 'codex' },
    };
    let state = createEmptyTranscriptReducerState();
    state = applyCodexTranscriptEvent(
      state,
      {
        type: 'canopy_user_prompt',
        original_text: 'Look up the account records.',
        provider: 'codex',
      },
      options,
    );
    state = applyCodexTranscriptEvent(
      state,
      {
        type: 'item.completed',
        item: { id: 'item-1', type: 'error', message: 'mid-turn hiccup' },
      },
      options,
    );

    const next = applyCodexTranscriptEvent(
      state,
      { type: CANOPY_AUTH_FAILURE_EVENT_TYPE, failure: codexProviderFailure },
      options,
    );

    const anchored = next.messages.filter((message) =>
      message.blocks.some(
        (block) => block.type === 'text' && block.authFailure !== undefined,
      ),
    );
    expect(anchored).toHaveLength(1);
    const anchoredBlock = anchored[0].blocks.find(
      (block) => block.type === 'text' && block.authFailure !== undefined,
    );
    if (anchoredBlock?.type !== 'text') {
      throw new Error('Expected the anchor to be a text block');
    }
    expect(anchoredBlock.text).toBe('Error: mid-turn hiccup');
  });

  it('returns the state unchanged when the toolUseId matches nothing', () => {
    const state = stateWith([
      {
        id: 'msg-1',
        role: 'assistant',
        timestamp: 1,
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'other',
            toolName: 'mcp__prod__query',
            output: 'ok',
            isError: false,
          },
        ],
      },
    ]);

    expect(
      applyClaudeTranscriptEvent(
        state,
        {
          type: CANOPY_AUTH_FAILURE_EVENT_TYPE,
          toolUseId: 'tu-1',
          failure: mcpFailure,
        },
        options,
      ),
    ).toBe(state);
  });

  it('returns the state unchanged for a malformed or semantically invalid payload', () => {
    const state = stateWith([
      {
        id: 'msg-1',
        role: 'assistant',
        timestamp: 1,
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'tu-1',
            toolName: 'mcp__prod__query',
            output: 'boom',
            isError: true,
          },
        ],
      },
    ]);

    expect(
      applyClaudeTranscriptEvent(
        state,
        {
          type: CANOPY_AUTH_FAILURE_EVENT_TYPE,
          toolUseId: 'tu-1',
          failure: { dependencyClass: 'mcp' },
        },
        options,
      ),
    ).toBe(state);
    expect(
      applyClaudeTranscriptEvent(
        state,
        {
          type: CANOPY_AUTH_FAILURE_EVENT_TYPE,
          toolUseId: 'tu-1',
          // quota_exceeded is not recoverable, so pairing it with mcp_oauth
          // violates the wire invariant and must not reach a block.
          failure: { ...mcpFailure, failureClass: 'quota_exceeded' },
        },
        options,
      ),
    ).toBe(state);
  });
});

describe('parseAgentTranscriptLines canopy_auth_failure', () => {
  // JSONL replay is the web Portal's path, and it is the reason this wire
  // model lives in `@canopy/protocol` at all. Omitting the event type from the
  // `canopy_*` allowlist dropped it on the floor there (CAN-1814 review).
  it.each([
    ['claude', { type: 'error', error: 'Claude is not authenticated.' }],
    ['codex', { type: 'turn.failed', error: { message: 'Unauthorized' } }],
  ])(
    'replays a %s transcript with the auth failure intact',
    (provider, terminalEvent) => {
      // The helper diagnostic is here deliberately: it is a `system` text
      // message inside the same turn, and it must NOT collect the failure
      // (CAN-1814 review round 2).
      const lines = [
        JSON.stringify({
          type: 'canopy_user_prompt',
          original_text: 'Look up the account records.',
          provider,
        }),
        JSON.stringify({
          type: 'canopy_helper_diagnostic',
          message: "You're not signed in to Claude.",
        }),
        JSON.stringify(terminalEvent),
        JSON.stringify({
          type: CANOPY_AUTH_FAILURE_EVENT_TYPE,
          failure: providerFailure,
        }),
      ];

      const parsed = parseAgentTranscriptLines(lines);
      const attached = parsed.messages
        .flatMap((message) => message.blocks)
        .filter((block) => block.type === 'text' && block.authFailure);

      expect(attached).toHaveLength(1);
      const [block] = attached;
      expect(block.type === 'text' && block.text).toBe(
        provider === 'claude'
          ? 'Error: Claude is not authenticated.'
          : 'Error: Unauthorized',
      );
    },
  );
});
