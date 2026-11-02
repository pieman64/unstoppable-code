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
  type FileOverlapComparison,
} from '../create-file-viewer-store';
import { THREE_WAY_MERGE_MAX_BYTES } from '../three-way-merge';
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
  relativePath: 'landing.md',
};
const KEY = fileViewerKey(REQUEST);

/** Lines separated by blank lines, so edits to neighbours stay disjoint. */
const lines = (...values: string[]): string =>
  values.map((value) => `${value}\n`).join('\n');

// Leah's landing page: she rewrites the call to action; the agent rewrites
// the same line and also fixes the heading.
const BASE = lines('# Welcome', 'Intro', 'Get started today', 'Footer');
const MINE = lines('# Welcome', 'Intro', 'Try it free', 'Footer');
const AGENT = lines('# Welcome!', 'Intro', 'Start your trial', 'Footer');

function preview(content: string, version: string): PortalFilePreview {
  const seconds = Number(version.replace(/\D/g, '')) || 0;
  return {
    workspaceLocalId: 'p1',
    worktreeLocalId: 'wt1',
    path: REQUEST.relativePath,
    content,
    size: content.length,
    version,
    truncated: false,
    modifiedAt: new Date(Date.UTC(2026, 9, 27, 0, 0, seconds)).toISOString(),
  };
}

const mtime = (version: string): number =>
  Date.parse(preview('', version).modifiedAt ?? '');

type SaveArgs = CommandMap['file.save']['args'];

/** A disk that refuses saves whose expected mtime is not current. */
function createDisk(initial: PortalFilePreview): {
  client: CanopyClient;
  saves: SaveArgs[];
  current: () => PortalFilePreview;
  write: (content: string) => PortalFilePreview;
  setRead: (handler: (() => Promise<PortalFilePreview>) | null) => void;
  beforeSave: (hook: ((args: SaveArgs) => void) | null) => void;
} {
  let current = initial;
  let counter = Number(initial.version.replace(/\D/g, ''));
  const saves: SaveArgs[] = [];
  let readOverride: (() => Promise<PortalFilePreview>) | null = null;
  let saveHook: ((args: SaveArgs) => void) | null = null;
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
      saveHook?.(saveArgs);
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
    current: (): PortalFilePreview => current,
    write,
    setRead: (handler): void => {
      readOverride = handler;
    },
    beforeSave: (hook): void => {
      saveHook = hook;
    },
  };
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

/** Open BASE, type `edited`, then let the agent write `latest`. */
async function overlapBeforeSave(
  edited = MINE,
  latest = AGENT,
): Promise<{
  disk: ReturnType<typeof createDisk>;
  store: ReturnType<typeof createFileViewerStore>;
}> {
  const disk = createDisk(preview(BASE, 'v1'));
  const store = createFileViewerStore(disk.client);
  await store.getState().openFile(REQUEST);
  store.getState().updateContent(KEY, edited);
  disk.write(latest);
  store.getState().markFileChanged(KEY, 'agent-edit');
  await flush();
  return { disk, store };
}

function overlapOf(
  store: ReturnType<typeof createFileViewerStore>,
): FileOverlapComparison {
  const overlap = store.getState().files[KEY]?.overlap;
  if (!overlap) throw new Error('expected an overlap comparison');
  return overlap;
}

