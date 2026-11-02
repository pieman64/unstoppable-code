import {
  applyCodexTranscriptEvent,
  createEmptyTranscriptReducerState,
  parseAgentTranscriptLines,
  type TranscriptReducerState,
} from '../transcript-parser';
import { buildSubagentTree } from '../subagent-tree/index';
import { collectLoadedSubagentInputs } from '../subagent-tree/native-inputs';

const ROOT = 'root-thread';
const CHILD = 'child-thread';

function apply(
  state: TranscriptReducerState,
  event: Record<string, unknown>,
  now: number,
): TranscriptReducerState {
  let id = state.messages.length;
  return applyCodexTranscriptEvent(state, event, {
    now,
    createMessageId: () => `message-${(id += 1)}`,
    childToolLiveness: { kind: 'unknown' },
  });
}

function receiverTimes(state: TranscriptReducerState): unknown {
  for (const message of state.messages)
    for (const block of message.blocks)
      if (block.type === 'codex_agent_call') return block.receiverTimes;
  return undefined;
}

function spawned(): TranscriptReducerState {
  let state = createEmptyTranscriptReducerState();
  state = apply(state, { type: 'thread.started', thread_id: ROOT }, 1);
  state = apply(
    state,
    { type: 'turn.started', thread_id: ROOT, turn_id: 'root-turn' },
    2,
  );
  return apply(
    state,
    {
      type: 'item.completed',
      thread_id: ROOT,
      turn_id: 'root-turn',
      item: {
        id: 'spawn-1',
        type: 'collab_agent_tool_call',
        tool: 'spawnAgent',
        status: 'completed',
        sender_thread_id: ROOT,
        receiver_thread_ids: [CHILD],
        prompt: 'Run the tests',
        agents_states: { [CHILD]: { status: 'running', message: null } },
      },
    },
    3,
  );
}

describe('Codex child turn times (CAN-5203)', () => {
  it("records a child thread's first start and its turn's end on its card", () => {
    let state = apply(
      spawned(),
      { type: 'turn.started', thread_id: CHILD, turn_id: 'child-1' },
      10,
    );
    expect(receiverTimes(state)).toEqual({ [CHILD]: { startedAt: 10 } });
    state = apply(
      state,
      {
        type: 'turn.completed',
        thread_id: CHILD,
        turn_id: 'child-1',
        status: 'completed',
      },
      20,
    );
    expect(receiverTimes(state)).toEqual({
      [CHILD]: { startedAt: 10, settledAt: 20 },
    });
    // A later turn keeps the first start and runs until it ends.
    state = apply(
      state,
      { type: 'turn.started', thread_id: CHILD, turn_id: 'child-2' },
      30,
    );
    expect(receiverTimes(state)).toEqual({ [CHILD]: { startedAt: 10 } });
    state = apply(
      state,
      {
        type: 'turn.failed',
        thread_id: CHILD,
        turn_id: 'child-2',
        error: { message: 'Tests failed.' },
      },
      40,
    );
    expect(receiverTimes(state)).toEqual({
      [CHILD]: { startedAt: 10, settledAt: 40 },
    });
    // The failure's own error event reports the same turn's end.
    state = apply(
      state,
      { type: 'error', thread_id: CHILD, message: 'Tests failed.' },
      41,
    );
    expect(receiverTimes(state)).toEqual({
      [CHILD]: { startedAt: 10, settledAt: 40 },
    });
  });

  it("times a replayed child turn by its events, not the transcript's line numbers", () => {
    const startedAt = Date.parse('2026-10-13T10:00:00.000Z');
    const lines = [
      { type: 'thread.started', thread_id: ROOT },
      { type: 'turn.started', thread_id: ROOT, turn_id: 'root-turn' },
      {
        type: 'item.completed',
        thread_id: ROOT,
        turn_id: 'root-turn',
        item: {
          id: 'spawn-1',
          type: 'collab_agent_tool_call',
          tool: 'spawnAgent',
          status: 'completed',
          sender_thread_id: ROOT,
          receiver_thread_ids: [CHILD],
          prompt: 'Run the tests',
          agents_states: { [CHILD]: { status: 'running', message: null } },
        },
      },
      {
        type: 'turn.started',
        thread_id: CHILD,
        turn_id: 'child-1',
        timestamp: new Date(startedAt).toISOString(),
      },
      {
        type: 'turn.completed',
        thread_id: CHILD,
        turn_id: 'child-1',
        status: 'completed',
        timestamp: new Date(startedAt + 50_000).toISOString(),
      },
    ].map((line) => JSON.stringify(line));
    const { messages } = parseAgentTranscriptLines(lines, 'codex');
    const tree = buildSubagentTree({
      root: { id: 'root-chat', title: 'Root chat' },
      managed: [],
      codexNative: collectLoadedSubagentInputs(messages).codexNative,
      codexRootThreadId: ROOT,
    });
    const node = Array.from(tree.nodes.values()).find(
      (candidate) => candidate.kind === 'codex-native',
    );
    expect(node).toMatchObject({ startedAt, settledAt: startedAt + 50_000 });
  });

  it('records nothing for the root thread', () => {
    const state = apply(
      spawned(),
      { type: 'turn.completed', thread_id: ROOT, turn_id: 'root-turn' },
      50,
    );
    expect(receiverTimes(state)).toBeUndefined();
  });
});
