import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { captureW5Files } from '../capture';
import {
  isW5CaptureResult,
  type W5CaptureFile,
  type W5CaptureResult,
} from '../capture-contract';
import {
  classifyW5FileProvenance,
  classifyW5RevisionEligibility,
} from '../eligibility';
import {
  W5CommitLog,
  applyW5Commit,
  fingerprintW5File,
  type W5Resource,
} from './fixtures/with-durability';

// Writers modelled on actual behaviour: desktop decisions fingerprint the
// decoded text they read and advance only what they diffed against it; the
// CLI replaces whole JSON files directly (desktop-shared workspace-service).

let dir: string;
let root: string;
let dbPath: string;
let log: W5CommitLog;

const workspaces: W5Resource = { kind: 'workspaces' };
const workspace: W5Resource = { kind: 'workspace', workspaceId: 'alpha' };
const worktrees: W5Resource = { kind: 'worktrees', workspaceId: 'alpha' };
const worktree = (worktreeId: string): W5Resource => ({
  kind: 'worktree',
  workspaceId: 'alpha',
  worktreeId,
});
const files = {
  index: { kind: 'index' },
  manifest: { kind: 'manifest', workspaceId: 'alpha' },
  worktrees: { kind: 'worktrees', workspaceId: 'alpha' },
} satisfies Record<string, W5CaptureFile>;
type Name = keyof typeof files;
const path = (name: Name): string =>
  name === 'index'
    ? join(root, 'index.json')
    : join(
        root,
        'alpha',
        name === 'manifest' ? 'workspace.json' : 'worktrees.json',
      );
const rows = (...worktreeRows: Array<{ id: string; label?: string }>): string =>
  JSON.stringify({ version: 1, worktrees: worktreeRows }, null, 2);
const list = (...ids: string[]): string => rows(...ids.map((id) => ({ id })));
const REPLACEMENT = '{"repos":["\uFFFD"]}';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'w5-eligibility-'));
  root = join(dir, 'workspaces');
  mkdirSync(join(root, 'alpha'), { recursive: true });
  dbPath = join(dir, 'log.sqlite');
  log = W5CommitLog.open(dbPath);
});
afterEach(() => {
  log.close();
  rmSync(dir, { recursive: true, force: true });
});

function decoded(name: Name): string | null {
  try {
    return readFileSync(path(name), 'utf8');
  } catch {
    return null;
  }
}

async function desktop(
  name: Name,
  contents: string | null,
  advance: readonly W5Resource[],
): Promise<void> {
  const saved = log.commit({
    operation: 'test.desktop',
    advance,
    files: [
      {
        path: path(name),
        contents,
        previousFingerprint: fingerprintW5File(decoded(name)),
      },
    ],
    outcome: null,
  });
  const pending = log
    .listPendingCommits()
    .find((commit) => commit.commitId === saved.commitId);
  if (!pending) throw new Error('Expected a pending commit');
  await expect(applyW5Commit(log, pending, { root })).resolves.toEqual({
    status: 'applied',
  });
}

/** fenceLockedFiles: the observed image, unchanged, with no advance. */
function fence(name: Name): Promise<void> {
  return desktop(name, decoded(name), []);
}

function cli(name: Name, contents: string | Buffer): void {
  const temporary = `${path(name)}.cli.tmp`;
  writeFileSync(temporary, contents);
  renameSync(temporary, path(name));
}

function withRaw(run: (db: DatabaseSync) => void): void {
  log.close();
  const db = new DatabaseSync(dbPath);
  try {
    run(db);
  } finally {
    db.close();
    log = W5CommitLog.open(dbPath);
  }
}

async function baseline(): Promise<void> {
  await desktop('index', JSON.stringify({ workspaces: [{ id: 'alpha' }] }), [
    workspaces,
    workspace,
  ]);
  await desktop('manifest', '{"repos":[]}', [workspace]);
  await desktop('worktrees', list('one', 'two'), [
    worktrees,
    worktree('one'),
    worktree('two'),
  ]);
}

