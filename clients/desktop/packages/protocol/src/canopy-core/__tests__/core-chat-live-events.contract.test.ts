import { CANOPY_STREAM_DEFINITIONS } from '..';
import {
  CORE_CHAT_LIVE_STREAM_DEFINITIONS,
  CORE_STREAM_DEFINITIONS,
} from '../core';

const LIVE = CORE_CHAT_LIVE_STREAM_DEFINITIONS['core.chat.live.events'];
const SCOPE = { workspaceId: 'ws-1', worktreeId: 'task-1', chatId: 'chat-1' };

describe('live reply contract (CAN-5984)', () => {
  it('follows one chat with core.chat.read only', () => {
    expect(LIVE.requiredGrants).toEqual(['core.chat.read']);
    expect(LIVE.params.safeParse({ scope: SCOPE }).success).toBe(true);
    expect(LIVE.params.safeParse({ scope: SCOPE, cursor: null }).success).toBe(
      true,
    );
    expect(
      LIVE.params.safeParse({ scope: { workspaceId: 'ws-1' } }).success,
    ).toBe(false);
    expect(LIVE.params.safeParse({ scope: SCOPE, revision: 3 }).success).toBe(
      false,
    );
  });

  it('stays out of the registries the desktop core serves, so it answers capability_unavailable there', () => {
    expect(Object.keys(CORE_STREAM_DEFINITIONS)).not.toContain(
      'core.chat.live.events',
    );
    expect(Object.keys(CANOPY_STREAM_DEFINITIONS)).not.toContain(
      'core.chat.live.events',
    );
  });

  it('carries a whole reply, an append at held lengths, or idle, never a revision', () => {
    const turn = {
      kind: 'turn',
      chatId: 'chat-1',
      turnId: 'turn-1',
      promptMessageId: 'prompt-1',
      text: 'Hello',
      reasoning: '',
      state: 'streaming',
    };
    expect(LIVE.item.parse(turn)).toEqual(turn);
    expect(
      LIVE.item.safeParse({
        kind: 'append',
        chatId: 'chat-1',
        turnId: 'turn-1',
        textOffset: 5,
        text: ' world',
        reasoningOffset: 0,
        reasoning: '',
      }).success,
    ).toBe(true);
    expect(
      LIVE.item.safeParse({ kind: 'idle', chatId: 'chat-1' }).success,
    ).toBe(true);
    expect(LIVE.item.safeParse({ ...turn, revision: 4 }).success).toBe(false);
    expect(
      LIVE.item.safeParse({
        kind: 'append',
        chatId: 'chat-1',
        turnId: 'turn-1',
        textOffset: -1,
        text: 'x',
        reasoningOffset: 0,
        reasoning: '',
      }).success,
    ).toBe(false);
  });
});
