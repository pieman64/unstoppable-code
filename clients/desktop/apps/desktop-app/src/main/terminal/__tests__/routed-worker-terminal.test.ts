/* eslint-disable @typescript-eslint/unbound-method */
import type {
  RemoteTerminals,
  WorkerTerminalEvent,
  WorkerTerminalEventListener,
  WorkerTerminalPort,
} from '@canopy/core-runtime/node/terminal';
import type { TerminalSession } from '@canopy/protocol/terminal';
import { RoutedWorkerTerminal } from '../routed-worker-terminal';

const session = (id: string): TerminalSession => ({
  id,
  projectId: 'project',
  worktreeId: 'task',
  shell: '/bin/zsh',
  shellBasename: 'zsh',
  cwd: '/root',
  createdAt: 1,
});

function engine(): WorkerTerminalPort & {
  sink: () => WorkerTerminalEventListener | undefined;
} {
  let sink: WorkerTerminalEventListener | undefined;
  return {
    sink: () => sink,
    create: jest.fn(() => session('local')),
    restore: jest.fn(() => session('local')),
    list: jest.fn(() => [session('local')]),
    get: jest.fn(() => session('local')),
    replay: jest.fn(),
    attach: jest.fn(),
    acknowledgeAttachment: jest.fn(),
    releaseAttachment: jest.fn(),
    replayText: jest.fn(() => 'local text'),
    write: jest.fn(),
    resize: jest.fn(),
    kill: jest.fn(),
    killWorktree: jest.fn(),
    killAll: jest.fn(),
    release: jest.fn(() => Promise.resolve()),
    releaseWorktree: jest.fn(() => Promise.resolve()),
    hasLiveTerminals: jest.fn(() => false),
    runningWorktrees: jest.fn(() => [
      { projectId: 'project', worktreeId: 'task' },
    ]),
    lowerPriority: jest.fn(),
    profiles: jest.fn(() => []),
    defaultShellBasename: jest.fn(() => 'zsh'),
    prewarmShell: jest.fn(() => Promise.resolve()),
    setEventSink: jest.fn((listener) => {
      sink = listener;
    }),
    addEventListener: jest.fn(() => () => undefined),
  };
}

function daemon(): Pick<
  RemoteTerminals,
  | 'has'
  | 'list'
  | 'get'
  | 'replay'
  | 'replayText'
  | 'write'
  | 'resize'
  | 'kill'
  | 'killWorktree'
  | 'killAll'
  | 'release'
  | 'releaseWorktree'
  | 'hasLiveTerminals'
  | 'runningWorktrees'
> {
  return {
    has: jest.fn((id: string) => id === 'remote'),
    list: jest.fn(() => [session('remote')]),
    get: jest.fn(() => session('remote')),
    replay: jest.fn(() => ({
      session: session('remote'),
      replay: new Uint8Array(),
      seq: 0,
    })),
    replayText: jest.fn(() => 'remote text'),
    write: jest.fn(),
    resize: jest.fn(),
    kill: jest.fn(),
    killWorktree: jest.fn(),
    killAll: jest.fn(() => Promise.resolve()),
    release: jest.fn(() => Promise.resolve()),
    releaseWorktree: jest.fn(() => Promise.resolve()),
    hasLiveTerminals: jest.fn(() => true),
    runningWorktrees: jest.fn(() => [
      { projectId: 'project', worktreeId: 'task' },
    ]),
  };
}

function setup(): {
  routed: RoutedWorkerTerminal;
  local: ReturnType<typeof engine>;
  remote: ReturnType<typeof daemon>;
} {
  const local = engine();
  const remote = daemon();
  const routed = new RoutedWorkerTerminal(local);
  // The mock covers every member the routed port calls.
  routed.useDaemonTerminals(remote as unknown as RemoteTerminals);
  return { routed, local, remote };
}

describe('RoutedWorkerTerminal (CAN-5088)', () => {
  it('sends each call that names a terminal to the side that holds it', async () => {
    const { routed, local, remote } = setup();
    routed.write('remote', 'ls\r');
    routed.write('local', 'ls\r');
    routed.resize('remote', 90, 30);
    routed.kill('remote', { signal: 'user-close' });
    await routed.release('remote');
    expect(routed.replayText('remote')).toBe('remote text');
    expect(routed.get('remote')?.id).toBe('remote');
    expect(jest.mocked(remote.write)).toHaveBeenCalledWith('remote', 'ls\r');
    expect(jest.mocked(local.write)).toHaveBeenCalledWith('local', 'ls\r');
    expect(jest.mocked(remote.resize)).toHaveBeenCalledWith('remote', 90, 30);
    expect(jest.mocked(remote.kill)).toHaveBeenCalledWith(
      'remote',
      'user-close',
    );
    expect(jest.mocked(remote.release)).toHaveBeenCalledWith('remote');
    expect(jest.mocked(local.kill)).not.toHaveBeenCalled();
  });

  it('keeps its own create in process and reaches both sides for worktree-wide calls', async () => {
    const { routed, local, remote } = setup();
    expect(
      routed.create({ projectId: 'p', worktreeId: 't', cols: 80, rows: 24 }).id,
    ).toBe('local');
    expect(routed.list().map(({ id }) => id)).toEqual(['local', 'remote']);
    const scope = { projectId: 'project', worktreeId: 'task' };
    routed.killWorktree(scope);
    routed.killAll();
    await routed.releaseWorktree(scope);
    expect(jest.mocked(local.killWorktree)).toHaveBeenCalledWith(scope);
    expect(jest.mocked(remote.killWorktree)).toHaveBeenCalledWith(scope);
    expect(jest.mocked(remote.killAll)).toHaveBeenCalled();
    expect(jest.mocked(remote.releaseWorktree)).toHaveBeenCalledWith(scope);
    expect(routed.hasLiveTerminals(scope)).toBe(true);
    expect(routed.runningWorktrees()).toEqual([scope]);
  });

  it('delivers engine and daemon events to the sink before other listeners', () => {
    const { routed, local } = setup();
    const order: string[] = [];
    routed.setEventSink(() => order.push('sink'));
    routed.addEventListener(() => order.push('listener'));
    const event: WorkerTerminalEvent = {
      type: 'exit',
      payload: {
        projectId: 'p',
        worktreeId: 't',
        terminalId: 'x',
        exitCode: 0,
        signal: null,
      },
    };
    local.sink()?.(event);
    routed.emit(event);
    expect(order).toEqual(['sink', 'listener', 'sink', 'listener']);
  });
});
