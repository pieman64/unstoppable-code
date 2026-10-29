import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { W5CommitLog, recoverW5CommitLog } from './fixtures/with-durability';

const child = join(__dirname, 'crash-child.fixture.ts');
const key = {
  caller: 'portal:1',
  operation: 'core.workspace.create',
  idempotencyKey: 'k1',
};

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'w5-crash-'));
  dbPath = join(dir, 'commit-log.sqlite');
  writeFileSync(join(dir, 'index.json'), 'index v1');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runChildUntil(stage: string): void {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', child, dbPath, dir, stage],
    { encoding: 'utf8', timeout: 60_000 },
  );
  if (stage === 'complete') {
    expect(result.status).toBe(0);
  } else {
    expect({ signal: result.signal, stderr: result.stderr }).toEqual({
      signal: 'SIGKILL',
      stderr: '',
    });
  }
}

function canonicalState(): { index: string; manifest: string | null } {
  const manifestPath = join(dir, 'workspace.json');
  return {
    index: readFileSync(join(dir, 'index.json'), 'utf8'),
    manifest: existsSync(manifestPath)
      ? readFileSync(manifestPath, 'utf8')
      : null,
  };
}

async function restart(): Promise<W5CommitLog> {
  const log = W5CommitLog.open(dbPath);
  await recoverW5CommitLog(log, { root: dir });
  return log;
}

describe('W5 commit log interruption (CAN-3805)', () => {
  it('shows the previous state and no outcome after a crash before the commit', async () => {
    runChildUntil('before-commit');
    const log = await restart();
    try {
      expect(canonicalState()).toEqual({ index: 'index v1', manifest: null });
      expect(log.lookupReceipt(key, 'f1')).toEqual({ status: 'none' });
      expect(log.revision({ kind: 'workspaces' })).toBe(0);
    } finally {
      log.close();
    }
  });

  it.each(['after-commit', 'between-files', 'before-mark-applied', 'complete'])(
    'shows the complete new state and its outcome after a crash at %s',
    async (stage) => {
      runChildUntil(stage);
      if (stage === 'between-files') {
        // The files alone are mixed; only the committed log can finish them.
        expect(canonicalState()).toEqual({ index: 'index v2', manifest: null });
      }
      const log = await restart();
      try {
        expect(canonicalState()).toEqual({
          index: 'index v2',
          manifest: 'manifest v1',
        });
        expect(log.revision({ kind: 'workspaces' })).toBe(1);
        // A retry after the lost response replays the saved outcome.
        expect(log.lookupReceipt(key, 'f1')).toMatchObject({
          status: 'replay',
          outcome: { workspaceId: 'suite' },
        });
        expect(log.listPendingCommits()).toEqual([]);
      } finally {
        log.close();
      }
    },
  );

  it('keeps an interrupted reservation and its key blocked for manual recovery', async () => {
    runChildUntil('reserved');
    const log = await restart();
    try {
      expect(canonicalState()).toEqual({ index: 'index v1', manifest: null });
      expect(log.lookupReceipt(key, 'f1')).toEqual({
        status: 'recovery-required',
        reservationId: 'op-1',
        diagnostics: { step: 'git clone' },
      });
    } finally {
      log.close();
    }
    // A second restart keeps it; nothing resumes or undoes the effect.
    const again = await restart();
    try {
      expect(again.listReservations()).toEqual([
        expect.objectContaining({ state: 'recovery-required' }),
      ]);
    } finally {
      again.close();
    }
  });
});
