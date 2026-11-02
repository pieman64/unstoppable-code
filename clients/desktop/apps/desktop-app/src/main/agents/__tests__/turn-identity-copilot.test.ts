const mockOpenManagedCopilotRuntime = jest.fn(() =>
  Promise.reject(new Error('inert runtime rejection')),
);
jest.mock('../delegation/gate', () => ({
  managedDelegationEnabled: (): boolean => false,
}));
jest.mock('../../copilot/connection', () => ({
  openManagedCopilotRuntime: (): Promise<never> =>
    mockOpenManagedCopilotRuntime(),
  assertCopilotConnectionGeneration: jest.fn(),
  assertCopilotModelAvailable: jest.fn(),
}));
jest.mock('@canopy/desktop-shared/node/copilot/turn-driver', () => ({
  runCopilotTurn: jest.fn(),
}));
jest.mock('../session-manager', () => ({
  // The session under test is its key's registered instance (CAN-4833).
  getSessionKeyOwnership: (): string => 'registered',
  buildSessionKey: (): string => 'turn-identity-copilot',
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
import { CopilotProvider } from '../copilot-session';
import { observeRoutedTurnBinding } from '../session-event-router';
import {
  releaseTurnLifecycleProducer,
  setTurnLifecycleSink,
} from '../provider-turn-lifecycle';

const scope = {
  projectId: 'turn-identity-project',
  worktreeId: 'turn-identity-worktree',
  chatId: 'turn-identity-copilot',
};

describe('Copilot producer turn identity baseline', () => {
  let events: ChatTurnLifecycleEvent[];

  beforeEach(() => {
    events = [];
    jest.mocked(observeRoutedTurnBinding).mockClear();
    mockOpenManagedCopilotRuntime.mockRejectedValue(
      new Error('inert runtime rejection'),
    );
    setTurnLifecycleSink((event) => events.push(event));
  });

  afterEach(() => {
    setTurnLifecycleSink(null);
    releaseTurnLifecycleProducer('copilot', scope);
  });

  function createSession(
    onEvent: (event: unknown) => void,
  ): ReturnType<CopilotProvider['createSession']> {
    return new CopilotProvider().createSession(
      {
        ...scope,
        cwd: '/unused',
        model: 'copilot:gpt-5',
        sdkSessionId: 'copilot-native-session',
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
      session.sendMessage('ordinary', { userMessageId: 'copilot-message-a' });
      await terminal;

      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'TurnStarted',
          provider: 'copilot',
          providerSessionId: 'copilot-native-session',
          turnId: 'copilot-message-a',
          origin: 'user',
          binding: 'bound',
          userMessageIds: ['copilot-message-a'],
        }),
      );
      expect(transcript[transcript.length - 1]).toMatchObject({
        canopy_turn_user_message_id: 'copilot-message-a',
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

      const start = events.find((event) => event.type === 'TurnStarted');
      expect(start).toMatchObject({
        provider: 'copilot',
        providerSessionId: 'copilot-native-session',
        origin: 'user',
        binding: 'unbound',
        userMessageIds: [],
      });
      expect(start?.type === 'TurnStarted' ? start.turnId : undefined).toMatch(
        /^[0-9a-f-]{36}$/,
      );
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
      session.sendMessage('first', { userMessageId: 'copilot-first' });

      expect(() =>
        session.sendMessage('second', { userMessageId: 'copilot-second' }),
      ).toThrow('Wait for the current Copilot turn to finish.');
      expect(
        events.filter((event) => event.type === 'TurnStarted'),
      ).toHaveLength(1);
      await terminal;
    } finally {
      await session.destroy();
    }
  });

  // Copilot retries are internal to one driver call; only sendMessage produces lifecycle T.

  it('two stopped resumes use distinct lifecycle T values while retaining A for output', async () => {
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
        userMessageId: 'copilot-stopped-anchor',
      });
      await session.cancel();

      session.sendMessage('resume stopped work', {
        userMessageId: 'copilot-stopped-anchor',
        lifecycleExecutionId: 'copilot-resume-execution-1',
      });
      await session.cancel();

      session.sendMessage('resume stopped work again', {
        userMessageId: 'copilot-stopped-anchor',
        lifecycleExecutionId: 'copilot-resume-execution-2',
      });
      await thirdTerminal;

      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'TurnEnded',
          provider: 'copilot',
          turnId: 'copilot-stopped-anchor',
          outcome: 'cancelled',
        }),
      );
      const starts = events.filter((event) => event.type === 'TurnStarted');
      expect(starts).toHaveLength(3);
      expect(starts[0]).toMatchObject({
        turnId: 'copilot-stopped-anchor',
        userMessageIds: ['copilot-stopped-anchor'],
      });
      expect(starts[1]).toMatchObject({
        turnId: 'copilot-resume-execution-1',
        userMessageIds: ['copilot-stopped-anchor'],
      });
      expect(starts[2]).toMatchObject({
        turnId: 'copilot-resume-execution-2',
        userMessageIds: ['copilot-stopped-anchor'],
      });
      expect(transcript[transcript.length - 1]).toMatchObject({
        canopy_turn_user_message_id: 'copilot-stopped-anchor',
      });
      expect(observeRoutedTurnBinding).toHaveBeenCalledWith(
        scope,
        session,
        ['copilot-stopped-anchor'],
        undefined,
        'copilot-resume-execution-2',
      );
    } finally {
      await session.destroy();
    }
  });
});
