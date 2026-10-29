import {
  existsSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as FsPromisesModule from 'node:fs/promises';
import type * as PathsModule from '../lib/paths';

jest.mock('node:fs/promises', () => {
  const actual =
    jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
  return {
    ...actual,
    readFile: jest.fn(actual.readFile),
  };
});

const tempDir = mkdtempSync(join(tmpdir(), 'code-review-persistence-'));
const repoDir = join(tempDir, 'repo');

jest.mock('../lib/paths', () => {
  const actual = jest.requireActual<typeof PathsModule>('../lib/paths');
  return {
    ...actual,
    getCodeReviewStateFilePath: (
      workspaceId: string,
      worktreeId: string,
    ): string => join(tempDir, `${workspaceId}-${worktreeId}.json`),
  };
});

jest.mock('../lib/resolve-worktree', () => ({
  // Single-repo checkouts live at the worktree root; a real child repo would
  // live under `repos/<id>`. `reevaluateReviewAnchors` must normalize the
  // `'default'` sentinel to the root (undefined) rather than passing it
  // through as a child-repo id.
  resolveWorktreeCwd: (
    _projectId: string,
    _worktreeId: string,
    repoId?: string,
  ): string =>
    repoId === undefined ? repoDir : join(repoDir, 'repos', repoId),
}));

import {
  appendReviewCommentReply,
  readCodeReviewState,
  reevaluateReviewAnchors,
  saveCodeReviewComments,
  setCodeReviewArmed,
  setCodeReviewArtifact,
} from '../lib/code-review-persistence';
import type { ReviewCommentThread } from '@canopy/desktop-shared/types';
import {
  drainCodeReviewTasks,
  releaseCodeReviewTasks,
  runCodeReviewTask,
} from '../lib/code-review-deletion-fence';
import { readFile as readFileAsync } from 'node:fs/promises';

function thread(id: string, quote: string): ReviewCommentThread {
  return {
    id,
    status: 'open',
    createdAt: '2026-07-07T00:00:00.000Z',
    anchor: {
      source: 'code',
      quote,
      repoId: 'default',
      filePath: 'src/index.ts',
      side: 'new',
      lineStart: 1,
      lineEnd: 1,
    },
    anchorState: 'matched',
    comments: [
      {
        id: `${id}-c1`,
        author: 'user',
        body: 'question',
        createdAt: '2026-07-07T00:00:00.000Z',
        staged: true,
      },
    ],
  };
}

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('code-review persistence', () => {
  it('drains a save whose state read began before deletion', async () => {
    const projectId = 'p-read-fence';
    const worktreeId = 'w-read-fence';
    const filePath = join(tempDir, `${projectId}-${worktreeId}.json`);
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        armed: false,
        commentThreads: [],
        diagrams: {},
      }),
    );

    const actualReadFile =
      jest.requireActual<typeof FsPromisesModule>('node:fs/promises').readFile;
    let signalReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    let releaseRead: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    jest.mocked(readFileAsync).mockImplementationOnce(async (...args) => {
      signalReadStarted?.();
      await readGate;
      return actualReadFile(...args);
    });

    const save = saveCodeReviewComments({
      projectId,
      worktreeId,
      commentThreads: [thread('t-read-fence', 'const value = 1;')],
    });
    await readStarted;

    let drained = false;
    const drain = drainCodeReviewTasks(projectId, worktreeId).then(() => {
      drained = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);

    releaseRead?.();
    await Promise.all([save, drain]);
    rmSync(filePath, { force: true });
    releaseCodeReviewTasks(projectId, worktreeId);

    expect(existsSync(filePath)).toBe(false);
  });

  it('rejects late writers until deletion cleanup releases the scope', async () => {
    await drainCodeReviewTasks('p-fence', 'w-fence');
    await expect(
      saveCodeReviewComments({
        projectId: 'p-fence',
        worktreeId: 'w-fence',
        commentThreads: [],
      }),
    ).rejects.toThrow('Code review state is being removed');

    releaseCodeReviewTasks('p-fence', 'w-fence');
    await expect(
      saveCodeReviewComments({
        projectId: 'p-fence',
        worktreeId: 'w-fence',
        commentThreads: [],
      }),
    ).resolves.toEqual(expect.objectContaining({ commentThreads: [] }));
  });

  it('rejects nested work that becomes runnable after deletion starts draining', async () => {
    let releaseOuter: (() => void) | undefined;
    let nestedRan = false;
    const scope = { projectId: 'p-nested', worktreeId: 'w-nested' };
    const outer = runCodeReviewTask(
      scope,
      async () => {
        await new Promise<void>((resolve) => {
          releaseOuter = resolve;
        });
        return runCodeReviewTask(
          scope,
          () => {
            nestedRan = true;
            return Promise.resolve();
          },
          () => undefined,
        );
      },
      () => undefined,
    );
    await Promise.resolve();
    const drain = drainCodeReviewTasks(scope.projectId, scope.worktreeId);
    releaseOuter?.();
    await Promise.all([outer, drain]);

    expect(nestedRan).toBe(false);
  });

  it('reads an empty default and arms', async () => {
    const initial = await readCodeReviewState('p1', 'w1');
    expect(initial.armed).toBe(false);
    const armed = await setCodeReviewArmed('p1', 'w1');
    expect(armed.armed).toBe(true);
    expect(typeof armed.armedAt).toBe('string');
  });

  it('saves comments and preserves agent replies on merge', async () => {
    const t = thread('t1', 'const x = 1;');
    await saveCodeReviewComments({
      projectId: 'p1',
      worktreeId: 'w1',
      commentThreads: [t],
    });
    const reply = await appendReviewCommentReply({
      projectId: 'p1',
      worktreeId: 'w1',
      threadId: 't1',
      body: 'done',
      resolve: true,
    });
    expect(reply.ok).toBe(true);
    // A renderer save that does not yet know about the agent reply must not
    // drop it or un-resolve the thread.
    const saved = await saveCodeReviewComments({
      projectId: 'p1',
      worktreeId: 'w1',
      commentThreads: [t],
    });
    const merged = saved?.commentThreads.find((entry) => entry.id === 't1');
    expect(merged?.comments.map((c) => c.author)).toEqual(['user', 'agent']);
    expect(merged?.status).toBe('resolved');
  });

  it('honors a user reopen (open over stored resolved) when no agent activity is missing', async () => {
    // A user resolves then reopens their own thread: the renderer's save has
    // all the (zero) agent comments, so the incoming `open` is a deliberate
    // reopen and must win over the stored `resolved` — otherwise a resolved
    // comment could never be reopened.
    const t = thread('t-reopen', 'const z = 3;');
    await saveCodeReviewComments({
      projectId: 'p1',
      worktreeId: 'wr',
      commentThreads: [{ ...t, status: 'resolved' }],
    });
    const reopened = await saveCodeReviewComments({
      projectId: 'p1',
      worktreeId: 'wr',
      commentThreads: [{ ...t, status: 'open' }],
    });
    const entry = reopened?.commentThreads.find((e) => e.id === 't-reopen');
    expect(entry?.status).toBe('open');
  });

  it('composes edits from two panels that loaded the same base threads', async () => {
    const first = thread('t-panel-1', 'const first = 1;');
    const second = thread('t-panel-2', 'const second = 2;');
    const base = [first, second];
    await saveCodeReviewComments({
      projectId: 'p-panels',
      worktreeId: 'w-panels',
      commentThreads: base,
    });

    const panelOneSave = {
      projectId: 'p-panels',
      worktreeId: 'w-panels',
      commentThreads: [
        {
          ...first,
          comments: [{ ...first.comments[0], body: 'Edited by panel one.' }],
        },
        second,
      ],
      baseCommentThreadIds: base.map((entry) => entry.id),
      baseCommentThreads: base,
    };
    await saveCodeReviewComments(panelOneSave);

    const panelTwoSave = {
      projectId: 'p-panels',
      worktreeId: 'w-panels',
      commentThreads: [
        first,
        {
          ...second,
          status: 'resolved' as const,
        },
      ],
      baseCommentThreadIds: base.map((entry) => entry.id),
      baseCommentThreads: base,
    };
    const saved = await saveCodeReviewComments(panelTwoSave);

    expect(
      saved?.commentThreads.find((entry) => entry.id === first.id)?.comments[0]
        ?.body,
    ).toBe('Edited by panel one.');
    expect(
      saved?.commentThreads.find((entry) => entry.id === second.id)?.status,
    ).toBe('resolved');
  });

  it('sets artifacts and flips anchors to outdated when the quote vanishes', async () => {
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'index.ts'), 'const y = 2;\n');
    const updated = await reevaluateReviewAnchors('p1', 'w1');
    const t1 = updated?.commentThreads.find((entry) => entry.id === 't1');
    expect(t1?.anchorState).toBe('outdated');

    const withArtifact = await setCodeReviewArtifact(
      'p1',
      'w1',
      'annotations',
      {
        data: { schemaVersion: 1, annotations: [] },
        derivedFromFingerprint: 'fp-1',
        status: 'ready',
        generatedAt: '2026-07-07T00:00:00.000Z',
      },
    );
    expect(withArtifact?.annotations?.status).toBe('ready');
  });

  it('marks a thread outdated when its anchor filePath escapes the repo root', async () => {
    // A file that would match by content but lives outside the repo root must
    // never satisfy the anchor — the escaping path is treated as unreadable.
    writeFileSync(join(tempDir, 'escape.ts'), 'const escape = true;\n');
    const escaping: ReviewCommentThread = {
      ...thread('t-escape', 'const escape = true;'),
      anchor: {
        source: 'code',
        quote: 'const escape = true;',
        repoId: 'default',
        filePath: '../escape.ts',
        side: 'new',
        lineStart: 1,
        lineEnd: 1,
      },
    };
    await saveCodeReviewComments({
      projectId: 'p2',
      worktreeId: 'w2',
      commentThreads: [escaping],
    });
    const updated = await reevaluateReviewAnchors('p2', 'w2');
    const entry = updated?.commentThreads.find(
      (candidate) => candidate.id === 't-escape',
    );
    expect(entry?.anchorState).toBe('outdated');
  });

  it('marks a thread outdated when its anchor resolves through an escaping symlink', async () => {
    const outsideDir = join(tempDir, 'outside-anchor');
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'secret.ts'), 'const secret = true;\n');
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    symlinkSync(outsideDir, join(repoDir, 'src', 'linked'));
    const escaping: ReviewCommentThread = {
      ...thread('t-symlink-escape', 'const secret = true;'),
      anchor: {
        source: 'code',
        quote: 'const secret = true;',
        repoId: 'default',
        filePath: 'src/linked/secret.ts',
        side: 'new',
        lineStart: 1,
        lineEnd: 1,
      },
    };
    await saveCodeReviewComments({
      projectId: 'p-symlink',
      worktreeId: 'w-symlink',
      commentThreads: [escaping],
    });

    const updated = await reevaluateReviewAnchors('p-symlink', 'w-symlink');
    const entry = updated?.commentThreads.find(
      (candidate) => candidate.id === 't-symlink-escape',
    );

    expect(entry?.anchorState).toBe('outdated');
  });

  it('keeps a single-repo "default" anchor matched when its quote is present', async () => {
    // Regression: the `'default'` sentinel repoId must resolve to the worktree
    // root, not a non-existent `repos/default` dir. Otherwise the working-tree
    // read fails and the thread is wrongly flipped to outdated on every
    // re-eval (e.g. right after a diagram/annotation regeneration), even
    // though nothing in the file changed.
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'index.ts'), 'const present = 1;\n');
    await saveCodeReviewComments({
      projectId: 'p3',
      worktreeId: 'w3',
      commentThreads: [thread('t-default', 'const present = 1;')],
    });
    const updated = await reevaluateReviewAnchors('p3', 'w3');
    const entry = updated?.commentThreads.find((c) => c.id === 't-default');
    expect(entry?.anchorState).toBe('matched');
  });

  it('keeps old-side anchors matched when the quote is absent from the working tree', async () => {
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'index.ts'), 'const current = 1;\n');
    const baseThread = thread('t-old-side', 'const removed = 1;');
    await saveCodeReviewComments({
      projectId: 'p4',
      worktreeId: 'w4',
      commentThreads: [
        {
          ...baseThread,
          anchor: {
            ...baseThread.anchor,
            side: 'old',
          },
          anchorState: 'outdated',
        },
      ],
    });

    const updated = await reevaluateReviewAnchors('p4', 'w4');
    const entry = updated?.commentThreads.find((c) => c.id === 't-old-side');

    expect(entry?.anchorState).toBe('matched');
  });
});
