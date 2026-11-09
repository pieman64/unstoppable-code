import { access } from 'node:fs/promises';
import { execFile, type ChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { LocalAuthorityIdentityError } from '../local-authority';
import { createWindowsClosureWitness } from '../supervision/windows-closure';
import {
  runWindowsProcess,
  WINDOWS_PROCESS_FILE,
  windowsPrincipalObserver,
  windowsPrincipalSid,
  windowsProcessObserver,
  windowsStartIdentity,
} from '../supervision/windows-process';

const ROOT = resolve(__dirname, '../../../..');
const HELPER = join(ROOT, '.cache/bin/win32-x64', WINDOWS_PROCESS_FILE);
const run = promisify(execFile);
const shipped = (args: string[]): Promise<{ stdout: string; stderr: string }> =>
  run(HELPER, args, {
    encoding: 'utf8',
    windowsHide: true,
    env: {},
    cwd: dirname(HELPER),
    timeout: 4000,
  });

// Not Node stand-ins: the source-built helper under its shipped recipe.
describe('shipped Windows identity helper', () => {
  beforeAll(async () => {
    if (process.platform !== 'win32') return;
    await access(HELPER).catch((cause: unknown) => {
      throw new Error(
        'Windows process helper missing or inaccessible; run pnpm run build:windows-process-identity before this suite.',
        { cause },
      );
    });
  });

  if (process.platform !== 'win32') {
    it('refuses principal observation off Windows without launching', async () => {
      const error: unknown = await windowsPrincipalObserver(HELPER)().catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(LocalAuthorityIdentityError);
      expect(error).toMatchObject({ code: 'principal_unavailable' });
    });
    return;
  }

  it('emits one canonical TokenUser receipt matching an independent token query', async () => {
    const { stdout, stderr } = await shipped(['--token-user']);
    expect(stderr).toBe('');
    const sid = windowsPrincipalSid(stdout);
    expect(sid).not.toBeNull();
    expect(stdout).toMatch(/^canopy-principal-v1 S-1-\d+(-\d+)*\r\n$/);
    const whoami = await run(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'),
      ['/user', '/fo', 'csv', '/nh'],
      { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
    );
    expect(sid).toBe(/,"(S-1-[0-9-]+)"\s*$/.exec(whoami.stdout)?.[1]);
    await expect(windowsPrincipalObserver(HELPER)()).resolves.toBe(sid);
  }, 30_000);

  it.each([
    { args: [] },
    { args: ['--TOKEN-USER'] },
    { args: ['--token-user', 'extra'] },
    { args: ['--principal'] },
  ])(
    'rejects unsupported invocation $args with no receipt',
    async ({ args }) => {
      await expect(shipped(args)).rejects.toMatchObject({
        code: 1,
        stdout: '',
        stderr: '',
      });
    },
    30_000,
  );

  it('shares four-child admission across both modes and closes every real child', async () => {
    const witness = createWindowsClosureWitness();
    const principal = windowsPrincipalObserver(HELPER);
    const observe = windowsProcessObserver(HELPER);
    const results = await witness.run(async () => {
      const admitted = [
        principal(),
        observe(process.pid),
        principal(),
        observe(process.pid),
      ];
      const refusedPrincipal = principal().catch((error: unknown) => error);
      const refusedProcess = observe(process.pid).catch(
        (error: unknown) => error,
      );
      const settled = await Promise.all(admitted);
      return {
        settled,
        refused: [await refusedPrincipal, await refusedProcess],
        retry: await principal(),
      };
    });
    const report = witness.finalize();
    const [sid, pidReceipt] = results.settled;
    expect(sid).toMatch(/^S-1-/);
    expect(results.settled).toEqual([sid, pidReceipt, sid, pidReceipt]);
    expect(windowsStartIdentity(pidReceipt ?? '', process.pid)).toMatch(
      new RegExp(`^win32:v1:${process.pid}:\\d{20}$`),
    );
    expect(results.refused[0]).toMatchObject({
      code: 'principal_unavailable',
    });
    expect(results.refused[1]).toEqual(expect.any(Error));
    expect(results.retry).toBe(sid);
    // Refused launches are failed observations, never safe closure.
    expect(report).toMatchObject({ started: 7, pending: 0 });
    expect(witness.accepts(report)).toBe(false);
    const clean = createWindowsClosureWitness();
    await clean.run(async () => {
      await expect(principal()).resolves.toBe(sid);
    });
    const closed = clean.finalize();
    expect(closed).toMatchObject({ started: 1, pending: 0, unsafe: false });
    expect(clean.accepts(closed)).toBe(true);
  }, 30_000);
});

async function bounded(promise: Promise<void>, ms = 3000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error('Helper startup or closure deadline exceeded')),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

it.each(['deadline', 'stdout', 'stderr', 'abort'] as const)(
  'real execFile %s exercises the Windows adapter and closes without test-assisted termination',
  async (mode) => {
    let child: ChildProcess | undefined;
    let closed: Promise<void> = Promise.resolve();
    let ready: Promise<void> = Promise.resolve();
    let started = false;
    let callbackError: Error | null | undefined;
    const controller = new AbortController();
    const reason = new Error('exact adapter cancellation');
    const script =
      mode === 'stdout' || mode === 'stderr'
        ? `process.${mode}.write('x'.repeat(131072));setInterval(()=>{},1000)`
        : "process.stdout.write('ready\\n');setInterval(()=>{},1000)";
    try {
      // Consume early failures while waiting for the independent startup receipt.
      const result = runWindowsProcess(
        process.execPath,
        4242,
        controller.signal,
        (file, _args, options, callback) => {
          child = execFile(
            file,
            ['-e', script],
            // Only project the fixture cwd on POSIX; Windows uses the exact
            // production options. Admission, buffers and termination stay real.
            process.platform === 'win32'
              ? options
              : { ...options, cwd: dirname(process.execPath) },
            (error, stdout, stderr) => {
              callbackError = error;
              callback(error, stdout, stderr);
            },
          );
          closed = new Promise<void>((resolve) =>
            child?.once('close', () => resolve()),
          );
          ready = new Promise<void>((resolve) => {
            let output = '';
            child?.stdout?.on('data', (chunk: string) => {
              output = (output + chunk).slice(0, 6);
              if (output === 'ready\n') {
                started = true;
                resolve();
              }
            });
          });
          return child;
        },
      ).catch((error: unknown) => error);
      if (mode === 'abort') {
        await bounded(ready, 4000);
        expect(child?.exitCode).toBeNull();
        expect(child?.signalCode).toBeNull();
        controller.abort(reason);
      }
      expect(await result).toEqual(
        mode === 'abort' ? reason : expect.any(Error),
      );
      // Prove production termination before the finally block's emergency kill.
      await bounded(closed);
      if (mode === 'stdout' || mode === 'stderr')
        expect(callbackError).toMatchObject({
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        });
      else {
        expect(started).toBe(true);
        expect(callbackError).toMatchObject({
          killed: true,
          signal: 'SIGTERM',
        });
      }
    } finally {
      // A killed flag is deliberately not closure evidence.
      if (child?.exitCode === null && child.signalCode === null) child.kill();
      await bounded(closed);
    }
  },
  12000,
);
