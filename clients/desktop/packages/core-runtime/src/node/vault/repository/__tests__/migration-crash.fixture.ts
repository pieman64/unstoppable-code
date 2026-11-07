import {
  migrationFixture,
  migrationIdentity,
  importRequest,
} from './migration-fixtures';
import { openVaultStore } from '../store';
import { recordingSecureFiles } from './store-fixtures';

const [folder, boundary] = process.argv.slice(2);
if (!folder || !boundary)
  throw new Error('Expected folder and crash boundary.');
function crash(): never {
  process.kill(process.pid, 'SIGKILL');
  throw new Error('Unreachable');
}
async function main(): Promise<void> {
  let writes = 0;
  const targets: Record<string, number> = {
    prepare: 1,
    intent: 2,
    entry: 3,
    progress: 4,
    selection: 5,
    use: 6,
    authorization: 7,
    submission: 8,
    completion: 9,
  };
  const target = targets[boundary];
  if (!target) throw new Error('Unknown boundary.');
  const opened = await openVaultStore({
    folder,
    platform: { os: 'darwin', secureFiles: recordingSecureFiles() },
    faults: {
      sync(commit) {
        commit();
        if (++writes === target) crash();
      },
    },
  });
  if (opened.kind !== 'opened') throw new Error('Store did not open.');
  const { migration, writer } = migrationFixture(opened.store);
  const attempt = migration.prepare(migrationIdentity, 1);
  await writer.put(importRequest(migration.importKey(attempt.id)));
  const result = migration.reconcile(attempt.id, 1);
  if (result.kind !== 'committed') throw new Error('Import did not commit.');
  migration.select(attempt.id, 1);
  migration.recordUse(attempt.id, 1, {
    id: 'use-1',
    pin: result.pin,
    successorKeys: [],
  });
  migration.authorizeDeletion(attempt.id, 1, 'delete-1');
  migration.deletionReceipt(
    attempt.id,
    1,
    'delete-1',
    migrationIdentity.generation,
    null,
  );
  migration.deletionReceipt(
    attempt.id,
    1,
    'delete-1',
    migrationIdentity.generation,
    'completed-1',
  );
  throw new Error('Crash boundary was not reached.');
}
void main();
