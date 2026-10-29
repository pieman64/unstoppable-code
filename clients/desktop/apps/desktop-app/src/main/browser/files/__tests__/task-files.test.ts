import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  writeFile,
  readdir,
  rm,
  symlink,
  rename,
} from 'node:fs/promises';
import type * as fsPromisesModule from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type * as fsModule from 'node:fs';
import { linkSync, renameSync } from 'node:fs';
import type { BrowserFilesSessionEvent } from '../task-files';
import type { BrowserEvent } from '@canopy/desktop-shared/types/browser';
import { BrowserTaskFiles, type BrowserTaskFilesDeps } from '../task-files';

jest.setTimeout(20000);
// The real link, replaceable by one test that has no hard links.
jest.mock('node:fs', () => {
  const actual = jest.requireActual<typeof fsModule>('node:fs');
  return {
    ...actual,
    linkSync: jest.fn(actual.linkSync),
    renameSync: jest.fn(actual.renameSync),
  };
});
// The real open, which the copy without hard links uses.
jest.mock('node:fs/promises', () => {
  const actual =
    jest.requireActual<typeof fsPromisesModule>('node:fs/promises');
  return { ...actual, open: jest.fn(actual.open) };
});

const scope = { projectId: 'project', worktreeId: 'task' };
const runtime = {
  browserId: 'tab',
  runtimeGeneration: 2,
  taskIncarnationId: 'incarnation',
};
let root: string;
let now: number;
let events: BrowserEvent[];
let diagnostics: BrowserFilesSessionEvent[];
let store: BrowserTaskFiles;
function create(deps: Partial<BrowserTaskFilesDeps> = {}): BrowserTaskFiles {
  return new BrowserTaskFiles({
    taskDir: () => root,
    now: () => now,
    platform: 'linux',
    emit: (event) => events.push(event),
    recordEvent: (_scope, event) => diagnostics.push(event),
    ...deps,
  });
}
function admit(
  id = 'one',
  extra: Partial<Parameters<BrowserTaskFiles['admitDownload']>[0]> = {},
): ReturnType<BrowserTaskFiles['admitDownload']> {
  return store.admitDownload({
    scope,
    runtime,
    downloadId: id,
    suggestedName: 'report.csv',
    url: 'https://example.com/report?q=secret#fragment',
    totalBytes: 10,
    source: 'user',
    ...extra,
  });
}
function staging(
  id = 'one',
  extra: Partial<Parameters<BrowserTaskFiles['admitDownload']>[0]> = {},
): string {
  const result = admit(id, extra);
  if (!result.ok) throw new Error(result.reason);
  return result.stagingPath;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'browser-task-files-'));
  now = 1000;
  events = [];
  diagnostics = [];
  store = create();
});
afterEach(async () => {
  await store.drain();
  await rm(root, { recursive: true, force: true });
});

