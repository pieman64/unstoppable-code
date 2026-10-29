import type {
  ChatEvent,
  ChatInterestDeclaration,
} from '@canopy/desktop-shared/types';
import {
  chatInterestKeys,
  ChatEventInterestFilter,
  shouldDropChatEvent,
} from '../ipc/chat-event-interest';

const x = { projectId: 'project', worktreeId: 'worktree', chatId: 'x' };
const y = { projectId: 'project', worktreeId: 'worktree', chatId: 'y' };
const interest: ChatInterestDeclaration = { focused: [x], warm: [] };
const codexUpdate = { type: 'codex', event: { type: 'item.updated' } };
const event = (chatId: string, data: unknown): ChatEvent => ({
  ...x,
  chatId,
  data,
});

describe('raw chat event interest', () => {
  it.each([
    ['undeclared', undefined, event('y', codexUpdate), false],
    ['focused', interest, event('x', codexUpdate), false],
    ['warm', { focused: [], warm: [y] }, event('y', codexUpdate), false],
    ['background', interest, event('y', codexUpdate), true],
    [
      'delegate frame',
      interest,
      event('y', { type: 'canopy_delegation', event: codexUpdate }),
      false,
    ],
    [
      'Claude content delta',
      interest,
      event('y', {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta' } },
      }),
      true,
    ],
    [
      'Claude tool input delta',
      interest,
      event('y', {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta' },
        },
      }),
      false,
    ],
    [
      'Claude message delta carries status',
      interest,
      event('y', { type: 'stream_event', event: { type: 'message_delta' } }),
      false,
    ],
    [
      'Claude stream system',
      interest,
      event('y', { type: 'stream_event', event: { type: 'message_start' } }),
      false,
    ],
    ...[
      { type: 'tool_use' },
      { type: 'tool_result' },
      { type: 'result' },
      { type: 'error' },
      { type: 'canopy_user_prompt_accepted' },
      { type: 'turn_diff' },
      { type: 'system' },
      { type: 'set_auto_archive_requested' },
      { type: 'codex', event: { type: 'item.started' } },
      { type: 'codex', event: { type: 'item.completed' } },
      { type: 'codex', event: { type: 'turn.completed' } },
    ].map((data) => [
      `always delivered ${String(data.type)} ${'event' in data ? String(data.event.type) : ''}`,
      interest,
      event('y', data),
      false,
    ]),
  ])('%s', (_name, declaration, message, expected) => {
    expect(
      shouldDropChatEvent(
        declaration ? chatInterestKeys(declaration) : undefined,
        message,
      ),
    ).toBe(expected);
  });

  it('rebuilds keys only when a declaration identity changes', () => {
    const filter = new ChatEventInterestFilter();
    const target = {};
    expect(filter.shouldDrop(target, interest, event('y', codexUpdate))).toBe(
      true,
    );
    expect(
      filter.shouldDrop(
        target,
        { focused: [y], warm: [] },
        event('y', codexUpdate),
      ),
    ).toBe(false);
  });
});
