/*
 * A second process writing one memory scope through the production write
 * path (see `./scope-child.ts`):
 *
 *   count <scopeDir> <n>   n times, under the scope's write lock: reads
 *                          `counter.txt`, yields, writes it back plus one and
 *                          records a document write; prints `DONE`.
 *   advance <scopeDir>     records one document write; prints `DONE`.
 *   prepare <scopeDir>     readies the scope (backfills it); prints `DONE`.
 *
 * Every command prints `READY` once loaded, before it starts writing.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  recordMemoryEdit,
  withMemoryWriteLock,
} from '../../../memory/local/edit-coordination';

async function readCounter(scopeDir: string): Promise<number> {
  try {
    return Number(await readFile(join(scopeDir, 'counter.txt'), 'utf8'));
  } catch {
    return 0;
  }
}

async function count(scopeDir: string, times: number): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await withMemoryWriteLock(scopeDir, async () => {
      const value = await readCounter(scopeDir);
      await new Promise((resolve) => setImmediate(resolve));
      await writeFile(join(scopeDir, 'counter.txt'), String(value + 1));
      await recordMemoryEdit(scopeDir);
    });
  }
}

async function main(): Promise<void> {
  const [command, scopeDir, argument] = process.argv.slice(2);
  if (!scopeDir) throw new Error('Usage: scope-child <command> <scopeDir>');
  process.stdout.write('READY\n');
  if (command === 'count') await count(scopeDir, Number(argument));
  else if (command === 'advance') {
    await withMemoryWriteLock(scopeDir, () => recordMemoryEdit(scopeDir));
  } else if (command === 'prepare') {
    await withMemoryWriteLock(scopeDir, () => Promise.resolve());
  } else throw new Error(`Unknown command ${command}`);
  process.stdout.write('DONE\n');
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
