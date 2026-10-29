import { createWindowsClosureWitness } from '../supervision/windows-closure';
import { ChildProcess } from 'node:child_process';
import { LocalAuthorityIdentityError } from '../local-authority';
import {
  runWindowsProcess,
  windowsPrincipal,
  windowsPrincipalObserver,
  windowsPrincipalSid,
  windowsStartIdentity,
  windowsProcessObserver,
} from '../supervision/windows-process';

const FILE = 'C:\\trusted\\canopy-process-identity.exe';
const RECEIPT = 'canopy-process-v1 4242 134359142061234569\n';
const ID = 'win32:v1:4242:20261008062326123456';
type Execute = NonNullable<Parameters<typeof runWindowsProcess>[3]>;
function pending(): {
  child: ChildProcess;
  execute: Execute;
  finish: (error?: Error | null, stdout?: string, stderr?: string) => void;
} {
  const child = new ChildProcess();
  jest.spyOn(child, 'kill').mockReturnValue(true);
  let callback: Parameters<Execute>[3] = () => {};
  const execute: Execute = jest.fn((_file, _args, _options, done) => {
    callback = done;
    return child;
  });
  return {
    child,
    execute,
    finish: (error = null, stdout = RECEIPT, stderr = '') =>
      callback(error, stdout, stderr),
  };
}
function close(child: ChildProcess): void {
  child.emit('close', 0, null);
}

it('normalizes integer FILETIME without rounding or losing microseconds', () => {
  for (let remainder = BigInt(0); remainder < BigInt(10); remainder++)
    expect(
      windowsStartIdentity(
        `canopy-process-v1 4242 ${BigInt('134359142061234560') + remainder}\n`,
        4242,
      ),
    ).toBe(ID);
  expect(
    windowsStartIdentity('canopy-process-v1 4242 134359142061234570\r\n', 4242),
  ).toBe(ID.replace(/56$/, '57'));
  for (const [iso, micros] of [
    ['2024-02-29T23:59:59Z', '999999'],
    ['2025-01-01T00:00:00Z', '000001'],
  ]) {
    const ticks =
      (BigInt(Date.parse(iso ?? '') / 1000) + BigInt(11644473600)) *
        BigInt(10000000) +
      BigInt(micros ?? '') * BigInt(10);
    expect(
      windowsStartIdentity(`canopy-process-v1 4242 ${ticks}\n`, 4242),
    ).toBe(`win32:v1:4242:${iso?.replace(/[-T:Z]/g, '')}${micros}`);
  }
});
it('rejects malformed, mismatched, default and unavailable identity receipts', () => {
  for (const text of [
    '',
    'null',
    RECEIPT + RECEIPT,
    RECEIPT.trim(),
    RECEIPT.replace('4242', '7'),
    RECEIPT.replace('4242', '04242'),
    RECEIPT.replace('v1', 'v2'),
    RECEIPT.replace('134359142061234569', '2650467744000000000'),
    RECEIPT.replace('134359142061234569', '-1'),
    ...Array.from({ length: 10 }, (_, n) => `canopy-process-v1 4242 ${n}\n`),
  ])
    expect(windowsStartIdentity(text, 4242)).toBeNull();
});
it('missing, relative, wrong-name and wrong-architecture helpers fail closed', async () => {
  for (const file of [
    '',
    'canopy-process-identity.exe',
    'C:\\trusted\\wrong.exe',
    FILE,
  ])
    await expect(windowsProcessObserver(file)(4242)).rejects.toThrow();
});