async function capture(
  selected: readonly W5CaptureFile[] = Object.values(files),
): Promise<W5CaptureResult> {
  const result = await captureW5Files(
    log,
    root,
    { files: selected, discoverWorkspaces: false },
    process.platform,
  );
  expect(isW5CaptureResult(result)).toBe(true);
  return result;
}

function label(result: W5CaptureResult, resource: W5Resource): number | string {
  const eligibility = classifyW5RevisionEligibility(
    result,
    resource,
    'complete',
  );
  return eligibility.status === 'eligible'
    ? eligibility.revision
    : eligibility.reason;
}

async function labels(): Promise<Record<string, number | string>> {
  const result = await capture();
  return {
    workspaces: label(result, workspaces),
    workspace: label(result, workspace),
    worktrees: label(result, worktrees),
    one: label(result, worktree('one')),
  };
}

it('grants labels for images created from absence by an unbroken logged chain', async () => {
  await baseline();
  expect(await labels()).toEqual({
    workspaces: 1,
    workspace: 2,
    worktrees: 1,
    one: 1,
  });
  await desktop('worktrees', list('one', 'two', 'three'), [
    worktrees,
    worktree('three'),
  ]);
  await fence('manifest');
  const result = await capture();
  expect(classifyW5FileProvenance(result, files.worktrees)).toEqual({
    status: 'canonical',
    fingerprint: fingerprintW5File(list('one', 'two', 'three')),
  });
  expect(
    result.log.chains.find((chain) => chain.file.kind === 'worktrees'),
  ).toEqual({
    file: files.worktrees,
    decisions: 2,
    startsAbsent: true,
    discontinuities: 0,
  });
  expect(await labels()).toEqual({
    workspaces: 1,
    workspace: 2,
    worktrees: 2,
    one: 1,
  });
  expect(label(result, worktree('three'))).toBe(1);
});

it.each([
  ['membership', 'write', list('one', 'two', 'cli')],
  ['membership', 'fence', list('one', 'two', 'cli')],
  ['order', 'write', list('two', 'one')],
  ['order', 'fence', list('two', 'one')],
  ['single-row', 'write', rows({ id: 'one', label: 'cli' }, { id: 'two' })],
  ['single-row', 'fence', rows({ id: 'one', label: 'cli' }, { id: 'two' })],
])(
  'keeps a foreign %s change ineligible after an unrelated %s',
  async (_change, sequel, foreign) => {
    await baseline();
    cli('worktrees', foreign);
    const unaffected = { workspaces: 1, workspace: 2 };
    expect(await labels()).toEqual({
      ...unaffected,
      worktrees: 'diverged',
      one: 'diverged',
    });
    if (sequel === 'fence') {
      await fence('worktrees');
    } else {
      // The repository diffs against the CLI image: only row "two" advances.
      const document: unknown = JSON.parse(decoded('worktrees') ?? '');
      if (
        typeof document !== 'object' ||
        document === null ||
        !('worktrees' in document) ||
        !Array.isArray(document.worktrees)
      )
        throw new Error('Expected a worktree list');
      const updated = document.worktrees.map((row: unknown) =>
        typeof row === 'object' &&
        row !== null &&
        'id' in row &&
        row.id === 'two'
          ? { ...row, label: 'desktop' }
          : row,
      );
      await desktop(
        'worktrees',
        JSON.stringify({ ...document, worktrees: updated }, null, 2),
        [worktree('two')],
      );
    }
    const result = await capture();
    // The latest logged fingerprint matches the bytes exactly; that is not enough.
    expect(
      result.log.files.find((row) => row.file.kind === 'worktrees')
        ?.newFingerprint,
    ).toBe(fingerprintW5File(decoded('worktrees')));
    expect(result.log.revisions['worktrees:alpha']).toBe(1);
    expect(await labels()).toEqual({
      ...unaffected,
      worktrees: 'foreign-preimage',
      one: 'foreign-preimage',
    });
    expect(label(result, worktree('two'))).toBe('foreign-preimage');
  },
);

