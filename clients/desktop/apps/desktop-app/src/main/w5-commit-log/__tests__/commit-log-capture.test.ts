import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { once } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import {
  W5CommitLog,
  W5CommitRefusedError,
  fingerprintW5File,
  type W5CommitRequest,
} from '@canopy/desktop-shared/node/w5-commit-log';
import { isW5CommitLogWorkerData } from '../commit-log-worker-contract';
import { W5CommitLogHost } from '../commit-log-host';

let mockBarrierPort: MessagePort | undefined;
jest.mock('node:worker_threads', () => {
  const actual = jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        const [filename, options] = args;
        const data: unknown = options?.workerData;
        if (mockBarrierPort && !isW5CommitLogWorkerData(data))
          throw new Error('Missing W5 worker data');
        super(
          filename,
          mockBarrierPort
            ? {
                ...options,
                workerData: {
                  ...(isW5CommitLogWorkerData(data) ? data : {}),
                  barrierPort: mockBarrierPort,
                },
                transferList: [mockBarrierPort],
              }
            : options,
        );
      }
    },
  };
});
jest.mock('../../lib/paths', () => ({
  getW5CommitLogPath: (): string => '/unused',
  getWorkspacesRootDir: (): string => '/unused',
}));
jest.setTimeout(60_000);
let dir: string;
let root: string;
let dbPath: string;
let host: W5CommitLogHost;
let barrier: MessagePort;
let workerPort: MessagePort;
const request = { files: [], discoverWorkspaces: true };
const index = (ids: string[]): string =>
  JSON.stringify({ workspaces: ids.map((id) => ({ id })) });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'w5-capture-host-'));
  root = join(dir, 'workspaces');
  mkdirSync(root);
  dbPath = join(dir, 'log.sqlite');
  const channel = new MessageChannel();
  barrier = channel.port1;
  workerPort = channel.port2;
  mockBarrierPort = workerPort;
  host = new W5CommitLogHost({
    root,
    dbPath,
    workerEntry: join(__dirname, 'fixtures/capture-barrier-worker.ts'),
  });
});
afterEach(async () => {
  await host.shutdown();
  barrier.close();
  workerPort.close();
  mockBarrierPort = undefined;
  rmSync(dir, { recursive: true, force: true });
});
function change(before: string[], after: string[]): W5CommitRequest {
  return {
    operation: 'test',
    advance: [
      { kind: 'workspaces' },
      { kind: 'workspace', workspaceId: 'alpha' },
    ],
    outcome: null,
    files: [
      {
        path: join(root, 'index.json'),
        contents: index(after),
        previousFingerprint: fingerprintW5File(index(before)),
      },
      {
        path: join(root, 'alpha', 'workspace.json'),
        contents: 'new manifest',
        previousFingerprint: fingerprintW5File('old manifest'),
      },
    ],
  };
}
function seed(ids: string[]): void {
  mkdirSync(join(root, 'alpha'));
  writeFileSync(join(root, 'index.json'), index(ids));
  writeFileSync(join(root, 'alpha', 'workspace.json'), 'old manifest');
}
async function next(kind: string): Promise<void> {
  expect((await once(barrier, 'message'))[0]).toBe(kind);
}
function release(): void {
  barrier.postMessage('continue');
}

it.each([
  { before: [], after: ['alpha'] },
  { before: ['alpha'], after: [] },
])(
  'discovers dependencies after the queued competing commit ($before -> $after)',
  async ({ before, after }) => {
    seed(before);
    await host.recoveryReport();
    const firstWrite = next('file-written');
    const commit = host.commit(change(before, after));
    await firstWrite;
    // Pending files apply in path order: alpha/workspace.json precedes index.json.
    expect(readFileSync(join(root, 'index.json'), 'utf8')).toBe(index(before));
    expect(readFileSync(join(root, 'alpha', 'workspace.json'), 'utf8')).toBe(
      'new manifest',
    );
    const capture = host.capture(request);
    const secondWrite = next('file-written');
    release();
    await secondWrite;
    expect(readFileSync(join(root, 'index.json'), 'utf8')).toBe(index(after));
    expect(readFileSync(join(root, 'alpha', 'workspace.json'), 'utf8')).toBe(
      'new manifest',
    );
    const captured = next('captured');
    release();
    await commit;
    await captured;
    release();
    const result = await capture;
    expect(result.discovery).toBe('complete');
    expect(result.files.map((file) => file.kind)).toEqual(
      after.length ? ['index', 'manifest', 'worktrees'] : ['index'],
    );
    expect(result.files[0]).toMatchObject({
      base64: Buffer.from(index(after)).toString('base64'),
    });
    if (after.length)
      expect(result.files[1]).toMatchObject({
        base64: Buffer.from('new manifest').toString('base64'),
      });
    expect(result.log.revisions.workspaces).toBe(1);
  },
);

