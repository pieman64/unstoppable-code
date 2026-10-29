// Regenerates schema-v2-base.sql and schema-v2-base.observations.json with the
// commit log as it was before CAN-4408 moved it, so the reopen suite compares
// this library against bytes and reads the base library produced. Test-only;
// run from a checkout with dependencies installed:
//
//   node packages/core-runtime/src/node/w5/commit-log/__tests__/fixtures/generate-schema-v2-base.mjs [base-ref]
//
// It extracts packages/desktop-shared/src/node/w5-commit-log at base-ref
// (default 9501d6fd) into a temp folder, bundles it with esbuild, writes the
// scenario in schema-v2-base-scenario.ts, dumps the database, reloads the dump
// into a new file and records the base library's reads of that file.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';
import { format, resolveConfig } from 'prettier';

const DEFAULT_BASE = '9501d6fdc35bcda4d02a98fadcc12400a1db7dd7';
const LIBRARY = 'packages/desktop-shared/src/node/w5-commit-log';

const here = dirname(fileURLToPath(import.meta.url));

const repoRoot = execFileSync(
  'git',
  ['-C', here, 'rev-parse', '--show-toplevel'],
  {
    encoding: 'utf8',
  },
).trim();

/** Schema in creation order, then every row; reloads with `exec`. */
function dump(path) {
  const db = new DatabaseSync(path);
  try {
    const lines = [];
    const objects = db
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
          WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid`,
      )
      .all();
    for (const object of objects) lines.push(`${object.sql};`);
    const tables = objects
      .filter((object) => object.type === 'table')
      .map((object) => object.name);
    for (const table of [...tables, 'sqlite_sequence']) {
      // AUTOINCREMENT state, replaced as the sqlite3 shell's .dump does.
      if (table === 'sqlite_sequence')
        lines.push('DELETE FROM sqlite_sequence;');
      const columns = db
        .prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid')
        .all(table)
        .map((column) => column.name);
      const values = columns
        .map((column) => `quote("${column}")`)
        .join(` || ', ' || `);
      for (const row of db
        .prepare(`SELECT ${values} AS row FROM "${table}" ORDER BY rowid`)
        .all()) {
        lines.push(
          `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${row.row});`,
        );
      }
    }
    return `${lines.join('\n')}\n`;
  } finally {
    db.close();
  }
}

function load(path, sql) {
  const db = new DatabaseSync(path);
  try {
    // As the reopen suite loads it: in the WAL mode the base library leaves.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(sql);
  } finally {
    db.close();
  }
}

/** Bundled with its dependencies (zod) from this checkout, then imported. */
async function bundle(entryPoint, name) {
  const outfile = join(scratch, `${name}.mjs`);
  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    nodePaths: [join(repoRoot, 'node_modules')],
    logLevel: 'error',
  });
  return import(pathToFileURL(outfile).href);
}

const baseSha = execFileSync(
  'git',
  ['-C', repoRoot, 'rev-parse', `${process.argv[2] ?? DEFAULT_BASE}^{commit}`],
  { encoding: 'utf8' },
).trim();
const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'w5-v2-base-'));
try {
  execFileSync('tar', ['-x', '-C', scratch], {
    input: execFileSync('git', ['-C', repoRoot, 'archive', baseSha, LIBRARY]),
  });
  const base = await bundle(join(scratch, LIBRARY, 'commit-log.ts'), 'base');
  const scenario = await bundle(
    join(here, 'schema-v2-base-scenario.ts'),
    'scenario',
  );

  const writtenPath = join(scratch, 'written.sqlite');
  let now = scenario.EARLIER;
  const log = base.W5CommitLog.open(writtenPath, { clock: () => now });
  const expired = log.commit(scenario.requests.expired);
  log.markApplied(expired.commitId);
  now = scenario.LATER;
  const applied = log.commit(scenario.requests.applied);
  log.markApplied(applied.commitId);
  log.commit(scenario.requests.pending);
  const conflicted = log.commit(scenario.requests.conflicted);
  log.markCommitRecoveryRequired(
    conflicted.commitId,
    scenario.conflictDiagnostics,
  );
  log.reserve(scenario.reservations.live);
  log.updateReservationDiagnostics(
    scenario.reservations.live.reservationId,
    scenario.liveDiagnosticsUpdate,
  );
  log.reserve(scenario.reservations.failed);
  log.markReservationRecoveryRequired(
    scenario.reservations.failed.reservationId,
    scenario.failedReservationDiagnostics,
  );
  const compacted = log.compact();
  log.close();
  if (compacted !== 1) throw new Error(`Expected 1 expiry, got ${compacted}.`);

  const rows = dump(writtenPath);
  const reopenedPath = join(scratch, 'reopened.sqlite');
  load(reopenedPath, rows);
  if (dump(reopenedPath) !== rows) throw new Error('The dump does not reload.');
  base.W5CommitLog.open(reopenedPath, { clock: () => now }).close();
  if (dump(reopenedPath) !== rows) {
    throw new Error('The base library changed the database on open.');
  }
  const reopened = base.W5CommitLog.open(reopenedPath, { clock: () => now });
  let observations;
  try {
    observations = scenario.observeW5CommitLog(reopened, () =>
      base.W5CommitLog.open(reopenedPath, 0),
    );
  } finally {
    reopened.close();
  }

  const header = [
    '-- A v2 W5 commit log as written by the base library (CAN-4408 reopen evidence).',
    `-- Base: ${LIBRARY} at ${baseSha}.`,
    '-- Generated, not edited: from the repository root, run',
    '--   node packages/core-runtime/src/node/w5/commit-log/__tests__/fixtures/generate-schema-v2-base.mjs',
    '-- It extracts the base library with git archive, bundles it with esbuild,',
    '-- writes the scenario in schema-v2-base-scenario.ts, dumps every table with',
    '-- quote(), checks the dump reloads unchanged and that a base open changes no',
    '-- row, and records the base reads in schema-v2-base.observations.json.',
  ];
  writeFileSync(
    join(here, 'schema-v2-base.sql'),
    `${header.join('\n')}\n${rows}`,
  );
  const observationsPath = join(here, 'schema-v2-base.observations.json');
  writeFileSync(
    observationsPath,
    await format(JSON.stringify({ base: baseSha, observations }), {
      ...(await resolveConfig(observationsPath)),
      filepath: observationsPath,
    }),
  );
  process.stdout.write(
    `Wrote schema-v2-base.sql and schema-v2-base.observations.json from ${baseSha} with Node ${process.version}.\n`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
