const mockAssertCursorHarnessEnabled = jest.fn<void, []>();
const mockReadPreferencesFile = jest.fn<
  Promise<{ cursorEnabled: boolean }>,
  []
>(() => Promise.resolve({ cursorEnabled: false }));
jest.mock('../../cursor/feature-flag', () => ({
  assertCursorHarnessEnabled: (): void => mockAssertCursorHarnessEnabled(),
}));
jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<{ cursorEnabled: boolean }> =>
    mockReadPreferencesFile(),
}));
jest.mock('@canopy/desktop-shared/node/cursor/turn-driver', () => ({
  runCursorTurn: jest.fn(),
}));
jest.mock('../../cursor/approval-check', () => ({
  verifyCursorVersion: jest.fn(),
}));
jest.mock('../../cursor/connection', () => ({
  getManagedCursorRuntime: jest.fn(),
}));
jest.mock('electron', () => ({ app: { isPackaged: false } }));
jest.mock('../session-manager', () => ({
  // The session under test is its key's registered instance (CAN-4833).
  getSessionKeyOwnership: (): string => 'registered',
  buildSessionKey: (): string => 'turn-identity-cursor',
  drainChatSessionEvents: jest.fn(() => Promise.resolve()),
  markTurnActive: jest.fn(),
  markTurnIdle: jest.fn(),
  recordSessionEvent: jest.fn(),
  registerSession: jest.fn(),
}));
jest.mock('../session-event-router', () => ({
  observeRoutedTurnBinding: jest.fn(),
}));

import type { ChatTurnLifecycleEvent } from '@canopy/protocol/canopy-core';
import { CursorProvider } from '../cursor-session';
import { observeRoutedTurnBinding } from '../session-event-router';
import {
  releaseTurnLifecycleProducer,
  setTurnLifecycleSink,
} from '../provider-turn-lifecycle';

const scope = {
  projectId: 'turn-identity-project',
  worktreeId: 'turn-identity-worktree',
  chatId: 'turn-identity-cursor',
};

