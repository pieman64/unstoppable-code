/**
 * Group commit through the chat state repository
 * by default (phase 11): admission overlaps the journal
 * sync in flight, later commits of the scope share one append and one sync,
 * and nothing is acknowledged or published before its batch is durable.
 *
 * - Batching: fewer journal syncs than commits under load; a lone commit and
 *   sequential commits each take their own sync.
 * - Ordering: across several scopes with varied arrival orders, every scope
 *   publishes strictly in revision order, each revision only once durable.
 * - Exclusion: reads, flush and demotion wait for an open batch.
 * - A failed batch rejects its commits, publishes none and the scope
 *   recovers from disk; mutation-id dedup and receipts hold across a batch.
 *   A transaction being built while the batch fails leaves no artifact
 *   behind.
 * - Diagnostics keep their meaning: one write and one sync per batch, one
 *   commit, one mutation count and one rewrite report per commit, each only
 *   after its batch is durable.
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatCoreMutation } from '@canopy/desktop-shared/types';
import { snapshotWorkCounters } from '@canopy/desktop-shared/node/work-counters';
import { readDeltaJournal } from '../lib/chat-delta-journal/replay';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import { VisualStagingStoreImpl } from '../lib/visual-staging';
import type {
  ProviderVisualAdmission,
  PromotedVisual,
  StageVisualDocument,
} from '../lib/chat-visual-contracts';
import type { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import type { ChatStateCommit } from '../services/chat-state-contracts';
import {
  setChatTranscriptRewriteDiagnosticsForTests,
  type ChatTranscriptFullRewriteDiagnostic,
} from '../services/chat-transcript-rewrite-diagnostics';
import {
  createV2Scope,
  seededRandom,
} from './helpers/chat-delta-journal-harness';
import {
  drainOpenRepositories,
  manifestVersion,
  measureWork,
  repositoryAt,
  storeAt,
  streaming,
  text,
  toolResult,
  upsert,
} from './helpers/chat-delta-journal-scope';
import {
  eventually,
  gateJournalSyncs,
  settlesWithin,
  type JournalSyncGate,
} from './helpers/chat-delta-journal-sync-gate';

const SCOPE = { projectId: 'workspace', worktreeId: 'scope' };

async function seed(root: string, scopeId = 'scope'): Promise<void> {
  await createV2Scope(root, scopeId, [
    {
      id: 'chat',
      messages: [text('m0', 'hello', 'user'), text('m1', 'answer')],
    },
  ]);
}

async function journalRevision(root: string, scopeId: string): Promise<number> {
  const store = storeAt(root, scopeId);
  return (await readDeltaJournal(store.directory, scopeId)).lastRevision;
}

function visualDocument(): StageVisualDocument {
  return {
    visualId: 'vis_123e4567-e89b-12d3-a456-426614174010',
    html: '<!doctype html><html><body>grouped</body></html>',
    title: 'Grouped visual',
    maxHeight: 400,
  };
}

function promotedVisual(document: StageVisualDocument): PromotedVisual {
  const digest = '0'.repeat(64);
  return {
    chatId: 'chat',
    visualId: document.visualId,
    reference: {
      version: 1,
      visualId: document.visualId,
      artifactId: `sha256-v1-${digest}`,
      byteLength: 1,
      sha256: digest,
      mediaType: 'text/html',
      title: document.title,
      maxHeight: document.maxHeight,
    },
  };
}

function isBackendAdmissionImplementation(
  value: unknown,
): value is ChatStateV2Backend['admit'] {
  return typeof value === 'function';
}

function isVisualRemoveImplementation(
  value: unknown,
): value is VisualStagingStoreImpl['remove'] {
  return typeof value === 'function';
}

function visualRemoveImplementation(): VisualStagingStoreImpl['remove'] {
  const method: unknown = Reflect.get(
    VisualStagingStoreImpl.prototype,
    'remove',
  );
  if (!isVisualRemoveImplementation(method))
    throw new Error('Visual removal method is unavailable');
  return method;
}

function forceNextVisualPromotion(document: StageVisualDocument): void {
  const admit = jest.spyOn(ChatStateV2Backend.prototype, 'admit');
  const candidate: unknown = admit.getMockImplementation();
  if (!isBackendAdmissionImplementation(candidate))
    throw new Error('Backend admission spy is missing');
  const originalAdmit = candidate;
  let pending = true;
  admit.mockImplementation(async function (
    this: ChatStateV2Backend,
    build: Parameters<ChatStateV2Backend['admit']>[0],
    options: Parameters<ChatStateV2Backend['admit']>[1],
    admission: ProviderVisualAdmission | undefined,
  ) {
    const result = await originalAdmit.call(this, build, options, admission);
    if (!pending || !result.commit.applied) return result;
    pending = false;
    return {
      ...result,
      commit: {
        ...result.commit,
        promotedVisuals: [promotedVisual(document)],
      },
    };
  });
}

/** Every file under `directory`, as sorted relative paths. */
async function filesUnder(directory: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory())
      files.push(...(await filesUnder(join(directory, entry.name), relative)));
    else files.push(relative);
  }
  return files.sort();
}

