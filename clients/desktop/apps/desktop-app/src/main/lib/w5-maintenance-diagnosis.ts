import { createHash } from 'node:crypto';
import {
  lstat,
  readdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
} from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { W5_COMMIT_LOG_SCHEMA_VERSION } from '@canopy/desktop-shared/node/w5-commit-log';
import { readW5FileBytes, validateW5Document } from './w5-backup';
import { isErrnoException, isRecord } from './type-guards';
import { validateId } from './validation';

export interface W5FileIssue {
  readonly path: string;
  readonly reason:
    | 'corrupt-file'
    | 'missing-file'
    | 'unknown-artifact'
    | 'log-mismatch'
    | 'untracked-file';
}
export interface W5Diagnosis {
  readonly files: readonly W5FileIssue[];
  readonly logIssue: 'unavailable' | 'incompatible-schema' | null;
  readonly commits: readonly {
    readonly commitId: number;
    readonly state: string;
    readonly diagnostics: string | null;
  }[];
  readonly reservations: readonly {
    readonly reservationId: string;
    readonly state: string;
    readonly diagnostics: string;
  }[];
}

function validId(id: string): boolean {
  try {
    validateId(id, 'workspace directory');
    return true;
  } catch {
    return false;
  }
}

interface DiagnosticCopy {
  readonly db: DatabaseSync;
  close(): Promise<void>;
}

