import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let registryPath = '';

jest.mock('../lib/paths', () => ({
  getSharedRunCommentsFilePath: (): string => registryPath,
}));

import {
  claimSharedRunCommentPollWindow,
  markSharedRunCommentsSeen,
  readSharedRunCommentEntries,
  readSharedRunCommentEntry,
  recordPolledCommentRevision,
  registerSharedRunForComments,
  setSharedRunCommentsCorruptionReporter,
  unregisterSharedRunForComments,
} from '../lib/shared-run-comments-registry';

const target = { projectId: 'proj', worktreeId: 'wt', chatId: 'chat-1' };

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shared-run-comments-'));
  registryPath = join(dir, 'shared-run-comments.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('shared-run comment registry', () => {
  it('returns an empty list when the file is missing', async () => {
    await expect(readSharedRunCommentEntries()).resolves.toEqual([]);
  });

  it('degrades to empty on a corrupt file rather than throwing', async () => {
    await writeFile(registryPath, 'not json', 'utf8');
    await expect(readSharedRunCommentEntries()).resolves.toEqual([]);
  });

  it('registers a shared run with a clean unread slate', async () => {
    await registerSharedRunForComments({ ...target, externalId: 'run-ext-1' });

    await expect(readSharedRunCommentEntry(target)).resolves.toEqual({
      ...target,
      externalId: 'run-ext-1',
      lastSeenCommentRevision: 0,
      lastPolledCommentRevision: 0,
      unreadCommentCount: 0,
    });
  });

  it('keeps seen state across a re-share of the same grant', async () => {
    await registerSharedRunForComments({ ...target, externalId: 'run-ext-1' });
    await markSharedRunCommentsSeen(target, 7);

    // A re-share updates the same row in place server-side, so its comment
    // threads (and therefore the seen marker) survive.
    await registerSharedRunForComments({ ...target, externalId: 'run-ext-1' });

    const entry = await readSharedRunCommentEntry(target);
    expect(entry?.lastSeenCommentRevision).toBe(7);
  });

  it('resets seen state when a brand-new grant replaces the old one', async () => {
    await registerSharedRunForComments({ ...target, externalId: 'run-ext-1' });
    await markSharedRunCommentsSeen(target, 7);

    // Unshare + re-share mints a new externalId; the old threads cascaded away.
    await registerSharedRunForComments({ ...target, externalId: 'run-ext-2' });

    const entry = await readSharedRunCommentEntry(target);
    expect(entry).toMatchObject({
      externalId: 'run-ext-2',
      lastSeenCommentRevision: 0,
      unreadCommentCount: 0,
    });
  });

  it('does not re-raise unread for a revision the user has already seen', async () => {
    // The poller computes `unreadCount` from a snapshot taken BEFORE its
    // network round trip. If the user reads the thread mid-flight, writing that
    // stale count would clobber the just-cleared 0 and re-light the badge for
    // comments they are reading right now.
    await registerSharedRunForComments({ ...target, externalId: 'run-ext-1' });
    await markSharedRunCommentsSeen(target, 5);

    const updated = await recordPolledCommentRevision(target, {
      externalId: 'run-ext-1',
      commentRevision: 5,
      unreadCount: 3, // stale: computed against lastSeen 0
    });

    expect(updated.unreadCommentCount).toBe(0);
    expect(updated.lastSeenCommentRevision).toBe(5);
  });

  it('still reports unread when the poll genuinely outruns the seen marker', async () => {
    await registerSharedRunForComments({ ...target, externalId: 'run-ext-1' });
    await markSharedRunCommentsSeen(target, 2);

    const updated = await recordPolledCommentRevision(target, {
      externalId: 'run-ext-1',
      commentRevision: 6,
      unreadCount: 4,
    });

    expect(updated.unreadCommentCount).toBe(4);
  });

  it('clamps a stale unread count to the revisions actually unseen', async () => {
    // Partial overlap: markSeen(4) landed while the poll was observing rev 5,
    // so the caller's count (derived against lastSeen 0) is inflated. Left
    // unclamped it also sticks, because countUnreadComments carries the stored
    // value forward via Math.max on later ticks.
    await registerSharedRunForComments({ ...target, externalId: 'run-ext-1' });
    await markSharedRunCommentsSeen(target, 4);

    const updated = await recordPolledCommentRevision(target, {
      externalId: 'run-ext-1',
      commentRevision: 5,
      unreadCount: 5,
    });

    expect(updated.unreadCommentCount).toBe(1);
  });

  it('never moves the polled marker backwards', async () => {
    await registerSharedRunForComments({ ...target, externalId: 'run-ext-1' });
    await markSharedRunCommentsSeen(target, 9);

    const updated = await recordPolledCommentRevision(target, {
      externalId: 'run-ext-1',
      commentRevision: 4,
      unreadCount: 0,
    });

    expect(updated.lastPolledCommentRevision).toBe(9);
  });

  it('records a polled revision without moving the seen marker', async () => {
    await registerSharedRunForComments({ ...target, externalId: 'run-ext-1' });
    await markSharedRunCommentsSeen(target, 2);

    const updated = await recordPolledCommentRevision(target, {
      externalId: 'run-ext-1',
      commentRevision: 5,
      unreadCount: 3,
    });

    expect(updated).toMatchObject({
      lastSeenCommentRevision: 2,
      lastPolledCommentRevision: 5,
      unreadCommentCount: 3,
    });
  });

  it('clears unread on markSeen and never moves the marker backwards', async () => {
    await registerSharedRunForComments({ ...target, externalId: 'run-ext-1' });
    await recordPolledCommentRevision(target, {
      externalId: 'run-ext-1',
      commentRevision: 5,
      unreadCount: 3,
    });

    await expect(markSharedRunCommentsSeen(target, 5)).resolves.toMatchObject({
      lastSeenCommentRevision: 5,
      unreadCommentCount: 0,
    });
    // A stale markSeen (e.g. a slow renderer) must not un-see newer comments.
    await expect(markSharedRunCommentsSeen(target, 2)).resolves.toMatchObject({
      lastSeenCommentRevision: 5,
    });
  });

  it('returns null when marking an unregistered run seen', async () => {
    await expect(markSharedRunCommentsSeen(target, 3)).resolves.toBeNull();
  });

  it('unregisters a run and leaves other entries intact', async () => {
    await registerSharedRunForComments({ ...target, externalId: 'run-ext-1' });
    await registerSharedRunForComments({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-2',
      externalId: 'run-ext-2',
    });

    await unregisterSharedRunForComments(target);

    const entries = await readSharedRunCommentEntries();
    expect(entries.map((item) => item.chatId)).toEqual(['chat-2']);
  });

  it('persists a versioned file shape', async () => {
    await registerSharedRunForComments({ ...target, externalId: 'run-ext-1' });

    const parsed: unknown = JSON.parse(await readFile(registryPath, 'utf8'));
    expect(parsed).toMatchObject({ version: 1 });
  });

  it('reports a corrupt file instead of silently disabling every badge', async () => {
    const reporter = jest.fn();
    setSharedRunCommentsCorruptionReporter(reporter);
    try {
      await writeFile(registryPath, 'not json', 'utf8');

      await expect(readSharedRunCommentEntries()).resolves.toEqual([]);
      expect(reporter).toHaveBeenCalledTimes(1);
    } finally {
      setSharedRunCommentsCorruptionReporter(() => {});
    }
  });

  it('stays silent for a missing file, which is the normal cold start', async () => {
    const reporter = jest.fn();
    setSharedRunCommentsCorruptionReporter(reporter);
    try {
      await expect(readSharedRunCommentEntries()).resolves.toEqual([]);
      expect(reporter).not.toHaveBeenCalled();
    } finally {
      setSharedRunCommentsCorruptionReporter(() => {});
    }
  });

  it('does not lose a concurrent markSeen to an interleaved poll write', async () => {
    // The regression: both mutators did read-whole-file → mutate → write-whole
    // -file with no lock, so a poll tick landing between the modal's read and
    // write re-wrote lastSeenCommentRevision from its own stale snapshot and
    // the unread badge reappeared right after the user read the thread.
    await registerSharedRunForComments({ ...target, externalId: 'run-ext-1' });

    await Promise.all([
      markSharedRunCommentsSeen(target, 5),
      recordPolledCommentRevision(target, {
        externalId: 'run-ext-1',
        commentRevision: 5,
        unreadCount: 2,
      }),
    ]);

    const entry = await readSharedRunCommentEntry(target);
    // Whichever ran second, the seen marker must never regress to 0.
    expect(entry?.lastSeenCommentRevision).toBe(5);
  });

  it('keeps concurrent registrations of different runs from clobbering each other', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        registerSharedRunForComments({
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: `chat-${index}`,
          externalId: `run-ext-${index}`,
        }),
      ),
    );

    const entries = await readSharedRunCommentEntries();
    expect(entries).toHaveLength(8);
  });
});

