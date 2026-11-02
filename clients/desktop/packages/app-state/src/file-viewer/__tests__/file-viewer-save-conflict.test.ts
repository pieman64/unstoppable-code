import {
  FileSaveConflictError,
  type CanopyCapabilities,
  type CanopyClient,
  type CommandMap,
  type CommandName,
  type QueryMap,
  type QueryName,
  type Unsubscribe,
} from '@canopy/app-core';
import type {
  PortalFilePreview,
  PortalFileReadPayload,
} from '@canopy/protocol/portal';
import {
  createFileViewerStore,
  fileViewerKey,
} from '../create-file-viewer-store';
import { threeWayMerge } from '../three-way-merge';
import { CLIENT_STORE_DISPOSE } from '../../client-store-lifecycle';

const CAPS: CanopyCapabilities = {
  localExecution: true,
  terminalPty: true,
  fileSystemAccess: 'read-write',
  voice: false,
  settingsScope: 'full',
  pipelines: 'execute',
  routing: 'in-memory',
  overviewNotifications: true,
};

const REQUEST: PortalFileReadPayload = {
  projectId: 'p1',
  worktreeId: 'wt1',
  fileRootLocalId: 'root',
  relativePath: 'notes.md',
};
const KEY = fileViewerKey(REQUEST);

const BASE = 'one\ntwo\nthree\nfour\nfive\n';
const AGENT = 'one\ntwo\nthree\nfour\nFIVE\n';

function preview(content: string, version: string): PortalFilePreview {
  // Distinct versions carry distinct mtimes so conditional writes are visible.
  const seconds = Number(version.replace(/\D/g, '')) || 0;
  return {
    workspaceLocalId: 'p1',
    worktreeLocalId: 'wt1',
    path: REQUEST.relativePath,
    content,
    size: content.length,
    version,
    truncated: false,
    modifiedAt: new Date(Date.UTC(2026, 9, 26, 0, 0, seconds)).toISOString(),
  };
}

