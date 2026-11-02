/*
 * The child process of a crash-kill trial (see `./crash-kill.ts`). It writes
 * one store through its production writer, in the data directory the trial
 * gives it, and reports the store's file so the parent can classify it:
 *
 *   loop <store> <token>  writes continuously; prints `READY <file>` after the
 *                         first write completes.
 *   ack <store> <token>   writes once, carrying the token; prints
 *                         `ACK <token> <file>` once it resolves, then idles.
 */
import {
  addWorkspaceApprovalRule,
  getWorkspaceApprovalsFilePath,
  removeWorkspaceApprovalRule,
} from '../../../lib/approvals-persistence';
import { getPreferencesFilePath } from '../../../lib/paths';
import { updatePreferencesFile } from '../../../lib/preferences-store';
import {
  CRASH_WORKSPACE_ID,
  isCrashStore,
  type CrashStore,
} from './crash-kill';

interface StoreWriter {
  file: () => string;
  write: (token: string, counter: number) => Promise<void>;
}

const ruleId = (token: string, counter: number): string =>
  `${token}_${counter}`;

const writers: Record<CrashStore, StoreWriter> = {
  approvals: {
    file: () => getWorkspaceApprovalsFilePath(CRASH_WORKSPACE_ID),
    write: async (token, counter) => {
      await addWorkspaceApprovalRule(CRASH_WORKSPACE_ID, {
        id: ruleId(token, counter),
        behavior: 'allow',
        target: { kind: 'command', pattern: `echo ${token} ${counter}` },
        createdAt: new Date().toISOString(),
        origin: 'prompt',
      });
      if (counter > 0) {
        await removeWorkspaceApprovalRule(
          CRASH_WORKSPACE_ID,
          ruleId(token, counter - 1),
        );
      }
    },
  },
  preferences: {
    file: getPreferencesFilePath,
    write: async (token, counter) => {
      // The padding keeps each write long enough for kills to land inside one.
      await updatePreferencesFile(() => ({
        prInstructions: `${token} ${counter} ${'x'.repeat(4096)}`,
      }));
    },
  },
};

async function main(): Promise<void> {
  const [mode, store, token] = process.argv.slice(2);
  if ((mode !== 'loop' && mode !== 'ack') || !isCrashStore(store) || !token) {
    throw new Error(`Usage: crash-child <loop|ack> <store> <token>`);
  }
  const writer = writers[store];
  if (mode === 'ack') {
    await writer.write(token, 0);
    process.stdout.write(`ACK ${token} ${writer.file()}\n`);
    setInterval(() => undefined, 60_000);
    return;
  }
  for (let counter = 0; ; counter += 1) {
    await writer.write(token, counter);
    if (counter === 0) process.stdout.write(`READY ${writer.file()}\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`CHILD-ERROR ${String(error)}\n`);
  process.exit(2);
});