describe('Cursor producer turn identity baseline', () => {
  let events: ChatTurnLifecycleEvent[];

  beforeEach(() => {
    events = [];
    jest.mocked(observeRoutedTurnBinding).mockClear();
    mockReadPreferencesFile.mockResolvedValue({ cursorEnabled: false });
    setTurnLifecycleSink((event) => events.push(event));
  });

  afterEach(() => {
    setTurnLifecycleSink(null);
    releaseTurnLifecycleProducer('cursor', scope);
  });

  function createSession(
    onEvent: (event: unknown) => void,
  ): ReturnType<CursorProvider['createSession']> {
    return new CursorProvider().createSession(
      {
        ...scope,
        cwd: '/unused',
        model: 'cursor-default',
        sdkSessionId: 'cursor-native-session',
      },
      onEvent,
      () => null,
    );
  }

  function isTerminal(event: unknown): boolean {
    return (
      typeof event === 'object' &&
      event !== null &&
      'type' in event &&
      (event.type === 'error' || event.type === 'result')
    );
  }

  it('ordinary send uses supplied A as lifecycle T and keeps provider session identity separate', async () => {
    let finish: () => void = () => undefined;
    const terminal = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const transcript: unknown[] = [];
    const session = createSession((event) => {
      transcript.push(event);
      if (isTerminal(event)) finish();
    });
    try {
      session.sendMessage('ordinary', { userMessageId: 'cursor-message-a' });
      await terminal;

      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'TurnStarted',
          provider: 'cursor',
          providerSessionId: 'cursor-native-session',
          turnId: 'cursor-message-a',
          origin: 'user',
          binding: 'bound',
          userMessageIds: ['cursor-message-a'],
        }),
      );
      expect(transcript[transcript.length - 1]).toMatchObject({
        canopy_turn_user_message_id: 'cursor-message-a',
      });
    } finally {
      await session.destroy();
    }
  });

  it('autonomous wake is not adapter-owned: host dispatch without A is an unbound user T', async () => {
    let finish: () => void = () => undefined;
    const terminal = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const session = createSession((event) => {
      if (isTerminal(event)) finish();
    });
    try {
      session.sendMessage('host-generated wake');
      await terminal;

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'TurnStarted',
            provider: 'cursor',
            providerSessionId: 'cursor-native-session',
            origin: 'user',
            binding: 'unbound',
            userMessageIds: [],
          }),
        ]),
      );
      const wakeStart = events.find((event) => event.type === 'TurnStarted');
      if (wakeStart?.type !== 'TurnStarted')
        throw new Error('Expected an ordinary host-dispatched start');
      expect(wakeStart.turnId).toMatch(/^[0-9a-f-]{36}$/);
      expect(
        events.filter(
          (event) =>
            event.type === 'TurnStarted' && event.origin === 'autonomous',
        ),
      ).toHaveLength(0);
    } finally {
      await session.destroy();
    }
  });

  it('merged send has no producer because an active send rejects a second start', async () => {
    let finish: () => void = () => undefined;
    const terminal = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const session = createSession((event) => {
      if (isTerminal(event)) finish();
    });
    try {
      session.sendMessage('first', { userMessageId: 'cursor-first' });

      expect(() =>
        session.sendMessage('second', { userMessageId: 'cursor-second' }),
      ).toThrow('Wait for the current Cursor turn to finish.');
      expect(
        events.filter((event) => event.type === 'TurnStarted'),
      ).toHaveLength(1);
      await terminal;
    } finally {
      await session.destroy();
    }
  });

  // Cursor retries/reloads are internal to one driver call; only sendMessage produces lifecycle T.

  it('stopped resume uses a fresh lifecycle T while retaining A for output placement', async () => {
    let terminalCount = 0;
    const transcript: unknown[] = [];
    let finishThird: () => void = () => undefined;
    const thirdTerminal = new Promise<void>((resolve) => {
      finishThird = resolve;
    });
    const session = createSession((event) => {
      transcript.push(event);
      if (!isTerminal(event)) return;
      terminalCount += 1;
      if (terminalCount === 3) finishThird();
    });
    try {
      session.sendMessage('stopped work', {
        userMessageId: 'cursor-stopped-anchor',
      });
      await session.cancel();

      session.sendMessage('resume stopped work', {
        userMessageId: 'cursor-stopped-anchor',
        lifecycleExecutionId: 'cursor-resume-execution-1',
      });
      await session.cancel();

      session.sendMessage('resume stopped work again', {
        userMessageId: 'cursor-stopped-anchor',
        lifecycleExecutionId: 'cursor-resume-execution-2',
      });
      await thirdTerminal;

      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'TurnEnded',
          provider: 'cursor',
          turnId: 'cursor-stopped-anchor',
          outcome: 'cancelled',
        }),
      );
      const starts = events.filter((event) => event.type === 'TurnStarted');
      expect(starts).toHaveLength(3);
      expect(starts[0]).toMatchObject({
        turnId: 'cursor-stopped-anchor',
        userMessageIds: ['cursor-stopped-anchor'],
      });
      expect(starts[1]).toMatchObject({
        turnId: 'cursor-resume-execution-1',
        userMessageIds: ['cursor-stopped-anchor'],
      });
      expect(starts[2]).toMatchObject({
        turnId: 'cursor-resume-execution-2',
        userMessageIds: ['cursor-stopped-anchor'],
      });
      expect(transcript[transcript.length - 1]).toMatchObject({
        canopy_turn_user_message_id: 'cursor-stopped-anchor',
      });
      expect(observeRoutedTurnBinding).toHaveBeenCalledWith(
        scope,
        session,
        ['cursor-stopped-anchor'],
        undefined,
        'cursor-resume-execution-2',
      );
    } finally {
      await session.destroy();
    }
  });
});