const mtime = (version: string): number =>
  Date.parse(preview('', version).modifiedAt ?? '');

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve: (value: T) => void = (): void => {};
  let reject: (error: Error) => void = (): void => {};
  const promise = new Promise<T>((res, rej): void => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type SaveArgs = CommandMap['file.save']['args'];

interface Disk {
  readonly client: CanopyClient;
  readonly saves: SaveArgs[];
  reads(): number;
  current(): PortalFilePreview;
  externalWrite(content: string): PortalFilePreview;
  setRead(handler: (() => Promise<PortalFilePreview>) | null): void;
  setSave(
    handler: ((args: SaveArgs) => Promise<PortalFilePreview>) | null,
  ): void;
}

/**
 * A disk with a conditional-write contract: a save whose expected mtime is
 * not the current version's is refused with the typed conflict.
 */
function createDisk(initial: PortalFilePreview): Disk {
  let current = initial;
  let counter = Number(initial.version.replace(/\D/g, ''));
  const saves: SaveArgs[] = [];
  let reads = 0;
  let readOverride: (() => Promise<PortalFilePreview>) | null = null;
  let saveOverride: ((args: SaveArgs) => Promise<PortalFilePreview>) | null =
    null;
  const write = (content: string): PortalFilePreview => {
    counter += 1;
    current = preview(content, `v${counter}`);
    return current;
  };
  const client: CanopyClient = {
    capabilities: CAPS,
    query<K extends QueryName>(name: K): Promise<QueryMap[K]['result']> {
      if (name !== 'file.read') {
        return Promise.reject(new Error(`unexpected query ${name}`));
      }
      reads += 1;
      const result = readOverride ? readOverride() : Promise.resolve(current);
      return result;
    },
    command<K extends CommandName>(
      name: K,
      args: CommandMap[K]['args'],
    ): Promise<CommandMap[K]['result']> {
      if (name !== 'file.save') {
        return Promise.reject(new Error(`unexpected command ${name}`));
      }
      const saveArgs = args as SaveArgs;
      saves.push(saveArgs);
      if (saveOverride) {
        return saveOverride(saveArgs);
      }
      if (saveArgs.expectedModifiedAtMs !== mtime(current.version)) {
        return Promise.reject(new FileSaveConflictError());
      }
      return Promise.resolve(write(saveArgs.content));
    },
    subscribe(): Unsubscribe {
      return (): void => {};
    },
  };
  return {
    client,
    saves,
    reads: (): number => reads,
    current: (): PortalFilePreview => current,
    externalWrite: write,
    setRead(handler: (() => Promise<PortalFilePreview>) | null): void {
      readOverride = handler;
    },
    setSave(
      handler: ((args: SaveArgs) => Promise<PortalFilePreview>) | null,
    ): void {
      saveOverride = handler;
    },
  };
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

/**
 * Open BASE, edit it, then let the agent write AGENT. Edits that combine with
 * AGENT raise no notice; overlapping edits raise one and choose Keep.
 */
async function keepThenEdit(
  edited: string,
  notify = true,
): Promise<{
  disk: Disk;
  store: ReturnType<typeof createFileViewerStore>;
}> {
  const disk = createDisk(preview(BASE, 'v1'));
  const store = createFileViewerStore(disk.client);
  await store.getState().openFile(REQUEST);
  store.getState().updateContent(KEY, edited);
  disk.externalWrite(AGENT);
  if (!notify) return { disk, store };
  store.getState().markFileChanged(KEY, 'agent-edit');
  await flush();
  const change = store.getState().files[KEY]?.externalChange;
  if (threeWayMerge(BASE, edited, AGENT).kind === 'clean') {
    expect(change).toBeNull();
  } else {
    expect(change?.source).toBe('agent-edit');
    store.getState().dismissExternalChange(KEY);
  }
  return { disk, store };
}

describe('file viewer save conflicts', () => {
  describe.each([
    'initial-save',
    'merge-read',
    'merged-write',
    'overwrite',
    'reload',
  ] as const)('invalidating during %s', (stage) => {
    it.each(['close', 'dispose', 'reopen'] as const)(
      'ignores late completion after %s without follow-up writes',
      async (invalidation) => {
        const disjoint = 'ONE\ntwo\nthree\nfour\nfive\n';
        const { disk, store } = await keepThenEdit(
          stage === 'overwrite' || stage === 'reload'
            ? `${BASE}overlap\n`
            : disjoint,
        );
        const gate = deferred<PortalFilePreview>();
        if (stage === 'overwrite' || stage === 'reload') {
          // Force an overlap against the last line before starting resolution.
          store.getState().updateContent(KEY, 'one\ntwo\nthree\nfour\nfive!\n');
          await store.getState().saveFile(KEY);
        }
        if (stage === 'merge-read' || stage === 'reload') {
          disk.setRead(() => gate.promise);
        } else {
          disk.setSave((args) =>
            stage === 'merged-write' && args.expectedVersion === 'v1'
              ? Promise.reject(new FileSaveConflictError())
              : gate.promise,
          );
        }
        const pending =
          stage === 'overwrite'
            ? store.getState().overwriteWithEdits(KEY)
            : stage === 'reload'
              ? store.getState().reloadFromDisk(KEY)
              : store.getState().saveFile(KEY);
        await flush();
        const saves = disk.saves.length;
        if (invalidation === 'dispose') {
          store[CLIENT_STORE_DISPOSE]?.();
        } else {
          store.getState().closeFile(KEY);
          if (invalidation === 'reopen') {
            disk.setRead(null);
            await store.getState().openFile(REQUEST);
            store.getState().updateContent(KEY, 'replacement draft');
          }
        }
        const before = store.getState().files[KEY];
        if (stage === 'initial-save') gate.reject(new FileSaveConflictError());
        else gate.resolve(preview('late completion', 'v99'));
        await pending;
        await flush();
        expect(disk.saves).toHaveLength(saves);
        expect(store.getState().files[KEY]).toBe(before);
      },
    );
  });

  it('does not offer oversized latest content as an overwrite baseline', async () => {
    const { disk, store } = await keepThenEdit(
      'one\ntwo\nthree\nfour\nfive!\n',
    );
    disk.externalWrite('x'.repeat(2 * 1024 * 1024 + 1));
    await expect(store.getState().saveFile(KEY)).resolves.toBe(false);
    expect(store.getState().files[KEY]?.saveConflict).toMatchObject({
      reason: 'merge-skipped',
      latest: null,
    });
    await expect(store.getState().overwriteWithEdits(KEY)).resolves.toBe(false);
    expect(disk.saves).toHaveLength(1);
    expect(store.getState().files[KEY]?.dirty).toBe(true);
  });

  it('keeps Discard recovery actionable until a fresh complete read succeeds', async () => {
    const { disk, store } = await keepThenEdit(
      'one\ntwo\nthree\nfour\nfive!\n',
    );
    await store.getState().saveFile(KEY);
    const before = store.getState().files[KEY];
    disk.setRead(() => Promise.reject(new Error('unavailable')));
    store.getState().discardEdits(KEY);
    await flush();
    expect(store.getState().files[KEY]).toMatchObject({
      content: before.content,
      preview: before.preview,
      dirty: true,
      saveConflict: { resolving: null, error: { kind: 'latest-unavailable' } },
    });
    disk.setRead(() => Promise.resolve({ ...disk.current(), truncated: true }));
    await expect(store.getState().reloadFromDisk(KEY)).resolves.toBe(false);
    expect(store.getState().files[KEY]?.content).toBe(before.content);
    disk.setRead(null);
    store.getState().discardEdits(KEY);
    await flush();
    expect(store.getState().files[KEY]).toMatchObject({
      content: AGENT,
      dirty: false,
      saveConflict: null,
    });
  });

  it('updates an existing external notice to the source of the latest observed version', async () => {
    const { disk, store } = await keepThenEdit(
      'one\ntwo\nthree\nfour\nfive!\n',
    );
    disk.externalWrite('one\ntwo\nthree\nfour\nFive.\n');
    store.getState().markFileChanged(KEY, 'agent-edit');
    await flush();
    expect(store.getState().files[KEY]?.externalChange?.source).toBe(
      'agent-edit',
    );
    disk.externalWrite('unrelated later version');
    await store.getState().refreshFile(KEY);
    expect(store.getState().files[KEY]?.externalChange?.source).toBeNull();
  });

  it('Keep leaves the buffer and its baseline unchanged', async () => {
    const { store } = await keepThenEdit('one\ntwo\nthree\nfour\nfive!\n');
    const session = store.getState().files[KEY];
    expect(session?.content).toBe('one\ntwo\nthree\nfour\nfive!\n');
    expect(session?.externalChange).toBeNull();
    expect(session?.preview?.content).toBe(BASE);
    expect(session?.preview?.version).toBe('v1');
  });

  describe('a change the next save combines', () => {
    const DISJOINT = 'ONE\ntwo\nthree\nfour\nfive\n';

    async function editThenAgentWrite(
      edited: string,
      latest: string,
    ): Promise<{
      disk: Disk;
      store: ReturnType<typeof createFileViewerStore>;
    }> {
      const disk = createDisk(preview(BASE, 'v1'));
      const store = createFileViewerStore(disk.client);
      await store.getState().openFile(REQUEST);
      store.getState().updateContent(KEY, edited);
      disk.externalWrite(latest);
      store.getState().markFileChanged(KEY, 'agent-edit');
      await flush();
      return { disk, store };
    }

    it('raises no notice and keeps the buffer and its baseline', async () => {
      const { store } = await editThenAgentWrite(DISJOINT, AGENT);
      const session = store.getState().files[KEY];
      expect(session).toMatchObject({
        content: DISJOINT,
        dirty: true,
        externalChange: null,
        saveConflict: null,
      });
      expect(session?.preview?.version).toBe('v1');
    });

    it('raises the notice when the changes overlap', async () => {
      const { store } = await editThenAgentWrite(
        'one\ntwo\nthree\nfour\nfive!\n',
        AGENT,
      );
      expect(store.getState().files[KEY]?.externalChange).toMatchObject({
        reloading: false,
        error: null,
        source: 'agent-edit',
      });
    });

    it('raises the notice when the latest version cannot be merged', async () => {
      const disk = createDisk(preview(BASE, 'v1'));
      const store = createFileViewerStore(disk.client);
      await store.getState().openFile(REQUEST);
      store.getState().updateContent(KEY, DISJOINT);
      disk.setRead(() =>
        Promise.resolve({ ...preview(AGENT, 'v2'), truncated: true }),
      );
      store.getState().markFileChanged(KEY, 'agent-edit');
      await flush();
      expect(store.getState().files[KEY]?.externalChange).not.toBeNull();
    });

    it('clears a shown notice once the latest version combines', async () => {
      const { disk, store } = await editThenAgentWrite(
        'one\ntwo\nthree\nfour\nfive!\n',
        AGENT,
      );
      expect(store.getState().files[KEY]?.externalChange).not.toBeNull();
      disk.externalWrite('ONE\ntwo\nthree\nfour\nfive\n');
      store.getState().markFileChanged(KEY, 'agent-edit');
      await flush();
      expect(store.getState().files[KEY]?.externalChange).toBeNull();
    });

    it('loads the newer version when undo returns to the stale baseline', async () => {
      const { store } = await editThenAgentWrite(DISJOINT, AGENT);
      store.getState().updateContent(KEY, BASE);
      await flush();
      expect(store.getState().files[KEY]).toMatchObject({
        content: AGENT,
        dirty: false,
        externalChange: null,
      });
      expect(store.getState().files[KEY]?.preview?.version).toBe('v2');
    });

    it('loads the newer version when the edits are discarded', async () => {
      const { store } = await editThenAgentWrite(DISJOINT, AGENT);
      store.getState().discardEdits(KEY);
      await flush();
      expect(store.getState().files[KEY]).toMatchObject({
        content: AGENT,
        dirty: false,
        externalChange: null,
      });
      expect(store.getState().files[KEY]?.preview?.version).toBe('v2');
    });
  });

  it('combines disjoint edits with exactly one follow-up conditional write', async () => {
    const { disk, store } = await keepThenEdit('ONE\ntwo\nthree\nfour\nfive\n');

    await expect(store.getState().saveFile(KEY)).resolves.toBe(true);

    expect(disk.saves).toHaveLength(2);
    expect(disk.saves[0]?.expectedModifiedAtMs).toBe(mtime('v1'));
    expect(disk.saves[1]).toMatchObject({
      content: 'ONE\ntwo\nthree\nfour\nFIVE\n',
      expectedVersion: 'v2',
      expectedModifiedAtMs: mtime('v2'),
    });
    expect(disk.current().content).toBe('ONE\ntwo\nthree\nfour\nFIVE\n');
    const session = store.getState().files[KEY];
    expect(session).toMatchObject({
      content: 'ONE\ntwo\nthree\nfour\nFIVE\n',
      dirty: false,
      status: 'idle',
      error: null,
      saveConflict: null,
      savedMerge: { revision: 1, source: 'agent-edit' },
    });
    expect(session?.preview?.version).toBe('v3');
  });

  it('adopts the newer version without writing when it already holds the edits', async () => {
    const { disk, store } = await keepThenEdit(AGENT);

    await expect(store.getState().saveFile(KEY)).resolves.toBe(true);

    expect(disk.saves).toHaveLength(1);
    expect(store.getState().files[KEY]).toMatchObject({
      content: AGENT,
      dirty: false,
      saveConflict: null,
      savedMerge: { revision: 1 },
    });
    expect(store.getState().files[KEY]?.preview?.version).toBe('v2');
  });

  it('stops at an overlap notice with the buffer and baseline untouched', async () => {
    const { disk, store } = await keepThenEdit(
      'one\ntwo\nthree\nfour\nfive!\n',
    );

    await expect(store.getState().saveFile(KEY)).resolves.toBe(false);

    expect(disk.saves).toHaveLength(1);
    expect(disk.current().content).toBe(AGENT);
    const session = store.getState().files[KEY];
    expect(session?.content).toBe('one\ntwo\nthree\nfour\nfive!\n');
    expect(session?.preview?.version).toBe('v1');
    expect(session?.status).toBe('idle');
    expect(session?.error).toBeNull();
    expect(session?.saveConflict).toMatchObject({
      reason: 'overlap',
      source: 'agent-edit',
      origin: 'user',
      resolving: null,
      error: null,
      focusRequest: 1,
    });
    expect(session?.saveConflict?.latest?.version).toBe('v2');
  });

  it('autosave conflicts never request focus and never retry', async () => {
    const { disk, store } = await keepThenEdit(
      'one\ntwo\nthree\nfour\nfive!\n',
      false, // Discover at save time, without a deferred pre-save comparison.
    );

    await store.getState().saveFile(KEY, { origin: 'autosave' });
    expect(store.getState().files[KEY]?.saveConflict).toMatchObject({
      origin: 'autosave',
      focusRequest: 0,
    });

    await store.getState().saveFile(KEY, { origin: 'autosave' });
    expect(disk.saves).toHaveLength(1);
    expect(store.getState().files[KEY]?.saveConflict?.focusRequest).toBe(0);

    // An explicit save re-exposes the notice without writing.
    await expect(store.getState().saveFile(KEY)).resolves.toBe(false);
    expect(disk.saves).toHaveLength(1);
    expect(store.getState().files[KEY]?.saveConflict?.focusRequest).toBe(1);
  });

  it('honors explicit Save while an autosave is still awaiting a refusal', async () => {
    const { disk, store } = await keepThenEdit(
      'one\ntwo\nthree\nfour\nfive!\n',
      false, // Discover at save time, without a deferred pre-save comparison.
    );
    const gate = deferred<PortalFilePreview>();
    disk.setSave(() => gate.promise);
    const automatic = store.getState().saveFile(KEY, { origin: 'autosave' });
    const explicit = store.getState().saveFile(KEY);
    gate.reject(new FileSaveConflictError());
    await expect(automatic).resolves.toBe(false);
    await expect(explicit).resolves.toBe(false);
    expect(disk.saves).toHaveLength(1);
    expect(store.getState().files[KEY]?.saveConflict?.focusRequest).toBe(1);
  });

  it('preserves typing during the initial stale write without issuing a merge write', async () => {
    const { disk, store } = await keepThenEdit('ONE\ntwo\nthree\nfour\nfive\n');
    const gate = deferred<PortalFilePreview>();
    disk.setSave(() => gate.promise);
    const saving = store.getState().saveFile(KEY);
    store.getState().updateContent(KEY, 'newer typing');
    gate.reject(new FileSaveConflictError());
    await expect(saving).resolves.toBe(false);
    expect(disk.saves).toHaveLength(1);
    expect(disk.current().content).toBe(AGENT);
    expect(store.getState().files[KEY]).toMatchObject({
      content: 'newer typing',
      preview: { content: BASE, version: 'v1' },
      dirty: true,
      saveConflict: {
        reason: 'newer-edits',
        latest: { content: AGENT, version: 'v2' },
      },
    });
  });

  it('typing preserves the conflict; returning to the baseline clears it', async () => {
    const { store } = await keepThenEdit('one\ntwo\nthree\nfour\nfive!\n');
    await store.getState().saveFile(KEY);

    store.getState().updateContent(KEY, 'one\ntwo\nthree\nfour\nfive!!\n');
    expect(store.getState().files[KEY]?.saveConflict?.reason).toBe('overlap');

    store.getState().updateContent(KEY, BASE);
    await flush();
    expect(store.getState().files[KEY]?.saveConflict).toBeNull();
    // The stale baseline is re-checked and the clean session takes disk.
    expect(store.getState().files[KEY]?.content).toBe(AGENT);
  });

  it('keeps edits when the latest version cannot be read', async () => {
    const { disk, store } = await keepThenEdit('ONE\ntwo\nthree\nfour\nfive\n');
    disk.setRead(() => Promise.reject(new Error('offline')));

    await expect(store.getState().saveFile(KEY)).resolves.toBe(false);

    expect(disk.saves).toHaveLength(1);
    expect(store.getState().files[KEY]).toMatchObject({
      content: 'ONE\ntwo\nthree\nfour\nfive\n',
      dirty: true,
      saveConflict: { reason: 'read-unavailable', latest: null },
    });
  });

  it('skips merging incomplete content and does not offer it as a baseline', async () => {
    const { disk, store } = await keepThenEdit('ONE\ntwo\nthree\nfour\nfive\n');
    disk.setRead(() =>
      Promise.resolve({ ...preview(AGENT, 'v2'), truncated: true }),
    );

    await store.getState().saveFile(KEY);

    expect(disk.saves).toHaveLength(1);
    expect(store.getState().files[KEY]?.saveConflict).toMatchObject({
      reason: 'merge-skipped',
      latest: null,
    });
  });

  it('stops after a second stale refusal and refreshes the notice version', async () => {
    const { disk, store } = await keepThenEdit('ONE\ntwo\nthree\nfour\nfive\n');
    let saves = 0;
    disk.setSave(() => {
      saves += 1;
      if (saves === 2) {
        // Another write lands between the merge read and the merged write.
        disk.externalWrite('changed again\n');
      }
      return Promise.reject(new FileSaveConflictError());
    });

    await expect(store.getState().saveFile(KEY)).resolves.toBe(false);

    expect(disk.saves).toHaveLength(2);
    const session = store.getState().files[KEY];
    expect(session?.content).toBe('ONE\ntwo\nthree\nfour\nfive\n');
    expect(session?.preview?.version).toBe('v1');
    expect(session?.saveConflict).toMatchObject({
      reason: 'changed-again',
      source: null,
    });
    expect(session?.saveConflict?.latest?.version).toBe('v3');
  });

  it('reports an unrelated merged-write failure without labeling it an overlap', async () => {
    const { disk, store } = await keepThenEdit('ONE\ntwo\nthree\nfour\nfive\n');
    let saves = 0;
    disk.setSave(() => {
      saves += 1;
      return Promise.reject(
        saves === 1 ? new FileSaveConflictError() : new Error('disk full'),
      );
    });

    await expect(store.getState().saveFile(KEY)).resolves.toBe(false);

    expect(store.getState().files[KEY]).toMatchObject({
      status: 'error',
      error: 'disk full',
      dirty: true,
      content: 'ONE\ntwo\nthree\nfour\nfive\n',
      saveConflict: null,
    });
  });

  it('keeps an unrelated first-write failure as a plain error', async () => {
    const { disk, store } = await keepThenEdit('ONE\ntwo\nthree\nfour\nfive\n');
    disk.setSave(() => Promise.reject(new Error('Permission denied')));

    await store.getState().saveFile(KEY);

    expect(disk.reads()).toBe(2);
    expect(store.getState().files[KEY]).toMatchObject({
      status: 'error',
      error: 'Permission denied',
      saveConflict: null,
    });
  });

  it('does not merge typing that arrives during the merge read', async () => {
    const { disk, store } = await keepThenEdit('ONE\ntwo\nthree\nfour\nfive\n');
    const read = deferred<PortalFilePreview>();
    disk.setRead(() => read.promise);

    const save = store.getState().saveFile(KEY);
    await flush();
    store.getState().updateContent(KEY, 'ONE!\ntwo\nthree\nfour\nfive\n');
    read.resolve(disk.current());

    await expect(save).resolves.toBe(false);
    expect(disk.saves).toHaveLength(1);
    expect(store.getState().files[KEY]).toMatchObject({
      content: 'ONE!\ntwo\nthree\nfour\nfive\n',
      saveConflict: { reason: 'newer-edits' },
    });
    expect(store.getState().files[KEY]?.preview?.version).toBe('v1');
  });

  it('never marks typing during the merged write as saved', async () => {
    const { disk, store } = await keepThenEdit('ONE\ntwo\nthree\nfour\nfive\n');
    const write = deferred<PortalFilePreview>();
    let saves = 0;
    disk.setSave((args) => {
      saves += 1;
      if (saves === 1) return Promise.reject(new FileSaveConflictError());
      return write.promise.then(() => disk.externalWrite(args.content));
    });

    const save = store.getState().saveFile(KEY);
    await flush();
    store.getState().updateContent(KEY, 'ONE!\ntwo\nthree\nfour\nfive\n');
    write.resolve(preview('', 'v0'));

    await expect(save).resolves.toBe(false);
    expect(disk.current().content).toBe('ONE\ntwo\nthree\nfour\nFIVE\n');
    const session = store.getState().files[KEY];
    expect(session).toMatchObject({
      content: 'ONE!\ntwo\nthree\nfour\nfive\n',
      dirty: true,
      saveConflict: { reason: 'newer-edits', source: 'agent-edit' },
    });
    // The baseline the newer buffer was derived from is kept.
    expect(session?.preview?.version).toBe('v1');
    expect(session?.saveConflict?.latest?.version).toBe('v3');
  });

  it('issues no follow-up write after the file closes during the merge read', async () => {
    const { disk, store } = await keepThenEdit('ONE\ntwo\nthree\nfour\nfive\n');
    const read = deferred<PortalFilePreview>();
    disk.setRead(() => read.promise);

    const save = store.getState().saveFile(KEY);
    await flush();
    store.getState().closeFile(KEY);
    read.resolve(disk.current());

    await expect(save).resolves.toBe(false);
    expect(disk.saves).toHaveLength(1);
    expect(store.getState().files[KEY]).toBeUndefined();
  });

  it('does not attribute an unrelated later version to the agent', async () => {
    const { disk, store } = await keepThenEdit(
      'one\ntwo\nthree\nfour\nfive!\n',
    );
    disk.externalWrite('someone else\n');

    await store.getState().saveFile(KEY);

    expect(store.getState().files[KEY]?.saveConflict).toMatchObject({
      reason: 'overlap',
      source: null,
    });
  });

  describe('Save my version', () => {
    it('drops attribution when a further refusal cannot identify the newer version', async () => {
      const { disk, store } = await keepThenEdit(
        'one\ntwo\nthree\nfour\nfive!\n',
      );
      await store.getState().saveFile(KEY);
      expect(store.getState().files[KEY]?.saveConflict?.source).toBe(
        'agent-edit',
      );
      disk.externalWrite('unrelated writer');
      disk.setRead(() => Promise.reject(new Error('unavailable')));
      await expect(store.getState().overwriteWithEdits(KEY)).resolves.toBe(
        false,
      );
      expect(store.getState().files[KEY]?.saveConflict).toMatchObject({
        reason: 'changed-again',
        latest: null,
        source: null,
        resolving: null,
      });
      expect(disk.current().content).toBe('unrelated writer');
    });

    it('replaces exactly the notice version through a conditional write', async () => {
      const { disk, store } = await keepThenEdit(
        'one\ntwo\nthree\nfour\nfive!\n',
      );
      await store.getState().saveFile(KEY);

      await expect(store.getState().overwriteWithEdits(KEY)).resolves.toBe(
        true,
      );

      expect(disk.saves).toHaveLength(2);
      expect(disk.saves[1]).toMatchObject({
        content: 'one\ntwo\nthree\nfour\nfive!\n',
        expectedVersion: 'v2',
        expectedModifiedAtMs: mtime('v2'),
      });
      expect(store.getState().files[KEY]).toMatchObject({
        dirty: false,
        saveConflict: null,
        content: 'one\ntwo\nthree\nfour\nfive!\n',
      });
    });

    it('requires renewed consent when the document changed again', async () => {
      const { disk, store } = await keepThenEdit(
        'one\ntwo\nthree\nfour\nfive!\n',
      );
      await store.getState().saveFile(KEY);
      disk.externalWrite('newest\n');

      await expect(store.getState().overwriteWithEdits(KEY)).resolves.toBe(
        false,
      );
      expect(disk.current().content).toBe('newest\n');
      expect(store.getState().files[KEY]?.saveConflict).toMatchObject({
        reason: 'changed-again',
        resolving: null,
      });
      expect(store.getState().files[KEY]?.saveConflict?.latest?.version).toBe(
        'v3',
      );

      await expect(store.getState().overwriteWithEdits(KEY)).resolves.toBe(
        true,
      );
      expect(disk.saves.at(-1)?.expectedModifiedAtMs).toBe(mtime('v3'));
      expect(disk.current().content).toBe('one\ntwo\nthree\nfour\nfive!\n');
    });

    it('fetches and exposes a missing version before any write', async () => {
      const { disk, store } = await keepThenEdit(
        'ONE\ntwo\nthree\nfour\nfive\n',
      );
      disk.setRead(() => Promise.reject(new Error('offline')));
      await store.getState().saveFile(KEY);
      disk.setRead(null);

      await expect(store.getState().overwriteWithEdits(KEY)).resolves.toBe(
        false,
      );
      expect(disk.saves).toHaveLength(1);
      expect(store.getState().files[KEY]?.saveConflict?.latest?.version).toBe(
        'v2',
      );

      await expect(store.getState().overwriteWithEdits(KEY)).resolves.toBe(
        true,
      );
      expect(disk.saves).toHaveLength(2);
      expect(disk.saves[1]?.expectedModifiedAtMs).toBe(mtime('v2'));
    });

    it('recovers its busy flag after an unrelated failure', async () => {
      const { disk, store } = await keepThenEdit(
        'one\ntwo\nthree\nfour\nfive!\n',
      );
      await store.getState().saveFile(KEY);
      disk.setSave(() => Promise.reject(new Error('disk full')));

      await expect(store.getState().overwriteWithEdits(KEY)).resolves.toBe(
        false,
      );

      expect(store.getState().files[KEY]).toMatchObject({
        status: 'idle',
        saveConflict: {
          resolving: null,
          error: { kind: 'save-failed', message: 'disk full' },
        },
      });
    });

    it('serializes with saves and ignores repeated activation', async () => {
      const { disk, store } = await keepThenEdit(
        'one\ntwo\nthree\nfour\nfive!\n',
      );
      await store.getState().saveFile(KEY);
      const write = deferred<PortalFilePreview>();
      disk.setSave((args) =>
        write.promise.then(() => disk.externalWrite(args.content)),
      );

      const first = store.getState().overwriteWithEdits(KEY);
      await expect(store.getState().overwriteWithEdits(KEY)).resolves.toBe(
        false,
      );
      await expect(store.getState().reloadFromDisk(KEY)).resolves.toBe(false);
      write.resolve(preview('', 'v0'));
      await expect(first).resolves.toBe(true);
      expect(disk.saves).toHaveLength(2);
    });
  });

  describe('Show latest version', () => {
    it('replaces the edits with freshly read content', async () => {
      const { disk, store } = await keepThenEdit(
        'one\ntwo\nthree\nfour\nfive!\n',
      );
      await store.getState().saveFile(KEY);
      disk.externalWrite('fresh\n');

      await expect(store.getState().reloadFromDisk(KEY)).resolves.toBe(true);

      expect(store.getState().files[KEY]).toMatchObject({
        content: 'fresh\n',
        dirty: false,
        saveConflict: null,
        externalChange: null,
      });
    });

    it('keeps the edits and recovery when typing happens during the read', async () => {
      const { disk, store } = await keepThenEdit(
        'one\ntwo\nthree\nfour\nfive!\n',
      );
      await store.getState().saveFile(KEY);
      const read = deferred<PortalFilePreview>();
      disk.setRead(() => read.promise);

      const reload = store.getState().reloadFromDisk(KEY);
      expect(store.getState().files[KEY]?.saveConflict?.resolving).toBe(
        'reload',
      );
      store.getState().updateContent(KEY, 'still typing\n');
      read.resolve(disk.current());

      await expect(reload).resolves.toBe(false);
      expect(store.getState().files[KEY]).toMatchObject({
        content: 'still typing\n',
        externalChange: null,
        saveConflict: { reason: 'newer-edits', resolving: null },
      });
    });

    it('keeps the edits and a retryable error when the read fails', async () => {
      const { disk, store } = await keepThenEdit(
        'one\ntwo\nthree\nfour\nfive!\n',
      );
      await store.getState().saveFile(KEY);
      disk.setRead(() => Promise.reject(new Error('offline')));

      await expect(store.getState().reloadFromDisk(KEY)).resolves.toBe(false);

      expect(store.getState().files[KEY]).toMatchObject({
        content: 'one\ntwo\nthree\nfour\nfive!\n',
        externalChange: null,
        saveConflict: {
          resolving: null,
          error: { kind: 'latest-unavailable' },
        },
      });
    });
  });

  it('Discard clears the conflict and shows the current version', async () => {
    const { store } = await keepThenEdit('one\ntwo\nthree\nfour\nfive!\n');
    await store.getState().saveFile(KEY);

    store.getState().discardEdits(KEY);
    await flush();

    expect(store.getState().files[KEY]).toMatchObject({
      content: AGENT,
      dirty: false,
      saveConflict: null,
    });
  });

  it('does not reopen the external-change notice after a combined save', async () => {
    const { disk, store } = await keepThenEdit('ONE\ntwo\nthree\nfour\nfive\n');
    const save = store.getState().saveFile(KEY);
    // The agent's write report arrives while the save is in flight.
    store.getState().markFileChanged(KEY, 'agent-edit');
    await save;
    await flush();

    expect(disk.saves).toHaveLength(2);
    expect(store.getState().files[KEY]).toMatchObject({
      dirty: false,
      externalChange: null,
      saveConflict: null,
    });
  });

  describe('the combinable change notice state', () => {
    const DISJOINT = 'ONE\ntwo\nthree\nfour\nfive\n';
    const OVERLAP = 'one\ntwo\nthree\nfour\nfive!\n';

    async function editThenWrite(
      edited: string,
      source?: 'agent-edit',
    ): Promise<{
      disk: Disk;
      store: ReturnType<typeof createFileViewerStore>;
    }> {
      const disk = createDisk(preview(BASE, 'v1'));
      const store = createFileViewerStore(disk.client);
      await store.getState().openFile(REQUEST);
      store.getState().updateContent(KEY, edited);
      disk.externalWrite(AGENT);
      if (source) {
        store.getState().markFileChanged(KEY, source);
        await flush();
      } else {
        await store.getState().refreshFile(KEY);
      }
      return { disk, store };
    }

    it('records an attributed combinable version without touching the buffer', async () => {
      const { store } = await editThenWrite(DISJOINT, 'agent-edit');
      const session = store.getState().files[KEY];
      expect(session).toMatchObject({
        content: DISJOINT,
        dirty: true,
        baselineStale: true,
        externalChange: null,
        saveConflict: null,
        combinableChange: { version: 'v2', source: 'agent-edit' },
      });
      expect(session?.preview?.version).toBe('v1');
    });

    it('starts with no combinable change and leaves unattributed versions neutral', async () => {
      const disk = createDisk(preview(BASE, 'v1'));
      const store = createFileViewerStore(disk.client);
      await store.getState().openFile(REQUEST);
      expect(store.getState().files[KEY]?.combinableChange).toBeNull();
      store.getState().updateContent(KEY, DISJOINT);
      disk.externalWrite(AGENT);
      await store.getState().refreshFile(KEY);
      expect(store.getState().files[KEY]?.combinableChange).toEqual({
        version: 'v2',
        source: null,
      });
    });

    it('follows the attribution of the newest accepted version', async () => {
      const { disk, store } = await editThenWrite(DISJOINT);
      expect(store.getState().files[KEY]?.combinableChange?.source).toBeNull();
      disk.externalWrite('one\ntwo\nthree\nFOUR\nFIVE\n');
      store.getState().markFileChanged(KEY, 'agent-edit');
      await flush();
      expect(store.getState().files[KEY]?.combinableChange).toEqual({
        version: 'v3',
        source: 'agent-edit',
      });
      disk.externalWrite('one\ntwo\nTHREE\nFOUR\nFIVE\n');
      await store.getState().refreshFile(KEY);
      expect(store.getState().files[KEY]?.combinableChange).toEqual({
        version: 'v4',
        source: null,
      });
    });

    it('keeps the same state for a repeated read of the same version', async () => {
      const { store } = await editThenWrite(DISJOINT, 'agent-edit');
      const before = store.getState().files[KEY]?.combinableChange;
      store.getState().markFileChanged(KEY, 'agent-edit');
      await flush();
      expect(store.getState().files[KEY]?.combinableChange).toBe(before);
    });

    it('gives way to the external change notice when the changes overlap', async () => {
      const { store } = await editThenWrite(OVERLAP, 'agent-edit');
      expect(store.getState().files[KEY]).toMatchObject({
        externalChange: { source: 'agent-edit' },
        combinableChange: null,
      });
    });

    it.each([undefined, 'agent-edit'] as const)(
      'combines the buffer after typing removes an inline overlap (%s)',
      async (source) => {
        const { disk, store } = await editThenWrite(OVERLAP, source);
        store.getState().updateContent(KEY, DISJOINT);
        expect(store.getState().files[KEY]).toMatchObject({
          content: 'ONE\ntwo\nthree\nfour\nFIVE\n',
          dirty: true,
          externalChange: null,
          saveConflict: null,
          overlap: null,
          combinableChange: null,
        });
        expect(store.getState().files[KEY]?.preview?.version).toBe('v2');
        // Combining the buffer never writes until Save.
        expect(disk.current().content).toBe(AGENT);
        await expect(store.getState().saveFile(KEY)).resolves.toBe(true);
        expect(disk.current().content).toBe('ONE\ntwo\nthree\nfour\nFIVE\n');
        expect(store.getState().files[KEY]?.combinableChange).toBeNull();
      },
    );

    it('clears when disk returns to the baseline', async () => {
      const { disk, store } = await editThenWrite(DISJOINT, 'agent-edit');
      disk.externalWrite(BASE);
      await store.getState().refreshFile(KEY);
      expect(store.getState().files[KEY]?.combinableChange).toBeNull();
    });

    it('does not claim a combine when only the disk version changed', async () => {
      const disk = createDisk(preview(BASE, 'v1'));
      const store = createFileViewerStore(disk.client);
      await store.getState().openFile(REQUEST);
      store.getState().updateContent(KEY, DISJOINT);
      disk.externalWrite(BASE);
      await store.getState().refreshFile(KEY);
      expect(store.getState().files[KEY]?.combinableChange).toBeNull();
      await expect(store.getState().saveFile(KEY)).resolves.toBe(true);
      expect(disk.current().content).toBe(DISJOINT);
      expect(store.getState().files[KEY]).toMatchObject({
        content: DISJOINT,
        dirty: false,
        savedMerge: null,
        combinableChange: null,
      });
    });

    it('follows typing between combinable and overlapping edits', async () => {
      const { store } = await editThenWrite(DISJOINT, 'agent-edit');
      store.getState().updateContent(KEY, 'ONE\ntwo\nthree\nfour\nfive!\n');
      expect(store.getState().files[KEY]).toMatchObject({
        dirty: true,
        externalChange: null,
        combinableChange: null,
      });
      store.getState().updateContent(KEY, 'ONE\nTWO\nthree\nfour\nfive\n');
      expect(store.getState().files[KEY]?.combinableChange).toEqual({
        version: 'v2',
        source: 'agent-edit',
      });
    });

    it('lets the save-time check protect both versions after typing overlaps', async () => {
      const { disk, store } = await editThenWrite(DISJOINT, 'agent-edit');
      store.getState().updateContent(KEY, OVERLAP);
      await expect(store.getState().saveFile(KEY)).resolves.toBe(false);
      expect(disk.current().content).toBe(AGENT);
      expect(store.getState().files[KEY]).toMatchObject({
        content: OVERLAP,
        saveConflict: { reason: 'overlap', source: 'agent-edit' },
        combinableChange: null,
      });
    });

    it('clears when undo returns to the stale baseline', async () => {
      const { store } = await editThenWrite(DISJOINT, 'agent-edit');
      store.getState().updateContent(KEY, BASE);
      expect(store.getState().files[KEY]?.combinableChange).toBeNull();
      await flush();
      expect(store.getState().files[KEY]).toMatchObject({
        content: AGENT,
        dirty: false,
        combinableChange: null,
      });
    });

    it('clears on Discard and does not return once the latest version loads', async () => {
      const { store } = await editThenWrite(DISJOINT, 'agent-edit');
      store.getState().discardEdits(KEY);
      expect(store.getState().files[KEY]?.combinableChange).toBeNull();
      await flush();
      expect(store.getState().files[KEY]).toMatchObject({
        content: AGENT,
        dirty: false,
        combinableChange: null,
      });
    });

    it('clears as soon as reload takes ownership, even if that read fails', async () => {
      const { disk, store } = await editThenWrite(DISJOINT, 'agent-edit');
      const read = deferred<PortalFilePreview>();
      disk.setRead(() => read.promise);
      const reload = store.getState().reloadFromDisk(KEY);
      expect(store.getState().files[KEY]).toMatchObject({
        content: DISJOINT,
        dirty: true,
        combinableChange: null,
        externalChange: { reloading: true },
      });
      read.reject(new Error('offline'));
      await expect(reload).resolves.toBe(false);
      expect(store.getState().files[KEY]).toMatchObject({
        content: DISJOINT,
        dirty: true,
        combinableChange: null,
        externalChange: { reloading: false, error: 'offline' },
      });
      disk.setRead(null);
      await expect(store.getState().reloadFromDisk(KEY)).resolves.toBe(true);
      expect(store.getState().files[KEY]).toMatchObject({
        content: AGENT,
        dirty: false,
        combinableChange: null,
        externalChange: null,
      });
    });

    it('retains the known combinable version when a refresh fails', async () => {
      const { disk, store } = await editThenWrite(DISJOINT, 'agent-edit');
      const pending = store.getState().files[KEY]?.combinableChange;
      disk.setRead(() => Promise.reject(new Error('offline')));
      await store.getState().refreshFile(KEY);
      expect(store.getState().files[KEY]?.combinableChange).toBe(pending);
      expect(store.getState().files[KEY]).toMatchObject({
        content: DISJOINT,
        dirty: true,
        savedMerge: null,
        externalChange: null,
      });
    });

    it('retains the newer read when typing cancels reload before Keep', async () => {
      const { disk, store } = await editThenWrite(OVERLAP, 'agent-edit');
      const newest = disk.externalWrite('one\ntwo\nTHREE\nfour\nFIVE\n');
      const read = deferred<PortalFilePreview>();
      disk.setRead(() => read.promise);
      const reload = store.getState().reloadFromDisk(KEY);
      const overlapping = 'ONE\ntwo\nlocal three\nfour\nfive\n';
      store.getState().updateContent(KEY, overlapping);
      read.resolve(newest);
      await expect(reload).resolves.toBe(false);
      disk.setRead(null);
      expect(store.getState().files[KEY]?.externalChange?.reloading).toBe(
        false,
      );

      store.getState().dismissExternalChange(KEY);

      expect(store.getState().files[KEY]).toMatchObject({
        content: overlapping,
        dirty: true,
        externalChange: null,
        combinableChange: null,
      });
      expect(store.getState().files[KEY]?.preview?.version).toBe('v1');
      store.getState().updateContent(KEY, DISJOINT);
      expect(store.getState().files[KEY]?.combinableChange).toEqual({
        version: 'v3',
        source: null,
      });
      store.getState().updateContent(KEY, overlapping);
      await expect(store.getState().saveFile(KEY)).resolves.toBe(false);
      expect(store.getState().files[KEY]?.saveConflict?.reason).toBe('overlap');
      expect(disk.current()).toBe(newest);
    });

    it('evaluates a delayed read against the newest local edits', async () => {
      const { disk, store } = await editThenWrite(DISJOINT, 'agent-edit');
      const read = deferred<PortalFilePreview>();
      disk.setRead(() => read.promise);
      const refresh = store.getState().refreshFile(KEY);
      store.getState().updateContent(KEY, OVERLAP);
      read.resolve(disk.current());
      await refresh;
      expect(store.getState().files[KEY]).toMatchObject({
        content: OVERLAP,
        dirty: true,
        combinableChange: null,
        externalChange: { reloading: false },
      });
      disk.setRead(null);
      await expect(store.getState().saveFile(KEY)).resolves.toBe(false);
      expect(disk.current().content).toBe(AGENT);
      expect(store.getState().files[KEY]?.saveConflict?.reason).toBe('overlap');
    });

    it('starts empty after close and reopen', async () => {
      const { store } = await editThenWrite(DISJOINT, 'agent-edit');
      store.getState().closeFile(KEY);
      await store.getState().openFile(REQUEST);
      store.getState().updateContent(KEY, DISJOINT);
      expect(store.getState().files[KEY]?.combinableChange).toBeNull();
    });

    it('clears after a combining save, and a later refresh does not restore it', async () => {
      const { disk, store } = await editThenWrite(DISJOINT, 'agent-edit');
      await expect(store.getState().saveFile(KEY)).resolves.toBe(true);
      expect(disk.current().content).toBe('ONE\ntwo\nthree\nfour\nFIVE\n');
      expect(store.getState().files[KEY]).toMatchObject({
        dirty: false,
        combinableChange: null,
        savedMerge: { revision: 1, source: 'agent-edit' },
      });
      await store.getState().refreshFile(KEY);
      expect(store.getState().files[KEY]?.combinableChange).toBeNull();
    });

    it('keeps the explanation when an ordinary save fails', async () => {
      const { disk, store } = await editThenWrite(DISJOINT, 'agent-edit');
      disk.setSave(() => Promise.reject(new Error('disk full')));
      await expect(store.getState().saveFile(KEY)).resolves.toBe(false);
      expect(store.getState().files[KEY]).toMatchObject({
        status: 'error',
        dirty: true,
        savedMerge: null,
        combinableChange: { version: 'v2', source: 'agent-edit' },
      });
    });

    it('clears and records no combine when the merged write fails', async () => {
      const { disk, store } = await editThenWrite(DISJOINT, 'agent-edit');
      let calls = 0;
      disk.setSave(() => {
        calls += 1;
        return Promise.reject(
          calls === 1 ? new FileSaveConflictError() : new Error('disk full'),
        );
      });
      await expect(store.getState().saveFile(KEY)).resolves.toBe(false);
      expect(store.getState().files[KEY]).toMatchObject({
        status: 'error',
        dirty: true,
        savedMerge: null,
      });
    });

    it.each([false, true])(
      'uses the recovery version after a failed merged write (typing during write: %s)',
      async (typeDuringWrite) => {
        const { disk, store } = await editThenWrite(DISJOINT, 'agent-edit');
        disk.externalWrite('one\ntwo\nTHREE\nfour\nFIVE\n');
        const write = deferred<PortalFilePreview>();
        let calls = 0;
        disk.setSave(() => {
          calls += 1;
          return calls === 1
            ? Promise.reject(new FileSaveConflictError())
            : write.promise;
        });
        const save = store.getState().saveFile(KEY);
        await flush();
        const overlapping = 'ONE\ntwo\nlocal three\nfour\nfive\n';
        if (typeDuringWrite) store.getState().updateContent(KEY, overlapping);
        write.reject(new Error('disk full'));
        await expect(save).resolves.toBe(false);
        if (!typeDuringWrite) {
          expect(store.getState().files[KEY]?.combinableChange).toEqual({
            version: 'v3',
            source: null,
          });
          store.getState().updateContent(KEY, overlapping);
        }
        expect(store.getState().files[KEY]).toMatchObject({
          content: overlapping,
          dirty: true,
          savedMerge: null,
          combinableChange: null,
        });
        store.getState().updateContent(KEY, DISJOINT);
        expect(store.getState().files[KEY]?.combinableChange).toEqual({
          version: 'v3',
          source: null,
        });
        store.getState().updateContent(KEY, overlapping);
        disk.setSave(null);
        await expect(store.getState().saveFile(KEY)).resolves.toBe(false);
        expect(store.getState().files[KEY]?.saveConflict?.reason).toBe(
          'overlap',
        );
      },
    );

    it('is superseded by a conflict when the latest version changed again', async () => {
      const { disk, store } = await editThenWrite(DISJOINT, 'agent-edit');
      disk.externalWrite('one!\ntwo\nthree\nfour\nFIVE\n');
      await expect(store.getState().saveFile(KEY)).resolves.toBe(false);
      expect(store.getState().files[KEY]).toMatchObject({
        savedMerge: null,
        combinableChange: null,
        saveConflict: { reason: 'overlap' },
      });
    });

    it('a read that started before Discard cannot restore the explanation', async () => {
      const { disk, store } = await editThenWrite(DISJOINT, 'agent-edit');
      const read = deferred<PortalFilePreview>();
      disk.setRead(() => read.promise);
      store.getState().markFileChanged(KEY, 'agent-edit');
      store.getState().discardEdits(KEY);
      disk.setRead(null);
      read.resolve(disk.current());
      await flush();
      expect(store.getState().files[KEY]).toMatchObject({
        dirty: false,
        combinableChange: null,
      });
    });

    it('a read that started before a save cannot restore the explanation', async () => {
      const { disk, store } = await editThenWrite(DISJOINT, 'agent-edit');
      const read = deferred<PortalFilePreview>();
      disk.setRead(() => read.promise);
      store.getState().markFileChanged(KEY, 'agent-edit');
      disk.setRead(null);
      await expect(store.getState().saveFile(KEY)).resolves.toBe(true);
      read.resolve(preview(AGENT, 'v2'));
      await flush();
      expect(store.getState().files[KEY]).toMatchObject({
        dirty: false,
        combinableChange: null,
      });
    });
  });
});