it('treats a formatting-only foreign rewrite as diverged and never repairs it with a later write', async () => {
  await baseline();
  cli('manifest', '{ "repos": [] }\n');
  expect((await labels()).workspace).toBe('diverged');
  await desktop('manifest', '{"repos":[1]}', [workspace]);
  expect(await labels()).toMatchObject({
    workspaces: 1,
    workspace: 'foreign-preimage',
  });
});

it('compares captured bytes, so lossy UTF-8 and BOM variants stay diverged even after a fence', async () => {
  await baseline();
  await desktop('manifest', REPLACEMENT, [workspace]);
  expect((await labels()).workspace).toBe(3);
  // Decodes to the canonical text, so the decoded fingerprints agree; the bytes do not.
  cli('manifest', Buffer.from('{"repos":["\xff"]}', 'latin1'));
  expect(fingerprintW5File(decoded('manifest'))).toBe(
    fingerprintW5File(REPLACEMENT),
  );
  await fence('manifest');
  const result = await capture();
  expect(
    result.log.chains.find((chain) => chain.file.kind === 'manifest'),
  ).toMatchObject({ discontinuities: 0 });
  expect(label(result, workspace)).toBe('diverged');
  cli('manifest', `\uFEFF${REPLACEMENT}`);
  expect((await labels()).workspace).toBe('diverged');
});

it('withholds labels for pre-log, untracked and missing files without manufacturing revision zero', async () => {
  writeFileSync(path('index'), '{"workspaces":[]}');
  let result = await capture();
  expect(classifyW5FileProvenance(result, files.index)).toEqual({
    status: 'unverified',
    reason: 'untracked',
  });
  // Missing with no deletion evidence.
  expect(classifyW5FileProvenance(result, files.manifest)).toEqual({
    status: 'unverified',
    reason: 'untracked',
  });
  expect(label(result, workspaces)).toBe('untracked');
  await desktop('index', JSON.stringify({ workspaces: [{ id: 'alpha' }] }), [
    workspaces,
    workspace,
  ]);
  await desktop('manifest', '{}', [workspace]);
  expect(await labels()).toMatchObject({
    workspaces: 'pre-log',
    workspace: 'pre-log',
  });

  // A logged creation that advanced no counter still yields no zero label.
  await desktop('worktrees', list(), []);
  result = await capture();
  expect(classifyW5FileProvenance(result, files.worktrees).status).toBe(
    'canonical',
  );
  expect(label(result, worktrees)).toBe('no-revision');
});

it('accepts a logged deletion as evidence of absence, but not a foreign one', async () => {
  await baseline();
  await desktop('worktrees', null, [worktrees, worktree('one')]);
  expect(await labels()).toMatchObject({ worktrees: 2, one: 2 });
  await desktop('worktrees', list('one'), [worktrees, worktree('one')]);
  expect(await labels()).toMatchObject({ worktrees: 3, one: 3 });
  rmSync(path('worktrees'));
  expect(await labels()).toMatchObject({
    worktrees: 'diverged',
    one: 'diverged',
  });
});

it('withholds every label while any commit is pending or needs recovery, without repairing it', async () => {
  await baseline();
  const pending = log.commit({
    operation: 'test',
    advance: [worktrees],
    files: [
      {
        path: path('worktrees'),
        contents: list(),
        previousFingerprint: fingerprintW5File(list('one', 'two')),
      },
    ],
    outcome: null,
  });
  const result = await capture();
  expect(classifyW5FileProvenance(result, files.worktrees)).toEqual({
    status: 'unverified',
    reason: 'pending',
  });
  expect(classifyW5FileProvenance(result, files.index).status).toBe(
    'canonical',
  );
  // Unrelated resources too: the log records no per-commit advance set.
  expect(await labels()).toEqual({
    workspaces: 'pending',
    workspace: 'pending',
    worktrees: 'pending',
    one: 'pending',
  });
  log.markCommitRecoveryRequired(pending.commitId, null);
  expect((await labels()).workspaces).toBe('pending');
  expect(log.listRecoveryRequiredCommitIds()).toEqual([pending.commitId]);
  expect(decoded('worktrees')).toBe(list('one', 'two'));
});

