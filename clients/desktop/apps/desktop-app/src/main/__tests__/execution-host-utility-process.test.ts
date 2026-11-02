import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import type { PlatformExecutionProcessServices } from '@canopy/core-runtime';

class FakeUtilityProcess extends EventEmitter {
  public pid: number | undefined;
  public readonly postMessage = jest.fn();
  public readonly kill = jest.fn(() => this.pid !== undefined);
}

jest.mock('electron', () => ({
  __esModule: true,
  utilityProcess: { fork: jest.fn(() => new FakeUtilityProcess()) },
}));

import { utilityProcess } from 'electron';
import { createUtilityProcessHostPort } from '../execution-host/utility-process-host';

// eslint-disable-next-line @typescript-eslint/unbound-method -- a jest mock, never called with `this`
const forkMock = jest.mocked(utilityProcess.fork);

function forked(): FakeUtilityProcess {
  const child: unknown = forkMock.mock.results.at(-1)?.value;
  if (!(child instanceof FakeUtilityProcess)) throw new Error('nothing forked');
  return child;
}

describe('utility-process execution host port', () => {
  beforeEach(() => {
    forkMock.mockClear();
  });

  it('forks the bundled entry with its service name and inherited environment', () => {
    const port = createUtilityProcessHostPort({
      entryDirectory: '/app/out/main',
    });
    port.launch({
      entry: 'pipeline-process-host-worker.js',
      serviceName: 'pipeline-process-host',
    });
    expect(forkMock).toHaveBeenLastCalledWith(
      path.join('/app/out/main', 'pipeline-process-host-worker.js'),
      [],
      { serviceName: 'pipeline-process-host' },
    );

    port.launch({
      entry: 'code-graph-fingerprint-worker.js',
      serviceName: 'code-graph-fingerprint',
      env: { CANOPY_GIT_EXECUTABLE: '/usr/bin/git' },
    });
    expect(forkMock).toHaveBeenLastCalledWith(
      path.join('/app/out/main', 'code-graph-fingerprint-worker.js'),
      [],
      {
        serviceName: 'code-graph-fingerprint',
        env: { ...process.env, CANOPY_GIT_EXECUTABLE: '/usr/bin/git' },
      },
    );
  });

  it('reports spawn and exit once and nothing after exit', () => {
    const port = createUtilityProcessHostPort({ entryDirectory: '/app' });
    const host = port.launch({ entry: 'host.js', serviceName: 'host' });
    const child = forked();
    const events: unknown[] = [];
    host.on('spawn', () => events.push(['spawn', host.pid]));
    host.on('message', (message) => events.push(['message', message]));
    host.on('exit', (code) => events.push(['exit', code]));

    expect(host.pid).toBeUndefined();
    child.pid = 42;
    child.emit('spawn');
    child.emit('spawn');
    child.emit('message', { type: 'result' });
    child.emit('exit', 0);
    child.emit('exit', 0);
    child.emit('message', { type: 'late' });

    expect(events).toEqual([
      ['spawn', 42],
      ['message', { type: 'result' }],
      ['exit', 0],
    ]);
  });

  it('passes messages and kills through, refusing a kill before launch', () => {
    const port = createUtilityProcessHostPort({ entryDirectory: '/app' });
    const host = port.launch({ entry: 'host.js', serviceName: 'host' });
    const child = forked();

    host.postMessage({ type: 'run' });
    expect(child.postMessage).toHaveBeenCalledWith({ type: 'run' });
    expect(host.kill()).toBe(false);
    child.pid = 7;
    expect(host.kill()).toBe(true);
    expect(child.kill).toHaveBeenCalledTimes(2);
  });

  it('runs probes over the owned-process services', async () => {
    const start = jest.fn(() => Promise.reject(new Error('refused')));
    const services: PlatformExecutionProcessServices = {
      start,
      shutdown: () => Promise.resolve(),
    };
    const port = createUtilityProcessHostPort({ services: () => services });
    await expect(
      port.probe({
        executable: '/bin/zsh',
        args: ['-lic', 'exit'],
        environment: { PATH: '/usr/bin' },
        timeoutMs: 1_000,
        maxOutputBytes: 1_024,
      }),
    ).resolves.toEqual({ ok: false, reason: 'not-started' });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: '/bin/zsh',
        args: ['-lic', 'exit'],
        environment: { PATH: '/usr/bin' },
        stdin: 'ignore',
        stderr: 'discard',
      }),
    );
  });

  it('loads the host primitive on the first probe and runs it', async () => {
    const port = createUtilityProcessHostPort();
    await expect(
      port.probe({
        executable: process.execPath,
        args: ['-e', 'process.stdout.write("probed")'],
        environment: { PATH: process.env.PATH ?? '' },
        timeoutMs: 20_000,
        maxOutputBytes: 1_024,
      }),
    ).resolves.toEqual({ ok: true, stdout: 'probed' });
  });
});