describe('Windows helper child lifecycle', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
  it('does not spawn pre-aborted work and preserves exact abort reasons', () => {
    const work = pending();
    const reason = new Error('exact');
    expect(() =>
      runWindowsProcess(FILE, 4242, AbortSignal.abort(reason), work.execute),
    ).toThrow(reason);
    expect(work.execute).not.toHaveBeenCalled();
  });
  it('uses fixed bounded exec inputs and waits for successful close', async () => {
    const work = pending();
    const result = runWindowsProcess(FILE, 4242, undefined, work.execute);
    work.finish();
    expect(work.execute).toHaveBeenCalledWith(
      FILE,
      ['4242'],
      {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 65536,
        env: {},
        cwd: 'C:\\trusted',
      },
      expect.any(Function),
    );
    await expect(
      Promise.race([result, Promise.resolve('pending')]),
    ).resolves.toBe('pending');
    close(work.child);
    await expect(result).resolves.toBe(RECEIPT);
  });
  it.each(['abort', 'timeout', 'error', 'output', 'stderr', 'exit'] as const)(
    '%s retains admission across independent callers until close and consumes late callbacks',
    async (mode) => {
      const works = Array.from({ length: 4 }, pending);
      const controller = new AbortController();
      const reason = new Error('exact reason');
      const results = works.map((work) =>
        runWindowsProcess(FILE, 4242, controller.signal, work.execute).catch(
          (error: unknown) => error,
        ),
      );
      if (mode === 'abort') controller.abort(reason);
      if (mode === 'timeout') await jest.advanceTimersByTimeAsync(4000);
      for (const work of works) {
        if (mode === 'error') work.child.emit('error', new Error('spawn'));
        if (mode === 'output') work.finish(null, 'x'.repeat(65537));
        if (mode === 'stderr') work.finish(null, RECEIPT, 'diagnostic');
        if (mode === 'exit') {
          work.finish(new Error('exit'));
        }
      }
      for (const result of results)
        expect(await result).toEqual(
          mode === 'abort' ? reason : expect.any(Error),
        );
      await expect(
        runWindowsProcess(FILE, 4242, undefined, pending().execute),
      ).rejects.toThrow();
      for (const work of works) {
        work.finish();
        close(work.child);
        work.finish(new Error('late'));
      }
      const retry = pending();
      const result = runWindowsProcess(FILE, 4242, undefined, retry.execute);
      retry.finish();
      close(retry.child);
      await expect(result).resolves.toBe(RECEIPT);
    },
  );
  it('consumes kill errors without retrying a failed termination or releasing admission early', async () => {
    const work = pending();
    const controller = new AbortController();
    const reason = new Error('cancel');
    const kill = jest.spyOn(work.child, 'kill').mockImplementation(() => {
      work.child.emit('error', new Error('kill denied'));
      return false;
    });
    const result = runWindowsProcess(
      FILE,
      4242,
      controller.signal,
      work.execute,
    );
    try {
      controller.abort(reason);
      await expect(result).rejects.toBe(reason);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(() =>
        work.child.emit('error', new Error('late error')),
      ).not.toThrow();
      work.finish();
    } finally {
      close(work.child);
    }
  });
  it('releases admission on synchronous no-child throw and rejects signalled/nonzero close', async () => {
    const execute: Execute = () => {
      throw new Error('spawn');
    };
    for (let i = 0; i < 8; i++)
      await expect(
        runWindowsProcess(FILE, 4242, undefined, execute),
      ).rejects.toThrow();
    for (const [code, signal] of [
      [1, null],
      [null, 'SIGTERM'],
    ]) {
      const work = pending();
      const result = runWindowsProcess(FILE, 4242, undefined, work.execute);
      work.finish();
      work.child.emit('close', code, signal);
      await expect(result).rejects.toThrow();
    }
  });
});

it('bounds helper validation and retains its slot until the no-child tail finishes', async () => {
  jest.useFakeTimers();
  const works = Array.from({ length: 4 }, pending);
  const finishes: Array<() => void> = [];
  const results = works.map((work) =>
    runWindowsProcess(
      FILE,
      4242,
      undefined,
      work.execute,
      () => new Promise<void>((resolve) => finishes.push(resolve)),
    ).catch((error: unknown) => error),
  );
  await jest.advanceTimersByTimeAsync(4000);
  for (const result of results) expect(await result).toEqual(expect.any(Error));
  await expect(
    runWindowsProcess(FILE, 4242, undefined, pending().execute),
  ).rejects.toThrow();
  for (const finish of finishes) finish();
  await jest.advanceTimersByTimeAsync(0);
  for (const work of works) expect(work.execute).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
});