it('withholds every label after abandonment, even when fingerprints match and counters advanced', async () => {
  await baseline();
  const abandoned = log.commit({
    operation: 'test',
    advance: [workspaces],
    files: [
      {
        path: path('index'),
        contents: '{"workspaces":[]}',
        previousFingerprint: fingerprintW5File(decoded('index')),
      },
    ],
    outcome: null,
  });
  log.markCommitRecoveryRequired(abandoned.commitId, null);
  log.abandonRecoveryRequiredCommit(abandoned.commitId);
  const result = await capture();
  expect(result.log).toMatchObject({
    commitId: abandoned.commitId,
    retainedCommits: abandoned.commitId - 1,
    unresolvedCommits: 0,
    revisions: { workspaces: 2 },
  });
  expect(
    result.log.files.find((row) => row.file.kind === 'index')?.newFingerprint,
  ).toBe(fingerprintW5File(decoded('index')));
  expect(await labels()).toEqual({
    workspaces: 'abandoned-history',
    workspace: 'abandoned-history',
    worktrees: 'abandoned-history',
    one: 'abandoned-history',
  });
  await desktop('worktrees', list('one', 'two', 'three'), [
    worktrees,
    worktree('three'),
  ]);
  expect((await labels()).worktrees).toBe('abandoned-history');
});

it('withholds a workspace label whose index entry ID repeats, but not the collection label', async () => {
  await baseline();
  await desktop(
    'index',
    JSON.stringify({ workspaces: [{ id: 'alpha' }, { id: 'alpha', n: 1 }] }),
    [workspaces, workspace],
  );
  expect(await labels()).toMatchObject({
    workspaces: 2,
    workspace: 'duplicate-row',
  });
});

it('omits labels for partial projections, unread selectors and unreadable images', async () => {
  await baseline();
  const result = await capture();
  expect(classifyW5RevisionEligibility(result, worktrees, 'partial')).toEqual({
    status: 'unverified',
    reason: 'projection-incomplete',
  });
  const indexOnly = await capture([files.index]);
  expect(label(indexOnly, workspaces)).toBe(1);
  expect(label(indexOnly, workspace)).toBe('not-captured');
  rmSync(path('manifest'));
  mkdirSync(path('manifest'));
  expect((await labels()).workspace).toBe('unreadable');
});

it('summarizes the whole retained chain, so an old break survives long history', async () => {
  await baseline();
  cli('worktrees', list('one', 'two', 'cli'));
  await fence('worktrees');
  const image = fingerprintW5File(list('one', 'two', 'cli'));
  withRaw((raw) => {
    raw.exec('BEGIN');
    const commit = raw.prepare(
      `INSERT INTO w5_commits (operation, outcome_json, state, committed_at, completed_at)
       VALUES ('test', 'null', 'applied', '2026-10-28T00:00:00Z', '2026-10-28T00:00:00Z')`,
    );
    const file = raw.prepare(
      `INSERT INTO w5_commit_files (commit_id, path, previous_fingerprint, new_fingerprint)
       VALUES (?, ?, ?, ?)`,
    );
    for (let i = 0; i < 5000; i++)
      file.run(commit.run().lastInsertRowid, path('worktrees'), image, image);
    raw.exec('COMMIT');
  });
  const result = await capture();
  expect(result.log.files).toHaveLength(3);
  expect(
    result.log.chains.find((chain) => chain.file.kind === 'worktrees'),
  ).toMatchObject({ decisions: 5002, startsAbsent: true, discontinuities: 1 });
  expect(label(result, worktrees)).toBe('foreign-preimage');
});

