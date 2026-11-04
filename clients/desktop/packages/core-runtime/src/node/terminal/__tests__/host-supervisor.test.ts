import { EventEmitter } from 'node:events';
import type {
  TerminalHostEvent,
  TerminalHostRequestMessage,
} from '../host/protocol';
import {
  TerminalHostSupervisor,
  type TerminalHostProcess,
} from '../host/supervisor';

const TERMINAL = {
  session: {
    id: 't1',
    projectId: 'workspace',
    worktreeId: 'task',
    shell: '/bin/sh',
    shellBasename: 'sh',
    cwd: '/root',
    createdAt: 1,
  },
  pid: 4242,
  cols: 80,
  rows: 24,
  outputOffset: 0,
  running: false,
  processName: null,
};

const LAUNCH = {
  projectId: 'workspace',
  worktreeId: 'task',
  root: '/root',
  cwd: '/root',
  environment: {},
  shell: { shell: '/bin/sh', args: [], shellBasename: 'sh' },
};

/** A host process whose replies the test delivers by hand. */
class FakeHost extends EventEmitter implements TerminalHostProcess {
  public readonly requests: TerminalHostRequestMessage[] = [];

  public postMessage(message: TerminalHostRequestMessage): void {
    this.requests.push(message);
  }

  public kill(): boolean {
    this.emit('exit', 137);
    return true;
  }
}

describe('TerminalHostSupervisor (CAN-5088)', () => {
  it('reports a terminal that exits with its create response as exited, never live', async () => {
    const host = new FakeHost();
    const killed: number[] = [];
    const supervisor = new TerminalHostSupervisor({
      launch: (): TerminalHostProcess => host,
      killProcessGroup: (pid): void => {
        killed.push(pid);
      },
    });
    const events: TerminalHostEvent[] = [];
    supervisor.onEvent((event) => events.push(event));
    const creating = supervisor.create(
      {
        projectId: 'workspace',
        worktreeId: 'task',
        root: '/root',
        cwd: '/root',
        environment: {},
        shell: { shell: '/bin/sh', args: [], shellBasename: 'sh' },
      },
      80,
      24,
    );
    const id = host.requests[0]?.id;
    // The response and the exit arrive in one read.
    host.emit('message', { kind: 'response', id, ok: true, value: TERMINAL });
    host.emit('message', {
      kind: 'event',
      event: {
        type: 'exit',
        terminalId: 't1',
        exitCode: 0,
        signal: null,
        outputOffset: 3,
      },
    });
    await creating;
    expect(supervisor.isLive('t1')).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual([expect.objectContaining({ type: 'exit' })]);
    // A later host fault signals no pid the exited shell left behind.
    host.kill();
    expect(killed).toEqual([]);
  });

  it('keeps a terminal exited when its exit arrives with a restore reply, and recreates it later', async () => {
    const host = new FakeHost();
    const supervisor = new TerminalHostSupervisor({
      launch: (): TerminalHostProcess => host,
    });
    const reply = (value: unknown): void => {
      const id = host.requests.at(-1)?.id;
      host.emit('message', { kind: 'response', id, ok: true, value });
    };
    const creating = supervisor.create(LAUNCH, 80, 24);
    reply(TERMINAL);
    await creating;
    expect(supervisor.isLive('t1')).toBe(true);

    const restoring = supervisor.restore({
      op: 'restore',
      terminalId: 't1',
      cols: 80,
      rows: 24,
    });
    // The reply and the shell's exit arrive in one read.
    reply({ terminal: TERMINAL, recreated: false });
    host.emit('message', {
      kind: 'event',
      event: { type: 'exit', terminalId: 't1', exitCode: 0, signal: null },
    });
    await restoring;
    expect(supervisor.isLive('t1')).toBe(false);

    const recreating = supervisor.restore({
      op: 'restore',
      terminalId: 't1',
      cols: 80,
      rows: 24,
      recreate: { ...LAUNCH, scrollback: '' },
    });
    reply({ terminal: TERMINAL, recreated: true });
    await recreating;
    expect(supervisor.isLive('t1')).toBe(true);
  });
});