describe('poll window rotation', () => {
  async function registerMany(count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await registerSharedRunForComments({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: `chat-${index}`,
        externalId: `run-ext-${index}`,
      });
    }
  }

  it('returns every entry when the registry fits in one window', async () => {
    await registerMany(3);

    const window = await claimSharedRunCommentPollWindow(20);

    expect(window.map((item) => item.chatId)).toEqual([
      'chat-0',
      'chat-1',
      'chat-2',
    ]);
  });

  it('reaches every registration within ceil(n/limit) ticks', async () => {
    // The regression: a fixed `slice(0, limit)` starved everything past the
    // window forever, because entries are stably ordered, new shares append to
    // the end, and a quiet run never reorders itself. The starved set was
    // therefore the most recently shared runs.
    await registerMany(7);

    const seen = new Set<string>();
    for (let tick = 0; tick < 3; tick += 1) {
      const window = await claimSharedRunCommentPollWindow(3);
      for (const item of window) {
        seen.add(item.chatId);
      }
    }

    expect(seen.size).toBe(7);
  });

  it('wraps the window across the end of the list', async () => {
    await registerMany(5);

    await claimSharedRunCommentPollWindow(4);
    const second = await claimSharedRunCommentPollWindow(4);

    // Cursor was at 4 of 5, so the window wraps: 4, 0, 1, 2.
    expect(second.map((item) => item.chatId)).toEqual([
      'chat-4',
      'chat-0',
      'chat-1',
      'chat-2',
    ]);
  });

  it('survives a restart without re-pinning the window to the head', async () => {
    await registerMany(6);

    await claimSharedRunCommentPollWindow(2);

    // A fresh process reads the cursor back off disk rather than restarting
    // from zero, which is what made an in-memory cursor insufficient.
    const parsed: unknown = JSON.parse(await readFile(registryPath, 'utf8'));
    expect(parsed).toMatchObject({ pollCursor: 2 });

    const next = await claimSharedRunCommentPollWindow(2);
    expect(next.map((item) => item.chatId)).toEqual(['chat-2', 'chat-3']);
  });

  it('returns an empty window for an empty registry', async () => {
    await expect(claimSharedRunCommentPollWindow(20)).resolves.toEqual([]);
  });
});
