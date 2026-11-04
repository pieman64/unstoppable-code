/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment */
import { buildRestoreMarker } from '../engine';
import type { TerminalPersistencePort, WorkerTerminalEvent } from '../ports';
import type {
  WorkerTerminalAttachItem,
  WorkerTerminalAttachParams,
} from '@canopy/protocol/canopy-core';
import { TERMINAL_USER_CLOSE_SIGNAL } from '@canopy/protocol/terminal';
import {
  RemoteTerminals,
  type RemoteTerminalFrame,
  type RemoteTerminalTransport,
} from '../remote';

interface Attached {
  params: WorkerTerminalAttachParams;
  onFrame: (frame: RemoteTerminalFrame) => void;
  closed: boolean;
}

/** A typed refusal, as the client raises it. */
function notFound(): Error & { payload: { kind: string; code: string } } {
  return Object.assign(new Error('gone'), {
    payload: { kind: 'not_found', code: 'worker.terminal.notFound' },
  });
}

function setup(): {
  terminals: RemoteTerminals;
  transport: jest.Mocked<RemoteTerminalTransport>;
  attached: Attached[];
  events: WorkerTerminalEvent[];
  persistence: jest.Mocked<TerminalPersistencePort>;
  unregister: jest.Mock;
  register: jest.Mock;
} {
  const attached: Attached[] = [];
  const events: WorkerTerminalEvent[] = [];
  const unregister = jest.fn();
  const register = jest.fn(() => ({ unregister }));
  const transport: jest.Mocked<RemoteTerminalTransport> = {
    create: jest.fn().mockResolvedValue({
      terminalId: 't1',
      pid: 4242,
      outputOffset: 0,
    }),
    restore: jest.fn().mockResolvedValue({
      terminalId: 't1',
      state: 'running',
      restored: true,
      recreated: true,
      outputOffset: 0,
      pid: 4343,
    }),
    write: jest.fn().mockResolvedValue({ acceptedBytes: 1, outputOffset: 0 }),
    resize: jest.fn().mockResolvedValue({}),
    kill: jest.fn().mockResolvedValue({}),
    release: jest.fn().mockResolvedValue({ released: true }),
    attach: jest.fn((params, onFrame) => {
      const entry: Attached = { params, onFrame, closed: false };
      attached.push(entry);
      return Promise.resolve({
        close: (): void => {
          entry.closed = true;
        },
      });
    }),
  };
  const persistence: jest.Mocked<TerminalPersistencePort> = {
    registerLiveSession: jest.fn(),
    appendTerminalOutput: jest.fn(),
    markTerminalExited: jest.fn(),
    getPersistedTerminalEntry: jest.fn<null, [string]>(() => null),
  };
  let key = 0;
  const terminals = new RemoteTerminals({
    transport,
    persistence,
    resources: { register },
    emit: (event): void => {
      events.push(event);
    },
    log: jest.fn(),
    now: (): number => 1_000,
    reattachDelaysMs: [0, 0],
    createIdempotencyKey: (): string => `key-${++key}`,
  });
  return {
    terminals,
    transport,
    attached,
    events,
    persistence,
    unregister,
    register,
  };
}

const LAUNCH = {
  projectId: 'project',
  worktreeId: 'task',
  scope: { workspaceId: 'workspace', worktreeId: 'task' },
  cwdRootId: 'workspace',
  cwdRelativePath: '',
  cwd: '/data/workspaces/workspace/worktrees/task',
  shell: { shell: '/bin/zsh', args: ['-l'], shellBasename: 'zsh' },
  environment: { PATH: '/usr/bin', UNSET: undefined },
  cols: 80,
  rows: 24,
};

