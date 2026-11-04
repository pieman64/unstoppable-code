import type {
  PlatformExecutionOutcome,
  PlatformExecutionProcess,
  PlatformExecutionProcessServices,
} from '@canopy/core-runtime';
import { createOwnedProcessHostPort } from '../execution-host/owned-process-host';

// A host killed as it spawns, over a scripted owned-process primitive: the
// messages posted while it was starting never reach its stdin.

function scriptedServices(): {
  services: PlatformExecutionProcessServices;
  start: () => void;
  written: Uint8Array[];
  terminated: string[];
} {
  const written: Uint8Array[] = [];
  const terminated: string[] = [];
  let finish: (outcome: PlatformExecutionOutcome) => void = () => undefined;
  const outcome = new Promise<PlatformExecutionOutcome>((resolve) => {
    finish = resolve;
  });
  const ended = { read: (): Promise<null> => outcome.then(() => null) };
  const child: PlatformExecutionProcess = {
    pid: 4242,
    stdin: {
      write: (bytes) => {
        written.push(bytes);
        return Promise.resolve();
      },
      end: () => Promise.resolve(),
    },
    stdout: {
      ...ended,
      acknowledge: () => undefined,
      discard: () => undefined,
    },
    stderr: null,
    outcome,
    terminate: (options) => {
      terminated.push(options?.mode ?? 'force');
      finish({
        kind: 'cancelled',
        code: null,
        signal: 'SIGTERM',
        output: 'discarded',
      });
      return Promise.resolve();
    },
  };
  let started: (process: PlatformExecutionProcess) => void = () => undefined;
  const launched = new Promise<PlatformExecutionProcess>((resolve) => {
    started = resolve;
  });
  return {
    services: {
      start: () => launched,
      shutdown: () => Promise.resolve(),
    },
    start: () => started(child),
    written,
    terminated,
  };
}

describe('owned-process host killed while it starts', () => {
  it('never delivers what was posted before spawn to a host killed on spawn', async () => {
    const scripted = scriptedServices();
    const port = createOwnedProcessHostPort({
      services: scripted.services,
      nodeExecutable: '/usr/bin/node',
      entryDirectory: '/entries',
      cwd: '/',
      environment: () => ({}),
    });
    const host = port.launch({ entry: 'channel-host.js', serviceName: 'test' });
    const exited = new Promise<void>((resolve) => {
      host.once('exit', () => resolve());
    });
    host.postMessage({ type: 'build' });
    expect(host.kill()).toBe(false);
    host.once('spawn', () => {
      expect(host.kill()).toBe(true);
    });

    scripted.start();
    await exited;
    expect(scripted.terminated).toEqual(['graceful']);
    expect(scripted.written).toEqual([]);
  });
});
