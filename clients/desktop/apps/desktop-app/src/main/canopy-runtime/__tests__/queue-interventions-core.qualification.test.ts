import type {
  ChatCommandOutcome,
  ChatCommandRequest,
  ChatCommandResult,
  ChatStateCommandPort,
  PortalCommandEnvelope,
} from '@canopy/desktop-shared/types';
import { getChatQueueService } from '../../services/chat-queue-service';
import {
  projectQueueCancel,
  projectQueueEdit,
  projectQueueEditLock,
  projectQueueForce,
} from '../../ipc/chat-queue-projections';
import {
  handlePortalChatQueueCancel,
  handlePortalChatQueueEdit,
  handlePortalChatQueueForce,
  handlePortalChatQueueSetEditLock,
} from '../../portal/adapters/chat-adapter';
import type { PortalAdapterContext } from '../../portal/adapters/types';
import {
  createChatCommandDispatchOptions,
  dispatchTrustedChatCommand,
} from '../core-chat-command-adapter';
import { createDesktopRuntime } from '../desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../desktop-runtime-identity';

jest.mock('../../services/chat-queue-service', () => ({
  ...jest.requireActual<object>('../../services/chat-queue-service'),
  getChatQueueService: jest.fn(() => {
    throw new Error('Queue interventions must enter through core.');
  }),
}));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const target = { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'chat-1' };

class MemoryQueuePort implements ChatStateCommandPort {
  public readonly commands: ChatCommandRequest[] = [];
  public outcome: ChatCommandOutcome = 'applied';
  public reason: string | undefined;
  private readonly receipts = new Map<string, ChatCommandResult>();

  public command(request: ChatCommandRequest): Promise<ChatCommandResult> {
    this.commands.push(request);
    const replay = this.receipts.get(request.commandId);
    if (replay)
      return Promise.resolve({ ...replay, outcome: 'already_applied' });
    const result: ChatCommandResult = {
      commandId: request.commandId,
      revision: 1,
      outcome: this.outcome,
      ...(this.reason !== undefined ? { reason: this.reason } : {}),
    };
    if (this.outcome === 'applied')
      this.receipts.set(request.commandId, result);
    return Promise.resolve(result);
  }

  public getState = jest.fn();
  public getTranscriptPage = jest.fn();
  public searchTranscript = jest.fn();
  public readVisual = jest.fn();
  public readToolOutput = jest.fn();
  public subscribe = jest.fn((): (() => void) => () => undefined);
}

function compose(): {
  port: MemoryQueuePort;
  runtime: ReturnType<typeof createDesktopRuntime>;
  dispatch: (request: ChatCommandRequest) => Promise<ChatCommandResult>;
} {
  const port = new MemoryQueuePort();
  const runtime = createDesktopRuntime({
    chatCommandPort: port,
    getChatStatePort: () => port,
  });
  const dispatch = (request: ChatCommandRequest): Promise<ChatCommandResult> =>
    dispatchTrustedChatCommand(
      request,
      createChatCommandDispatchOptions(port, runtime, {
        principalId: 'local-desktop-user',
        clientInstanceId: 'desktop-main-chat',
        authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
        interfaceKind: 'desktop',
        grants: ['core.chat.write'],
      }),
    );
  return { port, runtime, dispatch };
}

function portalContext(
  port: ChatStateCommandPort | undefined,
  dispatch: (request: ChatCommandRequest) => Promise<ChatCommandResult>,
): PortalAdapterContext & {
  completed: unknown[];
  failures: Array<{ code: string; message: string }>;
} {
  const completed: unknown[] = [];
  const failures: Array<{ code: string; message: string }> = [];
  return {
    completed,
    failures,
    ...(port ? { chatStatePort: port } : {}),
    dispatchChatCommand: (request) => dispatch(request),
    getWindow: () => null,
    enqueueEvent: () => undefined,
    complete: (_command, result) => {
      completed.push(result);
    },
    fail: (_command, code, message) => {
      failures.push({ code, message });
    },
  };
}

function portalCommand<T>(id: string, payload: T): PortalCommandEnvelope<T> {
  return {
    id,
    sequence: 1,
    type: 'portal.chat.queue.cancel',
    payload,
    createdAt: '2026-11-05T00:00:00.000Z',
    expiresAt: null,
  };
}

