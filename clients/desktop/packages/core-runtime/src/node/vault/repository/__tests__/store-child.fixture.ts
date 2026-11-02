// Run by the store tests in a separate process: opens the vault store in the
// folder it is given and prints the open result. With `commit-large`, it then
// commits a 1 MB revision, for a parent that capped this process's file size.
import { openVaultStore } from '../store';
import { putIntent, recordingSecureFiles, sealedBox } from './store-fixtures';

const [folder, mode] = process.argv.slice(2);
if (!folder) throw new Error('usage: <vault folder> [commit-large]');

// A write past the file-size cap must fail with EFBIG, not kill the process.
process.on('SIGXFSZ', () => undefined);

async function main(): Promise<void> {
  const result = await openVaultStore({
    folder,
    platform: { os: 'darwin', secureFiles: recordingSecureFiles() },
    openBusyTimeoutMs: 0,
  });
  if (result.kind !== 'opened') {
    process.stdout.write(JSON.stringify(result));
    return;
  }
  const { store } = result;
  if (mode !== 'commit-large') {
    store.close();
    process.stdout.write(JSON.stringify({ kind: 'opened' }));
    return;
  }
  const intent = store.recordIntent(putIntent('large'));
  const commit =
    intent.kind === 'written'
      ? store.commitEntry(intent.value.sequence, {
          entryId: intent.value.entryId,
          family: intent.value.family,
          revision: 0,
          expiresAt: null,
          label: 'Large',
          sealed: { ...sealedBox(3), ciphertext: new Uint8Array(1_000_000) },
        })
      : null;
  const state = store.state;
  store.close();
  process.stdout.write(
    JSON.stringify({ kind: 'opened', intent: intent.kind, commit, state }),
  );
}

void main();
