/**
 * A process that holds private record storage open until it is killed.
 *
 * Driven by `host-record-storage.test.ts`, which runs it under a temporary
 * root it owns exclusively (`TMPDIR`), waits for `ready`, then either kills it
 * with SIGKILL or asks it to finish. Nothing here cleans up on a signal: the
 * point is to see what a process that never gets to clean up leaves behind.
 *
 * Modes, each reaching a different raw backing at its real creation point and
 * default threshold:
 *   record    - an unterminated 9 MiB record through `SecretValueRedactor`
 *   identity  - an open key past the identity threshold (`canopy-record-identity-`)
 *   keyindex  - a mask-bearing key too large to hold (`canopy-keyindex-`)
 *   frames    - an array nested past the resident frame window
 *   owner     - a live store that is replayed and checked on `finish`
 *
 * Every storage directory the modules create is reported, so a test can tell
 * "nothing was left" from "nothing was ever created".
 */
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';

import { SpillingRecordStore } from '../record-store';
import { SecretValueRedactor } from '../spawned-process';
import { redactRecordFromSource } from '../streaming-json-redactor';

// Default imports are the module objects themselves, the ones the code under
// test calls through (it reads their properties at call time), so wrapping
// them here observes every creation point.
const created: string[] = [];
const realMkdtemp = fsPromises.mkdtemp.bind(fsPromises);
const realMkdtempSync = fs.mkdtempSync.bind(fs);
Object.assign(fsPromises, {
  mkdtemp: async (prefix: string): Promise<string> => {
    const directory = await realMkdtemp(prefix);
    created.push(directory);
    return directory;
  },
});
Object.assign(fs, {
  mkdtempSync: (prefix: string): string => {
    const directory = realMkdtempSync(prefix);
    created.push(directory);
    return directory;
  },
});

const mode = process.argv[2] ?? 'record';
const canary = process.argv[3] ?? 'synthetic-spill-canary';

const report = (message: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ ...message, created })}\n`);
};

const hold = (): Promise<never> =>
  new Promise<never>(() => {
    // Keeps the process, and every store it owns, alive until it is killed.
    setInterval(() => undefined, 1_000);
  });

const settle = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 200);
  });

async function feedRedactor(): Promise<void> {
  const redactor = new SecretValueRedactor([canary]);
  // No terminating newline: the record is still being assembled when the
  // process dies, which is exactly when it sits on disk.
  const record = JSON.stringify({
    value: canary,
    padding: 'x'.repeat(9 * 1024 * 1024),
  });
  for (let at = 0; at < record.length; at += 65_536) {
    redactor.redactChunk(record.slice(at, at + 65_536));
    const drain = redactor.takePendingDrain();
    if (drain) await drain;
  }
  await settle();
  report({ ready: true, stored: redactor.hasStoredWork });
  await hold();
}

async function feedSource(record: string): Promise<void> {
  const source = {
    chunks: async function* (): AsyncIterable<string> {
      for (let at = 0; at < record.length; at += 65_536)
        yield await Promise.resolve(record.slice(at, at + 65_536));
      await settle();
      report({ ready: true });
      await hold();
    },
  };
  await redactRecordFromSource(source, [canary], () => undefined);
}

async function liveOwner(): Promise<void> {
  const store = new SpillingRecordStore(1_024, 'owner');
  const text = `${canary}:${'y'.repeat(256 * 1024)}:${canary}`;
  store.append(text);
  const pending = store.settling();
  if (pending) await pending;
  await store.whenDrained();
  report({ ready: true, stored: store.spilled });
  process.stdin.resume();
  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => {
      resolve();
    });
  });
  let replayed = '';
  for await (const chunk of store.replay()) replayed += chunk;
  await store.dispose();
  report({ finished: true, intact: replayed === text });
  process.exit(0);
}

async function main(): Promise<void> {
  switch (mode) {
    case 'record':
      return feedRedactor();
    case 'identity':
      return feedSource(
        // The key never closes, so its identity store stays in use.
        `{"${canary}${'x'.repeat(1_200_000)}`,
      );
    case 'keyindex':
      return feedSource(
        `{"${'k'.repeat(1024 * 1024 + 1)}***${canary}":1,"next":"${canary}"`,
      );
    case 'frames':
      return feedSource(`${'['.repeat(70_000)}"${canary}"`);
    case 'owner':
      return liveOwner();
    default:
      throw new Error(`Unknown mode ${mode}`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
