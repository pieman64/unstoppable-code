import { StatementSync } from 'node:sqlite';
import { workerData } from 'node:worker_threads';

// Preloaded after tsx, before the real storage worker opens its connection.
const data: unknown = workerData;
if (
  typeof data !== 'object' ||
  data === null ||
  !('sqliteCallState' in data) ||
  !(data.sqliteCallState instanceof Int32Array)
) {
  throw new Error('Missing SQLite call observer');
}
const state = data.sqliteCallState;
const methods = Object.getOwnPropertyDescriptors(StatementSync.prototype);
const nativeGet = methods.get.value;
const nativeRun = methods.run.value;
if (nativeGet === undefined || nativeRun === undefined) {
  throw new Error('Missing native SQLite statement methods');
}

// 0: no observed call; 1: entry INSERT/get; 2: outbox INSERT/run.
// The host snapshots this call-window marker synchronously in terminate().
StatementSync.prototype.get = new Proxy(nativeGet, {
  apply(get, statement: StatementSync, args: unknown[]): unknown {
    const observed = statement.sourceSQL.startsWith(
      'INSERT INTO ledger_entries ',
    );
    if (observed) Atomics.store(state, 0, 1);
    try {
      return Reflect.apply(get, statement, args);
    } finally {
      if (observed) Atomics.store(state, 0, 0);
    }
  },
});

StatementSync.prototype.run = new Proxy(nativeRun, {
  apply(run, statement: StatementSync, args: unknown[]): unknown {
    const observed = statement.sourceSQL.startsWith(
      'INSERT INTO ledger_outbox ',
    );
    if (observed) Atomics.store(state, 0, 2);
    try {
      return Reflect.apply(run, statement, args);
    } finally {
      if (observed) Atomics.store(state, 0, 0);
    }
  },
});