it('fresh inspectors share admission and successful callback cancellation preserves the exact public reason', async () => {
  const { createProcessInspector } = await import('../supervision/inspect');
  const { NODE_SUPERVISION } = await import('../supervision/shared');
  const controller = new AbortController();
  const reason = new Error('cancel before successful close');
  const works = Array.from({ length: 5 }, pending);
  const inspectors = works.map((work) =>
    createProcessInspector('win32', {
      ...NODE_SUPERVISION,
      kill: () => {},
      windowsProcess: (pid, signal) =>
        runWindowsProcess(FILE, pid, signal, work.execute),
    }),
  );
  const results = inspectors
    .slice(0, 4)
    .map((inspect) =>
      inspect({ pid: 4242, signal: controller.signal }).catch(
        (error: unknown) => error,
      ),
    );
  await expect(inspectors[4]?.({ pid: 4242 })).resolves.toMatchObject({
    state: 'unverifiable',
  });
  expect(works[4]?.execute).not.toHaveBeenCalled();
  works[0]?.finish();
  controller.abort(reason);
  for (const result of results) expect(await result).toBe(reason);
  for (const work of works.slice(0, 4)) {
    work.finish();
    close(work.child);
  }
});

it('closure retains a rejected helper tail and cannot erase it with a later success', async () => {
  const witness = createWindowsClosureWitness();
  const first = pending();
  const second = pending();
  await witness.run(async () => {
    const failed = runWindowsProcess(FILE, 4242, undefined, first.execute);
    first.finish(new Error('failed observation'));
    await expect(failed).rejects.toThrow();
    const successful = runWindowsProcess(FILE, 4242, undefined, second.execute);
    second.finish();
    close(second.child);
    await expect(successful).resolves.toBe(RECEIPT);
  });
  const report = witness.finalize();
  try {
    expect(report.started).toBe(2);
    expect(report.pending).toBe(1);
    expect(witness.accepts(report)).toBe(false);
  } finally {
    close(first.child);
  }
  expect(witness.accepts(report)).toBe(false);
});

it.each(['throw', 'prepare', 'invalid', 'admission'] as const)(
  'closure refuses a pre-launch %s identity failure despite successful helpers',
  async (mode) => {
    const witness = createWindowsClosureWitness();
    const helpers = Array.from(
      { length: mode === 'admission' ? 4 : 1 },
      pending,
    );
    const throws: Execute = () => {
      throw new Error('spawn');
    };
    const execute = mode === 'throw' ? throws : pending().execute;
    const notPe = (): Promise<void> => Promise.reject(new Error('not PE'));
    await witness.run(async () => {
      const works = helpers.map((helper) =>
        runWindowsProcess(FILE, 4242, undefined, helper.execute),
      );
      await expect(
        mode === 'invalid'
          ? windowsProcessObserver('C:\\trusted\\wrong.exe')(4242)
          : runWindowsProcess(
              FILE,
              4242,
              undefined,
              execute,
              mode === 'prepare' ? notPe : undefined,
            ),
      ).rejects.toThrow();
      for (const { finish, child } of helpers) {
        finish();
        close(child);
      }
      for (const work of works) await expect(work).resolves.toBe(RECEIPT);
    });
    const report = witness.finalize();
    expect(report).toMatchObject({ started: helpers.length + 1, pending: 0 });
    expect(witness.accepts(report)).toBe(false);
  },
);

it('closure accepts successful native-helper callback plus original child close', async () => {
  const witness = createWindowsClosureWitness();
  const helper = pending();
  await witness.run(async () => {
    const work = runWindowsProcess(FILE, 4242, undefined, helper.execute);
    helper.finish();
    close(helper.child);
    await expect(work).resolves.toBe(RECEIPT);
  });
  const report = witness.finalize();
  expect(report).toMatchObject({ started: 1, pending: 0, unsafe: false });
  expect(witness.accepts(report)).toBe(true);
});

const SID = 'S-1-5-21-1004336348-1177238915-682003330-1001';
const PRINCIPAL = `canopy-principal-v1 ${SID}\n`;
const MAX_SID = `S-1-281474976710655${'-4294967295'.repeat(15)}`;
const unavailable = (error: unknown): boolean =>
  error instanceof LocalAuthorityIdentityError &&
  error.code === 'principal_unavailable' &&
  !error.message.includes('S-1') &&
  !error.message.includes('trusted');

