import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  ProviderProcessError,
  type ProviderProcess,
  type ProviderProcessOwner,
  type ProviderProcessRequest,
} from '../../provider-process/spawn';
import {
  verifyCursorRuntimeVersion,
  type CursorVersionProbeDiagnostic,
} from '../runtime-process';

const VERSION = '2026.09.08-6caf4ff';
const OWNER: ProviderProcessOwner = { kind: 'turn', id: 'probe-test' };
const LAUNCH = {
  command: '/opt/cursor/bin/cursor-agent',
  prefix: ['--prefixed'],
};

class FakeProcess extends EventEmitter implements ProviderProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stop = jest.fn((): Promise<void> => {
    this.close(null, 'SIGKILL');
    return Promise.resolve();
  });
  private closed = false;

  constructor(readonly pid: number | undefined) {
    super();
  }

  close(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.emit('close', code, signal);
  }
}

function spawnerWith(behave: (child: FakeProcess) => void): {
  requests: ProviderProcessRequest[];
  children: FakeProcess[];
  spawner: (request: ProviderProcessRequest) => ProviderProcess;
} {
  const requests: ProviderProcessRequest[] = [];
  const children: FakeProcess[] = [];
  return {
    requests,
    children,
    spawner: (request) => {
      requests.push(request);
      const child = new FakeProcess(4242);
      children.push(child);
      process.nextTick(() => behave(child));
      return child;
    },
  };
}

describe('verifyCursorRuntimeVersion through the provider spawner', () => {
  it('the version probe spawns through the injected spawner with the pinned arguments', async () => {
    const fake = spawnerWith((child) => {
      child.stdout.write(`${VERSION}\n`);
      child.close(0, null);
    });
    await expect(
      verifyCursorRuntimeVersion(
        { spawner: fake.spawner, owner: OWNER },
        LAUNCH,
        { PATH: '/usr/bin' },
        new AbortController().signal,
        VERSION,
      ),
    ).resolves.toBeUndefined();
    expect(fake.requests).toEqual([
      {
        command: LAUNCH.command,
        args: ['--prefixed', '--disable-auto-update', '--version'],
        cwd: '/opt/cursor/bin',
        env: { PATH: '/usr/bin' },
        owner: OWNER,
      },
    ]);
  });

  it('a spawn failure is a spawn-error', async () => {
    const diagnostics: CursorVersionProbeDiagnostic[] = [];
    const requests: ProviderProcessRequest[] = [];
    const spawner = (request: ProviderProcessRequest): ProviderProcess => {
      requests.push(request);
      const child = new FakeProcess(undefined);
      process.nextTick(() => {
        child.emit(
          'error',
          new ProviderProcessError(`spawn ${request.command} ENOENT`, 'ENOENT'),
        );
        child.close(null, null);
      });
      return child;
    };
    await expect(
      verifyCursorRuntimeVersion(
        { spawner, owner: OWNER },
        LAUNCH,
        {},
        new AbortController().signal,
        VERSION,
        undefined,
        (diagnostic) => diagnostics.push(diagnostic),
      ),
    ).rejects.toThrow("Couldn't start the Cursor version check. Try again.");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      outcome: 'spawn-error',
      errorCode: 'ENOENT',
    });
  });

  it('a cancelled probe stops its child at once', async () => {
    const abort = new AbortController();
    const fake = spawnerWith(() => {
      abort.abort();
    });
    await expect(
      verifyCursorRuntimeVersion(
        { spawner: fake.spawner, owner: OWNER },
        LAUNCH,
        {},
        abort.signal,
        VERSION,
      ),
    ).rejects.toThrow('Cursor version check cancelled.');
    expect(fake.children).toHaveLength(1);
    expect(fake.children[0].stop).toHaveBeenCalledTimes(1);
    expect(fake.children[0].stop).toHaveBeenCalledWith({ graceMs: 0 });
  });
});
