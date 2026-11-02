import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  BrowserSwitchJournal,
  performBrowserProfileSwitch,
  type BrowserSwitchAdapter,
} from '../browser/browser-profile-switch';
import type {
  BrowserProfileSwitchRequest,
  BrowserSessionSnapshot,
} from '@canopy/desktop-shared/types/browser';

const source = {
  id: 'browser',
  projectId: 'project',
  worktreeId: 'task',
  url: 'https://example.test/',
  profile: {
    selection: { kind: 'task' },
    resolvedProfileId: 'task-profile',
    storageGeneration: 1,
    runtimeGeneration: 1,
    taskIncarnationId: 'incarnation',
  },
} satisfies Partial<BrowserSessionSnapshot> as BrowserSessionSnapshot & {
  profile: NonNullable<BrowserSessionSnapshot['profile']>;
};
const target = {
  ...source,
  profile: {
    ...source.profile,
    selection: { kind: 'named' as const, profileId: 'named' },
    resolvedProfileId: 'named',
    runtimeGeneration: 2,
  },
};

describe('durable browser profile switch decisions', () => {
  let root: string;
  let journal: BrowserSwitchJournal;
  let request: BrowserProfileSwitchRequest;
  let adapter: jest.Mocked<BrowserSwitchAdapter<object>>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'profile-switch-'));
    journal = new BrowserSwitchJournal(root);
    request = {
      operationId: randomUUID(),
      browserId: source.id,
      expectedRuntimeGeneration: 1,
      selection: { kind: 'named', profileId: 'named' },
      mode: 'replace',
    };
    adapter = {
      allocate: jest.fn(() => Promise.resolve({})),
      discard: jest.fn<
        ReturnType<BrowserSwitchAdapter<object>['discard']>,
        [target: object]
      >(() => Promise.resolve()),
      authorize: jest.fn(() => Promise.resolve(undefined)),
      closeSource: jest.fn(() => Promise.resolve(true)),
      commit: jest.fn(async (_target, save) => {
        await save();
      }),
      openTarget: jest.fn<
        ReturnType<BrowserSwitchAdapter<object>['openTarget']>,
        [target: object]
      >(() => Promise.resolve(target)),
      reloadSource: jest.fn(() => Promise.resolve(source)),
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it('honors a source veto without binding or navigating the hidden destination', async () => {
    jest.mocked(adapter.closeSource).mockResolvedValue(false);
    const record = await journal.begin(request, source, target);
    expect(
      await performBrowserProfileSwitch(journal, record, adapter),
    ).toMatchObject({ status: 'cancelled', browser: source });
    expect(adapter.commit).not.toHaveBeenCalled();
    expect(adapter.openTarget).not.toHaveBeenCalled();
    expect(adapter.discard).toHaveBeenCalledTimes(1);
    expect((await journal.find(request))?.stage).toBe('aborted');
  });
  it('reloads the source after accepted close and binding persistence failure', async () => {
    jest.mocked(adapter.commit).mockRejectedValue(new Error('disk full'));
    const result = await performBrowserProfileSwitch(
      journal,
      await journal.begin(request, source, target),
      adapter,
    );
    expect(result).toMatchObject({
      status: 'source_reloaded_after_failure',
      browser: source,
    });
    expect(adapter.openTarget).not.toHaveBeenCalled();
    expect(adapter.discard).toHaveBeenCalledTimes(1);
    expect((await journal.find(request))?.stage).toBe('aborted');
  });
  it('rechecks revocation after the close wait and cannot load the destination', async () => {
    jest
      .mocked(adapter.authorize)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('revoked'));
    const result = await performBrowserProfileSwitch(
      journal,
      await journal.begin(request, source, target),
      adapter,
    );
    expect(result.status).toBe('source_reloaded_after_failure');
    expect(adapter.commit).not.toHaveBeenCalled();
    expect(adapter.openTarget).not.toHaveBeenCalled();
  });
  it('keeps a committed target decision when target loading fails', async () => {
    jest.mocked(adapter.openTarget).mockRejectedValue(new Error('load failed'));
    await expect(
      performBrowserProfileSwitch(
        journal,
        await journal.begin(request, source, target),
        adapter,
      ),
    ).rejects.toThrow('load failed');
    expect(adapter.reloadSource).not.toHaveBeenCalled();
    expect((await journal.pending('project', 'task'))[0].stage).toBe(
      'target_committed',
    );
  });
  it.each(['prepared', 'close_intent', 'target_committed'] as const)(
    'retains the %s crash decision without guessing from the native page',
    async (stage) => {
      await journal.update(await journal.begin(request, source, target), stage);
      expect(
        (await new BrowserSwitchJournal(root).pending('project', 'task'))[0],
      ).toMatchObject({ stage, source, target });
    },
  );
  it('replays equivalent payloads regardless of object key insertion order', async () => {
    await journal.begin(request, source, target);
    const reordered = {
      mode: request.mode,
      selection: { profileId: 'named', kind: 'named' as const },
      expectedRuntimeGeneration: 1,
      browserId: 'browser',
      operationId: request.operationId,
    };
    expect(await journal.find(reordered)).toMatchObject({
      operationId: request.operationId,
    });
  });
  it('compacts expired results without allowing an old operation ID to execute again', async () => {
    const initial = await journal.begin(request, source, target);
    await journal.update(
      { ...initial, createdAt: Date.now() - 8 * 86400_000 },
      'complete',
      { status: 'complete', browser: target },
    );
    await expect(journal.find(request)).rejects.toMatchObject({
      code: 'operation_expired',
    });
    const saved = JSON.parse(
      await readFile(join(root, `${request.operationId}.json`), 'utf8'),
    ) as Record<string, unknown>;
    expect(saved.stage).toBe('expired');
    expect(saved).not.toHaveProperty('source');
    expect(await journal.pending('project', 'task')).toEqual([]);
    await expect(journal.begin(request, source, target)).rejects.toMatchObject({
      code: 'operation_expired',
    });
  });
  it('new-tab mode preserves the source and operation replay rejects mismatched input', async () => {
    request.mode = 'new-tab';
    const result = await performBrowserProfileSwitch(
      journal,
      await journal.begin(request, source, target),
      adapter,
    );
    expect(result.status).toBe('complete');
    expect(adapter.closeSource).not.toHaveBeenCalled();
    expect((await journal.find(request))?.result).toEqual(result);
    await expect(
      journal.find({ ...request, mode: 'replace' }),
    ).rejects.toMatchObject({ code: 'operation_conflict' });
  });
});
