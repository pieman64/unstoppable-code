import type {
  ConversationHostIdentity,
  ConversationPresentation,
  ConversationProjectedMessage,
} from '@canopy/app-core/conversation';
import {
  runConversationHostConformance,
  type ConversationConformanceHost,
} from '../conformance';

// Desktop host fixture: an in-memory presentation source shaped like the
// shared chat contract desktop will read over the web-core connection
// (CAN-4185). Nothing here is mounted.

const IDENTITY: ConversationHostIdentity = {
  accountKey: 'desktop-account',
  authGeneration: 'desktop-auth-1',
  localChatId: 'desktop:chat-1',
  externalChatId: 'chat-1',
  workspaceLocalId: 'desktop:workspace-1',
  worktreeLocalId: 'desktop:worktree-1',
};

function message(
  id: string,
  role: 'user' | 'assistant',
  content: string,
  status: string,
  parts?: ConversationProjectedMessage['parts'],
): ConversationProjectedMessage {
  return {
    scope: 'worktree',
    localChatId: IDENTITY.localChatId,
    localMessageId: id,
    canonicalMessageId: id,
    workspaceLocalId: IDENTITY.workspaceLocalId,
    worktreeLocalId: IDENTITY.worktreeLocalId,
    role,
    status,
    content,
    occurredAt: '2026-10-29T12:00:00.000Z',
    turnId: 'turn-1',
    ...(parts === undefined ? {} : { parts }),
  };
}

function createDesktopHost(): ConversationConformanceHost {
  const listeners = new Set<() => void>();
  let view: ConversationPresentation = {
    hostStatus: 'closed',
    binding: null,
    sessionStatus: 'UNKNOWN',
    transcript: [],
    activeExecution: null,
  };
  let user: ConversationProjectedMessage | null = null;
  let reply: ConversationProjectedMessage | null = null;
  const publish = (next: ConversationPresentation): void => {
    view = next;
    listeners.forEach((listener) => listener());
  };
  const rows = (): ConversationPresentation['transcript'] =>
    [user, reply].flatMap((entry) =>
      entry === null
        ? []
        : [{ canonical: { id: entry.canonicalMessageId }, projected: [entry] }],
    );
  const running = (): void =>
    publish({
      ...view,
      sessionStatus: 'RUNNING',
      transcript: rows(),
      activeExecution: {
        turnId: 'turn-1',
        userMessageId: 'user-1',
        startedAtMs: 1_793_275_200_000,
      },
    });

  return {
    source: {
      open(): Promise<void> {
        publish({
          ...view,
          hostStatus: 'ready',
          binding: IDENTITY,
          sessionStatus: 'IDLE',
        });
        return Promise.resolve();
      },
      close(): void {
        publish({ ...view, hostStatus: 'closed' });
      },
      getSnapshot: () => view,
      subscribe(listener): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    startTurn(prompt): void {
      user = message('user-1', 'user', prompt, 'complete');
      running();
    },
    reply(text): void {
      reply = message('assistant-1', 'assistant', text, 'streaming');
      running();
    },
    askUser(question): void {
      reply = message('assistant-1', 'assistant', '', 'streaming', [
        {
          kind: 'tool_use',
          data: {
            toolCallId: 'ask-1',
            toolName: 'AskUserQuestion',
            input: { questions: [{ question }] },
          },
        },
      ]);
      running();
    },
    endTurn(outcome): void {
      if (reply !== null) reply = { ...reply, status: 'complete' };
      publish({
        ...view,
        sessionStatus: outcome === 'failed' ? 'FAILED' : 'IDLE',
        transcript: rows(),
        activeExecution: null,
      });
    },
    revoke(): void {
      publish({
        hostStatus: 'revoked',
        binding: null,
        sessionStatus: 'UNKNOWN',
        transcript: [],
        activeExecution: null,
      });
    },
  };
}

runConversationHostConformance({ describe, it }, 'desktop host', () =>
  createDesktopHost(),
);
