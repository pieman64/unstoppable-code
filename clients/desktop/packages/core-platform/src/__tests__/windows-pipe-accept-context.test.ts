import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import type { PlatformNamedPipeAddress } from '@canopy/core-runtime';
import {
  loadWindowsPipeSecurity,
  type WindowsPipeSecurity,
} from '../endpoints';
import { openSecurePipe } from '../endpoints/windows-pipe';
import {
  captureWindowsClosureContext,
  createWindowsClosureWitness,
  observeWindowsClosure,
} from '../supervision/windows-closure';
import { FixtureCleanup } from './fixtures/pipe-test-cleanup';

// Kept out of windows-pipe-security.test.ts: that file is the qualified
// eight-case native gate (windows-pipe-inventory.json).

const windows = process.platform === 'win32';
const acceptance = process.env.CANOPY_PIPE_SECURITY_ACCEPTANCE === '1';
const ADDON =
  process.env.CANOPY_PIPE_SECURITY_ADDON ??
  path.resolve(
    __dirname,
    '../../native/windows-pipe/build/Release/windows_pipe_security.node',
  );
const addonMissing = existsSync(ADDON)
  ? null
  : `the addon is not built at ${ADDON} (run pnpm run build:windows-pipe-security or set CANOPY_PIPE_SECURITY_ADDON)`;

const TITLE = 'Windows named-pipe accept-thread context';
const available = windows && addonMissing === null;
if (windows && addonMissing !== null && !acceptance)
  process.stdout.write(`${TITLE}: skipped because ${addonMissing}.\n`);

const uniqueAddress = (): PlatformNamedPipeAddress => ({
  kind: 'named-pipe',
  path: `\\\\.\\pipe\\canopy-pipe-test-${randomBytes(8).toString('hex')}`,
});

async function within<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out after ${ms} ms: ${label}.`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

let cleanups = new FixtureCleanup();
beforeEach(() => {
  cleanups = new FixtureCleanup();
});
afterEach(async () => {
  const failures = await cleanups.close();
  if (failures)
    throw new Error(`Native teardown incomplete (${failures} releases).`);
}, 20_000);

let native: WindowsPipeSecurity | undefined;
function addon(): WindowsPipeSecurity {
  native ??= loadWindowsPipeSecurity(ADDON);
  return native;
}

if (windows && addonMissing !== null && acceptance)
  describe(TITLE, () => {
    it('has its prerequisites under CANOPY_PIPE_SECURITY_ACCEPTANCE=1', () => {
      throw new Error(`Acceptance run, but ${addonMissing}.`);
    });
  });

(available ? describe : describe.skip)(TITLE, () => {
  // C1: openSecurePipe binds delivery to the async context that opened the
  // pipe, so a closure run owns what its connections start. The bare
  // threadsafe callback does not carry it (Node 24.15, Windows 11 x64).
  it('a connection from outside the run is admitted and read inside the run that listened', async () => {
    // `listener` names the context that called listen; undefined means the
    // callback ran somewhere else.
    type Seen = { readonly edge: boolean; readonly listener?: string };
    const marker = new AsyncLocalStorage<string>();
    const serve = (
      address: PlatformNamedPipeAddress,
    ): {
      admitted: Promise<Seen>;
      read: Promise<Seen>;
      close(): void;
    } => {
      // Production's runner/host guard: a mismatch marks both runs unsafe.
      const check = captureWindowsClosureContext();
      const observe = (): Seen => {
        const edge = observeWindowsClosure('git');
        edge?.close();
        check();
        return { edge: edge !== undefined, listener: marker.getStore() };
      };
      let admitted!: (seen: Seen) => void;
      let read!: (seen: Seen) => void;
      const server = openSecurePipe(addon(), address.path, (socket) => {
        admitted(observe());
        socket.once('data', () => {
          read(observe());
          socket.destroy();
        });
      });
      if (server === 'in-use') throw new Error('Pipe name in use.');
      cleanups.own(() => {
        server.close();
        return Promise.resolve();
      });
      return {
        admitted: new Promise((resolve) => (admitted = resolve)),
        read: new Promise((resolve) => (read = resolve)),
        close: () => server.close(),
      };
    };
    const connectFromOutside = async (pipePath: string): Promise<void> => {
      const socket = createConnection(pipePath);
      socket.on('error', () => undefined);
      const closed = new Promise<void>((resolve) =>
        socket.once('close', () => resolve()),
      );
      cleanups.own(() => {
        socket.destroy();
        return closed;
      });
      await within(
        Promise.race([
          once(socket, 'connect'),
          closed.then(() => {
            throw new Error('Client closed before connecting.');
          }),
        ]),
        10_000,
        'client connect',
      );
      socket.write('ping');
      await within(closed, 10_000, 'server close');
    };

    const witness = createWindowsClosureWitness();
    const address = uniqueAddress();
    let listening!: (served: ReturnType<typeof serve>) => void;
    const ready = new Promise<ReturnType<typeof serve>>(
      (resolve) => (listening = resolve),
    );
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    const run = witness.run(async () => {
      const served = marker.run('run', () => serve(address));
      listening(served);
      await finished;
      served.close();
    });
    // This continuation, and the client, run outside the witness run.
    const served = await within(ready, 10_000, 'listen');
    expect(observeWindowsClosure('git')).toBeUndefined();
    expect(marker.getStore()).toBeUndefined();
    await within(connectFromOutside(address.path), 10_000, 'client');
    const seen = await within(
      Promise.all([served.admitted, served.read]),
      10_000,
      'admit and read',
    );
    finish();
    await within(run, 10_000, 'run');
    const report = witness.finalize();
    expect(seen).toEqual([
      { edge: true, listener: 'run' },
      { edge: true, listener: 'run' },
    ]);
    expect(report).toMatchObject({ started: 2, pending: 0, unsafe: false });
    expect(witness.accepts(report)).toBe(true);

    // Control: listened outside any run, the same callbacks observe no run but
    // still the listener's own context.
    const control = uniqueAddress();
    const outside = marker.run('control', () => serve(control));
    await within(connectFromOutside(control.path), 10_000, 'control client');
    expect(
      await within(
        Promise.all([outside.admitted, outside.read]),
        10_000,
        'control admit and read',
      ),
    ).toEqual([
      { edge: false, listener: 'control' },
      { edge: false, listener: 'control' },
    ]);
    outside.close();
  }, 60_000);
});
