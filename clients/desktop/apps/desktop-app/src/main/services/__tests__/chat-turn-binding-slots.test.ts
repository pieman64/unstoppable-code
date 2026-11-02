import {
  initialChatTurnState,
  serializeChatTurnState,
} from '@canopy/agent-transcript/turn';
import {
  isCurrentTurnBindingFull,
  releaseTurnBindingSlot,
  reservePromptBindingSlot,
  reserveTurnBindingSlot,
  resetTurnBindingSlotsForTests,
} from '../chat-turn-binding-slots';
import { getChatTurnOwnership } from '../chat-turn-ownership';

const SCOPE = { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' };

let current: { id: string; inputIds: string[] } | undefined;

beforeEach(() => {
  resetTurnBindingSlotsForTests();
  current = undefined;
  const ownership = getChatTurnOwnership();
  const snapshot = ownership.getSnapshot(SCOPE);
  jest.spyOn(ownership, 'getSnapshot').mockImplementation(() => {
    const state = serializeChatTurnState({
      ...initialChatTurnState(),
      ...(current
        ? {
            current: {
              id: current.id,
              origin: 'user',
              startedAtMs: 1,
              pauses: [],
              inputIds: current.inputIds,
            },
          }
        : {}),
    });
    return { ...snapshot, receipt: { generation: 1, state } };
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

const ids = (count: number, prefix = 'input'): string[] =>
  Array.from({ length: count }, (_, index) => `${prefix}-${index}`);

it('reserves up to 64 distinct inputs per turn, counting bound ones', () => {
  current = { id: 'turn-1', inputIds: ids(60, 'bound') };
  for (const id of ids(4)) expect(reserveTurnBindingSlot(SCOPE, id)).toBe(true);
  expect(isCurrentTurnBindingFull(SCOPE)).toBe(true);
  expect(reserveTurnBindingSlot(SCOPE, 'input-65')).toBe(false);
  // A bound or retried id reuses its slot.
  expect(reserveTurnBindingSlot(SCOPE, 'bound-0')).toBe(true);
  expect(reserveTurnBindingSlot(SCOPE, 'input-3')).toBe(true);
});

it('frees a slot only on release', () => {
  current = { id: 'turn-1', inputIds: ids(63, 'bound') };
  expect(reserveTurnBindingSlot(SCOPE, 'steer-1')).toBe(true);
  expect(reserveTurnBindingSlot(SCOPE, 'steer-2')).toBe(false);
  releaseTurnBindingSlot(SCOPE, 'steer-1');
  expect(reserveTurnBindingSlot(SCOPE, 'steer-2')).toBe(true);
});

it('starts a new turn with 64 slots', () => {
  current = { id: 'turn-1', inputIds: ids(64, 'bound') };
  expect(reserveTurnBindingSlot(SCOPE, 'next')).toBe(false);
  current = { id: 'turn-2', inputIds: [] };
  expect(isCurrentTurnBindingFull(SCOPE)).toBe(false);
  expect(reserveTurnBindingSlot(SCOPE, 'next')).toBe(true);
});

it('counts inputs reserved before the turn is known against it', () => {
  for (const id of ids(2)) expect(reserveTurnBindingSlot(SCOPE, id)).toBe(true);
  current = { id: 'turn-1', inputIds: ids(62, 'bound') };
  expect(isCurrentTurnBindingFull(SCOPE)).toBe(true);
  expect(reserveTurnBindingSlot(SCOPE, 'late')).toBe(false);
});

it('counts a prompt sent before its turn starts, and lets unstarted reservations lapse', () => {
  for (const id of ids(3, 'unstarted')) reserveTurnBindingSlot(SCOPE, id);
  reservePromptBindingSlot(SCOPE, 'prompt');
  current = { id: 'turn-1', inputIds: ids(60, 'bound') };
  // 60 bound plus the prompt: three slots remain.
  for (const id of ids(3, 'steer'))
    expect(reserveTurnBindingSlot(SCOPE, id)).toBe(true);
  expect(reserveTurnBindingSlot(SCOPE, 'one-more')).toBe(false);
});

it('reserves a prompt sent into a current turn against it', () => {
  current = { id: 'turn-1', inputIds: ids(63, 'bound') };
  reservePromptBindingSlot(SCOPE, 'prompt');
  expect(isCurrentTurnBindingFull(SCOPE)).toBe(true);
});
