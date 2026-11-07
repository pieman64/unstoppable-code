import { writeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { LedgerRepository } from '@canopy/desktop-shared/node/ledger';
import {
  CONTAINER_CREATED_AT,
  WORKTREE_CONTAINER,
  addInput,
  registerTestActor,
  updateInput,
} from '@canopy/desktop-shared/node/ledger/__tests__/ledger-test-harness';

/*
 * Writes a Ledger database from a separate process, pauses at a chosen SQL
 * statement and prints a `paused` line, for the crash-restart tests to kill it
 * with SIGKILL. Lines go out with `writeSync`, so each describes work already
 * done. The tests run it through tsx; tests must not import this module.
 *
 *   write <databasePath> <commands>: runs <commands> keyed commands, adding an
 *     entry and then updating it, with an `ack` line after each and then a
 *     `state` line; then pauses the add `unacknowledged-add` before COMMIT.
 *   migrate <databasePath> inside|committed: pauses a version 4 database's
 *     4→5 migration after it creates its table, or after it commits.
 */

/** Bounds a pause the parent never ends, so no process outlives the test. */
const PAUSE_LIMIT_MS = 60_000;

function writeLine(line: object): void {
  writeSync(1, `${JSON.stringify(line)}\n`);
}

function pauseUntilKilled(): never {
  writeLine({ type: 'paused' });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, PAUSE_LIMIT_MS);
  process.exit(1);
}

/** Pauses every connection before or after the statement `pauseAt` picks. */
function pauseOnExec(
  pauseAt: (sql: string) => 'before' | 'after' | undefined,
): void {
  // Called with the connection as `this` below.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function pausingExec(
    this: DatabaseSync,
    sql: string,
  ): void {
    const when = pauseAt(sql);
    if (when === 'before') pauseUntilKilled();
    exec.call(this, sql);
    if (when === 'after') pauseUntilKilled();
  };
}

function write(databasePath: string, commands: number): void {
  const repository = LedgerRepository.open({ databasePath });
  const { authorityId } = repository;
  const { ledgerId } = repository.bindScope({
    authorityId,
    container: WORKTREE_CONTAINER,
    containerCreatedAt: CONTAINER_CREATED_AT,
    accountId: null,
  }).scope.scope;
  const user = registerTestActor(repository, ledgerId, 'user', 'user:1', 'You');
  let entryId = '';
  for (let index = 0; index < commands; index += 1) {
    const n = Math.floor(index / 2);
    if (index % 2 === 0) {
      const input = addInput(
        { ledgerId },
        user,
        { type: 'TASK', title: `Entry ${n}`, content: 'Before the crash.' },
        `add-${n}`,
      );
      const receipt = repository.addEntry(input);
      entryId = receipt.entry.entryId;
      writeLine({ type: 'ack', method: 'addEntry', args: [input], receipt });
    } else {
      const input = updateInput(
        { ledgerId },
        user,
        { entryId, expectedRevision: 1, status: 'IN_PROGRESS' },
        `update-${n}`,
      );
      const receipt = repository.updateEntry(input);
      writeLine({ type: 'ack', method: 'updateEntry', args: [input], receipt });
    }
  }
  writeLine({
    type: 'state',
    authorityId,
    ledgerId,
    counts: repository.getStorageCounts(),
    outbox: repository.readOutbox({ ledgerId, afterSequence: '0', limit: 100 }),
  });
  pauseOnExec((sql) => (sql === 'COMMIT' ? 'before' : undefined));
  repository.addEntry(
    addInput(
      { ledgerId },
      user,
      { type: 'TASK', title: 'In flight', content: 'Never acknowledged.' },
      'unacknowledged-add',
    ),
  );
}

function migrate(databasePath: string, point: 'inside' | 'committed'): void {
  let createdGlobalBindings = false;
  pauseOnExec((sql) => {
    if (sql.startsWith('CREATE TABLE ledger_global_bindings')) {
      createdGlobalBindings = true;
      return point === 'inside' ? 'after' : undefined;
    }
    return createdGlobalBindings && sql === 'COMMIT' ? 'after' : undefined;
  });
  LedgerRepository.open({ databasePath }).close();
}

const [mode, databasePath, option] = process.argv.slice(2);
if (databasePath !== undefined && mode === 'write') {
  write(databasePath, Number(option));
} else if (
  databasePath !== undefined &&
  mode === 'migrate' &&
  (option === 'inside' || option === 'committed')
) {
  migrate(databasePath, option);
} else {
  throw new Error('Usage: write|migrate <databasePath> <option>');
}
// Reaching here means the pause point never came.
writeLine({ type: 'unpaused' });
process.exit(2);
