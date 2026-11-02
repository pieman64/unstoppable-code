import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type * as AtomicFile from '@canopy/desktop-shared/node/lib/atomic-file';
import * as atomicFile from '@canopy/desktop-shared/node/lib/atomic-file';
import { desktopW5Durability } from '@canopy/desktop-shared/node/w5-commit-log/durability';
import {
  W5CommitLog,
  fingerprintW5File,
  recoverW5CommitLog,
  type W5CommitRequest,
} from '@canopy/desktop-shared/node/w5-commit-log';
import { W5CommitLogRequestHandler } from '../commit-log-worker-requests';
import { ensureW5DataRoot } from '../commit-log-root';

jest.mock('@canopy/desktop-shared/node/lib/atomic-file', () => {
  const actual = jest.requireActual<typeof AtomicFile>(
    '@canopy/desktop-shared/node/lib/atomic-file',
  );
  return {
    ...actual,
    syncDirectory: jest.fn(actual.syncDirectory),
    writeFileAtomically: jest.fn(actual.writeFileAtomically),
  };
});

const syncDirectory = jest.mocked(atomicFile.syncDirectory);
const writeFileAtomically = jest.mocked(atomicFile.writeFileAtomically);
const DURABLE_UTF8 = { encoding: 'utf8', durable: true };

let dir: string;
let root: string;
let indexPath: string;
let log: W5CommitLog;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'w5-durability-'));
  root = join(dir, 'workspaces');
  mkdirSync(root);
  indexPath = join(root, 'index.json');
  log = W5CommitLog.open(join(dir, 'commit-log.sqlite'));
  syncDirectory.mockClear();
  writeFileAtomically.mockClear();
});

afterEach(() => {
  log.close();
  rmSync(dir, { recursive: true, force: true });
});

function indexChange(contents: string): W5CommitRequest {
  return {
    operation: 'internal.repository.write',
    advance: [{ kind: 'workspaces' }],
    files: [{ path: indexPath, contents, previousFingerprint: null }],
    outcome: null,
  };
}

// The worker composes the portable commit log with these modules (CAN-4408).
describe('W5 commit log worker durability composition', () => {
  it('is the atomic-file port: durable UTF-8 installs and its folder sync, without storage admission', async () => {
    expect(desktopW5Durability.syncDirectory).toBe(atomicFile.syncDirectory);

    await desktopW5Durability.writeFileDurably(indexPath, 'v1');

    expect(writeFileAtomically.mock.calls).toEqual([
      [indexPath, 'v1', DURABLE_UTF8],
    ]);
    expect(readFileSync(indexPath, 'utf8')).toBe('v1');
  });

  it('applies request commits through atomic-file', async () => {
    const handler = new W5CommitLogRequestHandler(
      log,
      { dbPath: join(dir, 'commit-log.sqlite'), root },
      { applied: [], recoveryRequired: [], interruptedReservations: 0 },
    );

    await expect(
      handler.run({ id: 1, method: 'commit', args: [indexChange('v1')] }),
    ).resolves.toMatchObject({ status: 'applied' });

    expect(writeFileAtomically.mock.calls).toEqual([
      [indexPath, 'v1', DURABLE_UTF8],
    ]);
    expect(syncDirectory).toHaveBeenLastCalledWith(root);
  });

  it('runs launch recovery through atomic-file', async () => {
    log.commit(indexChange('v1'));

    await expect(recoverW5CommitLog(log, { root })).resolves.toMatchObject({
      applied: [1],
    });

    expect(writeFileAtomically.mock.calls).toEqual([
      [indexPath, 'v1', DURABLE_UTF8],
    ]);
    expect(fingerprintW5File(readFileSync(indexPath, 'utf8'))).toBe(
      fingerprintW5File('v1'),
    );
  });

  it('flushes the data root with atomic-file folder syncs', async () => {
    const created = join(dir, 'data', 'workspaces');

    await ensureW5DataRoot(created, undefined, { dataRoot: join(dir, 'data') });

    // Every folder up to the data root, the data root's parent last.
    expect(syncDirectory.mock.calls).toEqual([
      [join(dir, 'data')],
      [resolve(dir)],
    ]);
  });
});