describe('file viewer overlap comparison', () => {
  it('shows both wordings of the overlapping passage before Save', async () => {
    const { disk, store } = await overlapBeforeSave();
    const session = store.getState().files[KEY];
    expect(session).toMatchObject({
      content: MINE,
      dirty: true,
      saveConflict: null,
      externalChange: { reloading: false, source: 'agent-edit' },
      preview: { version: 'v1' },
    });
    expect(overlapOf(store)).toMatchObject({
      latest: { version: 'v2' },
      choices: [null],
      regions: [
        {
          index: 0,
          ours: 'Try it free\n',
          theirs: 'Start your trial\n',
          oursLines: { line: 5, lineCount: 1 },
        },
      ],
    });
    expect(disk.saves).toHaveLength(0);
  });

  it('keeps my wording and the agent heading, then saves once against the compared version', async () => {
    const { disk, store } = await overlapBeforeSave();
    const { token } = overlapOf(store);
    store.getState().chooseOverlapVersion(KEY, token, 0, 'ours');
    const resolved = lines('# Welcome!', 'Intro', 'Try it free', 'Footer');
    expect(store.getState().files[KEY]).toMatchObject({
      content: resolved,
      dirty: true,
      overlap: null,
      externalChange: null,
      saveConflict: null,
      baselineStale: false,
      preview: { version: 'v2' },
      overlapResolvedRevision: 1,
    });
    expect(disk.saves).toHaveLength(0);

    await expect(store.getState().saveFile(KEY)).resolves.toBe(true);
    expect(disk.saves).toHaveLength(1);
    expect(disk.saves[0]).toMatchObject({
      content: resolved,
      expectedVersion: 'v2',
      expectedModifiedAtMs: mtime('v2'),
    });
    expect(store.getState().files[KEY]?.saveConflict).toBeNull();
  });

  it('settles clean without a write when the agent wording leaves nothing of mine', async () => {
    const { disk, store } = await overlapBeforeSave();
    store
      .getState()
      .chooseOverlapVersion(KEY, overlapOf(store).token, 0, 'theirs');
    expect(store.getState().files[KEY]).toMatchObject({
      content: AGENT,
      dirty: false,
      reloadRevision: 1,
      preview: { version: 'v2' },
    });
    expect(disk.saves).toHaveLength(0);
  });

  it('keeps my disjoint edits when the agent wording wins the passage', async () => {
    const edited = lines('# Welcome', 'Intro, edited', 'Try it free', 'Footer');
    const { store } = await overlapBeforeSave(edited);
    store
      .getState()
      .chooseOverlapVersion(KEY, overlapOf(store).token, 0, 'theirs');
    expect(store.getState().files[KEY]).toMatchObject({
      content: lines(
        '# Welcome!',
        'Intro, edited',
        'Start your trial',
        'Footer',
      ),
      dirty: true,
    });
  });

  it('records partial choices without touching the buffer and allows revising them', async () => {
    const edited = lines('# Hello', 'Intro', 'Try it free', 'Footer');
    const { store } = await overlapBeforeSave(edited);
    const first = overlapOf(store);
    expect(first.regions).toHaveLength(2);

    store.getState().chooseOverlapVersion(KEY, first.token, 0, 'theirs');
    store.getState().chooseOverlapVersion(KEY, first.token, 0, 'ours');
    expect(store.getState().files[KEY]?.content).toBe(edited);
    expect(overlapOf(store).choices).toEqual(['ours', null]);

    store.getState().chooseOverlapVersion(KEY, first.token, 1, 'theirs');
    expect(store.getState().files[KEY]).toMatchObject({
      content: lines('# Hello', 'Intro', 'Start your trial', 'Footer'),
      overlap: null,
    });
  });

  it('ignores invalid passages, stale tokens, and choices after close and reopen', async () => {
    const { disk, store } = await overlapBeforeSave();
    const { token } = overlapOf(store);
    store.getState().chooseOverlapVersion(KEY, token, 3, 'ours');
    store.getState().chooseOverlapVersion(KEY, 'stale', 0, 'ours');
    expect(overlapOf(store).choices).toEqual([null]);

    store.getState().closeFile(KEY);
    disk.write(BASE);
    await store.getState().openFile(REQUEST);
    store.getState().updateContent(KEY, MINE);
    disk.write(AGENT);
    store.getState().markFileChanged(KEY, 'agent-edit');
    await flush();
    const replacement = overlapOf(store);
    expect(replacement.token).not.toBe(token);
    store.getState().chooseOverlapVersion(KEY, token, 0, 'ours');
    expect(overlapOf(store)).toBe(replacement);
  });

  it('accepts no choice after the store is disposed', async () => {
    const { store } = await overlapBeforeSave();
    const { token } = overlapOf(store);
    store[CLIENT_STORE_DISPOSE]?.();
    store.getState().chooseOverlapVersion(KEY, token, 0, 'ours');
    expect(store.getState().files[KEY]?.content).toBe(MINE);
  });

  it('keeps the comparison and choices across identical reads; a newer version starts over', async () => {
    const edited = lines('# Hello', 'Intro', 'Try it free', 'Footer');
    const { disk, store } = await overlapBeforeSave(edited);
    const first = overlapOf(store);
    store.getState().chooseOverlapVersion(KEY, first.token, 0, 'ours');
    const chosen = overlapOf(store);

    await store.getState().refreshFile(KEY);
    expect(overlapOf(store)).toBe(chosen);

    disk.write(lines('# Welcome!', 'Intro', 'Begin a trial', 'Footer'));
    await store.getState().refreshFile(KEY);
    const newer = overlapOf(store);
    expect(newer.token).not.toBe(first.token);
    expect(newer.latest.version).toBe('v3');
    expect(newer.choices).toEqual([null, null]);
    store.getState().chooseOverlapVersion(KEY, first.token, 1, 'ours');
    expect(overlapOf(store).choices).toEqual([null, null]);
  });

  it('keeps a choice across unrelated typing but not across editing the chosen wording', async () => {
    const edited = lines('# Hello', 'Intro', 'Try it free', 'Footer');
    const { store } = await overlapBeforeSave(edited);
    const first = overlapOf(store);
    store.getState().chooseOverlapVersion(KEY, first.token, 0, 'ours');

    store
      .getState()
      .updateContent(KEY, lines('# Hello', 'Intro', 'Try it free', 'Footer!'));
    const afterUnrelated = overlapOf(store);
    expect(afterUnrelated.token).not.toBe(first.token);
    expect(afterUnrelated.choices).toEqual(['ours', null]);
    store.getState().chooseOverlapVersion(KEY, first.token, 1, 'ours');
    expect(overlapOf(store).choices).toEqual(['ours', null]);

    store
      .getState()
      .updateContent(KEY, lines('# Hi', 'Intro', 'Try it free', 'Footer!'));
    expect(overlapOf(store).choices).toEqual([null, null]);
  });

  it('does not transfer consent between identical repeated passages after reanalysis', async () => {
    const repeatedBase = lines('80%', 'separator', '80%', 'footer');
    const mine = lines('85%', 'separator', '85%', 'footer');
    const latest = lines('Most', 'separator', 'Most', 'footer');
    const disk = createDisk(preview(repeatedBase, 'v1'));
    const store = createFileViewerStore(disk.client);
    await store.getState().openFile(REQUEST);
    store.getState().updateContent(KEY, mine);
    disk.write(latest);
    await store.getState().refreshFile(KEY);
    const first = overlapOf(store);
    expect(first.regions).toHaveLength(2);
    store.getState().chooseOverlapVersion(KEY, first.token, 0, 'ours');
    store.getState().updateContent(KEY, mine.replace('footer', 'footer!'));
    expect(overlapOf(store).choices).toEqual([null, null]);
    // Removing one duplicate still cannot move its sibling's old consent.
    store
      .getState()
      .updateContent(KEY, lines('80%', 'separator', '85%', 'footer!'));
    expect(overlapOf(store).choices).toEqual([null]);
  });

  it('requires new choices when a newer snapshot splits a selected passage', async () => {
    const base = 'a\nb\nc\nseparator\nz\n';
    const mine = 'A\nB\nC\nseparator\nZ\n';
    const disk = createDisk(preview(base, 'v1'));
    const store = createFileViewerStore(disk.client);
    await store.getState().openFile(REQUEST);
    store.getState().updateContent(KEY, mine);
    disk.write('X\nY\nW\nseparator\nQ\n');
    await store.getState().refreshFile(KEY);
    const first = overlapOf(store);
    expect(first.regions).toHaveLength(2);
    store.getState().chooseOverlapVersion(KEY, first.token, 0, 'ours');
    disk.write('X\nb\nW\nseparator\nQ\n');
    await store.getState().refreshFile(KEY);
    const split = overlapOf(store);
    expect(split.regions).toHaveLength(3);
    expect(split.choices).toEqual([null, null, null]);
    expect(split.latest.version).toBe('v3');
    expect(store.getState().files[KEY]?.content).toBe(mine);
    store.getState().chooseOverlapVersion(KEY, first.token, 0, 'theirs');
    expect(overlapOf(store).choices).toEqual([null, null, null]);
  });

  it('compares only the conflicting bullets of a rewritten list and saves the newer bullets between them', async () => {
    // Rosa corrects bullets 1 and 3; the agent rewrites all three.
    const list = (...bullets: string[]): string =>
      ['## Outcomes', ...bullets].map((value) => `${value}\n`).join('');
    const listBase = list(
      '- 80% complete',
      '- Twelve workshops',
      '- Quarterly reports',
    );
    const mine = list(
      '- 85% complete',
      '- Twelve workshops',
      '- Monthly reports',
    );
    const agent = list(
      '- Most finish',
      '- A workshop a month',
      '- Board updates',
    );
    const disk = createDisk(preview(listBase, 'v1'));
    const store = createFileViewerStore(disk.client);
    await store.getState().openFile(REQUEST);
    store.getState().updateContent(KEY, mine);
    disk.write(agent);
    store.getState().markFileChanged(KEY, 'agent-edit');
    await flush();

    const overlap = overlapOf(store);
    expect(overlap.regions.map((region) => region.ours)).toEqual([
      '- 85% complete\n',
      '- Monthly reports\n',
    ]);
    store.getState().chooseOverlapVersion(KEY, overlap.token, 0, 'ours');
    expect(store.getState().files[KEY]?.content).toBe(mine);
    store.getState().chooseOverlapVersion(KEY, overlap.token, 1, 'theirs');
    const resolved = list(
      '- 85% complete',
      '- A workshop a month',
      '- Board updates',
    );
    expect(store.getState().files[KEY]).toMatchObject({
      content: resolved,
      overlap: null,
      preview: { version: 'v2' },
    });

    await expect(store.getState().saveFile(KEY)).resolves.toBe(true);
    expect(disk.saves[0]).toMatchObject({
      content: resolved,
      expectedVersion: 'v2',
      expectedModifiedAtMs: mtime('v2'),
    });
  });

  it('settles into the newer version when typing removes every overlap', async () => {
    const { store } = await overlapBeforeSave();
    store
      .getState()
      .updateContent(
        KEY,
        lines('# Welcome', 'Intro', 'Start your trial', 'Footer'),
      );
    expect(store.getState().files[KEY]).toMatchObject({
      content: AGENT,
      dirty: false,
      overlap: null,
      externalChange: null,
      preview: { version: 'v2' },
    });
  });

  it('pauses autosave and turns an explicit Save into the save-time comparison without writing', async () => {
    const { disk, store } = await overlapBeforeSave();
    const before = overlapOf(store);
    await expect(
      store.getState().saveFile(KEY, { origin: 'autosave' }),
    ).resolves.toBe(false);
    expect(store.getState().files[KEY]?.saveConflict).toBeNull();

    await expect(store.getState().saveFile(KEY)).resolves.toBe(false);
    expect(disk.saves).toHaveLength(0);
    expect(store.getState().files[KEY]).toMatchObject({
      externalChange: null,
      saveConflict: {
        reason: 'overlap',
        source: 'agent-edit',
        focusRequest: 1,
        latest: { version: 'v2' },
      },
    });
    expect(overlapOf(store)).toBe(before);
  });

  it('defers a comparison, keeps it hidden on an unchanged read, and shows it again on Save', async () => {
    const edited = lines('# Hello', 'Intro', 'Try it free', 'Footer');
    const { disk, store } = await overlapBeforeSave(edited);
    store
      .getState()
      .chooseOverlapVersion(KEY, overlapOf(store).token, 0, 'ours');
    store.getState().dismissExternalChange(KEY);
    expect(store.getState().files[KEY]).toMatchObject({
      overlap: null,
      externalChange: null,
      baselineStale: true,
      dirty: true,
      preview: { version: 'v1' },
    });

    await store.getState().refreshFile(KEY);
    expect(store.getState().files[KEY]?.overlap).toBeNull();

    await expect(store.getState().saveFile(KEY)).resolves.toBe(false);
    expect(disk.saves).toHaveLength(1);
    expect(store.getState().files[KEY]?.saveConflict).toMatchObject({
      reason: 'overlap',
      focusRequest: 1,
    });
    // Dismissal discarded the partial choice.
    expect(overlapOf(store).choices).toEqual([null, null]);
  });

  it('autosave respects Decide later without reopening or retrying', async () => {
    const { disk, store } = await overlapBeforeSave();
    store.getState().dismissExternalChange(KEY);
    await store.getState().saveFile(KEY, { origin: 'autosave' });
    await store.getState().saveFile(KEY, { origin: 'autosave' });
    expect(disk.saves).toHaveLength(0);
    expect(store.getState().files[KEY]?.saveConflict).toBeNull();
    expect(store.getState().files[KEY]?.overlap).toBeNull();
    await store.getState().saveFile(KEY);
    expect(overlapOf(store).choices).toEqual([null]);
  });

  it('retires a deferred overlap when a newer read merges cleanly', async () => {
    const { disk, store } = await overlapBeforeSave();
    store.getState().dismissExternalChange(KEY);
    await store.getState().refreshFile(KEY);
    await store.getState().saveFile(KEY, { origin: 'autosave' });
    expect(disk.saves).toHaveLength(0);

    // The newer version keeps only the agent's disjoint heading edit.
    disk.write(lines('# Welcome!', 'Intro', 'Get started today', 'Footer'));
    await store.getState().refreshFile(KEY);
    const merged = lines('# Welcome!', 'Intro', 'Try it free', 'Footer');
    expect(store.getState().files[KEY]).toMatchObject({
      preview: { version: 'v3' },
      content: merged,
      dirty: true,
      overlap: null,
      externalChange: null,
      baselineStale: false,
    });
    expect(disk.saves).toHaveLength(0);

    const edited = merged + 'More local text\n';
    store.getState().updateContent(KEY, edited);
    await expect(
      store.getState().saveFile(KEY, { origin: 'autosave' }),
    ).resolves.toBe(true);
    expect(disk.saves).toEqual([
      expect.objectContaining({ content: edited, expectedVersion: 'v3' }),
    ]);
    expect(disk.current().content).toBe(edited);
  });

  it('resolves a save-time comparison and saves against the compared version', async () => {
    const { disk, store } = await overlapBeforeSave();
    store.getState().dismissExternalChange(KEY);
    await store.getState().saveFile(KEY);
    store
      .getState()
      .chooseOverlapVersion(KEY, overlapOf(store).token, 0, 'ours');
    expect(store.getState().files[KEY]).toMatchObject({
      saveConflict: null,
      overlap: null,
      preview: { version: 'v2' },
      dirty: true,
    });
    await expect(store.getState().saveFile(KEY)).resolves.toBe(true);
    expect(disk.saves.at(-1)?.expectedVersion).toBe('v2');
    expect(disk.current().content).toBe(
      lines('# Welcome!', 'Intro', 'Try it free', 'Footer'),
    );
  });

  it('requires a fresh comparison when a third write overlaps after resolution', async () => {
    const { disk, store } = await overlapBeforeSave();
    store
      .getState()
      .chooseOverlapVersion(KEY, overlapOf(store).token, 0, 'ours');
    disk.write(lines('# Welcome!', 'Intro', 'Start free', 'Footer'));
    await expect(store.getState().saveFile(KEY)).resolves.toBe(false);
    expect(store.getState().files[KEY]?.saveConflict?.reason).toBe('overlap');
    expect(overlapOf(store)).toMatchObject({
      latest: { version: 'v3' },
      regions: [{ ours: 'Try it free\n', theirs: 'Start free\n' }],
    });
  });

  it('combines a disjoint third write after resolution through the ordinary save', async () => {
    const { disk, store } = await overlapBeforeSave();
    store
      .getState()
      .chooseOverlapVersion(KEY, overlapOf(store).token, 0, 'ours');
    disk.write(lines('# Welcome!', 'Intro', 'Start your trial', 'Footer.'));
    await expect(store.getState().saveFile(KEY)).resolves.toBe(true);
    expect(disk.current().content).toBe(
      lines('# Welcome!', 'Intro', 'Try it free', 'Footer.'),
    );
  });

  it('settles a disjoint change during the merged write into the buffer without writing again', async () => {
    const edited = lines('# Welcome', 'Intro', 'Try it free', 'Footer');
    const agent = lines('# Welcome!', 'Intro', 'Get started today', 'Footer');
    const { disk, store } = await overlapBeforeSave(edited, agent);
    expect(store.getState().files[KEY]?.overlap ?? null).toBeNull();
    disk.beforeSave((args) => {
      if (args.expectedVersion === 'v2') {
        disk.write(lines('# Welcome!', 'Intro', 'Get started today', 'Fin'));
      }
    });
    await expect(store.getState().saveFile(KEY)).resolves.toBe(false);
    expect(disk.saves).toHaveLength(2);
    expect(store.getState().files[KEY]).toMatchObject({
      status: 'idle',
      content: lines('# Welcome!', 'Intro', 'Try it free', 'Fin'),
      dirty: true,
      saveConflict: null,
      preview: { version: 'v3' },
    });
  });

  it('keeps generic recovery for an incomplete newer version', async () => {
    const disk = createDisk(preview(BASE, 'v1'));
    const store = createFileViewerStore(disk.client);
    await store.getState().openFile(REQUEST);
    store.getState().updateContent(KEY, MINE);
    disk.setRead(() =>
      Promise.resolve({ ...preview(AGENT, 'v2'), truncated: true }),
    );
    store.getState().markFileChanged(KEY, 'agent-edit');
    await flush();
    expect(store.getState().files[KEY]?.externalChange).not.toBeNull();
    expect(store.getState().files[KEY]?.overlap ?? null).toBeNull();
  });

  it('falls back to generic recovery when the combined result is too large', async () => {
    const big = 'x'.repeat(Math.ceil(THREE_WAY_MERGE_MAX_BYTES * 0.6));
    const base = lines('a', 'm', 'z');
    const disk = createDisk(preview(base, 'v1'));
    const store = createFileViewerStore(disk.client);
    await store.getState().openFile(REQUEST);
    store.getState().updateContent(KEY, lines('a', 'mine', 'z', big));
    disk.write(lines(big, 'a', 'agent', 'z'));
    store.getState().markFileChanged(KEY, 'agent-edit');
    await flush();
    store
      .getState()
      .chooseOverlapVersion(KEY, overlapOf(store).token, 0, 'ours');
    expect(store.getState().files[KEY]).toMatchObject({
      overlap: null,
      dirty: true,
      externalChange: { reloading: false },
      preview: { version: 'v1' },
    });
    await store.getState().refreshFile(KEY);
    expect(store.getState().files[KEY]?.overlap).toBeNull();
  });

  it('Discard drops the comparison and loads the newer version', async () => {
    const { store } = await overlapBeforeSave();
    store.getState().discardEdits(KEY);
    await flush();
    expect(store.getState().files[KEY]).toMatchObject({
      content: AGENT,
      dirty: false,
      overlap: null,
      externalChange: null,
    });
  });
  it('applies preserved choices when typing removes the last unchosen passage', async () => {
    const { disk, store } = await overlapBeforeSave(
      lines('# Hello', 'Intro', 'Try it free', 'Footer'),
    );
    store
      .getState()
      .chooseOverlapVersion(KEY, overlapOf(store).token, 0, 'theirs');
    store
      .getState()
      .updateContent(
        KEY,
        lines('# Hello', 'Intro', 'Start your trial', 'Footer'),
      );
    expect(store.getState().files[KEY]).toMatchObject({
      content: AGENT,
      dirty: false,
      overlap: null,
      saveConflict: null,
      preview: { version: 'v2' },
    });
    expect(disk.saves).toHaveLength(0);
  });

  it('falls back to generic recovery when a refresh cannot read the newer version', async () => {
    const { disk, store } = await overlapBeforeSave();
    const stale = overlapOf(store).token;
    disk.setRead(() => Promise.reject(new Error('offline')));
    await store.getState().refreshFile(KEY);
    expect(store.getState().files[KEY]).toMatchObject({
      overlap: null,
      content: MINE,
      externalChange: { error: 'offline' },
    });
    store.getState().chooseOverlapVersion(KEY, stale, 0, 'theirs');
    expect(store.getState().files[KEY]?.content).toBe(MINE);
  });

  it('reports a skipped merge when editing a save-time comparison into a binary buffer', async () => {
    const { store } = await overlapBeforeSave();
    await store.getState().saveFile(KEY);
    store.getState().updateContent(KEY, MINE + '\0');
    expect(store.getState().files[KEY]).toMatchObject({
      overlap: null,
      saveConflict: { reason: 'merge-skipped' },
      dirty: true,
    });
  });
});