function item(
  fromOffset: number,
  text: string,
  extra: Partial<WorkerTerminalAttachItem> = {},
): RemoteTerminalFrame {
  const data = Buffer.from(text);
  return {
    kind: 'item',
    item: {
      terminalId: 't1',
      fromOffset,
      toOffset: fromOffset + data.length,
      data: data.toString('base64'),
      encoding: 'base64',
      truncatedBefore: false,
      exit: null,
      ...extra,
    },
  };
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('RemoteTerminals', () => {
  it('creates an interactive terminal from main-resolved inputs and mirrors its output', async () => {
    const { terminals, transport, attached, events, persistence, register } =
      setup();
    const session = await terminals.create(LAUNCH);
    expect(transport.create).toHaveBeenCalledWith({
      scope: LAUNCH.scope,
      cwdRootId: 'workspace',
      cwdRelativePath: '',
      shell: '/bin/zsh',
      args: ['-l'],
      env: { PATH: '/usr/bin' },
      cols: 80,
      rows: 24,
      kind: 'interactive',
      _meta: { idempotencyKey: 'key-1' },
    });
    expect(session).toEqual({
      id: 't1',
      projectId: 'project',
      worktreeId: 'task',
      shell: '/bin/zsh',
      shellBasename: 'zsh',
      cwd: LAUNCH.cwd,
      createdAt: 1_000,
    });
    expect(persistence.registerLiveSession).toHaveBeenCalledWith(session);
    expect(register).toHaveBeenCalledWith(session, 4242);
    expect(attached[0]?.params).toEqual({
      scope: LAUNCH.scope,
      terminalId: 't1',
      fromOffset: 0,
    });

    attached[0]?.onFrame(item(0, 'hello'));
    attached[0]?.onFrame(item(5, ' world'));
    expect(events).toEqual([
      {
        type: 'output',
        payload: {
          projectId: 'project',
          worktreeId: 'task',
          terminalId: 't1',
          data: new Uint8Array(Buffer.from('hello')),
          seq: 5,
        },
      },
      {
        type: 'output',
        payload: {
          projectId: 'project',
          worktreeId: 'task',
          terminalId: 't1',
          data: new Uint8Array(Buffer.from(' world')),
          seq: 11,
        },
      },
    ]);
    expect(persistence.appendTerminalOutput).toHaveBeenCalledTimes(2);
    expect(terminals.replay('t1')).toMatchObject({ seq: 11 });
    expect(Buffer.from(terminals.replay('t1')?.replay ?? []).toString()).toBe(
      'hello world',
    );
    expect(terminals.list()).toEqual([
      { ...session, running: false, processName: null },
    ]);
  });

  it('reports running changes and the exit with the signal main asked for', async () => {
    const { terminals, transport, attached, events, persistence, unregister } =
      setup();
    await terminals.create(LAUNCH);
    attached[0]?.onFrame(
      item(0, '', { running: { running: true, processName: 'vim' } }),
    );
    expect(terminals.runningWorktrees()).toEqual([
      { projectId: 'project', worktreeId: 'task' },
    ]);
    terminals.kill('t1', TERMINAL_USER_CLOSE_SIGNAL);
    await flush();
    expect(transport.kill).toHaveBeenCalledWith({
      scope: LAUNCH.scope,
      terminalId: 't1',
    });
    attached[0]?.onFrame(
      item(0, '', { exit: { code: null, signal: 'SIGKILL' } }),
    );
    expect(events.slice(-2)).toEqual([
      {
        type: 'runningChanged',
        payload: {
          projectId: 'project',
          worktreeId: 'task',
          terminalId: 't1',
          kind: 'shell',
          running: false,
          processName: null,
        },
      },
      {
        type: 'exit',
        payload: {
          projectId: 'project',
          worktreeId: 'task',
          terminalId: 't1',
          kind: 'shell',
          exitCode: null,
          signal: TERMINAL_USER_CLOSE_SIGNAL,
        },
      },
    ]);
    expect(persistence.markTerminalExited).toHaveBeenCalledWith(
      'project',
      'task',
      't1',
      null,
      TERMINAL_USER_CLOSE_SIGNAL,
    );
    expect(unregister).toHaveBeenCalled();
    expect(terminals.has('t1')).toBe(false);
  });

  it('reattaches from its last byte when the stream ends before the exit', async () => {
    const { terminals, transport, attached, events } = setup();
    await terminals.create(LAUNCH);
    attached[0]?.onFrame(item(0, 'abc'));
    attached[0]?.onFrame({ kind: 'end', outcome: 'error', error: null });
    await flush();
    await flush();
    expect(transport.attach).toHaveBeenCalledTimes(2);
    expect(attached[1]?.params.fromOffset).toBe(3);
    attached[1]?.onFrame(item(3, 'def'));
    expect(events.at(-1)).toMatchObject({
      type: 'output',
      payload: { seq: 6 },
    });
    expect(terminals.has('t1')).toBe(true);
  });

  it('keeps reattaching when a replacement stream ends while it opens, then ends the terminal as lost', async () => {
    const { terminals, transport, attached, events } = setup();
    await terminals.create(LAUNCH);
    transport.attach.mockImplementation((params, onFrame) => {
      attached.push({ params, onFrame, closed: false });
      onFrame({ kind: 'end', outcome: 'error', error: null });
      return Promise.resolve({ close: (): void => undefined });
    });
    attached[0]?.onFrame({ kind: 'end', outcome: 'error', error: null });
    await flush();
    await flush();
    expect(transport.attach).toHaveBeenCalledTimes(3);
    expect(terminals.has('t1')).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: 'exit',
      payload: { terminalId: 't1', signal: 'connection-lost' },
    });
  });

  it('ends a terminal the daemon no longer has as lost, so it can be restarted', async () => {
    const { terminals, transport, attached, events, persistence } = setup();
    await terminals.create(LAUNCH);
    transport.attach.mockRejectedValue(notFound());
    attached[0]?.onFrame({ kind: 'end', outcome: 'error', error: null });
    await flush();
    await flush();
    expect(events.at(-1)).toEqual({
      type: 'exit',
      payload: {
        projectId: 'project',
        worktreeId: 'task',
        terminalId: 't1',
        kind: 'shell',
        exitCode: null,
        signal: 'connection-lost',
      },
    });
    expect(persistence.markTerminalExited).toHaveBeenCalledWith(
      'project',
      'task',
      't1',
      null,
      'connection-lost',
    );
  });

  it('recreates a persisted shell with its scrollback in the replay before it returns, never as live output', async () => {
    const { terminals, transport, attached, events, persistence } = setup();
    const scrollback = 'earlier';
    const marker = buildRestoreMarker(true);
    const seeded = Buffer.byteLength(scrollback) + marker.length;
    transport.restore.mockResolvedValue({
      terminalId: 't1',
      state: 'running',
      restored: true,
      recreated: true,
      outputOffset: seeded,
      pid: 4343,
    });
    const session = await terminals.recreate({
      ...LAUNCH,
      terminalId: 't1',
      createdAt: 5,
      scrollback,
    });
    expect(transport.restore).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalId: 't1',
        restoreMode: 'recreate_if_exited',
        snapshot: expect.objectContaining({ scrollback, shell: '/bin/zsh' }),
      }),
    );
    expect(session.createdAt).toBe(5);
    expect(persistence.appendTerminalOutput).toHaveBeenCalledWith(
      'project',
      'task',
      't1',
      marker,
    );
    // A pane that attaches now already sees the restored history.
    expect(Buffer.from(terminals.replay('t1')?.replay ?? [])).toEqual(
      Buffer.concat([Buffer.from(scrollback), marker]),
    );
    expect(attached[0]?.params.fromOffset).toBe(seeded);
    expect(events).toEqual([]);
    attached[0]?.onFrame(item(seeded, 'live'));
    expect(events).toEqual([
      expect.objectContaining({
        type: 'output',
        payload: expect.objectContaining({ seq: seeded + 4 }),
      }),
    ]);
    expect(persistence.appendTerminalOutput).toHaveBeenCalledTimes(2);
  });

  it('adopts a shell still live on the worker without a restart marker, after reading its replay', async () => {
    const { terminals, transport, attached, events, persistence } = setup();
    transport.restore.mockResolvedValue({
      terminalId: 't1',
      state: 'running',
      restored: true,
      recreated: false,
      outputOffset: 13,
      pid: 4343,
    });
    let returned = false;
    const recreating = terminals
      .recreate({
        ...LAUNCH,
        terminalId: 't1',
        createdAt: 5,
        scrollback: 'old',
      })
      .then((session) => {
        returned = true;
        return session;
      });
    await flush();
    expect(attached[0]?.params.fromOffset).toBe(0);
    expect(returned).toBe(false);
    // The persisted 'old', then output from while no client mirrored it.
    attached[0]?.onFrame(item(0, 'old-while-off'));
    await recreating;
    expect(Buffer.from(terminals.replay('t1')?.replay ?? []).toString()).toBe(
      'old-while-off',
    );
    // Persisted once, and never replayed as live output.
    expect(persistence.appendTerminalOutput.mock.calls).toEqual([
      ['project', 'task', 't1', Buffer.from('-while-off')],
    ]);
    expect(events).toEqual([]);
    attached[0]?.onFrame(item(13, 'live'));
    expect(persistence.appendTerminalOutput).toHaveBeenLastCalledWith(
      'project',
      'task',
      't1',
      Buffer.from('live'),
    );
  });

  it("persists only the output a live terminal's scrollback lacks, when the window starts inside it", async () => {
    const { terminals, transport, attached, persistence } = setup();
    transport.restore.mockResolvedValue({
      terminalId: 't1',
      state: 'running',
      restored: true,
      recreated: false,
      outputOffset: 9,
      pid: 4343,
    });
    const recreating = terminals.recreate({
      ...LAUNCH,
      terminalId: 't1',
      createdAt: 5,
      scrollback: 'earlier\r\n$ ls',
    });
    await flush();
    // The worker's window starts after the scrollback's own start.
    attached[0]?.onFrame(item(0, '$ ls\r\nNEW'));
    await recreating;
    expect(persistence.appendTerminalOutput.mock.calls).toEqual([
      ['project', 'task', 't1', Buffer.from('\r\nNEW')],
    ]);
  });

  it('sends a call again only when the client reports it was not applied', async () => {
    const { terminals, transport } = setup();
    await terminals.create(LAUNCH);
    const notApplied = Object.assign(new Error('reconnecting'), {
      payload: { kind: 'unavailable', retry: { kind: 'same_request' } },
    });
    const unknown = Object.assign(new Error('lost'), {
      payload: { kind: 'unavailable', retry: { kind: 'never' } },
    });
    transport.write
      .mockRejectedValueOnce(notApplied)
      .mockRejectedValueOnce(unknown);
    terminals.write('t1', 'first\r');
    terminals.write('t1', 'second\r');
    terminals.write('t1', 'third\r');
    await flush();
    await flush();
    // `first` is sent again once; its second failure has an unknown outcome,
    // so it is not replayed, and the later writes follow in order.
    expect(transport.write.mock.calls.map(([params]) => params.input)).toEqual([
      'first\r',
      'first\r',
      'second\r',
      'third\r',
    ]);
  });

  it('ends terminals killed with their worktree as a worktree cleanup, as in process', async () => {
    const { terminals, attached, events, persistence } = setup();
    await terminals.create(LAUNCH);
    attached[0]?.onFrame(
      item(0, '', { running: { running: true, processName: 'sleep' } }),
    );
    events.length = 0;
    terminals.killWorktree({ projectId: 'project', worktreeId: 'task' });
    attached[0]?.onFrame(item(0, '', { exit: { code: null, signal: '9' } }));
    expect(events).toEqual([
      expect.objectContaining({
        type: 'exit',
        payload: expect.objectContaining({ signal: 'worktree-cleanup' }),
      }),
    ]);
    expect(persistence.markTerminalExited).toHaveBeenCalledWith(
      'project',
      'task',
      't1',
      null,
      'worktree-cleanup',
    );
  });

  it('shares one restore between concurrent requests for a terminal', async () => {
    const { terminals, transport, attached, register } = setup();
    const request = {
      ...LAUNCH,
      terminalId: 't1',
      createdAt: 5,
      scrollback: '',
    };
    const [first, second] = await Promise.all([
      terminals.recreate(request),
      terminals.recreate(request),
    ]);
    expect(second).toBe(first);
    expect(transport.restore).toHaveBeenCalledTimes(1);
    expect(attached).toHaveLength(1);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('announces an exit that arrives while it opens only after create returns the session', async () => {
    const { terminals, transport, events, persistence } = setup();
    const order: string[] = [];
    transport.attach.mockImplementationOnce((_params, onFrame) => {
      onFrame(item(0, '', { exit: { code: null, signal: 'connection-lost' } }));
      return Promise.resolve({ close: (): void => undefined });
    });
    persistence.markTerminalExited.mockImplementation(() => {
      order.push('exited');
    });
    const session = await terminals.create(LAUNCH);
    order.push('returned');
    expect(session.id).toBe('t1');
    expect(terminals.has('t1')).toBe(false);
    await flush();
    expect(order).toEqual(['returned', 'exited']);
    expect(events.at(-1)).toMatchObject({
      type: 'exit',
      payload: { terminalId: 't1', signal: 'connection-lost' },
    });
  });

  it('persists repeated output a live terminal wrote after its scrollback', async () => {
    const { terminals, transport, attached, persistence } = setup();
    transport.restore.mockResolvedValue({
      terminalId: 't1',
      state: 'running',
      restored: true,
      recreated: false,
      outputOffset: 10,
      pid: 4343,
    });
    const recreating = terminals.recreate({
      ...LAUNCH,
      terminalId: 't1',
      createdAt: 5,
      scrollback: 'hello',
    });
    await flush();
    attached[0]?.onFrame(item(0, 'hellohello'));
    await recreating;
    expect(persistence.appendTerminalOutput.mock.calls).toEqual([
      ['project', 'task', 't1', Buffer.from('hello')],
    ]);
  });

  it('keeps reconnecting when a replacement stream ends right after it opens', async () => {
    const { terminals, transport, attached, events } = setup();
    await terminals.create(LAUNCH);
    transport.attach.mockImplementation((params, onFrame) => {
      attached.push({ params, onFrame, closed: false });
      // Ends once it opened, before the reconnect that opened it resumes
      // (two microtasks after the transport resolves).
      void Promise.resolve()
        .then(() => undefined)
        .then(() => onFrame({ kind: 'end', outcome: 'error', error: null }));
      return Promise.resolve({ close: (): void => undefined });
    });
    attached[0]?.onFrame({ kind: 'end', outcome: 'error', error: null });
    await flush();
    await flush();
    expect(transport.attach).toHaveBeenCalledTimes(3);
    expect(terminals.has('t1')).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: 'exit',
      payload: { terminalId: 't1', signal: 'connection-lost' },
    });
  });

  it('releases a terminal whose stream it lost before ending it, and asks again on worktree release', async () => {
    const { terminals, transport, attached, events } = setup();
    await terminals.create(LAUNCH);
    const unreachable = Object.assign(new Error('unreachable'), {
      payload: { kind: 'unavailable', retry: { kind: 'never' } },
    });
    transport.attach.mockRejectedValue(unreachable);
    transport.release.mockRejectedValueOnce(unreachable);
    attached[0]?.onFrame({ kind: 'end', outcome: 'error', error: null });
    await flush();
    await flush();
    expect(terminals.has('t1')).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: 'exit',
      payload: { terminalId: 't1', signal: 'connection-lost' },
    });
    expect(transport.release).toHaveBeenCalledTimes(1);
    await terminals.releaseWorktree({
      projectId: 'project',
      worktreeId: 'task',
    });
    expect(transport.release).toHaveBeenCalledTimes(2);
    // Released now: a later cleanup does not ask again.
    await terminals.releaseWorktree({
      projectId: 'project',
      worktreeId: 'task',
    });
    expect(transport.release).toHaveBeenCalledTimes(2);
  });

  it('keeps a lost terminal live for cleanup while its release keeps failing', async () => {
    const { terminals, transport, attached } = setup();
    await terminals.create(LAUNCH);
    const unreachable = Object.assign(new Error('unreachable'), {
      payload: { kind: 'unavailable', retry: { kind: 'never' } },
    });
    transport.attach.mockRejectedValue(unreachable);
    transport.release.mockRejectedValue(unreachable);
    attached[0]?.onFrame({ kind: 'end', outcome: 'error', error: null });
    await flush();
    await flush();
    const scope = { projectId: 'project', worktreeId: 'task' };
    expect(terminals.hasLiveTerminals(scope)).toBe(true);
    await expect(terminals.releaseWorktree(scope)).rejects.toBe(unreachable);
    expect(terminals.hasLiveTerminals(scope)).toBe(true);
    // Quit stays bounded and best effort.
    await expect(terminals.killAll()).resolves.toBeUndefined();
  });

  it('kills a terminal still starting when every terminal is killed', async () => {
    const { terminals, transport, attached } = setup();
    let created = (): void => undefined;
    transport.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          // The fields the mirror reads, as the default create mock returns.
          created = (): void =>
            resolve({
              terminalId: 't1',
              pid: 4242,
              outputOffset: 0,
            } as unknown as Awaited<
              ReturnType<RemoteTerminalTransport['create']>
            >);
        }),
    );
    const creating = terminals.create(LAUNCH);
    const killing = terminals.killAll();
    created();
    await creating;
    await flush();
    expect(transport.kill).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: 't1' }),
    );
    attached[0]?.onFrame(item(0, '', { exit: { code: null, signal: '9' } }));
    await killing;
    expect(terminals.has('t1')).toBe(false);
  });

  it('reports a foreground change only when the state changed', async () => {
    const { terminals, attached, events } = setup();
    await terminals.create(LAUNCH);
    const idle = { running: false, processName: null };
    attached[0]?.onFrame(item(0, '', { running: idle }));
    expect(events).toEqual([]);
    attached[0]?.onFrame(
      item(0, '', { running: { running: true, processName: 'sleep' } }),
    );
    attached[0]?.onFrame(item(0, '', { running: idle }));
    expect(events.map(({ type }) => type)).toEqual([
      'runningChanged',
      'runningChanged',
    ]);
  });

  it('waits for exits when killing every terminal, bounded', async () => {
    const { terminals, attached } = setup();
    await terminals.create(LAUNCH);
    const killed = terminals.killAll();
    expect(terminals.killAll()).toBe(killed);
    await flush();
    attached[0]?.onFrame(item(0, '', { exit: { code: 0, signal: null } }));
    await killed;
    expect(terminals.count()).toBe(0);
  });

  it('releases a terminal and resolves once its exit arrives', async () => {
    const { terminals, transport, attached, persistence } = setup();
    await terminals.create(LAUNCH);
    transport.release.mockImplementation(() => {
      attached[0]?.onFrame(
        item(0, '', { exit: { code: null, signal: 'worktree-cleanup' } }),
      );
      return Promise.resolve({ released: true });
    });
    await terminals.releaseWorktree({
      projectId: 'project',
      worktreeId: 'task',
    });
    expect(persistence.markTerminalExited).toHaveBeenCalledWith(
      'project',
      'task',
      't1',
      null,
      'worktree-cleanup',
    );
    expect(
      terminals.hasLiveTerminals({ projectId: 'project', worktreeId: 'task' }),
    ).toBe(false);
  });
});
