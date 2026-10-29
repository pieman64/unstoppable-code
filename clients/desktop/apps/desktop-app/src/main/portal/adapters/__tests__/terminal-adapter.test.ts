import type {
  PortalCommandEnvelope,
  PortalEventEnvelope,
  TerminalSession,
} from '@canopy/desktop-shared/types';
import {
  handlePortalTerminalClose,
  handlePortalTerminalOpen,
  handlePortalTerminalWrite,
} from '../terminal-adapter';
import type { PortalAdapterContext } from '../types';
import {
  closeTerminal,
  spawnTerminalAfterShellPrewarm,
  TerminalServiceError,
  writeTerminal,
} from '../../../services/terminal-service';

jest.mock('../../../services/terminal-service', () => {
  class MockTerminalServiceError extends Error {
    public constructor(
      public readonly code: 'invalid_payload' | 'invalid_target' | 'not_found',
      message: string,
    ) {
      super(message);
      this.name = 'TerminalServiceError';
    }
  }

  return {
    TerminalServiceError: MockTerminalServiceError,
    closeTerminal: jest.fn(),
    resizeTerminal: jest.fn(),
    spawnTerminalAfterShellPrewarm: jest.fn(),
    terminalSessionToPortalEntity: jest.fn((session: TerminalSession) => ({
      entityType: 'terminal_session',
      localId: session.id,
      parentLocalId: `${session.projectId}:${session.worktreeId}`,
      payload: {
        id: session.id,
        workspaceLocalId: session.projectId,
        worktreeLocalId: session.worktreeId,
      },
    })),
    writeTerminal: jest.fn(),
  };
});

const mockedCloseTerminal = jest.mocked(closeTerminal);
const mockedSpawnTerminal = jest.mocked(spawnTerminalAfterShellPrewarm);
const mockedWriteTerminal = jest.mocked(writeTerminal);

function command(
  input: Partial<PortalCommandEnvelope> & {
    type: PortalCommandEnvelope['type'];
  },
): PortalCommandEnvelope {
  return {
    ...input,
    id: input.id ?? 'cmd-1',
    sequence: input.sequence ?? 7,
    type: input.type,
    payload: input.payload ?? {},
    createdAt: '2026-05-06T00:00:00.000Z',
    expiresAt: null,
  };
}

function adapterContext(events: PortalEventEnvelope[]): PortalAdapterContext {
  return {
    enqueueEvent: (event) => events.push(event),
    complete: (command, result): void => {
      events.push({
        type: 'portal.command.completed',
        commandId: command.id,
        eventId: `${command.id}-completed`,
        occurredAt: '2026-05-06T00:00:00.000Z',
        payload: {
          commandId: command.id,
          sequenceNumber: command.sequence,
          result,
          generatedAt: '2026-05-06T00:00:00.000Z',
        },
      });
    },
    fail: (command, code, message, retryable = false): void => {
      events.push({
        type: 'portal.command.failed',
        commandId: command.id,
        eventId: `${command.id}-failed`,
        occurredAt: '2026-05-06T00:00:00.000Z',
        payload: {
          commandId: command.id,
          sequenceNumber: command.sequence,
          error: { code, message },
          retryable,
          generatedAt: '2026-05-06T00:00:00.000Z',
        },
      });
    },
  };
}

describe('terminal portal adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('emits invalid_payload for service payload validation failures', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedSpawnTerminal.mockRejectedValue(
      new TerminalServiceError('invalid_payload', 'Invalid cols'),
    );

    await handlePortalTerminalOpen(
      command({
        type: 'portal.terminal.open',
        payload: {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          cols: -1,
          rows: 24,
        },
      }) as Parameters<typeof handlePortalTerminalOpen>[0],
      adapterContext(events),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'portal.command.failed',
      payload: {
        error: { code: 'invalid_payload', message: 'Invalid cols' },
        retryable: false,
      },
    });
  });

  it('emits not_found for missing terminal targets', () => {
    const events: PortalEventEnvelope[] = [];
    mockedWriteTerminal.mockImplementation(() => {
      throw new TerminalServiceError('not_found', 'Terminal not found: term-1');
    });

    handlePortalTerminalWrite(
      command({
        type: 'portal.terminal.write',
        payload: { terminalId: 'term-1', data: 'pwd\n' },
      }) as Parameters<typeof handlePortalTerminalWrite>[0],
      adapterContext(events),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'portal.command.failed',
      payload: {
        error: {
          code: 'not_found',
          message: 'Terminal not found: term-1',
        },
      },
    });
  });

  it('passes command target scope to terminal writes', () => {
    const events: PortalEventEnvelope[] = [];

    handlePortalTerminalWrite(
      command({
        type: 'portal.terminal.write',
        target: {
          workspaceLocalId: 'project-1',
          worktreeLocalId: 'worktree-1',
          terminalLocalId: 'term-1',
        },
        payload: { terminalId: 'term-1', data: 'pwd\n' },
      }) as Parameters<typeof handlePortalTerminalWrite>[0],
      adapterContext(events),
    );

    expect(mockedWriteTerminal).toHaveBeenCalledWith({
      terminalId: 'term-1',
      data: 'pwd\n',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
  });

  it('does not emit removal deltas when close target is missing', () => {
    const events: PortalEventEnvelope[] = [];
    mockedCloseTerminal.mockImplementation(() => {
      throw new TerminalServiceError('not_found', 'Terminal not found: term-1');
    });

    handlePortalTerminalClose(
      command({
        type: 'portal.terminal.close',
        payload: { terminalId: 'term-1' },
      }) as Parameters<typeof handlePortalTerminalClose>[0],
      adapterContext(events),
    );

    expect(events.map((event) => event.type)).toEqual([
      'portal.command.failed',
    ]);
  });
});