describe('queue interventions through core (CAN-4112)', () => {
  it('each desktop queue channel dispatches its core operation once', async () => {
    const { port, runtime, dispatch } = compose();
    try {
      const fileReferences = [
        { absolutePath: '/repo/notes.md', displayPath: 'notes.md' },
      ];
      await projectQueueEdit(
        { ...target, entryId: 'queue-1', text: 'Updated', fileReferences },
        dispatch,
      );
      await projectQueueCancel({ ...target, entryId: 'queue-2' }, dispatch);
      await projectQueueForce({ ...target, entryId: 'queue-3' }, dispatch);
      await projectQueueEditLock(
        { ...target, entryId: 'queue-4', locked: true },
        dispatch,
      );

      expect(port.commands.map((request) => request.command)).toEqual([
        {
          type: 'chat.edit_queued_message',
          chatId: 'chat-1',
          queuedMessageId: 'queue-1',
          text: 'Updated',
          fileReferences,
        },
        {
          type: 'chat.cancel_queued_message',
          chatId: 'chat-1',
          queuedMessageId: 'queue-2',
        },
        {
          type: 'chat.force_queued_message',
          chatId: 'chat-1',
          queuedMessageId: 'queue-3',
        },
        {
          type: 'chat.set_queued_message_edit_lock',
          chatId: 'chat-1',
          queuedMessageId: 'queue-4',
          locked: true,
        },
      ]);
      for (const request of port.commands) {
        expect(request).toMatchObject({
          projectId: 'ws-1',
          worktreeId: 'wt-1',
        });
        expect(request.commandId).toMatch(UUID);
      }
      expect(
        new Set(port.commands.map((request) => request.commandId)).size,
      ).toBe(4);
    } finally {
      await runtime.shutdown();
    }
  });

  it('queue channels keep their responses', async () => {
    const { port, runtime, dispatch } = compose();
    try {
      for (const outcome of ['not_found', 'rejected'] as const) {
        port.outcome = outcome;
        await expect(
          projectQueueEdit(
            { ...target, entryId: 'queue-1', text: 'x' },
            dispatch,
          ),
        ).resolves.toBeUndefined();
        await expect(
          projectQueueCancel({ ...target, entryId: 'queue-1' }, dispatch),
        ).resolves.toBeUndefined();
        await expect(
          projectQueueForce({ ...target, entryId: 'queue-1' }, dispatch),
        ).resolves.toBeUndefined();
      }
      port.outcome = 'rejected';
      port.reason = 'Another message operation is in progress';
      await expect(
        projectQueueEditLock(
          { ...target, entryId: 'queue-1', locked: true },
          dispatch,
        ),
      ).rejects.toThrow('Another message operation is in progress');
      await expect(
        projectQueueEditLock(
          { ...target, entryId: 'queue-1', locked: false },
          dispatch,
        ),
      ).rejects.toThrow('Another message operation is in progress');
      port.reason = undefined;
      await expect(
        projectQueueEditLock(
          { ...target, entryId: 'queue-1', locked: true },
          dispatch,
        ),
      ).rejects.toThrow('This message is no longer available to edit.');
    } finally {
      await runtime.shutdown();
    }
  });

  it('Portal queue commands never reach the queue service directly', async () => {
    const { port, runtime, dispatch } = compose();
    try {
      const context = portalContext(port, dispatch);
      await handlePortalChatQueueCancel(
        portalCommand('portal-cancel', { ...target, entryId: 'queue-1' }),
        context,
      );
      await handlePortalChatQueueEdit(
        portalCommand('portal-edit', {
          ...target,
          entryId: 'queue-1',
          text: 'Updated',
        }),
        context,
      );
      await handlePortalChatQueueForce(
        portalCommand('portal-force', { ...target, entryId: 'queue-1' }),
        context,
      );
      await handlePortalChatQueueSetEditLock(
        portalCommand('portal-lock', {
          ...target,
          entryId: 'queue-1',
          locked: true,
        }),
        context,
      );

      expect(context.failures).toEqual([]);
      expect(context.completed).toHaveLength(4);
      expect(port.commands.at(-1)?.command).toEqual({
        type: 'chat.set_queued_message_edit_lock',
        chatId: 'chat-1',
        queuedMessageId: 'queue-1',
        locked: true,
        acquisitionId: 'portal-lock',
      });

      const detached = portalContext(undefined, dispatch);
      await handlePortalChatQueueCancel(
        portalCommand('detached-cancel', { ...target, entryId: 'queue-1' }),
        detached,
      );
      await handlePortalChatQueueEdit(
        portalCommand('detached-edit', {
          ...target,
          entryId: 'queue-1',
          text: 'Updated',
        }),
        detached,
      );
      await handlePortalChatQueueForce(
        portalCommand('detached-force', { ...target, entryId: 'queue-1' }),
        detached,
      );
      await handlePortalChatQueueSetEditLock(
        portalCommand('detached-lock', {
          ...target,
          entryId: 'queue-1',
          locked: true,
        }),
        detached,
      );
      expect(detached.failures.map((failure) => failure.code)).toEqual([
        'execution_failed',
        'execution_failed',
        'execution_failed',
        'execution_failed',
      ]);
      expect(getChatQueueService).not.toHaveBeenCalled();
    } finally {
      await runtime.shutdown();
    }
  });
});
