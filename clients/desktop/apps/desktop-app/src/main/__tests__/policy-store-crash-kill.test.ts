import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreferencesLastGoodPath } from '../lib/preferences-file-paths';
import {
  classifyStoreFile,
  crashTrialCount,
  runCrashTrial,
  type CrashStore,
  type CrashTrialResult,
} from './helpers/crash-kill/crash-kill';

jest.setTimeout(240_000);

const LOOP_TRIALS = crashTrialCount(3);
const ACK_TRIALS = crashTrialCount(1);

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'policy-store-crash-kill-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * The files a store's writer keeps, with the states a kill may leave. An
 * acknowledged preferences save covers the primary only; its last-good copy
 * is refreshed after, so a kill can leave none yet, but never a damaged one.
 */
function storeFiles(
  store: CrashStore,
  file: string,
): Array<{ path: string; allowed: readonly string[] }> {
  const primary = { path: file, allowed: ['valid'] };
  return store === 'preferences'
    ? [
        primary,
        {
          path: createPreferencesLastGoodPath(file),
          allowed: ['valid', 'missing'],
        },
      ]
    : [primary];
}

/** Trials run side by side: each child owns its data directory. */
async function runTrials(
  count: number,
  run: (trial: number) => Promise<void>,
): Promise<void> {
  await Promise.all(Array.from({ length: count }, (_, trial) => run(trial)));
}

async function expectValidStoreFiles(
  store: CrashStore,
  result: CrashTrialResult,
  token: string,
): Promise<void> {
  expect(result).toEqual(
    expect.objectContaining({ reported: true, signal: 'SIGKILL' }),
  );
  if (result.file === undefined) {
    throw new Error(`The child reported no store file: ${result.stderr}`);
  }
  for (const { path, allowed } of storeFiles(store, result.file)) {
    expect(allowed).toContain(
      await classifyStoreFile(path, { version: 1, token }),
    );
  }
}

describe.each<CrashStore>(['approvals', 'preferences'])(
  'the %s store, killed by a process crash',
  (store) => {
    it('leaves valid files when killed mid-write', async () => {
      await runTrials(LOOP_TRIALS, async (trial) => {
        const token = `loop${trial}`;
        const result = await runCrashTrial({
          store,
          mode: 'loop',
          dataDir: join(root, `${store}-loop-${trial}`, 'data'),
          token,
          killAfterMs: (trial * 7) % 41,
        });
        await expectValidStoreFiles(store, result, token);
      });
    });

    it('keeps a write that resolved before the kill', async () => {
      await runTrials(ACK_TRIALS, async (trial) => {
        const token = `ack${trial}`;
        const result = await runCrashTrial({
          store,
          mode: 'ack',
          dataDir: join(root, `${store}-ack-${trial}`, 'data'),
          token,
        });
        await expectValidStoreFiles(store, result, token);
      });
    });
  },
);
