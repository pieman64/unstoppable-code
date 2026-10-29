// Run by crash.test.ts in a separate process, which this kills itself at the
// requested point of a W5 change: before the commit, after the commit, between
// the change's two file writes, or before the commit is marked applied.
import { join } from 'node:path';

import {
  W5CommitLog,
  applyW5Commit,
  fingerprintW5File,
} from './fixtures/with-durability';

const [dbPath, dir, stage] = process.argv.slice(2);
if (!dbPath || !dir || !stage) throw new Error('usage: <db> <dir> <stage>');

function die(): never {
  process.kill(process.pid, 'SIGKILL');
  throw new Error('unreachable');
}

const receipt = {
  caller: 'portal:1',
  operation: 'core.workspace.create',
  idempotencyKey: 'k1',
  fingerprint: 'f1',
};

async function main(): Promise<void> {
  const log = W5CommitLog.open(dbPath);
  if (stage === 'reserved') {
    log.reserve({
      reservationId: 'op-1',
      operation: receipt.operation,
      receipt,
      diagnostics: { step: 'git clone' },
    });
    die();
  }
  if (stage === 'before-commit') die();
  log.commit({
    operation: receipt.operation,
    receipt,
    advance: [{ kind: 'workspaces' }],
    files: [
      {
        path: join(dir, 'index.json'),
        contents: 'index v2',
        previousFingerprint: fingerprintW5File('index v1'),
      },
      {
        path: join(dir, 'workspace.json'),
        contents: 'manifest v1',
        previousFingerprint: null,
      },
    ],
    outcome: { workspaceId: 'suite' },
  });
  if (stage === 'after-commit') die();
  const [pending] = log.listPendingCommits();
  if (!pending) throw new Error('Expected a pending commit');
  await applyW5Commit(log, pending, {
    root: dir,
    onStep: (step) => {
      if (stage === 'between-files' && step.kind === 'after-file') die();
      if (
        stage === 'before-mark-applied' &&
        step.kind === 'before-mark-applied'
      )
        die();
    },
  });
  log.close();
}

void main();