it('pins canonical decimal SID receipts at every structural boundary', () => {
  expect(MAX_SID).toHaveLength(184);
  for (const sid of [
    SID,
    'S-1-0',
    'S-1-5',
    'S-1-0-0',
    'S-1-5-18',
    'S-1-4294967296-0',
    'S-1-281474976710655',
    `S-1-5${'-0'.repeat(15)}`,
    MAX_SID,
  ]) {
    expect(windowsPrincipalSid(`canopy-principal-v1 ${sid}\n`)).toBe(sid);
    expect(windowsPrincipalSid(`canopy-principal-v1 ${sid}\r\n`)).toBe(sid);
  }
});
it('rejects noncanonical, out-of-range, duplicate and malformed principal receipts', () => {
  const row = (sid: string): string => `canopy-principal-v1 ${sid}\n`;
  for (const text of [
    '',
    'null',
    RECEIPT,
    PRINCIPAL.trim(),
    `${PRINCIPAL.trim()}\r`,
    PRINCIPAL + PRINCIPAL,
    `${PRINCIPAL}\n`,
    `${PRINCIPAL}${'x'.repeat(300)}`,
    ` ${PRINCIPAL}`,
    PRINCIPAL.replace(' ', '  '),
    PRINCIPAL.replace('\n', ' \n'),
    PRINCIPAL.replace('v1', 'v2'),
    PRINCIPAL.replace('principal', 'process'),
    ...[
      '',
      'S-1',
      'S-1-',
      'S-1-5-',
      'S-1-5--18',
      's-1-5-18',
      'S-2-5-18',
      'S-01-5-18',
      'S-1-05-18',
      'S-1-5-018',
      'S-1-5-00',
      'S-1-+5-18',
      'S-1--5-18',
      'S-1-0x5-18',
      'S-1-0x000100000000-0',
      'S-1-5-1e3',
      'S-1-281474976710656',
      'S-1-1000000000000000',
      'S-1-5-4294967296',
      'S-1-5-10000000000',
      `S-1-5${'-0'.repeat(16)}`,
      `${MAX_SID}-0`,
      'S-1-5-1\u00008',
      'S-1-5-\uff11',
      'S-1-5-\u0661',
      'S-1-5-18\u200b',
      'S\u20111-5-18',
    ].map(row),
  ])
    expect(windowsPrincipalSid(text)).toBeNull();
});
it('principal observer refuses untrusted locations and preserves exact pre-launch abort reasons', async () => {
  for (const file of [
    '',
    'canopy-process-identity.exe',
    'C:\\trusted\\wrong.exe',
    `${FILE}\n`,
    FILE,
  ]) {
    const error: unknown = await windowsPrincipalObserver(file)().catch(
      (caught: unknown) => caught,
    );
    expect(unavailable(error)).toBe(true);
  }
  const reason = new Error('exact');
  await expect(
    windowsPrincipalObserver(FILE)(AbortSignal.abort(reason)),
  ).rejects.toBe(reason);
});

