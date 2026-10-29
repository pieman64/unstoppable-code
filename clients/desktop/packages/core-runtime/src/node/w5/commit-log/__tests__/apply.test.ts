import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  W5CommitLog,
  fingerprintW5File,
  recoverW5CommitLog,
  type W5FileChange,
} from './fixtures/with-durability';

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected an error');
}

let dir: string;
let log: W5CommitLog;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'w5-apply-'));
  log = W5CommitLog.open(join(dir, 'commit-log.sqlite'));
});

afterEach(() => {
  log.close();
  rmSync(dir, { recursive: true, force: true });
});

function file(
  name: string,
  contents: string | null,
  previous: string | null,
): W5FileChange {
  return {
    path: join(dir, name),
    contents,
    previousFingerprint: fingerprintW5File(previous),
  };
}

function commit(files: W5FileChange[]): number {
  const result = log.commit({
    operation: 'core.workspace.create',
    advance: [{ kind: 'workspaces' }],
    files,
    outcome: null,
  });
  if (result.status !== 'committed') throw new Error('Expected a commit');
  return result.commitId;
}

describe('W5 commit applier (CAN-3805)', () => {
  it('writes, replaces and removes every file of a commit, then marks it applied', async () => {
    writeFileSync(join(dir, 'index.json'), 'v1');
    writeFileSync(join(dir, 'gone.json'), 'old');
    const id = commit([
      file('index.json', 'v2', 'v1'),
      file('new.json', 'n1', null),
      file('gone.json', null, 'old'),
    ]);

    await expect(recoverW5CommitLog(log, { root: dir })).resolves.toEqual({
      applied: [id],
      recoveryRequired: [],
      interruptedReservations: 0,
    });
    expect(readFileSync(join(dir, 'index.json'), 'utf8')).toBe('v2');
    expect(readFileSync(join(dir, 'new.json'), 'utf8')).toBe('n1');
    expect(existsSync(join(dir, 'gone.json'))).toBe(false);
    expect(log.listPendingCommits()).toEqual([]);
  });

  it('keeps a file a crash already brought up to date', async () => {
    writeFileSync(join(dir, 'a.json'), 'a2');
    writeFileSync(join(dir, 'b.json'), 'b1');
    const id = commit([file('a.json', 'a2', 'a1'), file('b.json', 'b2', 'b1')]);

    await expect(recoverW5CommitLog(log, { root: dir })).resolves.toMatchObject(
      {
        applied: [id],
      },
    );
    expect(readFileSync(join(dir, 'b.json'), 'utf8')).toBe('b2');
  });

  it('overwrites nothing when a file changed out of band and waits for recovery', async () => {
    writeFileSync(join(dir, 'a.json'), 'a1');
    writeFileSync(join(dir, 'b.json'), 'edited elsewhere');
    const id = commit([file('a.json', 'a2', 'a1'), file('b.json', 'b2', 'b1')]);

    await expect(recoverW5CommitLog(log, { root: dir })).resolves.toEqual({
      applied: [],
      recoveryRequired: [id],
      interruptedReservations: 0,
    });
    expect(readFileSync(join(dir, 'a.json'), 'utf8')).toBe('a1');
    expect(readFileSync(join(dir, 'b.json'), 'utf8')).toBe('edited elsewhere');
    // The commit is no longer pending, but its files stay blocked.
    expect(log.listPendingCommits()).toEqual([]);
    expect(
      thrown(() =>
        log.commit({
          operation: 'core.workspace.update',
          advance: [],
          files: [file('b.json', 'b3', 'edited elsewhere')],
          outcome: null,
        }),
      ),
    ).toMatchObject({ reason: 'unapplied-change' });
  });

  it('keeps reporting a commit awaiting recovery on every later launch', async () => {
    writeFileSync(join(dir, 'b.json'), 'edited elsewhere');
    const id = commit([file('b.json', 'b2', 'b1')]);
    await recoverW5CommitLog(log, { root: dir });

    await expect(recoverW5CommitLog(log, { root: dir })).resolves.toEqual({
      applied: [],
      recoveryRequired: [id],
      interruptedReservations: 0,
    });
  });

  it('applies a commit awaiting recovery once the user restores its files and retries it', async () => {
    writeFileSync(join(dir, 'b.json'), 'edited elsewhere');
    const id = commit([file('b.json', 'b2', 'b1')]);
    await recoverW5CommitLog(log, { root: dir });
    writeFileSync(join(dir, 'b.json'), 'b1');

    log.retryRecoveryRequiredCommit(id);

    await expect(recoverW5CommitLog(log, { root: dir })).resolves.toMatchObject(
      {
        applied: [id],
        recoveryRequired: [],
      },
    );
    expect(readFileSync(join(dir, 'b.json'), 'utf8')).toBe('b2');
  });

  it('flags a retried commit again when its files still do not match', async () => {
    writeFileSync(join(dir, 'b.json'), 'edited elsewhere');
    const id = commit([file('b.json', 'b2', 'b1')]);
    await recoverW5CommitLog(log, { root: dir });

    log.retryRecoveryRequiredCommit(id);

    await expect(recoverW5CommitLog(log, { root: dir })).resolves.toMatchObject(
      {
        applied: [],
        recoveryRequired: [id],
      },
    );
    expect(readFileSync(join(dir, 'b.json'), 'utf8')).toBe('edited elsewhere');
  });

  it('drops a commit awaiting recovery with its receipt, keeping the files as they are', async () => {
    writeFileSync(join(dir, 'b.json'), 'kept by the user');
    const key = {
      caller: 'portal:1',
      operation: 'core.workspace.update',
      idempotencyKey: 'k1',
    };
    const result = log.commit({
      operation: key.operation,
      receipt: { ...key, fingerprint: 'f1' },
      advance: [{ kind: 'workspaces' }],
      files: [file('b.json', 'b2', 'b1')],
      outcome: { ok: true },
    });
    if (result.status !== 'committed') throw new Error('Expected a commit');
    await recoverW5CommitLog(log, { root: dir });

    log.abandonRecoveryRequiredCommit(result.commitId);

    expect(readFileSync(join(dir, 'b.json'), 'utf8')).toBe('kept by the user');
    await expect(recoverW5CommitLog(log, { root: dir })).resolves.toMatchObject(
      {
        recoveryRequired: [],
      },
    );
    // The change never reached the files, so a retry runs it again.
    expect(log.lookupReceipt(key, 'f1')).toEqual({ status: 'none' });
    // Its files are no longer blocked.
    expect(
      log.commit({
        operation: 'core.workspace.update',
        advance: [],
        files: [file('b.json', 'b3', 'kept by the user')],
        outcome: null,
      }),
    ).toMatchObject({ status: 'committed' });
  });

  it('only drops a commit that is awaiting recovery', () => {
    const id = commit([file('c.json', 'c1', null)]);

    expect(thrown(() => log.abandonRecoveryRequiredCommit(id))).toMatchObject({
      reason: 'invalid-state',
    });
    expect(log.listPendingCommits()).toEqual([
      expect.objectContaining({ commitId: id }),
    ]);
  });

  it('creates the folders of a new file', async () => {
    const id = commit([
      file(join('workspaces', 'suite', 'workspace.json'), 'm1', null),
    ]);

    await expect(recoverW5CommitLog(log, { root: dir })).resolves.toMatchObject(
      {
        applied: [id],
      },
    );
    expect(
      readFileSync(join(dir, 'workspaces', 'suite', 'workspace.json'), 'utf8'),
    ).toBe('m1');
  });

  it('overwrites nothing edited out of band after the check, and flags the commit', async () => {
    writeFileSync(join(dir, 'a.json'), 'a1');
    writeFileSync(join(dir, 'b.json'), 'b1');
    const id = commit([file('a.json', 'a2', 'a1'), file('b.json', 'b2', 'b1')]);

    const report = await recoverW5CommitLog(log, {
      root: dir,
      onStep: (step) => {
        // Another writer edits b.json once a.json is written.
        if (step.kind === 'after-file' && step.path.endsWith('a.json')) {
          writeFileSync(join(dir, 'b.json'), 'edited meanwhile');
        }
      },
    });

    expect(report).toMatchObject({ applied: [], recoveryRequired: [id] });
    expect(readFileSync(join(dir, 'b.json'), 'utf8')).toBe('edited meanwhile');
  });

  it('flags a commit whose apply fails unexpectedly and keeps recovering the rest', async () => {
    writeFileSync(join(dir, 'blocker'), 'a file where a folder should be');
    const broken = commit([file(join('blocker', 'x.json'), 'x1', null)]);
    const fine = commit([file('ok.json', 'ok', null)]);

    await expect(recoverW5CommitLog(log, { root: dir })).resolves.toMatchObject(
      {
        applied: [fine],
        recoveryRequired: [broken],
      },
    );
    expect(readFileSync(join(dir, 'ok.json'), 'utf8')).toBe('ok');
  });

  it.each([
    ['a root with a trailing slash', (root: string): string => `${root}/`],
    [
      'a relative root',
      (root: string): string => join(relative(process.cwd(), root)),
    ],
  ])('applies a commit under %s', async (_label, spell) => {
    const id = commit([file(join('w', 'a.json'), 'a1', null)]);

    await expect(
      recoverW5CommitLog(log, { root: spell(dir) }),
    ).resolves.toMatchObject({ applied: [id] });
    expect(readFileSync(join(dir, 'w', 'a.json'), 'utf8')).toBe('a1');
  });

  it('applies a file path that contains ..', async () => {
    mkdirSync(join(dir, 'other'));
    const id = commit([file(join('other', '..', 'b.json'), 'b1', null)]);

    await expect(recoverW5CommitLog(log, { root: dir })).resolves.toMatchObject(
      {
        applied: [id],
      },
    );
    expect(readFileSync(join(dir, 'b.json'), 'utf8')).toBe('b1');
  });

  it('refuses a path that leaves the root through a symlinked folder', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'w5-outside-'));
    try {
      symlinkSync(outside, join(dir, 'link'));
      const id = commit([file(join('link', 'escape.json'), 'x', null)]);

      await expect(
        recoverW5CommitLog(log, { root: dir }),
      ).resolves.toMatchObject({ applied: [], recoveryRequired: [id] });
      expect(existsSync(join(outside, 'escape.json'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('writes the path it checked, not one a symlink plus .. would reach', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'w5-outside-'));
    try {
      mkdirSync(join(outside, 'inner'));
      symlinkSync(join(outside, 'inner'), join(dir, 'link'));
      // Built without join, which would remove link/.. before the OS sees it.
      const id = commit([
        {
          path: `${dir}/link/../victim.json`,
          contents: 'v1',
          previousFingerprint: null,
        },
      ]);

      await expect(
        recoverW5CommitLog(log, { root: dir }),
      ).resolves.toMatchObject({ applied: [id] });
      expect(readFileSync(join(dir, 'victim.json'), 'utf8')).toBe('v1');
      expect(existsSync(join(outside, 'victim.json'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('applies commits in order', async () => {
    writeFileSync(join(dir, 'a.json'), 'a1');
    const first = commit([file('a.json', 'a2', 'a1')]);
    log.markApplied(first);
    writeFileSync(join(dir, 'a.json'), 'a2');
    const second = commit([file('a.json', 'a3', 'a2')]);

    await expect(recoverW5CommitLog(log, { root: dir })).resolves.toMatchObject(
      {
        applied: [second],
      },
    );
    expect(readFileSync(join(dir, 'a.json'), 'utf8')).toBe('a3');
  });
});
