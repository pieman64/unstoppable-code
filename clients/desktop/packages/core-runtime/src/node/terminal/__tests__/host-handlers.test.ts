import type { WorkerTerminalAttachItem } from '@canopy/protocol/canopy-core';
import type {
  CanopyHandlerContext,
  CanopyStreamSink,
} from '../../../runtime/types';
import {
  createWorkerTerminalHandlers,
  type WorkerTerminalHandlers,
} from '../host/handlers';
import type { TerminalHostEvent, TerminalHostTerminal } from '../host/protocol';
import type { TerminalHostSupervisor } from '../host/supervisor';

const SCOPE = { workspaceId: 'workspace', worktreeId: 'task' };

const CONTEXT = {
  requestId: 'r1',
  caller: { principalId: 'core', clientInstanceId: 'core' },
  metadata: {},
  signal: new AbortController().signal,
} as unknown as CanopyHandlerContext;

function hostTerminal(
  running: Pick<TerminalHostTerminal, 'running' | 'processName'> = {
    running: false,
    processName: null,
  },
): TerminalHostTerminal {
  return {
    session: {
      id: 't1',
      projectId: 'workspace',
      worktreeId: 'task',
      shell: '/bin/sh',
      shellBasename: 'sh',
      cwd: '/root',
      createdAt: 1,
    },
    pid: 10,
    cols: 80,
    rows: 24,
    outputOffset: 0,
    ...running,
  };
}

/** A fake host supervisor covering every member these handlers call. */
function setup(
  overrides: {
    attached?: TerminalHostTerminal;
    recreated?: boolean;
  } = {},
): {
  handlers: WorkerTerminalHandlers;
  emit: (event: TerminalHostEvent) => void;
} {
  const listeners = new Set<(event: TerminalHostEvent) => void>();
  const supervisor = {
    onEvent: (listener: (event: TerminalHostEvent) => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isLive: (): boolean => false,
    create: (): Promise<TerminalHostTerminal> =>
      Promise.resolve(hostTerminal()),
    restore: (): Promise<{
      terminal: TerminalHostTerminal;
      recreated: boolean;
    }> =>
      Promise.resolve({
        terminal: hostTerminal(),
        recreated: overrides.recreated ?? true,
      }),
    attach: (): Promise<{
      attachmentId: string;
      terminal: TerminalHostTerminal;
    }> =>
      Promise.resolve({
        attachmentId: 'a1',
        terminal: overrides.attached ?? hostTerminal(),
      }),
    acknowledge: (): void => undefined,
    detach: (): void => undefined,
    // As on Linux: the killed shell's exit reaches the worker before the
    // kill's reply does.
    kill: (): Promise<TerminalHostTerminal> => {
      for (const listener of listeners)
        listener({
          type: 'exit',
          terminalId: 't1',
          exitCode: null,
          signal: 'SIGKILL',
        });
      return Promise.resolve(hostTerminal());
    },
  };
  const handlers = createWorkerTerminalHandlers({
    supervisor: supervisor as unknown as TerminalHostSupervisor,
    resolveRoot: () => Promise.resolve('/root'),
    flushIntervalMs: 0,
  });
  return {
    handlers,
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
  };
}

function create(handlers: WorkerTerminalHandlers): Promise<unknown> {
  return handlers.instructions['worker.terminal.create'](
    {
      scope: SCOPE,
      cwdRootId: 'workspace',
      cwdRelativePath: '',
      shell: '/bin/sh',
      args: [],
      env: {},
      cols: 80,
      rows: 24,
      kind: 'interactive',
      _meta: { idempotencyKey: 'k1' },
    },
    CONTEXT,
  );
}

async function attach(
  handlers: WorkerTerminalHandlers,
  fromOffset: number,
): Promise<WorkerTerminalAttachItem[]> {
  const items: WorkerTerminalAttachItem[] = [];
  const sink: CanopyStreamSink<WorkerTerminalAttachItem> = {
    buffered: () => 0,
    emit: (item) => {
      items.push(item);
      return null;
    },
    emitAt: () => null,
    end: () => undefined,
  };
  await handlers.streams['worker.terminal.attach'](
    { terminalId: 't1', fromOffset },
    CONTEXT,
    sink,
  );
  return items;
}

describe('worker terminal handlers (CAN-5088)', () => {
  it('tells a new attachment which process runs in the foreground now', async () => {
    // The process changed while no attachment was open, so no change event
    // reaches this attachment; only the host's state at attach time does.
    const now = { running: true, processName: 'sleep' };
    const { handlers } = setup({ attached: hostTerminal(now) });
    await create(handlers);
    const items = await attach(handlers, 0);
    expect(items.map(({ running }) => running)).toEqual([now]);
  });

  it('flags output a client missed when it attaches after the exit', async () => {
    const { handlers, emit } = setup();
    await create(handlers);
    // The terminal wrote 50 bytes with no client attached, then exited.
    emit({
      type: 'exit',
      terminalId: 't1',
      exitCode: 0,
      signal: null,
      outputOffset: 50,
    });
    const items = await attach(handlers, 10);
    expect(items).toEqual([
      expect.objectContaining({
        truncatedBefore: true,
        exit: { code: 0, signal: null },
      }),
    ]);
  });

  it('refuses kill options the host cannot honor instead of force-killing', async () => {
    const { handlers } = setup();
    await create(handlers);
    for (const options of [{ signal: 'SIGTERM' }, { graceMs: 5_000 }])
      await expect(
        handlers.instructions['worker.terminal.kill'](
          { terminalId: 't1', ...options },
          CONTEXT,
        ),
      ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
  });

  it('answers a kill whose exit arrived before its reply with the ended terminal', async () => {
    const { handlers } = setup();
    await create(handlers);
    await expect(
      handlers.instructions['worker.terminal.kill'](
        { terminalId: 't1' },
        CONTEXT,
      ),
    ).resolves.toMatchObject({
      terminalId: 't1',
      state: 'exited',
      signal: 'SIGKILL',
      scope: SCOPE,
    });
  });

  it('reports a restore that found the terminal already recreated as adopted', async () => {
    const { handlers } = setup({ recreated: false });
    await expect(
      handlers.instructions['worker.terminal.restore'](
        {
          scope: SCOPE,
          terminalId: 't1',
          restoreMode: 'recreate_if_exited',
          cols: 80,
          rows: 24,
          _meta: { idempotencyKey: 'k2' },
          snapshot: {
            cwdRootId: 'workspace',
            cwdRelativePath: '',
            shell: '/bin/sh',
            args: [],
            env: {},
            scrollback: 'stale',
          },
        },
        CONTEXT,
      ),
    ).resolves.toMatchObject({ restored: true, recreated: false });
  });
});