describe('delta journal group commit through the repository', () => {
  let root: string;
  let syncs: JournalSyncGate;
  /** Admissions the backend completed (the commit is in memory, queued). */
  let admitted: number;
  let published: Array<{ scope: string; revision: number; syncs: number }>;
  jest.setTimeout(180_000);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-delta-journal-group-repo-'));
    syncs = gateJournalSyncs();
    admitted = 0;
    published = [];
    // Called below with the backend it was taken from.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const admit = ChatStateV2Backend.prototype.admit;
    jest
      .spyOn(ChatStateV2Backend.prototype, 'admit')
      .mockImplementation(async function (
        this: ChatStateV2Backend,
        build,
        options,
      ) {
        const admission = await admit.call(this, build, options);
        admitted += 1;
        return admission;
      });
  });

  afterEach(async () => {
    syncs.release();
    jest.restoreAllMocks();
    await drainOpenRepositories();
    setChatTranscriptRewriteDiagnosticsForTests();
    await rm(root, { recursive: true, force: true });
  });

  function repository(): ChatStateV2Repository {
    return repositoryAt(root, {
      onCommit: (commit: ChatStateCommit): void => {
        published.push({
          scope: commit.worktreeId,
          revision: commit.revision,
          syncs: syncs.completedFor(commit.worktreeId),
        });
      },
    });
  }

  function commit(
    target: ChatStateV2Repository,
    mutationId: string,
    mutations: ChatCoreMutation[],
    options: { scope?: typeof SCOPE; commandId?: string } = {},
  ): Promise<ChatStateCommit> {
    return target.transact(options.scope ?? SCOPE, mutations, {
      source: 'provider',
      mutationId,
      chatIds: ['chat'],
      ...(options.commandId
        ? {
            commandResult: {
              commandId: options.commandId,
              outcome: 'applied',
            },
          }
        : {}),
    });
  }

  /** A promoted scope with a turn in progress, so later rows stay journaled. */
  async function startTurn(
    target: ChatStateV2Repository,
    scope = SCOPE,
  ): Promise<number> {
    const started = await commit(
      target,
      `${scope.worktreeId}-turn-start`,
      [streaming('chat', 'p1'), upsert('chat', text('p1', 'go', 'user'))],
      { scope },
    );
    expect(started.applied).toBe(true);
    return started.revision;
  }

  function stream(
    target: ChatStateV2Repository,
    id: string,
    scope = SCOPE,
  ): Promise<ChatStateCommit> {
    return commit(
      target,
      `${scope.worktreeId}-${id}`,
      [upsert('chat', text(`row-${id}`, `streamed ${id}`))],
      { scope },
    );
  }

  it('shares one append and one sync among commits that arrive during a sync', async () => {
    await seed(root);
    const target = repository();
    const base = await startTurn(target);
    published = [];
    const admittedBefore = admitted;
    const work = measureWork();
    const syncsBefore = syncs.completed();
    syncs.hold();
    const settled: number[] = [];
    const commits = ['a', 'b', 'c', 'd', 'e'].map((id) =>
      stream(target, id).then((result) => {
        settled.push(result.revision);
        return result;
      }),
    );
    // Every commit is admitted while the first one's sync is still held.
    await eventually(
      () => admitted - admittedBefore === 5 && syncs.waiting() === 1,
      'five commits admitted during one journal sync',
    );
    // A read waits for the open batch instead of seeing undurable state.
    const read = target.getState(SCOPE, { chatIds: ['chat'] });
    expect(await settlesWithin(read, 50)).toBe(false);
    expect(settled).toEqual([]);
    expect(published).toEqual([]);
    expect(await journalRevision(root, 'scope')).toBe(base + 1);
    syncs.release();
    const results = await Promise.all(commits);
    const delta = work();
    // Five commits: the leader's append and sync, and one for the other four.
    expect(delta.commits).toBe(5);
    expect(delta.journalSyncs).toBe(2);
    expect(syncs.completed() - syncsBefore).toBe(2);
    expect(delta.checkpoints).toBe(0);
    // Acknowledged and published strictly in revision order, each only once
    // its own batch was synced.
    const revisions = [1, 2, 3, 4, 5].map((step) => base + step);
    expect(results.map((result) => result.revision)).toEqual(revisions);
    expect(settled).toEqual(revisions);
    expect(published).toEqual([
      { scope: 'scope', revision: base + 1, syncs: syncsBefore + 1 },
      ...[2, 3, 4, 5].map((step) => ({
        scope: 'scope',
        revision: base + step,
        syncs: syncsBefore + 2,
      })),
    ]);
    // The read ran after the batch and sees every row.
    const state = await read;
    expect(state.tabsFile.revision).toBe(base + 5);
    expect(
      state.tabsFile.tabs[0].messages
        .map((message) => message.id)
        .filter((id) => id.startsWith('row-')),
    ).toEqual(['row-a', 'row-b', 'row-c', 'row-d', 'row-e']);
  });

  it('gives a lone commit and sequential commits their own sync', async () => {
    await seed(root);
    const target = repository();
    await startTurn(target);
    const work = measureWork();
    for (const id of ['a', 'b', 'c']) await stream(target, id);
    const delta = work();
    // Nothing is concurrent, so nothing batches and nothing waits.
    expect(delta.commits).toBe(3);
    expect(delta.journalSyncs).toBe(3);
  });

  it('publishes every scope strictly in revision order under concurrent load', async () => {
    const scopes = ['alpha', 'beta', 'gamma'].map((worktreeId) => ({
      projectId: 'workspace',
      worktreeId,
    }));
    for (const scope of scopes) await seed(root, scope.worktreeId);

    const durableAtPublication: string[] = [];
    const target = repositoryAt(root, {
      onCommit: async (commit: ChatStateCommit): Promise<void> => {
        published.push({
          scope: commit.worktreeId,
          revision: commit.revision,
          syncs: syncs.completedFor(commit.worktreeId),
        });
        // Nothing is visible before the journal holds it.
        if ((await journalRevision(root, commit.worktreeId)) < commit.revision)
          durableAtPublication.push(
            `${commit.worktreeId}@${commit.revision} published before it was durable`,
          );
      },
    });
    const bases = new Map<string, number>();
    for (const scope of scopes)
      bases.set(scope.worktreeId, await startTurn(target, scope));
    published = [];
    const random = seededRandom(1111);
    // Syncs of different lengths, so batches of every size form.
    syncs.delayEach(() => Math.floor(random() * 4));
    const perScope = 24;
    const settled = new Map<string, number[]>();
    const work = measureWork();
    // Batching depends on how long a sync takes against an admission, so the
    // first syncs are held until seven commits are admitted. With three
    // scopes, one scope then has its leader in a sync and at least two
    // commits queued behind it, which share the next sync, however fast this
    // host syncs. Released, the syncs above form batches of every size.
    const heldAdmissions = 7;
    const admittedBefore = admitted;
    syncs.hold();
    const pending: Array<Promise<unknown>> = [];
    const remaining = new Map(
      scopes.map((scope) => [scope.worktreeId, perScope]),
    );
    let ordinal = 0;
    while (Array.from(remaining.values()).some((left) => left > 0)) {
      // A varied arrival order: any scope with commits left goes next.
      const candidates = scopes.filter(
        (scope) => (remaining.get(scope.worktreeId) ?? 0) > 0,
      );
      const scope = candidates[Math.floor(random() * candidates.length)];
      remaining.set(
        scope.worktreeId,
        (remaining.get(scope.worktreeId) ?? 0) - 1,
      );
      ordinal += 1;
      pending.push(
        stream(target, `c${ordinal}`, scope).then((result) => {
          const list = settled.get(scope.worktreeId) ?? [];
          list.push(result.revision);
          settled.set(scope.worktreeId, list);
        }),
      );
      if (ordinal === heldAdmissions) {
        await eventually(
          () => admitted - admittedBefore >= heldAdmissions,
          'seven commits admitted while the first syncs are held',
        );
        syncs.release();
      }
      // Bursts and gaps.
      if (random() < 0.3)
        await new Promise((resolve) =>
          setTimeout(resolve, Math.floor(random() * 3)),
        );
    }
    await Promise.all(pending);
    const delta = work();
    expect(durableAtPublication).toEqual([]);
    for (const scope of scopes) {
      const base = bases.get(scope.worktreeId) ?? 0;
      const expected = Array.from(
        { length: perScope },
        (_, index): number => base + index + 1,
      );
      // Published and acknowledged in revision order, without a gap.
      expect(
        published
          .filter((entry) => entry.scope === scope.worktreeId)
          .map((entry) => entry.revision),
      ).toEqual(expected);
      expect(settled.get(scope.worktreeId)).toEqual(expected);
      expect(await journalRevision(root, scope.worktreeId)).toBe(
        base + perScope,
      );
    }
    // Under load, syncs are amortized across commits: at least the batch
    // queued while the first syncs were held shared one.
    expect(delta.commits).toBe(perScope * scopes.length);
    expect(delta.journalSyncs).toBeLessThan(delta.commits);
    // A restart replays every commit of every scope.
    await target.drainAll();
    const reopened = repository();
    for (const scope of scopes) {
      const state = await reopened.getState(scope, { chatIds: ['chat'] });
      expect(state.tabsFile.revision).toBe(
        (bases.get(scope.worktreeId) ?? 0) + perScope,
      );
      expect(
        state.tabsFile.tabs[0].messages.filter((message) =>
          message.id.startsWith('row-'),
        ),
      ).toHaveLength(perScope);
    }
  });

  it('makes flush wait for an open batch', async () => {
    await seed(root);
    const target = repository();
    const base = await startTurn(target);
    const admittedBefore = admitted;
    syncs.hold();
    const commits = ['a', 'b', 'c'].map((id) => stream(target, id));
    await eventually(
      () => admitted - admittedBefore === 3 && syncs.waiting() === 1,
      'three commits admitted during one journal sync',
    );
    const flush = target.flushScope(SCOPE);
    expect(await settlesWithin(flush, 50)).toBe(false);
    expect(await manifestVersion(storeAt(root, 'scope'))).toBe(3);
    syncs.release();
    const results = await Promise.all(commits);
    expect(results.map((result) => result.revision)).toEqual([
      base + 1,
      base + 2,
      base + 3,
    ]);
    await flush;
    // Flush checkpoints every commit and preserves journal authority.
    expect(await manifestVersion(storeAt(root, 'scope'))).toBe(3);
    const state = await target.getState(SCOPE, { chatIds: ['chat'] });
    expect(state.tabsFile.revision).toBe(base + 3);
    expect(
      state.tabsFile.tabs[0].messages
        .map((message) => message.id)
        .filter((id) => id.startsWith('row-')),
    ).toEqual(['row-a', 'row-b', 'row-c']);
  });

  it('rejects the commits of a failed batch, publishes none and recovers from disk', async () => {
    await seed(root);
    const target = repository();
    const base = await startTurn(target);
    published = [];
    const admittedBefore = admitted;
    syncs.hold();
    // The second journal sync from now fails: the batch behind the leader.
    syncs.failSync(2, Object.assign(new Error('EIO'), { code: 'EIO' }));
    const leader = stream(target, 'leader');
    const batch = [stream(target, 'x'), stream(target, 'y')];
    const outcomes = batch.map((entry) =>
      entry.then(
        () => 'resolved',
        (error: unknown) =>
          error instanceof Error ? error.message : 'rejected',
      ),
    );
    await eventually(
      () => admitted - admittedBefore === 3 && syncs.waiting() === 1,
      'the batch is admitted behind the leader',
    );
    syncs.release();
    expect((await leader).revision).toBe(base + 1);
    expect(await Promise.all(outcomes)).toEqual(['EIO', 'EIO']);
    // Only the leader was acknowledged and published.
    expect(published.map((entry) => entry.revision)).toEqual([base + 1]);
    // The scope reloads from the bytes on disk. The failed batch was
    // written before its sync failed, so its records replay, as records that
    // were synced but never acknowledged do; a retry does not apply twice.
    const state = await target.getState(SCOPE, { chatIds: ['chat'] });
    expect(state.tabsFile.revision).toBe(base + 3);
    const retry = await stream(target, 'x');
    expect(retry.applied).toBe(false);
    const next = await stream(target, 'after');
    expect(next).toMatchObject({ applied: true, revision: base + 4 });
    expect(published.map((entry) => entry.revision)).toEqual([
      base + 1,
      base + 4,
    ]);
  });

  it('leaves no artifact behind when a batch fails while the next transaction is being built', async () => {
    await seed(root);
    const target = repository();
    const base = await startTurn(target);
    const directory = storeAt(root, 'scope').directory;
    const toolOutputs = async (): Promise<string[]> =>
      (await filesUnder(directory)).filter((name) =>
        name.includes('tool-output'),
      );
    const before = await toolOutputs();
    const admittedBefore = admitted;
    syncs.hold();
    syncs.failSync(1, Object.assign(new Error('EIO'), { code: 'EIO' }));
    const leader = stream(target, 'leader').then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : ''),
    );
    await eventually(
      () => admitted - admittedBefore === 1 && syncs.waiting() === 1,
      'the leader is in flight',
    );
    // The next transaction is admitted beside the open batch. Its builder
    // is still running when the batch fails; it then returns a tool output
    // large enough to be externalized.
    let entered = (): void => undefined;
    const building = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finishBuild = (): void => undefined;
    const mayFinish = new Promise<void>((resolve) => {
      finishBuild = resolve;
    });
    const build = async (): Promise<ChatCoreMutation[]> => {
      entered();
      await mayFinish;
      return [upsert('chat', toolResult('row-tool', 'T'.repeat(600_000)))];
    };
    const options = {
      source: 'provider' as const,
      mutationId: 'tool',
      chatIds: ['chat'],
    };
    const next = target.transactWith(SCOPE, build, options).then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : ''),
    );
    await building;
    syncs.release();
    expect(await leader).toBe('EIO');
    finishBuild();
    expect(await next).toBe('Delta journal writer must be reopened');
    // The record was never queued, so it cannot be durable and nothing
    // references the file its transaction externalized.
    expect(await toolOutputs()).toEqual(before);
    // The scope recovers, and the same transaction then commits with its
    // artifact in place.
    const state = await target.getState(SCOPE, { chatIds: ['chat'] });
    expect(state.tabsFile.revision).toBe(base + 1);
    const retried = await target.transactWith(SCOPE, build, options);
    expect(retried).toMatchObject({ applied: true, revision: base + 2 });
    expect((await toolOutputs()).length).toBe(before.length + 1);
  });

  it('applies a retried mutation once and keeps receipts across a batch', async () => {
    await seed(root);
    const target = repository();
    const base = await startTurn(target);
    const admittedBefore = admitted;
    syncs.hold();
    const leader = stream(target, 'leader');
    const original = commit(
      target,
      'with-receipt',
      [upsert('chat', text('row-r', 'with a receipt'))],
      { commandId: 'command-1' },
    );
    // The same mutation again, while the original waits for its batch.
    let retrySettled = false;
    const retry = commit(
      target,
      'with-receipt',
      [upsert('chat', text('row-r', 'with a receipt'))],
      { commandId: 'command-1' },
    ).then((result) => {
      retrySettled = true;
      return result;
    });
    await eventually(
      () => admitted - admittedBefore === 3 && syncs.waiting() === 1,
      'the retry is admitted behind the original',
    );
    // Not acknowledged before the commit it repeats is durable.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(retrySettled).toBe(false);
    syncs.release();
    expect((await leader).revision).toBe(base + 1);
    expect(await original).toMatchObject({
      applied: true,
      revision: base + 2,
    });
    expect(await retry).toMatchObject({ applied: false, revision: base + 2 });
    expect(await target.getReceipt(SCOPE, 'command-1')).toMatchObject({
      commandId: 'command-1',
      outcome: 'applied',
      revision: base + 2,
    });
    // After a restart without a checkpoint, the receipt and the dedup hold.
    await target.drainAll();
    const reopened = repository();
    expect(await reopened.getReceipt(SCOPE, 'command-1')).toMatchObject({
      revision: base + 2,
    });
    expect(await reopened.hasMutation(SCOPE, 'with-receipt')).toBe(true);
  });

  it('counts a batch as one write and one sync and each commit once, after it is durable', async () => {
    await seed(root);
    const target = repository();
    await startTurn(target);
    const reports: Array<{
      record: ChatTranscriptFullRewriteDiagnostic;
      syncs: number;
    }> = [];
    setChatTranscriptRewriteDiagnosticsForTests({
      sink: (record): void => {
        reports.push({ record, syncs: syncs.completed() });
      },
    });
    const admittedBefore = admitted;
    const syncsBefore = syncs.completed();
    const before = snapshotWorkCounters().chatStorage;
    syncs.hold();
    const leader = stream(target, 'leader');
    const follower = stream(target, 'follower');
    await eventually(
      () => admitted - admittedBefore === 2 && syncs.waiting() === 1,
      'a follower is admitted behind the leader',
    );
    // A rewrite of a committed row joins the open batch, then checkpoints.
    const rewrite = commit(target, 'rewrite', [
      upsert('chat', text('m1', 'answer, edited after it was committed')),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Nothing is counted or reported while the batch is not durable.
    const during = snapshotWorkCounters().chatStorage;
    expect((during.commits ?? 0) - (before.commits ?? 0)).toBe(0);
    expect((during.mutations ?? 0) - (before.mutations ?? 0)).toBe(0);
    expect(reports).toEqual([]);
    syncs.release();
    await Promise.all([leader, follower, rewrite]);
    const after = snapshotWorkCounters().chatStorage;
    const delta = (key: string): number =>
      (after[key] ?? 0) - (before[key] ?? 0);
    // Three commits, one mutation each.
    expect(delta('commits')).toBe(3);
    expect(delta('mutations')).toBe(3);
    // The rewrite is reported exactly once, only after its batch (the
    // second journal sync) was durable.
    expect(reports).toHaveLength(1);
    expect(reports[0].record).toMatchObject({
      kind: 'chat_transcript_full_rewrite',
      reason: 'patch',
      chatTranscriptRewritePatchedRows: 1,
    });
    expect(reports[0].syncs).toBeGreaterThanOrEqual(syncsBefore + 2);
    // Commits published in order: the two streamed rows, then the rewrite.
    const tail = published.slice(-3).map((entry) => entry.revision);
    expect(tail).toEqual([tail[0], tail[0] + 1, tail[0] + 2]);
  });

  it('cleans promoted staging only after the group sync and publication', async () => {
    await seed(root);
    const target = repository();
    await target.getState(SCOPE);
    await startTurn(target);
    const document = visualDocument();
    await target.stageVisual(SCOPE, { chatId: 'chat' }, document);
    forceNextVisualPromotion(document);
    const publishedBefore = published.length;
    const syncsBefore = syncs.completedFor('scope');
    let cleanupStarted: () => void = () => undefined;
    const cleanup = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    const originalRemove = visualRemoveImplementation();
    jest
      .spyOn(VisualStagingStoreImpl.prototype, 'remove')
      .mockImplementation(async function (
        this: VisualStagingStoreImpl,
        visualId,
      ) {
        expect(syncs.completedFor('scope')).toBe(syncsBefore + 1);
        expect(published.length).toBeGreaterThan(publishedBefore);
        cleanupStarted();
        await originalRemove.call(this, visualId);
      });
    syncs.hold();
    const transaction = target.transactProviderEventWith(
      SCOPE,
      () => [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat',
          patch: { unread: true },
        },
      ],
      { source: 'provider', mutationId: 'visual-promotion', chatIds: ['chat'] },
      { resolveToolKey: () => undefined },
    );
    await eventually(
      () => syncs.waiting() === 1,
      'visual group sync enters wait',
    );
    expect(published).toHaveLength(publishedBefore);
    syncs.release();
    const commit = await transaction;
    await cleanup;
    expect(syncs.completedFor('scope')).toBe(syncsBefore + 1);
    expect(published.slice(publishedBefore)).toMatchObject([
      { revision: commit.revision, syncs: syncsBefore + 1 },
    ]);
    await target.drainAll();
  });

  it('leaves staged visuals after a failed group batch', async () => {
    await seed(root);
    const target = repository();
    await target.getState(SCOPE);
    await startTurn(target);
    const directory = storeAt(root, 'scope').directory;
    const document = visualDocument();
    await target.stageVisual(SCOPE, { chatId: 'chat' }, document);
    forceNextVisualPromotion(document);
    const remove = jest.spyOn(VisualStagingStoreImpl.prototype, 'remove');
    const publishedBefore = published.length;
    syncs.hold();
    syncs.failSync(1, Object.assign(new Error('EIO'), { code: 'EIO' }));
    const transaction = target.transactProviderEventWith(
      SCOPE,
      () => [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat',
          patch: { unread: true },
        },
      ],
      {
        source: 'provider',
        mutationId: 'failed-visual-promotion',
        chatIds: ['chat'],
      },
      { resolveToolKey: () => undefined },
    );
    await eventually(
      () => syncs.waiting() === 1,
      'failed visual batch enters wait',
    );
    syncs.release();
    await expect(transaction).rejects.toThrow();
    expect(published).toHaveLength(publishedBefore);
    expect(remove).not.toHaveBeenCalled();
    await expect(
      readFile(
        join(directory, 'visual-staging', `${document.visualId}.html`),
        'utf8',
      ),
    ).resolves.toBe(document.html);
  });
});