it('holds the worker slot until the captured before-image and evidence are returned', async () => {
  seed(['alpha']);
  await host.recoveryReport();
  const captured = next('captured');
  const capture = host.capture(request);
  await captured;
  const commit = host.commit(change(['alpha'], []));
  expect(readFileSync(join(root, 'index.json'), 'utf8')).toBe(index(['alpha']));
  const firstWrite = next('file-written');
  release();
  const result = await capture;
  expect(result.files[1]).toMatchObject({
    base64: Buffer.from('old manifest').toString('base64'),
  });
  expect(result.log.commitId).toBe(0);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.files[0])).toBe(true);
  await firstWrite;
  const secondWrite = next('file-written');
  release();
  await secondWrite;
  release();
  await commit;
  expect(result.files[0]).toMatchObject({
    base64: Buffer.from(index(['alpha'])).toString('base64'),
  });
});

it('recovers at startup separately, before capture readiness', async () => {
  await host.shutdown();
  mockBarrierPort = undefined;
  const log = W5CommitLog.open(dbPath);
  log.commit({
    operation: 'test',
    advance: [{ kind: 'workspaces' }],
    files: [
      {
        path: join(root, 'index.json'),
        contents: index([]),
        previousFingerprint: null,
      },
    ],
    outcome: null,
  });
  log.close();
  host = new W5CommitLogHost({
    root,
    dbPath,
    workerEntry: join(__dirname, '..', 'commit-log-worker.ts'),
  });
  expect((await host.recoveryReport()).applied).toEqual([1]);
  expect((await host.capture(request)).log.files[0]?.state).toBe('applied');
});

it('refuses a data root that does not resolve as typed, keeping its worker', async () => {
  await host.shutdown();
  mockBarrierPort = undefined;
  host = new W5CommitLogHost({
    root,
    dbPath,
    workerEntry: join(__dirname, '..', 'commit-log-worker.ts'),
  });
  await host.recoveryReport();
  // As while an ancestor of the root is swapped away.
  rmSync(root, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    const error: unknown = await host.capture(request).then(
      () => 'captured',
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(W5CommitRefusedError);
    expect(error).toMatchObject({
      details: { capture: 'root-unavailable', code: 'ENOENT' },
    });
  }
  mkdirSync(root);
  expect((await host.capture(request)).files).toEqual([
    { kind: 'index', state: 'absent' },
  ]);
  expect(host.workersStarted).toBe(1);
});

it.each(['exit-on-request', 'silent', 'unexpected-result', 'failed'])(
  'keeps typed host failures for capture: %s',
  async (script) => {
    await host.shutdown();
    mockBarrierPort = undefined;
    host = new W5CommitLogHost({
      root: script,
      dbPath,
      workerEntry: join(__dirname, 'fixtures/scripted-worker.ts'),
      requestTimeoutMs: 200,
    });
    await expect(host.capture(request)).rejects.toMatchObject({
      reason: 'outcome-unknown',
    });
  },
);

it('validates request IDs before starting a worker and honors shutdown', async () => {
  await expect(
    host.capture({
      files: [{ kind: 'manifest', workspaceId: '../escape' }],
      discoverWorkspaces: false,
    }),
  ).rejects.toMatchObject({ reason: 'malformed' });
  expect(host.workersStarted).toBe(0);
  await host.shutdown();
  await expect(host.capture(request)).rejects.toMatchObject({
    reason: 'unavailable',
  });
});
