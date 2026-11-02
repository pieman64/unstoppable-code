import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
  lstat,
  symlink,
} from 'node:fs/promises';
import * as childProcess from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CopilotProcessReceipt,
  reapCopilotProcessReceipts,
} from '../process-receipts';
import * as ownership from '../process-ownership';

jest.mock('node:child_process', () => ({
  __esModule: true,
  ...jest.requireActual<typeof childProcess>('node:child_process'),
}));

const root = { pid: 12345, parent: 1, group: 12345, started: 'original' };
const tool = { pid: 12346, parent: 12345, group: 12346, started: 'tool' };
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'copilot-receipts-'));
  jest.spyOn(ownership, 'terminateCopilotDescendants').mockResolvedValue();
  jest.spyOn(ownership, 'remainingCopilotProcesses').mockResolvedValue([]);
});
afterEach(async () => {
  jest.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

test('durably records root and detached descendants; no tokens, commands or paths', async () => {
  const receipt = new CopilotProcessReceipt(directory);
  await receipt.save([root, tool]);
  const [name] = await readdir(directory);
  const path = join(directory, name);
  const bytes = await readFile(path, 'utf8');
  expect(JSON.parse(bytes)).toEqual({ version: 1, processes: [root, tool] });
  if (process.platform !== 'win32') {
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  }
  const before = (await lstat(path)).mtimeMs;
  await receipt.save([root, tool]);
  expect((await lstat(path)).mtimeMs).toBe(before);
  await receipt.removeIfReaped([root, tool]);
  expect(await readdir(directory)).toEqual([]);
});

test('next boot reaps only the saved identities, then removes the receipt', async () => {
  await new CopilotProcessReceipt(directory).save([root, tool]);
  await reapCopilotProcessReceipts(directory);
  expect(ownership.terminateCopilotDescendants).toHaveBeenCalledWith([
    root,
    tool,
  ]);
  expect(await readdir(directory)).toEqual([]);
});

test('retains the receipt on kill failure and on surviving identities', async () => {
  await new CopilotProcessReceipt(directory).save([root]);
  const denied = new Error('denied');
  jest
    .mocked(ownership.terminateCopilotDescendants)
    .mockRejectedValueOnce(denied);
  const killFailure = await reapCopilotProcessReceipts(directory).catch(
    (error: unknown) => error,
  );
  expect(killFailure).toBeInstanceOf(Error);
  expect(killFailure).toHaveProperty(
    'message',
    expect.stringContaining('recovery did not finish'),
  );
  expect(killFailure).toHaveProperty('cause', denied);
  expect(await readdir(directory)).toHaveLength(1);
  jest.mocked(ownership.remainingCopilotProcesses).mockResolvedValue([root]);
  await expect(reapCopilotProcessReceipts(directory)).rejects.toThrow(
    'recovery did not finish',
  );
  expect(await readdir(directory)).toHaveLength(1);
});

test('waits for a killed process that is still exiting, then removes its receipt', async () => {
  await new CopilotProcessReceipt(directory).save([root, tool]);
  // A SIGKILLed process can still appear in the snapshot taken right after.
  jest
    .mocked(ownership.remainingCopilotProcesses)
    .mockResolvedValueOnce([root, tool])
    .mockResolvedValueOnce([tool])
    .mockResolvedValue([]);
  await reapCopilotProcessReceipts(directory);
  expect(ownership.terminateCopilotDescendants).toHaveBeenCalledTimes(1);
  expect(ownership.remainingCopilotProcesses).toHaveBeenCalledTimes(3);
  expect(await readdir(directory)).toEqual([]);
});

test('retains the receipt and reports the survivor when it outlives the bounded wait', async () => {
  await new CopilotProcessReceipt(directory).save([root]);
  jest.mocked(ownership.remainingCopilotProcesses).mockResolvedValue([root]);
  const started = Date.now();
  const failure = await reapCopilotProcessReceipts(directory).catch(
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toHaveProperty(
    'message',
    'Copilot process recovery did not finish.',
  );
  expect(failure).toHaveProperty(
    'cause',
    expect.objectContaining({
      message: 'Copilot processes remain after recovery.',
    }),
  );
  expect(Object.keys(failure as object)).not.toContain('cause');
  expect(Date.now() - started).toBeGreaterThanOrEqual(1_500);
  expect(
    jest.mocked(ownership.remainingCopilotProcesses).mock.calls.length,
  ).toBeGreaterThan(2);
  expect(ownership.terminateCopilotDescendants).toHaveBeenCalledTimes(1);
  expect(await readdir(directory)).toHaveLength(1);
});

test('kills every receipt before waiting, and shares one exit deadline', async () => {
  await new CopilotProcessReceipt(directory).save([root]);
  await new CopilotProcessReceipt(directory).save([tool]);
  const events: string[] = [];
  jest.mocked(ownership.terminateCopilotDescendants).mockImplementation(() => {
    events.push('kill');
    return Promise.resolve();
  });
  jest
    .mocked(ownership.remainingCopilotProcesses)
    .mockImplementation((owned) => {
      events.push('probe');
      return Promise.resolve(owned);
    });
  const started = Date.now();
  await expect(reapCopilotProcessReceipts(directory)).rejects.toThrow(
    'recovery did not finish',
  );
  // Two lingering receipts cost one bounded wait, not one each.
  expect(Date.now() - started).toBeLessThan(3_500);
  expect(events.slice(0, 2)).toEqual(['kill', 'kill']);
  expect(events.filter((event) => event === 'kill')).toHaveLength(2);
  expect(await readdir(directory)).toHaveLength(2);
});

test('re-reads all lingering receipts in one probe, so slow probes cannot stack', async () => {
  await new CopilotProcessReceipt(directory).save([root]);
  await new CopilotProcessReceipt(directory).save([tool]);
  // A Windows identity query can take seconds; each probe advances the clock.
  let now = Date.now();
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  jest
    .mocked(ownership.remainingCopilotProcesses)
    .mockImplementation((owned) => {
      now += 1_500;
      return Promise.resolve(owned);
    });
  await expect(reapCopilotProcessReceipts(directory)).rejects.toThrow(
    'recovery did not finish',
  );
  const probes = jest.mocked(ownership.remainingCopilotProcesses).mock.calls;
  expect(probes).toHaveLength(2);
  for (const [owned] of probes)
    expect(owned).toEqual(expect.arrayContaining([root, tool]));
  expect(await readdir(directory)).toHaveLength(2);
});

test('removes the receipts that cleared and keeps only the survivor', async () => {
  await new CopilotProcessReceipt(directory).save([root]);
  await new CopilotProcessReceipt(directory).save([tool]);
  jest
    .mocked(ownership.remainingCopilotProcesses)
    .mockImplementation((owned) =>
      Promise.resolve(owned.filter((row) => row.pid === root.pid)),
    );
  await expect(reapCopilotProcessReceipts(directory)).rejects.toThrow(
    'recovery did not finish',
  );
  const left = await readdir(directory);
  expect(left).toHaveLength(1);
  expect(JSON.parse(await readFile(join(directory, left[0]), 'utf8'))).toEqual({
    version: 1,
    processes: [root],
  });
});

test('keeps the survivor failure as the cause when its probe fails', async () => {
  await new CopilotProcessReceipt(directory).save([root]);
  const unreadable = new Error('ps unavailable');
  jest
    .mocked(ownership.remainingCopilotProcesses)
    .mockResolvedValueOnce([root])
    .mockRejectedValueOnce(unreadable);
  const failure = await reapCopilotProcessReceipts(directory).catch(
    (error: unknown) => error,
  );
  expect(failure).toHaveProperty('cause', unreadable);
  expect(await readdir(directory)).toHaveLength(1);
});

test('removes an old receipt only after the absence probe confirms completion', async () => {
  await new CopilotProcessReceipt(directory).save([root]);
  let confirmAbsent: (remaining: ownership.ProcessIdentity[]) => void = () =>
    undefined;
  const absence = new Promise<ownership.ProcessIdentity[]>((resolve) => {
    confirmAbsent = resolve;
  });
  let probing: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    probing = resolve;
  });
  jest
    .mocked(ownership.remainingCopilotProcesses)
    .mockImplementationOnce(() => {
      probing();
      return absence;
    });
  const recovery = reapCopilotProcessReceipts(directory);
  await started;
  expect(ownership.terminateCopilotDescendants).toHaveBeenCalledWith([root]);
  expect(await readdir(directory)).toHaveLength(1);
  confirmAbsent([]);
  await recovery;
  expect(await readdir(directory)).toEqual([]);
});

test('does not remove a live runtime receipt during normal close', async () => {
  const receipt = new CopilotProcessReceipt(directory);
  await receipt.save([root]);
  jest.mocked(ownership.remainingCopilotProcesses).mockResolvedValue([root]);
  await receipt.removeIfReaped([root]);
  expect(await readdir(directory)).toHaveLength(1);
});

test.each([
  'not json',
  '{"version":2,"processes":[]}',
  '{"version":1,"processes":[{"pid":-1}]}',
])(
  'keeps corrupt or unsupported receipts without signaling (%s)',
  async (contents) => {
    const path = join(directory, '00000000-0000-0000-0000-000000000000.json');
    await writeFile(path, contents);
    await expect(reapCopilotProcessReceipts(directory)).rejects.toThrow(
      'recovery did not finish',
    );
    expect(ownership.terminateCopilotDescendants).not.toHaveBeenCalled();
    expect(await readFile(path, 'utf8')).toBe(contents);
  },
);

test('missing directory and empty receipt need no processes', async () => {
  await reapCopilotProcessReceipts(join(directory, 'missing'));
  const receipt = new CopilotProcessReceipt(directory);
  await receipt.save([]);
  expect(await readdir(directory)).toEqual([]);
  expect(ownership.terminateCopilotDescendants).not.toHaveBeenCalled();
});

test('next boot ignores reused PIDs rather than killing an unrelated process', async () => {
  if (process.platform === 'win32') return;
  jest.mocked(ownership.terminateCopilotDescendants).mockRestore();
  jest.mocked(ownership.remainingCopilotProcesses).mockRestore();
  jest.spyOn(childProcess, 'execFile').mockImplementation((...args) => {
    const callback = args[args.length - 1];
    if (typeof callback === 'function')
      callback(null, '12345 1 12345 replacement\n', '');
    return new childProcess.ChildProcess();
  });
  const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
  await new CopilotProcessReceipt(directory).save([root]);
  await reapCopilotProcessReceipts(directory);
  expect(kill).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual([]);
});

test('a corrupt receipt does not stop recovery of other runtimes', async () => {
  const corrupt = join(directory, '00000000-0000-0000-0000-000000000000.json');
  await writeFile(corrupt, 'not json');
  await new CopilotProcessReceipt(directory).save([root]);
  await expect(reapCopilotProcessReceipts(directory)).rejects.toThrow(
    'recovery did not finish',
  );
  expect(ownership.terminateCopilotDescendants).toHaveBeenCalledWith([root]);
  expect(await readdir(directory)).toEqual([
    '00000000-0000-0000-0000-000000000000.json',
  ]);
});

test('does not follow a receipt symlink or remove its target', async () => {
  if (process.platform === 'win32') return;
  const target = join(directory, 'target');
  await writeFile(target, JSON.stringify({ version: 1, processes: [root] }));
  await symlink(
    target,
    join(directory, '00000000-0000-0000-0000-000000000000.json'),
  );
  await expect(reapCopilotProcessReceipts(directory)).rejects.toThrow(
    'recovery did not finish',
  );
  expect(ownership.terminateCopilotDescendants).not.toHaveBeenCalled();
  expect(await readFile(target, 'utf8')).toContain('12345');
});

test(
  'a fresh receipt reader reaps a live orphan but not a bystander',
  async () => {
    jest.mocked(ownership.terminateCopilotDescendants).mockRestore();
    jest.mocked(ownership.remainingCopilotProcesses).mockRestore();
    const spawn = (): childProcess.ChildProcess =>
      childProcess.spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        {
          detached: true,
          stdio: 'ignore',
        },
      );
    const parent = childProcess.spawn(
      process.execPath,
      [
        '-e',
        `
const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
child.once('spawn', () => process.send(child.pid));
child.unref();
setInterval(() => {}, 1000);
`,
      ],
      { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    const bystander = spawn();
    const parentExit = once(parent, 'exit');
    const bystanderExit = once(bystander, 'exit');
    let identities: readonly ownership.ProcessIdentity[] = [];
    try {
      const [toolPid] = await Promise.all([
        once(parent, 'message').then((args): unknown => args[0]),
        once(bystander, 'spawn'),
      ]);
      if (!parent.pid || !bystander.pid || typeof toolPid !== 'number')
        throw new Error('Missing process identity');
      identities = await ownership.snapshotCopilotDescendants(parent.pid, true);
      expect(identities.some((row) => row.pid === toolPid)).toBe(true);
      await new CopilotProcessReceipt(directory).save(identities);
      parent.kill('SIGKILL');
      await parentExit;
      expect(() => process.kill(toolPid, 0)).not.toThrow();
      expect(
        (await ownership.remainingCopilotProcesses(identities)).map(
          (row) => row.pid,
        ),
      ).toContain(toolPid);
      await reapCopilotProcessReceipts(directory);
      expect(await ownership.remainingCopilotProcesses(identities)).toEqual([]);
      expect(await readdir(directory)).toEqual([]);
      // A wrongly killed bystander stays signalable as a zombie until its exit
      // is delivered, so give that exit time to arrive before probing.
      let bystanderExited = false;
      void bystanderExit.then(() => {
        bystanderExited = true;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      expect(bystanderExited).toBe(false);
      expect(bystander.exitCode).toBeNull();
      expect(bystander.signalCode).toBeNull();
      expect(() => process.kill(bystander.pid ?? 0, 0)).not.toThrow();
    } finally {
      try {
        await ownership.terminateCopilotDescendants(identities);
      } finally {
        parent.kill('SIGKILL');
        bystander.kill('SIGKILL');
        await Promise.all([parentExit, bystanderExit]);
      }
    }
  },
  process.platform === 'win32' ? 45_000 : 10_000,
);