it('reserves synchronous contained staging paths and in-flight collisions', async () => {
  const first = staging();
  const second = staging('two');
  expect(first).toBe(
    join(root, 'browser-files', 'downloads', 'report.csv.download'),
  );
  expect(second).toBe(
    join(root, 'browser-files', 'downloads', 'report (1).csv.download'),
  );
  await store.drain();
  expect(
    JSON.parse(
      await readFile(join(root, 'browser-files', 'files.json'), 'utf8'),
    ),
  ).toMatchObject({ version: 1, records: [{ id: 'one' }, { id: 'two' }] });
});
it('indexes existing complete and staging names before bind', async () => {
  await mkdir(join(root, 'browser-files', 'downloads'), { recursive: true });
  await writeFile(
    join(root, 'browser-files', 'downloads', 'report.csv'),
    'old',
  );
  await writeFile(
    join(root, 'browser-files', 'downloads', 'report (1).csv.download'),
    'old',
  );
  expect(staging()).toContain('report (2).csv.download');
});
it.each(['browser-files', 'browser-files/downloads'])(
  'refuses escaped symlink folder %s',
  async (folder) => {
    const outside = join(root, 'outside');
    await mkdir(outside);
    await mkdir(join(root, 'browser-files'), { recursive: true });
    if (folder === 'browser-files')
      await rm(join(root, folder), { recursive: true });
    await symlink(outside, join(root, folder));
    expect(admit()).toEqual({ ok: false, reason: 'unavailable' });
    expect(await readdir(outside)).toEqual([]);
  },
);
it('never stages a download at a name a symlink already has', async () => {
  await store.bind(scope);
  const link = join(root, 'browser-files', 'downloads', 'report.csv.download');
  await symlink(join(root, 'outside'), link);
  const admitted = admit();
  if (!admitted.ok) throw new Error(admitted.reason);
  expect(admitted.stagingPath).not.toBe(link);
  expect(admitted.record.fileName).toBe('report (1).csv');
  await expect(readdir(root)).resolves.not.toContain('outside');
});
it('renames complete files without following a final symlink and emits final once', async () => {
  const path = staging();
  await writeFile(path, 'bytes');
  const outside = join(root, 'outside');
  await writeFile(outside, 'untouched');
  await symlink(
    outside,
    join(root, 'browser-files', 'downloads', 'report.csv'),
  );
  await store.completeDownload('one');
  expect(await readFile(outside, 'utf8')).toBe('untouched');
  expect(
    await readFile(
      join(root, 'browser-files', 'downloads', 'report (1).csv'),
      'utf8',
    ),
  ).toBe('bytes');
  expect(store.get(scope, 'one')).toMatchObject({
    status: 'complete',
    fileName: 'report (1).csv',
    endedAt: now,
  });
  await store.completeDownload('one');
  expect(
    diagnostics.filter((event) => event.kind === 'browser_download_finished'),
  ).toHaveLength(1);
});
it('refuses symlink staging on completion and a swapped downloads parent', async () => {
  const path = staging();
  const outside = join(root, 'outside');
  await writeFile(outside, 'untouched');
  await symlink(outside, path);
  await store.completeDownload('one');
  expect(store.get(scope, 'one')?.status).toBe('failed');
  expect(await readFile(outside, 'utf8')).toBe('untouched');
  const next = staging('two');
  await writeFile(next, 'bytes');
  await rename(
    join(root, 'browser-files', 'downloads'),
    join(root, 'old-downloads'),
  );
  await mkdir(join(root, 'outside-dir'));
  await symlink(
    join(root, 'outside-dir'),
    join(root, 'browser-files', 'downloads'),
  );
  await store.completeDownload('two');
  expect(store.get(scope, 'two')?.status).toBe('failed');
  expect(await readdir(join(root, 'outside-dir'))).toEqual([]);
  await expect(store.drain()).resolves.toBeUndefined();
  await rm(join(root, 'browser-files', 'downloads'));
  await rename(
    join(root, 'old-downloads'),
    join(root, 'browser-files', 'downloads'),
  );
});
it.each(['cancelled', 'failed', 'interrupted'] as const)(
  'deletes staging for terminal %s, ignores late progress',
  async (status) => {
    const path = staging();
    await writeFile(path, 'partial');
    await store.discardDownload('one', status);
    store.updateDownload('one', { status: 'in_progress', receivedBytes: 1 });
    await store.drain();
    expect(
      await readdir(join(root, 'browser-files', 'downloads')),
    ).not.toContain('report.csv.download');
    expect(store.get(scope, 'one')).toMatchObject({ status, canResume: false });
  },
);
it('keeps resumable interruption live and prevents bytes moving backward', async () => {
  const path = staging();
  await writeFile(path, 'partial');
  store.updateDownload('one', {
    receivedBytes: 8,
    status: 'interrupted',
    canResume: true,
  });
  store.updateDownload('one', { receivedBytes: 2 });
  expect(store.get(scope, 'one')).toMatchObject({
    status: 'interrupted',
    receivedBytes: 8,
    canResume: true,
  });
  expect(await readFile(path, 'utf8')).toBe('partial');
  store.updateDownload('one', { status: 'in_progress', canResume: false });
  expect(store.get(scope, 'one')?.status).toBe('in_progress');
});
it('recovers once, deletes recovered partials and temp catalogs but preserves complete files', async () => {
  const complete = staging('complete');
  await writeFile(complete, 'complete');
  await store.completeDownload('complete');
  const paused = staging('paused');
  await writeFile(paused, 'partial');
  store.updateDownload('paused', { status: 'paused' });
  await store.drain();
  await writeFile(
    join(root, 'browser-files', 'downloads', 'orphan.download'),
    'partial',
  );
  await writeFile(join(root, 'browser-files', '.files-orphan.tmp'), 'broken');
  store = create();
  await Promise.all([store.bind(scope), store.bind(scope)]);
  expect(store.get(scope, 'paused')).toMatchObject({
    status: 'interrupted',
    canResume: false,
  });
  // A partial file no record names is not known to be a partial: it stays.
  expect(
    (await readdir(join(root, 'browser-files', 'downloads'))).sort(),
  ).toEqual(['orphan.download', 'report.csv']);
  expect(await readdir(join(root, 'browser-files'))).not.toContain(
    '.files-orphan.tmp',
  );
  const live = staging('live');
  await writeFile(live, 'live');
  await store.bind(scope);
  expect(await readFile(live, 'utf8')).toBe('live');
});
it('serializes whole snapshots through a single queue and drain joins writes', async () => {
  const snapshots: string[] = [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  store = create({
    beforeCatalogWrite: async (_scope, snapshot) => {
      snapshots.push(snapshot);
      if (snapshots.length === 1) await gate;
    },
  });
  staging();
  store.updateDownload('one', { receivedBytes: 8 });
  let drained = false;
  const pending = store.drain().then(() => {
    drained = true;
  });
  await new Promise(setImmediate);
  expect(snapshots).toHaveLength(1);
  expect(drained).toBe(false);
  release?.();
  await pending;
  expect(
    JSON.parse(
      await readFile(join(root, 'browser-files', 'files.json'), 'utf8'),
    ),
  ).toMatchObject({ records: [{ receivedBytes: 8 }] });
  expect(
    (await readdir(join(root, 'browser-files'))).filter((name) =>
      name.endsWith('.tmp'),
    ),
  ).toEqual([]);
});
it('maps injected ENOSPC to disk_full and deletes partial bytes', async () => {
  let fail = true;
  // The write fails only once the download's bytes are on disk.
  let partialWritten = (): void => undefined;
  const written = new Promise<void>((resolve) => {
    partialWritten = resolve;
  });
  store = create({
    beforeCatalogWrite: async () => {
      if (fail) {
        fail = false;
        await written;
        throw Object.assign(new Error('full'), { code: 'ENOSPC' });
      }
    },
  });
  const path = staging();
  await writeFile(path, 'partial');
  partialWritten();
  await store.drain();
  expect(store.get(scope, 'one')).toMatchObject({
    status: 'failed',
    error: { code: 'disk_full' },
  });
  expect(await readdir(join(root, 'browser-files', 'downloads'))).toEqual([]);
});
it('fences late admissions, joins removal, and never recreates a removed scope', async () => {
  const path = staging();
  await writeFile(path, 'partial');
  store.fence(scope);
  expect(admit('late')).toEqual({ ok: false, reason: 'fenced' });
  await store.discardDownload('one', 'cancelled');
  await store.drain();
  await store.removeTask(scope);
  expect(await readdir(root)).not.toContain('browser-files');
  await store.bind(scope);
  expect(admit('later')).toEqual({ ok: false, reason: 'fenced' });
  expect(await readdir(root)).not.toContain('browser-files');
});
it('limits three active across all sources, coalesces blocked notices, allowMore does not reset active', async () => {
  staging('one', { source: 'agent' });
  staging('two', { source: 'print' });
  staging('three', { source: 'pdf_document' });
  for (let index = 0; index < 10; index++)
    expect(
      admit(`blocked-${index}`, { url: 'data:text/plain,secret' }),
    ).toEqual({ ok: false, reason: 'rate_limited' });
  expect(
    events.filter((event) => event.type === 'download-blocked'),
  ).toHaveLength(1);
  store.allowMore('tab');
  expect(admit('still-active')).toEqual({ ok: false, reason: 'rate_limited' });
  await store.discardDownload('one', 'cancelled');
  expect(admit('allowed').ok).toBe(true);
});
it('limits twenty admissions per rolling minute and allowMore resets only the rolling window', async () => {
  for (let index = 0; index < 20; index++) {
    staging(String(index));
    await store.discardDownload(String(index), 'cancelled');
  }
  expect(admit('blocked')).toEqual({ ok: false, reason: 'rate_limited' });
  store.allowMore('tab');
  expect(admit('explicit').ok).toBe(true);
  await store.discardDownload('explicit', 'cancelled');
  now += 60001;
  expect(admit('later').ok).toBe(true);
});
it('keys attribution by the entire runtime and projects only host-neutral DTOs and diagnostics', async () => {
  store.setAttribution(runtime, 'action');
  staging();
  const newer = { ...runtime, runtimeGeneration: 3 };
  const reincarnated = { ...runtime, taskIncarnationId: 'other' };
  expect(store.attributionFor(newer)).toBeUndefined();
  expect(store.attributionFor(reincarnated)).toBeUndefined();
  expect(store.forAction(runtime, 'action')).toHaveLength(1);
  expect(store.forAction(newer, 'action')).toEqual([]);
  store.setAttribution(runtime, undefined);
  expect(store.attributionFor(runtime)).toBeUndefined();
  expect(store.get(scope, 'one')?.origin).toBe('https://example.com/report');
  staging('blob', { url: 'blob:https://example.com/private?secret' });
  staging('data', { url: 'data:text/plain,secret' });
  expect(store.get(scope, 'blob')?.origin).toBe('blob:');
  expect(store.get(scope, 'data')?.origin).toBe('data:');
  const json = JSON.stringify([
    store.list(scope, 'tab', { browserId: 'tab' }),
    events,
    diagnostics,
  ]);
  expect(json).not.toContain(root);
  expect(json).not.toContain('secret');
  expect(json).not.toContain('fragment');
  await store.drain();
});
it('records an action named at admission when no action window attributes it', async () => {
  staging('named', { source: 'print', actionId: 'save-pdf-1' });
  expect(store.get(scope, 'named')).toMatchObject({ actionId: 'save-pdf-1' });
  store.setAttribution(runtime, 'window');
  staging('both', { actionId: 'save-pdf-2' });
  expect(store.get(scope, 'both')).toMatchObject({ actionId: 'save-pdf-2' });
  await store.drain();
});
it('lists only the browser scope newest first with filtering and bounded pagination', async () => {
  staging('one');
  now++;
  staging('two');
  now++;
  staging('three', { runtime: { ...runtime, browserId: 'other' } });
  await store.discardDownload('one', 'cancelled');
  expect(
    store.list(scope, 'tab', { browserId: 'tab', offset: 1, limit: 1000 }),
  ).toMatchObject({
    total: 2,
    offset: 1,
    limit: 100,
    transfers: [{ id: 'one' }],
  });
  expect(
    store.list(scope, 'tab', { browserId: 'tab', status: 'cancelled' })
      .transfers,
  ).toHaveLength(1);
  expect(store.get({ ...scope, worktreeId: 'other' }, 'one')).toBeUndefined();
});
it('resolves complete local paths only with realpath containment and regular-file checks', async () => {
  const path = staging();
  expect(await store.resolveLocalPath(scope, 'one')).toBeUndefined();
  await writeFile(path, 'complete');
  await store.completeDownload('one');
  expect(await store.resolveLocalPath(scope, 'one')).toBe(
    join(root, 'browser-files', 'downloads', 'report.csv'),
  );
  await rm(join(root, 'browser-files', 'downloads', 'report.csv'));
  await writeFile(join(root, 'outside'), 'outside');
  await symlink(
    join(root, 'outside'),
    join(root, 'browser-files', 'downloads', 'report.csv'),
  );
  expect(await store.resolveLocalPath(scope, 'one')).toBeUndefined();
});
it('waits for the first admission after since, reports progress, and terminal states resolve', async () => {
  staging('old');
  const controller = new AbortController();
  const progress = jest.fn();
  const waiting = store.waitForDownload(scope, 'tab', {
    since: now,
    signal: controller.signal,
    onProgress: progress,
  });
  now++;
  staging('next');
  store.updateDownload('next', { status: 'interrupted', canResume: true });
  let finished = false;
  void waiting.then(() => {
    finished = true;
  });
  await new Promise(setImmediate);
  expect(finished).toBe(false);
  await store.discardDownload('next', 'interrupted');
  expect(await waiting).toMatchObject({
    id: 'next',
    status: 'interrupted',
    canResume: false,
  });
  expect(progress).toHaveBeenCalled();
});
it.each(['complete', 'cancelled', 'failed', 'interrupted'] as const)(
  'specific wait resolves final %s, even started before since',
  async (status) => {
    const path = staging();
    await writeFile(path, 'bytes');
    const waiting = store.waitForDownload(scope, 'tab', {
      downloadId: 'one',
      since: now + 1,
      signal: new AbortController().signal,
    });
    if (status === 'complete') await store.completeDownload('one');
    else await store.discardDownload('one', status);
    expect(await waiting).toMatchObject({ id: 'one', status });
  },
);
it('aborts waits including already-aborted signals and never observes another browser', async () => {
  const controller = new AbortController();
  const wait = store.waitForDownload(scope, 'tab', {
    since: now,
    signal: controller.signal,
  });
  controller.abort();
  expect(await wait).toBeUndefined();
  expect(
    await store.waitForDownload(scope, 'tab', {
      since: now,
      signal: controller.signal,
    }),
  ).toBeUndefined();
});
it('throttles transfer events to 250 ms but always emits final status', async () => {
  staging();
  store.updateDownload('one', { receivedBytes: 1 });
  now += 249;
  store.updateDownload('one', { receivedBytes: 2 });
  expect(events.filter((event) => event.type === 'transfer')).toHaveLength(1);
  now++;
  store.updateDownload('one', { receivedBytes: 3 });
  expect(events.filter((event) => event.type === 'transfer')).toHaveLength(2);
  await store.discardDownload('one', 'cancelled');
  expect(events.filter((event) => event.type === 'transfer')).toHaveLength(3);
});
it('marks macOS downloads with com.apple.quarantine before complete is published', async () => {
  if (process.platform !== 'darwin') return;
  store = create({ platform: 'darwin' });
  const path = staging();
  await writeFile(path, 'content');
  await store.completeDownload('one');
  expect(store.get(scope, 'one')?.status).toBe('complete');
  expect(
    execFileSync(
      '/usr/bin/xattr',
      [
        '-p',
        'com.apple.quarantine',
        join(root, 'browser-files', 'downloads', 'report.csv'),
      ],
      { encoding: 'utf8' },
    ),
  ).toMatch(/^0081;/);
});

it('removeTask removes persisted files even before the scope was bound', async () => {
  await mkdir(join(root, 'browser-files', 'downloads'), { recursive: true });
  await writeFile(
    join(root, 'browser-files', 'downloads', 'orphan.download'),
    'partial',
  );
  await store.removeTask(scope);
  expect(await readdir(root)).not.toContain('browser-files');
  expect(admit()).toEqual({ ok: false, reason: 'fenced' });
});
it('reports completion catalog ENOSPC as failed rather than publishing complete', async () => {
  let writes = 0;
  store = create({
    beforeCatalogWrite: () => {
      writes++;
      if (writes === 2)
        throw Object.assign(new Error('full'), { code: 'ENOSPC' });
    },
  });
  const path = staging();
  await store.drain();
  await writeFile(path, 'bytes');
  await store.completeDownload('one');
  await store.drain();
  expect(store.get(scope, 'one')).toMatchObject({
    status: 'failed',
    error: { code: 'disk_full' },
  });
  expect(
    events.filter(
      (event) =>
        event.type === 'transfer' && event.transfer.status === 'complete',
    ),
  ).toEqual([]);
  expect(await readdir(join(root, 'browser-files', 'downloads'))).toEqual([]);
});
it('permanent catalog write failure settles drain and marks every active record failed', async () => {
  // The write fails only once the download's bytes are on disk.
  let partialWritten = (): void => undefined;
  const written = new Promise<void>((resolve) => {
    partialWritten = resolve;
  });
  store = create({
    beforeCatalogWrite: async () => {
      await written;
      throw Object.assign(new Error('full'), { code: 'ENOSPC' });
    },
  });
  const path = staging();
  await writeFile(path, 'partial');
  partialWritten();
  await expect(store.drain()).resolves.toBeUndefined();
  expect(store.get(scope, 'one')).toMatchObject({
    status: 'failed',
    error: { code: 'disk_full' },
  });
  expect(await readdir(join(root, 'browser-files', 'downloads'))).toEqual([]);
});

it('wait selects a subsequent admission in the same millisecond, not an existing record', async () => {
  staging('old');
  const signal = new AbortController();
  const progress = jest.fn();
  const waiting = store.waitForDownload(scope, 'tab', {
    since: now,
    signal: signal.signal,
    onProgress: progress,
  });
  staging('next');
  expect(progress).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'next' }),
  );
  await store.discardDownload('next', 'cancelled');
  expect(await waiting).toMatchObject({ id: 'next', status: 'cancelled' });
});
it('keeps a renamed download and files it did not write when it recovers', async () => {
  const downloads = join(root, 'browser-files', 'downloads');
  await writeFile(staging('complete'), 'complete');
  await store.completeDownload('complete');
  await writeFile(staging('running'), 'partial');
  await store.drain();
  await rename(join(downloads, 'report.csv'), join(downloads, 'renamed.csv'));
  await writeFile(join(downloads, 'notes.txt'), 'mine');
  store = create();
  await store.bind(scope);
  expect(store.get(scope, 'running')).toMatchObject({
    status: 'interrupted',
    canResume: false,
  });
  expect((await readdir(downloads)).sort()).toEqual([
    'notes.txt',
    'renamed.csv',
  ]);
  expect(await readFile(join(downloads, 'renamed.csv'), 'utf8')).toBe(
    'complete',
  );
});
it.each(['missing', 'unreadable'] as const)(
  'keeps every finished file when the catalog is %s',
  async (damage) => {
    const downloads = join(root, 'browser-files', 'downloads');
    await writeFile(staging(), 'complete');
    await store.completeDownload('one');
    await store.drain();
    const catalog = join(root, 'browser-files', 'files.json');
    if (damage === 'missing') await rm(catalog);
    else await writeFile(catalog, '{"version":1,');
    store = create();
    await store.bind(scope);
    expect(await readFile(join(downloads, 'report.csv'), 'utf8')).toBe(
      'complete',
    );
  },
);
it('does not reuse a name a file took after the task was opened', async () => {
  await store.bind(scope);
  await writeFile(
    join(root, 'browser-files', 'downloads', 'report.csv'),
    'mine',
  );
  expect(staging()).toBe(
    join(root, 'browser-files', 'downloads', 'report (1).csv.download'),
  );
});
it('does not overwrite a file that takes the name before the download finishes', async () => {
  const downloads = join(root, 'browser-files', 'downloads');
  await writeFile(staging(), 'bytes');
  await writeFile(join(downloads, 'report.csv'), 'mine');
  await store.completeDownload('one');
  expect(await readFile(join(downloads, 'report.csv'), 'utf8')).toBe('mine');
  expect(store.get(scope, 'one')).toMatchObject({
    status: 'complete',
    fileName: 'report (1).csv',
  });
  expect(await readFile(join(downloads, 'report (1).csv'), 'utf8')).toBe(
    'bytes',
  );
  expect((await readdir(downloads)).sort()).toEqual([
    'report (1).csv',
    'report.csv',
  ]);
  expect(
    events
      .filter(
        (event) => event.type === 'transfer' && event.transfer.id === 'one',
      )
      .at(-1),
  ).toMatchObject({
    transfer: { status: 'complete', fileName: 'report (1).csv' },
  });
});
it("never stages a download at another download's final name", async () => {
  const downloads = join(root, 'browser-files', 'downloads');
  const first = staging('first', { suggestedName: 'x.txt.download' });
  const second = staging('second', { suggestedName: 'x.txt' });
  expect(second).not.toBe(join(downloads, 'x.txt.download'));
  await writeFile(first, 'first');
  await writeFile(second, 'second');
  await store.completeDownload('first');
  await store.completeDownload('second');
  const one = store.get(scope, 'first');
  const two = store.get(scope, 'second');
  expect([one?.status, two?.status]).toEqual(['complete', 'complete']);
  expect(one?.fileName).toBe('x.txt.download');
  if (one?.kind !== 'download' || two?.kind !== 'download')
    throw new Error('Missing downloads');
  expect(await readFile(join(downloads, one.fileName), 'utf8')).toBe('first');
  expect(await readFile(join(downloads, two.fileName), 'utf8')).toBe('second');
});
it("admits a download whose partial file would be a finished download's name", async () => {
  await writeFile(staging('first', { suggestedName: 'x.txt.download' }), 'a');
  await store.completeDownload('first');
  const second = admit('second', { suggestedName: 'x.txt' });
  expect(second.ok).toBe(true);
});
it('announces a block again after its notice could have been dismissed', () => {
  jest.useFakeTimers();
  try {
    const blocked = (): BrowserEvent[] =>
      events.filter((event) => event.type === 'download-blocked');
    staging('one');
    staging('two');
    staging('three');
    expect(admit('first-block').ok).toBe(false);
    expect(admit('burst').ok).toBe(false);
    // A burst is one announcement, and the attempt after it is not lost.
    expect(blocked()).toHaveLength(1);
    now += 1000;
    jest.advanceTimersByTime(1000);
    expect(blocked()).toHaveLength(2);
    expect(blocked().at(-1)).toMatchObject({ blockedCount: 2 });
    now += 5000;
    expect(admit('much-later').ok).toBe(false);
    expect(blocked()).toHaveLength(3);
    store.allowMore('tab');
    expect(admit('after-allow').ok).toBe(false);
    expect(blocked()).toHaveLength(4);
    store.allowMore('tab');
    jest.advanceTimersByTime(5000);
    expect(blocked()).toHaveLength(4);
  } finally {
    jest.useRealTimers();
  }
});
it('moves a finished download without a hard link only into a free name', async () => {
  const downloads = join(root, 'browser-files', 'downloads');
  const link = jest.mocked(linkSync);
  link.mockImplementation((): void => {
    throw Object.assign(new Error('Operation not supported'), {
      code: 'ENOTSUP',
    });
  });
  try {
    await writeFile(staging(), 'bytes');
    await writeFile(join(downloads, 'report.csv'), 'mine');
    await store.completeDownload('one');
    expect(link).toHaveBeenCalled();
    expect(await readFile(join(downloads, 'report.csv'), 'utf8')).toBe('mine');
    expect(store.get(scope, 'one')).toMatchObject({
      status: 'complete',
      fileName: 'report (1).csv',
    });
    expect(await readFile(join(downloads, 'report (1).csv'), 'utf8')).toBe(
      'bytes',
    );
  } finally {
    link.mockImplementation(
      jest.requireActual<typeof fsModule>('node:fs').linkSync,
    );
  }
});
it('leaves a file that replaced the download before it was marked', async () => {
  const downloads = join(root, 'browser-files', 'downloads');
  const outside = join(root, 'outside');
  await writeFile(outside, 'untouched');
  const actual = jest.requireActual<typeof fsModule>('node:fs');
  // The user moves the finished file away and something else takes its name
  // before the download is marked.
  jest
    .mocked(linkSync)
    .mockImplementationOnce(
      (from: fsModule.PathLike, to: fsModule.PathLike) => {
        actual.linkSync(from, to);
        actual.renameSync(to, join(downloads, 'moved.csv'));
        actual.symlinkSync(outside, to);
      },
    );
  await writeFile(staging(), 'bytes');
  await store.completeDownload('one');
  expect(store.get(scope, 'one')?.status).toBe('failed');
  expect(actual.lstatSync(join(downloads, 'report.csv')).isSymbolicLink()).toBe(
    true,
  );
  expect(await readFile(outside, 'utf8')).toBe('untouched');
  expect(await readFile(join(downloads, 'moved.csv'), 'utf8')).toBe('bytes');
});
it('does not remove a file that took the name when the completion cannot be recorded', async () => {
  const downloads = join(root, 'browser-files', 'downloads');
  let armed = false;
  store = create({
    beforeCatalogWrite: async (_scope, snapshot) => {
      if (!armed || !snapshot.includes('"complete"')) return;
      armed = false;
      await rename(join(downloads, 'report.csv'), join(downloads, 'moved.csv'));
      await writeFile(join(downloads, 'report.csv'), 'mine');
      throw Object.assign(new Error('full'), { code: 'ENOSPC' });
    },
  });
  const path = staging();
  await store.drain();
  await writeFile(path, 'bytes');
  armed = true;
  await store.completeDownload('one');
  await store.drain();
  expect(store.get(scope, 'one')).toMatchObject({
    status: 'failed',
    error: { code: 'disk_full' },
  });
  expect(await readFile(join(downloads, 'report.csv'), 'utf8')).toBe('mine');
});
it('tells its listeners about each download it fails while the download still runs', async () => {
  let failing = false;
  store = create({
    beforeCatalogWrite: () => {
      if (failing) throw Object.assign(new Error('full'), { code: 'ENOSPC' });
    },
  });
  const failed: string[] = [];
  const removed: string[] = [];
  store.onDownloadFailed((id) => failed.push(id));
  const stop = store.onDownloadFailed((id) => removed.push(id));
  stop();
  await writeFile(staging(), 'partial');
  await writeFile(staging('done'), 'bytes');
  await store.completeDownload('done');
  await store.drain();
  failing = true;
  store.updateDownload('one', { receivedBytes: 4 });
  await store.drain();
  expect(store.get(scope, 'one')?.status).toBe('failed');
  expect(store.get(scope, 'done')?.status).toBe('complete');
  expect(failed).toEqual(['one']);
  expect(removed).toEqual([]);
});
it('reports a download complete only once its catalog write has succeeded', async () => {
  let release: (() => void) | undefined;
  let armed = false;
  store = create({
    beforeCatalogWrite: (_scope, snapshot): Promise<void> | undefined => {
      if (!armed || !snapshot.includes('"complete"')) return undefined;
      armed = false;
      return new Promise<void>((_resolve, reject) => {
        release = (): void =>
          reject(Object.assign(new Error('full'), { code: 'ENOSPC' }));
      });
    },
  });
  const path = staging();
  await store.drain();
  await writeFile(path, 'bytes');
  const seen: string[] = [];
  const waited = store.waitForDownload(scope, 'tab', {
    downloadId: 'one',
    since: 0,
    signal: new AbortController().signal,
    onProgress: (transfer) => seen.push(transfer.status),
  });
  armed = true;
  const completing = store.completeDownload('one');
  for (let turn = 0; turn < 100 && !release; turn++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  if (!release) throw new Error('The completion write never started');
  // While the write is pending nothing may read the download as complete,
  // including a waiter woken by another download's update.
  expect(store.get(scope, 'one')?.status).toBe('in_progress');
  expect(store.list(scope, 'tab', {}).transfers[0]?.status).toBe('in_progress');
  expect(admit('two').ok).toBe(true);
  release();
  await completing;
  await store.drain();
  await expect(waited).resolves.toMatchObject({ status: 'failed' });
  expect(seen).not.toContain('complete');
  expect(
    events.some(
      (event) =>
        event.type === 'transfer' &&
        event.transfer.id === 'one' &&
        event.transfer.status === 'complete',
    ),
  ).toBe(false);
  expect(store.get(scope, 'one')).toMatchObject({
    status: 'failed',
    error: { code: 'disk_full' },
  });
  expect(
    (await readdir(join(root, 'browser-files', 'downloads'))).filter((name) =>
      name.startsWith('report.csv'),
    ),
  ).toEqual([]);
});
it.each(['cancelled', 'failed', 'interrupted'] as const)(
  "never removes a file that later takes a %s download's partial name",
  async (status) => {
    const partial = join(
      root,
      'browser-files',
      'downloads',
      'report.csv.download',
    );
    await writeFile(staging(), 'partial');
    await store.discardDownload('one', status);
    await store.drain();
    await writeFile(partial, 'mine');
    await store.drain();
    expect(await readFile(partial, 'utf8')).toBe('mine');
    // Nor does the next start's recovery.
    store = create();
    await store.bind(scope);
    await store.drain();
    expect(await readFile(partial, 'utf8')).toBe('mine');
  },
);
it.each(['cancel', 'complete'] as const)(
  "does not %s through a file that replaced a running download's partial file",
  async (ending) => {
    const downloads = join(root, 'browser-files', 'downloads');
    const path = staging();
    await writeFile(path, 'partial');
    // The store has seen the download's own partial file.
    store.updateDownload('one', { receivedBytes: 7, status: 'in_progress' });
    await rename(path, join(root, 'moved-partial'));
    await writeFile(path, 'mine');
    if (ending === 'cancel') await store.discardDownload('one', 'cancelled');
    else await store.completeDownload('one');
    await store.drain();
    expect(await readFile(path, 'utf8')).toBe('mine');
    expect(await readdir(downloads)).toEqual(['report.csv.download']);
    const record = store.get(scope, 'one');
    expect(record?.status).toBe(ending === 'cancel' ? 'cancelled' : 'failed');
    expect(
      events.some(
        (event) =>
          event.type === 'transfer' && event.transfer.status === 'complete',
      ),
    ).toBe(false);
  },
);
it('without hard links, takes the next name when the file appears before the copy', async () => {
  const downloads = join(root, 'browser-files', 'downloads');
  const actual = jest.requireActual<typeof fsModule>('node:fs');
  const link = jest.mocked(linkSync);
  link.mockImplementation((_from: fsModule.PathLike, to: fsModule.PathLike) => {
    if (String(to) === join(downloads, 'report.csv'))
      actual.writeFileSync(to, 'mine');
    throw Object.assign(new Error('Operation not supported'), {
      code: 'ENOTSUP',
    });
  });
  try {
    await writeFile(staging(), 'bytes');
    await store.completeDownload('one');
    expect(await readFile(join(downloads, 'report.csv'), 'utf8')).toBe('mine');
    expect(store.get(scope, 'one')).toMatchObject({
      status: 'complete',
      fileName: 'report (1).csv',
    });
    expect(await readFile(join(downloads, 'report (1).csv'), 'utf8')).toBe(
      'bytes',
    );
    expect(await readdir(downloads)).toEqual(['report (1).csv', 'report.csv']);
  } finally {
    link.mockImplementation(actual.linkSync);
  }
});
it('does not finish a same-size file that replaced the partial file it followed', async () => {
  const downloads = join(root, 'browser-files', 'downloads');
  const path = staging();
  await writeFile(path, 'partial');
  store.updateDownload('one', { receivedBytes: 7, status: 'in_progress' });
  await rename(path, join(root, 'moved-partial'));
  await writeFile(path, 'mine!!!');
  await store.completeDownload('one');
  expect(store.get(scope, 'one')?.status).toBe('failed');
  expect(await readFile(path, 'utf8')).toBe('mine!!!');
  expect(await readdir(downloads)).toEqual(['report.csv.download']);
});
/** Without hard links for the duration of `run`; `wrap` may change the copy's target file. */
async function withoutHardLinks(
  run: () => Promise<void>,
  wrap?: (
    path: string,
    handle: fsPromisesModule.FileHandle,
  ) => fsPromisesModule.FileHandle,
  beforeExclusiveOpen?: (path: string) => void,
): Promise<void> {
  const actualFs = jest.requireActual<typeof fsModule>('node:fs');
  const actualPromises =
    jest.requireActual<typeof fsPromisesModule>('node:fs/promises');
  const link = jest.mocked(linkSync);
  const opened = jest.mocked(open);
  link.mockImplementation((): void => {
    throw Object.assign(new Error('Operation not supported'), {
      code: 'ENOTSUP',
    });
  });
  opened.mockImplementation(
    async (
      path: fsModule.PathLike,
      flags?: string | number,
      mode?: fsModule.Mode,
    ): Promise<fsPromisesModule.FileHandle> => {
      const exclusive =
        typeof flags === 'number' && (flags & actualFs.constants.O_EXCL) !== 0;
      if (exclusive) beforeExclusiveOpen?.(String(path));
      const handle = await actualPromises.open(path, flags, mode);
      return exclusive && wrap ? wrap(String(path), handle) : handle;
    },
  );
  try {
    await run();
  } finally {
    link.mockImplementation(actualFs.linkSync);
    opened.mockImplementation(actualPromises.open);
  }
}
/** The handle with its `write` replaced. */
function withWrite(
  handle: fsPromisesModule.FileHandle,
  write: fsPromisesModule.FileHandle['write'],
): fsPromisesModule.FileHandle {
  return new Proxy(handle, {
    get(target, property): unknown {
      if (property === 'write') return write;
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
it('without hard links, never moves a finished download over a file that appears at the last moment', async () => {
  const downloads = join(root, 'browser-files', 'downloads');
  const actual = jest.requireActual<typeof fsModule>('node:fs');
  const move = jest.mocked(renameSync);
  const target = join(downloads, 'report.csv');
  // A writer creates the file at the last moment before the download takes
  // the name: just before a rename onto it, or an exclusive create of it.
  move.mockImplementation((from: fsModule.PathLike, to: fsModule.PathLike) => {
    if (String(to) === target) actual.writeFileSync(to, 'mine');
    actual.renameSync(from, to);
  });
  try {
    await withoutHardLinks(
      async () => {
        await writeFile(staging(), 'bytes');
        await store.completeDownload('one');
        expect(await readFile(target, 'utf8')).toBe('mine');
        const record = store.get(scope, 'one');
        expect(record?.status).toBe('complete');
        if (record?.kind !== 'download') throw new Error('Missing download');
        expect(await readFile(join(downloads, record.fileName), 'utf8')).toBe(
          'bytes',
        );
      },
      undefined,
      (path) => {
        if (path === target && !actual.existsSync(target))
          actual.writeFileSync(target, 'mine');
      },
    );
  } finally {
    move.mockImplementation(actual.renameSync);
  }
});
it('without hard links, finishes a copy whose writes come up short', async () => {
  const downloads = join(root, 'browser-files', 'downloads');
  const bytes = 'x'.repeat(3000) + 'end';
  await withoutHardLinks(
    async () => {
      await writeFile(staging(), bytes);
      await store.completeDownload('one');
      expect(store.get(scope, 'one')?.status).toBe('complete');
      expect(await readFile(join(downloads, 'report.csv'), 'utf8')).toBe(bytes);
    },
    // Each write takes at most half of what it is given.
    (_path, handle) =>
      withWrite(handle, ((
        buffer: NodeJS.ArrayBufferView,
        offset?: number,
        length?: number,
        position?: number | null,
      ) =>
        handle.write(
          buffer,
          offset ?? 0,
          Math.max(1, Math.floor((length ?? buffer.byteLength) / 2)),
          position,
        )) as fsPromisesModule.FileHandle['write']),
  );
});
it('without hard links, fails a copy that cannot write and publishes no partial copy', async () => {
  const downloads = join(root, 'browser-files', 'downloads');
  await withoutHardLinks(
    async () => {
      await writeFile(staging(), 'bytes');
      await store.completeDownload('one');
      expect(store.get(scope, 'one')?.status).toBe('failed');
      expect(await readdir(downloads)).not.toContain('report.csv');
      expect(
        events.some(
          (event) =>
            event.type === 'transfer' && event.transfer.status === 'complete',
        ),
      ).toBe(false);
    },
    (_path, handle) =>
      withWrite(handle, ((buffer: NodeJS.ArrayBufferView) =>
        Promise.resolve({
          bytesWritten: 0,
          buffer,
        })) as fsPromisesModule.FileHandle['write']),
  );
});
it('without hard links, copies without holding up the main thread', async () => {
  const downloads = join(root, 'browser-files', 'downloads');
  let ticks = 0;
  let ticking = true;
  const tick = (): void => {
    ticks += 1;
    if (ticking) setImmediate(tick);
  };
  const during: number[] = [];
  await withoutHardLinks(
    async () => {
      // Four copy chunks.
      await writeFile(staging(), Buffer.alloc(4 * 1024 * 1024, 7));
      setImmediate(tick);
      await store.completeDownload('one');
      ticking = false;
      expect(store.get(scope, 'one')?.status).toBe('complete');
      expect((await readFile(join(downloads, 'report.csv'))).length).toBe(
        4 * 1024 * 1024,
      );
    },
    (_path, handle) =>
      withWrite(handle, ((
        ...args: Parameters<fsPromisesModule.FileHandle['write']>
      ) => {
        during.push(ticks);
        return handle.write(...args);
      }) as fsPromisesModule.FileHandle['write']),
  );
  // The event loop turned while the copy ran.
  expect(during.length).toBeGreaterThanOrEqual(4);
  expect(during[during.length - 1]).toBeGreaterThan(during[0] ?? 0);
});