describe('Windows principal helper lifecycle', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
  it('launches only the fixed token-user mode with PID-mode inputs and waits for close', async () => {
    const work = pending();
    const result = windowsPrincipal(
      runWindowsProcess(FILE, 'token-user', undefined, work.execute),
    );
    work.finish(null, PRINCIPAL);
    expect(work.execute).toHaveBeenCalledWith(
      FILE,
      ['--token-user'],
      {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 65536,
        env: {},
        cwd: 'C:\\trusted',
      },
      expect.any(Function),
    );
    await expect(
      Promise.race([result, Promise.resolve('pending')]),
    ).resolves.toBe('pending');
    close(work.child);
    await expect(result).resolves.toBe(SID);
  });
  it.each([
    'receipt',
    'pid-receipt',
    'empty',
    'timeout',
    'error',
    'output',
    'stderr',
    'exit',
    'nonzero',
    'signal',
    'abort',
  ] as const)(
    '%s maps to the fixed principal refusal (abort keeps its reason) and keeps admission until close',
    async (mode) => {
      const work = pending();
      const controller = new AbortController();
      const reason = new Error('exact reason');
      const result = windowsPrincipal(
        runWindowsProcess(FILE, 'token-user', controller.signal, work.execute),
        controller.signal,
      ).catch((error: unknown) => error);
      if (mode === 'receipt')
        work.finish(null, PRINCIPAL.replace('-5-', '-05-'));
      if (mode === 'pid-receipt') work.finish(null, RECEIPT);
      if (mode === 'empty') work.finish(null, '');
      if (mode === 'timeout') await jest.advanceTimersByTimeAsync(4000);
      if (mode === 'error') work.child.emit('error', new Error(SID));
      if (mode === 'output') work.finish(null, PRINCIPAL.repeat(4096));
      if (mode === 'stderr') work.finish(null, PRINCIPAL, SID);
      if (mode === 'exit') work.finish(new Error(SID), PRINCIPAL);
      if (mode === 'nonzero' || mode === 'signal') {
        work.finish(null, PRINCIPAL);
        work.child.emit(
          'close',
          mode === 'nonzero' ? 1 : null,
          mode === 'signal' ? 'SIGTERM' : null,
        );
      }
      if (mode === 'abort') controller.abort(reason);
      if (['receipt', 'pid-receipt', 'empty'].includes(mode)) close(work.child);
      const error = await result;
      if (mode === 'abort') expect(error).toBe(reason);
      else expect(unavailable(error)).toBe(true);
      // Every admitted slot is still owned by its child until close.
      const others = Array.from({ length: 3 }, pending);
      const held = others.map((other) =>
        runWindowsProcess(FILE, 'token-user', undefined, other.execute),
      );
      const closedChild = ![
        'timeout',
        'error',
        'output',
        'stderr',
        'exit',
        'abort',
      ].includes(mode);
      const extra = pending();
      const fifth = windowsPrincipal(
        runWindowsProcess(FILE, 'token-user', undefined, extra.execute),
      ).catch((caught: unknown) => caught);
      if (!closedChild) {
        expect(unavailable(await fifth)).toBe(true);
        expect(extra.execute).not.toHaveBeenCalled();
        work.finish();
        close(work.child);
      } else {
        extra.finish(null, PRINCIPAL);
        close(extra.child);
        expect(await fifth).toBe(SID);
      }
      for (const other of others) {
        other.finish(null, PRINCIPAL);
        close(other.child);
      }
      for (const item of held) await expect(item).resolves.toBe(PRINCIPAL);
    },
  );
  it('shares four-child admission across PID and principal modes until each child closes', async () => {
    const works = Array.from({ length: 4 }, pending);
    const results = works.map((work, index) =>
      index % 2
        ? windowsPrincipal(
            runWindowsProcess(FILE, 'token-user', undefined, work.execute),
          )
        : runWindowsProcess(FILE, 4242, undefined, work.execute),
    );
    const extra = pending();
    const refusedPrincipal = windowsPrincipal(
      runWindowsProcess(FILE, 'token-user', undefined, extra.execute),
    ).catch((error: unknown) => error);
    expect(unavailable(await refusedPrincipal)).toBe(true);
    await expect(
      runWindowsProcess(FILE, 4242, undefined, extra.execute),
    ).rejects.toThrow();
    expect(extra.execute).not.toHaveBeenCalled();
    works.forEach((work, index) => {
      work.finish(null, index % 2 ? PRINCIPAL : RECEIPT);
      close(work.child);
    });
    expect(await Promise.all(results)).toEqual([RECEIPT, SID, RECEIPT, SID]);
    const retry = pending();
    const again = windowsPrincipal(
      runWindowsProcess(FILE, 'token-user', undefined, retry.execute),
    );
    retry.finish(null, PRINCIPAL);
    close(retry.child);
    await expect(again).resolves.toBe(SID);
  });
});

it('closure accepts a closed principal child and refuses a pre-launch principal refusal', async () => {
  for (const mode of ['closed', 'invalid'] as const) {
    const witness = createWindowsClosureWitness();
    const helper = pending();
    await witness.run(async () => {
      if (mode === 'invalid') {
        await expect(
          windowsPrincipalObserver('C:\\trusted\\wrong.exe')(),
        ).rejects.toBeInstanceOf(LocalAuthorityIdentityError);
        return;
      }
      const work = windowsPrincipal(
        runWindowsProcess(FILE, 'token-user', undefined, helper.execute),
      );
      helper.finish(null, PRINCIPAL);
      close(helper.child);
      await expect(work).resolves.toBe(SID);
    });
    const report = witness.finalize();
    expect(report).toMatchObject({ started: 1, pending: 0 });
    expect(witness.accepts(report)).toBe(mode === 'closed');
  }
});