async function copyLogForDiagnosis(logPath: string): Promise<DiagnosticCopy> {
  // SQLite readOnly can create/change source WAL/SHM files. Inspect a private
  // copy, including WAL, so even interrupted decisions are visible without
  // touching source bytes. Never copy the SHM index; SQLite rebuilds it here.
  const temporary = await mkdtemp(join(tmpdir(), 'canopy-w5-diagnose-'));
  try {
    const copied = new Map<string, Buffer>();
    for (const suffix of ['', '-wal']) {
      try {
        const bytes = await readFile(`${logPath}${suffix}`);
        copied.set(suffix, bytes);
        await writeFile(join(temporary, `commit-log.sqlite${suffix}`), bytes, {
          flag: 'wx',
          mode: 0o600,
        });
      } catch (error) {
        if (
          suffix !== '-wal' ||
          !isErrnoException(error) ||
          error.code !== 'ENOENT'
        )
          throw error;
      }
    }
    for (const [suffix, bytes] of Array.from(copied))
      if (!(await readFile(`${logPath}${suffix}`)).equals(bytes))
        throw new Error('Log changed during inspection');
    if (!copied.has('-wal')) {
      try {
        await lstat(`${logPath}-wal`);
        throw new Error('WAL appeared during inspection');
      } catch (error) {
        if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
      }
    }
    const db = new DatabaseSync(join(temporary, 'commit-log.sqlite'), {
      readOnly: true,
    });
    return {
      db,
      close: async (): Promise<void> => {
        try {
          db.close();
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Offline-only reader: does not open W5CommitLog or its auto-recovering host.
 * No migration, recovery, compensation, reservation transition or file write.
 * Kept outside the running desktop graph; production exposure remains blocked.
 */
export async function diagnoseW5State(dataRoot: string): Promise<W5Diagnosis> {
  const root = join(dataRoot, 'workspaces');
  const issues: W5FileIssue[] = [];
  const images = new Map<string, Buffer | null>();
  const documents = new Map<string, Record<string, unknown>>();
  async function inspect(path: string, required: boolean): Promise<void> {
    try {
      const bytes = await readW5FileBytes(root, path);
      images.set(path, bytes);
      if (bytes === null) {
        if (required) issues.push({ path, reason: 'missing-file' });
      } else {
        documents.set(path, validateW5Document(bytes, path));
      }
    } catch {
      issues.push({ path, reason: 'corrupt-file' });
    }
  }
  await inspect('index.json', true);
  await inspect('index.json.bak', false);
  const workspaceTypes = new Map<string, unknown>();
  const rows = documents.get('index.json')?.workspaces;
  if (Array.isArray(rows))
    for (const row of rows)
      if (isRecord(row) && typeof row.id === 'string')
        workspaceTypes.set(row.id, row.type);
  const ids = new Set(workspaceTypes.keys());
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Invalid W5 root');
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory() && validId(entry.name)) {
        ids.add(entry.name);
        if (!workspaceTypes.has(entry.name))
          issues.push({ path: entry.name, reason: 'unknown-artifact' });
        for (const child of await readdir(join(root, entry.name), {
          withFileTypes: true,
        }))
          if (
            child.name !== 'workspace.json' &&
            child.name !== 'worktrees.json'
          )
            issues.push({
              path: `${entry.name}/${child.name}`,
              reason: 'unknown-artifact',
            });
      } else if (
        entry.name !== 'index.json' &&
        entry.name !== 'index.json.bak'
      ) {
        issues.push({ path: entry.name, reason: 'unknown-artifact' });
      }
    }
  } catch {
    issues.push({ path: '.', reason: 'corrupt-file' });
  }
  for (const id of Array.from(ids).sort()) {
    await inspect(`${id}/workspace.json`, workspaceTypes.has(id));
    const type = workspaceTypes.get(id);
    await inspect(
      `${id}/worktrees.json`,
      type === 'single-repo' || type === 'multi-repo',
    );
  }

  let logIssue: W5Diagnosis['logIssue'] = null;
  const commits: Array<{
    commitId: number;
    state: string;
    diagnostics: string | null;
  }> = [];
  const reservations: Array<{
    reservationId: string;
    state: string;
    diagnostics: string;
  }> = [];
  let copy: DiagnosticCopy | undefined;
  try {
    // Check the complete parent chain, including sidecars, before SQLite opens.
    for (const path of [dataRoot, join(dataRoot, 'w5')]) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Invalid log parent');
    }
    const recognizedLogArtifacts = new Set([
      'commit-log.sqlite',
      'commit-log.sqlite-wal',
      'commit-log.sqlite-shm',
      'backups',
      'restore-evidence',
    ]);
    for (const entry of await readdir(join(dataRoot, 'w5'), {
      withFileTypes: true,
    }))
      if (!recognizedLogArtifacts.has(entry.name) || entry.isSymbolicLink())
        issues.push({ path: `w5/${entry.name}`, reason: 'unknown-artifact' });
    const logPath = join(dataRoot, 'w5/commit-log.sqlite');
    for (const path of [logPath, `${logPath}-wal`, `${logPath}-shm`]) {
      try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new Error('Invalid log file');
      } catch (error) {
        if (
          path === logPath ||
          !isErrnoException(error) ||
          error.code !== 'ENOENT'
        )
          throw error;
      }
    }
    copy = await copyLogForDiagnosis(logPath);
    const { db } = copy;
    db.exec('PRAGMA query_only = ON; BEGIN');
    const version = db
      .prepare("SELECT value FROM w5_meta WHERE key = 'schema_version'")
      .get()?.value;
    if (version !== String(W5_COMMIT_LOG_SCHEMA_VERSION)) {
      logIssue = 'incompatible-schema';
    } else {
      for (const row of db
        .prepare(
          "SELECT commit_id, state, diagnostics_json FROM w5_commits WHERE state != 'applied' ORDER BY commit_id",
        )
        .all()) {
        if (
          typeof row.commit_id !== 'number' ||
          typeof row.state !== 'string' ||
          (row.diagnostics_json !== null &&
            typeof row.diagnostics_json !== 'string')
        )
          throw new Error('Invalid commit');
        commits.push({
          commitId: row.commit_id,
          state: row.state,
          diagnostics: row.diagnostics_json,
        });
      }
      for (const row of db
        .prepare(
          'SELECT reservation_id, state, diagnostics_json FROM w5_reservations ORDER BY reservation_id',
        )
        .all()) {
        if (
          typeof row.reservation_id !== 'string' ||
          typeof row.state !== 'string' ||
          typeof row.diagnostics_json !== 'string'
        )
          throw new Error('Invalid reservation');
        reservations.push({
          reservationId: row.reservation_id,
          state: row.state,
          diagnostics: row.diagnostics_json,
        });
      }
      const tracked = new Set<string>();
      for (const row of db
        .prepare(
          `SELECT f.path, f.new_fingerprint FROM w5_commit_files f
        WHERE f.commit_id = (SELECT MAX(last.commit_id) FROM w5_commit_files last WHERE last.path = f.path)
        ORDER BY f.path`,
        )
        .all()) {
        if (
          typeof row.path !== 'string' ||
          (row.new_fingerprint !== null &&
            typeof row.new_fingerprint !== 'string')
        )
          throw new Error('Invalid file receipt');
        const path = relative(root, row.path).split('\\').join('/');
        // Never inspect a path supplied by the log outside the three namespaces.
        if (
          join(root, path) !== row.path ||
          !/^(index\.json(?:\.bak)?|[a-zA-Z0-9_-]+\/(workspace|worktrees)\.json)$/.test(
            path,
          )
        ) {
          issues.push({ path: 'commit-log', reason: 'unknown-artifact' });
          continue;
        }
        tracked.add(path);
        if (!images.has(path)) await inspect(path, false);
        const bytes = images.get(path);
        if (bytes === undefined) continue; // Already reported unreadable/non-file.
        const fingerprint =
          bytes === null
            ? null
            : createHash('sha256').update(bytes).digest('hex');
        if (fingerprint !== row.new_fingerprint)
          issues.push({ path, reason: 'log-mismatch' });
      }
      for (const [path, bytes] of Array.from(images))
        if (bytes !== null && !tracked.has(path))
          issues.push({ path, reason: 'untracked-file' });
    }
  } catch {
    logIssue = 'unavailable';
  } finally {
    await copy?.close();
  }

  return {
    files: issues.sort(
      (a, b) =>
        a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason),
    ),
    logIssue,
    commits,
    reservations,
  };
}