it('never treats a malformed fingerprint as continuous, even with itself', async () => {
  await baseline();
  for (const repos of ['[1]', '[2]', '[3]'])
    await desktop('manifest', `{"repos":${repos}}`, [workspace]);
  const middle = fingerprintW5File('{"repos":[1]}');
  withRaw((raw) => {
    raw
      .prepare(
        'UPDATE w5_commit_files SET new_fingerprint = ? WHERE path = ? AND new_fingerprint = ?',
      )
      .run('X', path('manifest'), middle);
    raw
      .prepare(
        'UPDATE w5_commit_files SET previous_fingerprint = ? WHERE path = ? AND previous_fingerprint = ?',
      )
      .run('X', path('manifest'), middle);
  });
  const result = await capture();
  expect(
    result.log.chains.find((chain) => chain.file.kind === 'manifest'),
  ).toMatchObject({ decisions: 4, discontinuities: 2 });
  expect(label(result, workspace)).toBe('foreign-preimage');
});

it('classifies migrated v1 evidence by the images v1 retained', async () => {
  log.close();
  rmSync(dbPath);
  const before = JSON.stringify({ workspaces: [{ id: 'alpha' }] });
  const after = JSON.stringify({ workspaces: [{ id: 'alpha' }, { id: 'b' }] });
  const v1 = new DatabaseSync(dbPath);
  try {
    v1.exec(readFileSync(join(__dirname, 'fixtures/schema-v1.sql'), 'utf8'));
    const commit = v1.prepare(
      `INSERT INTO w5_commits (operation, outcome_json, state, committed_at)
       VALUES ('test', 'null', 'applied', '2026-10-13T00:00:00Z')`,
    );
    const file = v1.prepare('INSERT INTO w5_commit_files VALUES (?, ?, ?, ?)');
    file.run(commit.run().lastInsertRowid, path('index'), null, before);
    file.run(
      commit.run().lastInsertRowid,
      path('manifest'),
      fingerprintW5File('pre-log'),
      '{}',
    );
    file.run(
      commit.run().lastInsertRowid,
      path('index'),
      fingerprintW5File(before),
      after,
    );
    const revision = v1.prepare('INSERT INTO w5_revisions VALUES (?, ?)');
    revision.run('workspaces', 2);
    revision.run('workspace:alpha', 2);
  } finally {
    v1.close();
  }
  writeFileSync(path('index'), after);
  writeFileSync(path('manifest'), '{}');
  log = W5CommitLog.open(dbPath);
  const result = await capture();
  expect(result.log.schemaVersion).toBe(3);
  expect(label(result, workspaces)).toBe(2);
  expect(label(result, workspace)).toBe('pre-log');
  writeFileSync(path('index'), before);
  expect(label(await capture(), workspaces)).toBe('diverged');
});

it.each([
  ['more retained than allocated commits', { retainedCommits: 99 }],
  ['more unresolved than retained commits', { unresolvedCommits: 99 }],
  ['fewer chain summaries than images', { chains: [] }],
])('rejects capture evidence with %s', async (_name, change) => {
  await baseline();
  const result = await capture();
  expect(
    isW5CaptureResult({ ...result, log: { ...result.log, ...change } }),
  ).toBe(false);
});

it.each([
  { discontinuities: 9 },
  { decisions: 0, startsAbsent: true, discontinuities: 0 },
  { extra: true },
])('rejects an inconsistent chain summary %p', async (change) => {
  await baseline();
  const result = await capture();
  const chains = result.log.chains.map((chain) => ({ ...chain, ...change }));
  expect(isW5CaptureResult({ ...result, log: { ...result.log, chains } })).toBe(
    false,
  );
});
