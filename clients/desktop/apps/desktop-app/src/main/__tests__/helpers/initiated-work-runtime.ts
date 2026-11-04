import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InitiatedWorkEngine } from '@canopy/core-runtime/node/initiated-work';
import { OperationService } from '@canopy/core-runtime/node/operations';
import { OperationLedger } from '@canopy/core-runtime/node/operations/ledger';

/*
 * A real initiated-work engine over a temporary operation ledger, for suites
 * that run hooks without composing the desktop runtime. Mock the runtime
 * accessor with it:
 *
 *   jest.mock('../../canopy-runtime/desktop-runtime', () => ({
 *     getActiveDesktopRuntime: () => ({
 *       initiatedWork: jest.requireActual<InitiatedWorkRuntimeHelper>(
 *         '../helpers/initiated-work-runtime',
 *       ).testInitiatedWork().engine,
 *     }),
 *   }));
 */

export interface TestInitiatedWork {
  engine: InitiatedWorkEngine;
  operations: OperationService;
}

let current: (TestInitiatedWork & { dir: string }) | null = null;

export function testInitiatedWork(): TestInitiatedWork {
  if (current) return current;
  const dir = mkdtempSync(join(tmpdir(), 'initiated-work-'));
  const operations = new OperationService({
    openLedger: (): OperationLedger =>
      OperationLedger.open(join(dir, 'operation-ledger.sqlite')),
  });
  current = {
    dir,
    operations,
    engine: new InitiatedWorkEngine({ operations }),
  };
  return current;
}

/** Opens the ledger, so a suite's first run needs no extra turns. */
export async function readyTestInitiatedWork(): Promise<TestInitiatedWork> {
  const runtime = testInitiatedWork();
  await runtime.operations.ready();
  return runtime;
}

export function closeTestInitiatedWork(): void {
  if (!current) return;
  current.operations.close();
  rmSync(current.dir, { recursive: true, force: true });
  current = null;
}

export type InitiatedWorkRuntimeHelper = {
  testInitiatedWork: typeof testInitiatedWork;
};
