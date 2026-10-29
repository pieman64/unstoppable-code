import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BrowserCopyTransfer,
  BrowserEvent,
} from '@canopy/desktop-shared/types/browser';
import { BrowserTaskFiles } from '../task-files';
import {
  prepareWorkspaceDestination,
  type CopyDestination,
} from '../workspace-copy';

jest.setTimeout(20000);

const scope = { projectId: 'project', worktreeId: 'task' };
const runtime = {
  browserId: 'tab',
  runtimeGeneration: 2,
  taskIncarnationId: 'incarnation',
};
let base: string;
let root: string;
let workspace: string;
let events: BrowserEvent[];
let store: BrowserTaskFiles;

function create(
  platform: NodeJS.Platform = 'linux',
  beforeCatalogWrite?: (snapshot: string) => void | Promise<void>,
): BrowserTaskFiles {
  return new BrowserTaskFiles({
    taskDir: () => root,
    platform,
    emit: (event) => events.push(event),
    ...(beforeCatalogWrite
      ? {
          beforeCatalogWrite: (_scope, snapshot): void | Promise<void> =>
            beforeCatalogWrite(snapshot),
        }
      : {}),
  });
}
/** Whether a catalog snapshot records a copy as complete. */
function namesCompleteCopy(snapshot: string): boolean {
  const parsed: unknown = JSON.parse(snapshot);
  const records =
    parsed && typeof parsed === 'object' && 'records' in parsed
      ? parsed.records
      : [];
  return (
    Array.isArray(records) &&
    records.some(
      (record: unknown) =>
        !!record &&
        typeof record === 'object' &&
        'kind' in record &&
        record.kind === 'copy' &&
        'status' in record &&
        record.status === 'complete',
    )
  );
}
/** A catalog naming a copy a crash interrupted, with its temp file on disk. */
async function crashedCopy(): Promise<string> {
  const catalog = join(root, 'browser-files', 'files.json');
  const parsed: unknown = JSON.parse(await readFile(catalog, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !('records' in parsed))
    throw new Error('Unexpected catalog');
  const records: unknown[] = Array.isArray(parsed.records)
    ? parsed.records
    : [];
  const temp = join(
    workspace,
    '.canopy-copy-00000000-0000-4000-8000-000000000000.part',
  );
  await writeFile(temp, 'partial');
  await writeFile(
    catalog,
    JSON.stringify({
      version: 1,
      records: [
        ...records,
        {
          kind: 'copy',
          id: 'crashed',
          browserId: 'tab',
          sourceId: 'one',
          source: 'agent',
          destinationName: 'report.csv',
          copiedBytes: 3,
          totalBytes: 8,
          status: 'in_progress',
          startedAt: 5,
          tempPath: temp,
        },
      ],
    }),
  );
  return temp;
}
/** A finished download with these bytes. */
async function downloaded(
  id = 'one',
  bytes: string | Buffer = 'a,b\n1,2\n',
): Promise<void> {
  const admitted = store.admitDownload({
    scope,
    runtime,
    downloadId: id,
    suggestedName: 'report.csv',
    url: 'https://example.com/report',
    totalBytes: bytes.length,
    source: 'agent',
  });
  if (!admitted.ok) throw new Error(admitted.reason);
  await writeFile(admitted.stagingPath, bytes);
  store.updateDownload(id, {
    receivedBytes: bytes.length,
    status: 'in_progress',
  });
  await store.completeDownload(id);
}
async function destination(path: string): Promise<CopyDestination> {
  const result = await prepareWorkspaceDestination(workspace, path);
  if (!result.ok) throw new Error(result.error.message);
  return result.destination;
}
async function copied(
  path = 'exports/report.csv',
  extra: Partial<Parameters<BrowserTaskFiles['startCopy']>[1]> = {},
): Promise<BrowserCopyTransfer> {
  const started = store.startCopy(scope, {
    browserId: runtime.browserId,
    downloadId: 'one',
    source: 'agent',
    destinationName: path,
    destination: await destination(path),
    overwrite: false,
    ...extra,
  });
  if (!started.ok) throw new Error(started.error.message);
  const settled = await store.waitForTransfer(scope, started.transfer.id, {
    signal: new AbortController().signal,
  });
  if (settled?.kind !== 'copy') throw new Error('Not a copy');
  return settled;
}
async function parts(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.endsWith('.part'));
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'task-files-copies-'));
  root = join(base, 'task');
  workspace = join(base, 'workspace');
  await mkdir(root);
  await mkdir(workspace);
  events = [];
  store = create();
  await store.bind(scope);
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('copies of finished downloads', () => {
  it('copies a finished download, lists it as a copy, and never exposes a host path', async () => {
    await downloaded();
    const copy = await copied();

    expect(copy).toMatchObject({
      kind: 'copy',
      browserId: 'tab',
      sourceId: 'one',
      source: 'agent',
      destinationName: 'exports/report.csv',
      copiedBytes: 8,
      totalBytes: 8,
      status: 'complete',
    });
    expect(
      await readFile(join(workspace, 'exports', 'report.csv'), 'utf8'),
    ).toBe('a,b\n1,2\n');
    expect(await parts(join(workspace, 'exports'))).toEqual([]);
    expect(
      store.list(scope, 'tab', { browserId: 'tab', kind: 'copy' }).transfers,
    ).toEqual([copy]);
    expect(
      store
        .list(scope, 'tab', { browserId: 'tab', kind: 'download' })
        .transfers.map((transfer) => transfer.kind),
    ).toEqual(['download']);
    expect(store.get(scope, copy.id)).toEqual(copy);
    const published = events.flatMap((event) =>
      event.type === 'transfer' && event.transfer.kind === 'copy'
        ? [event.transfer]
        : [],
    );
    expect(published.at(-1)).toEqual(copy);
    expect(JSON.stringify(published)).not.toContain(workspace);
    expect(JSON.stringify(published)).not.toContain('.part');
  });

  it('refuses a download that is unknown, unfinished, or another browser’s', async () => {
    const admitted = store.admitDownload({
      scope,
      runtime,
      downloadId: 'running',
      suggestedName: 'running.csv',
      url: 'https://example.com/running',
      totalBytes: 10,
      source: 'user',
    });
    expect(admitted.ok).toBe(true);
    await downloaded();
    const prepared = await destination('report.csv');
    const attempt = (
      input: Partial<Parameters<BrowserTaskFiles['startCopy']>[1]>,
    ): ReturnType<BrowserTaskFiles['startCopy']> =>
      store.startCopy(scope, {
        browserId: 'tab',
        downloadId: 'one',
        source: 'agent',
        destinationName: 'report.csv',
        destination: prepared,
        overwrite: false,
        ...input,
      });
    expect(attempt({ downloadId: 'missing' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(attempt({ browserId: 'other-tab' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(attempt({ downloadId: 'running' })).toMatchObject({
      ok: false,
      error: { code: 'file_not_eligible' },
    });
  });

  it('records a refused write as a failed copy and keeps the file that has the name', async () => {
    await downloaded();
    const prepared = await destination('report.csv');
    await writeFile(join(workspace, 'report.csv'), 'mine');
    const started = store.startCopy(scope, {
      browserId: 'tab',
      downloadId: 'one',
      source: 'agent',
      destinationName: 'report.csv',
      destination: prepared,
      overwrite: false,
    });
    if (!started.ok) throw new Error(started.error.message);
    const settled = await store.waitForTransfer(scope, started.transfer.id, {
      signal: new AbortController().signal,
    });

    expect(settled).toMatchObject({
      status: 'failed',
      error: { code: 'destination_exists' },
    });
    expect(await readFile(join(workspace, 'report.csv'), 'utf8')).toBe('mine');
    expect(await parts(workspace)).toEqual([]);
  });

  it('does not count copies toward the three-downloads-at-once guard', async () => {
    await downloaded();
    const prepared = await destination('report.csv');
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      const started = store.startCopy(scope, {
        browserId: 'tab',
        downloadId: 'one',
        source: 'user',
        destinationName: `copy-${index}.csv`,
        destination: { ...prepared, name: `copy-${index}.csv` },
        overwrite: false,
      });
      if (!started.ok) throw new Error(started.error.message);
      ids.push(started.transfer.id);
    }
    for (const id of ['two', 'three', 'four'])
      expect(
        store.admitDownload({
          scope,
          runtime,
          downloadId: id,
          suggestedName: `${id}.csv`,
          url: 'https://example.com/more',
          totalBytes: 1,
          source: 'user',
        }).ok,
      ).toBe(true);
    await Promise.all(
      ids.map((id) =>
        store.waitForTransfer(scope, id, {
          signal: new AbortController().signal,
        }),
      ),
    );
  });

  it('cancels a running copy and removes its partial file', async () => {
    await downloaded('one', Buffer.alloc(16 * 1024 * 1024, 7));
    const started = store.startCopy(scope, {
      browserId: 'tab',
      downloadId: 'one',
      source: 'user',
      destinationName: 'large.bin',
      destination: await destination('large.bin'),
      overwrite: false,
    });
    if (!started.ok) throw new Error(started.error.message);
    expect(store.cancelCopy(scope, started.transfer.id)).toBe(true);
    const settled = await store.waitForTransfer(scope, started.transfer.id, {
      signal: new AbortController().signal,
    });

    expect(settled).toMatchObject({ kind: 'copy', status: 'cancelled' });
    expect(await readdir(workspace)).toEqual([]);
    expect(store.cancelCopy(scope, started.transfer.id)).toBe(false);
  });

  it('keeps finished copies across a restart', async () => {
    await downloaded();
    const copy = await copied();
    store = create();
    await store.bind(scope);

    expect(store.get(scope, copy.id)).toEqual(copy);
    expect(store.get(scope, 'one')).toMatchObject({
      kind: 'download',
      status: 'complete',
    });
  });

  it('fails a copy a crash interrupted and removes its partial file', async () => {
    await downloaded();
    const catalog = join(root, 'browser-files', 'files.json');
    const parsed: unknown = JSON.parse(await readFile(catalog, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !('records' in parsed))
      throw new Error('Unexpected catalog');
    const records: unknown[] = Array.isArray(parsed.records)
      ? parsed.records
      : [];
    const temp = join(
      workspace,
      '.canopy-copy-00000000-0000-4000-8000-000000000000.part',
    );
    await writeFile(temp, 'partial');
    await writeFile(
      catalog,
      JSON.stringify({
        version: 1,
        records: [
          ...records,
          {
            kind: 'copy',
            id: 'crashed',
            browserId: 'tab',
            sourceId: 'one',
            source: 'agent',
            destinationName: 'report.csv',
            copiedBytes: 3,
            totalBytes: 8,
            status: 'in_progress',
            startedAt: 5,
            tempPath: temp,
          },
        ],
      }),
    );
    store = create();
    await store.bind(scope);

    expect(store.get(scope, 'crashed')).toMatchObject({
      kind: 'copy',
      status: 'failed',
      error: { code: 'copy_failed' },
    });
    expect(await readdir(workspace)).toEqual([]);
    expect(JSON.stringify(store.get(scope, 'crashed'))).not.toContain(temp);
  });

  it('marks a copy as downloaded on macOS, like the download itself', async () => {
    if (process.platform !== 'darwin') return;
    store = create('darwin');
    await store.bind(scope);
    await downloaded();
    await copied();
    expect(
      execFileSync(
        '/usr/bin/xattr',
        [
          '-p',
          'com.apple.quarantine',
          join(workspace, 'exports', 'report.csv'),
        ],
        { encoding: 'utf8' },
      ),
    ).toMatch(/^0081;/);
  });

  it('removes a crashed copy’s temp file when a task that was never opened is deleted', async () => {
    await downloaded();
    const temp = await crashedCopy();
    store = create();
    await store.removeTask(scope);

    expect(existsSync(temp)).toBe(false);
    expect(existsSync(join(root, 'browser-files'))).toBe(false);
  });

  it('does not report a copy complete when its record cannot be saved', async () => {
    store = create('linux', (snapshot) => {
      if (namesCompleteCopy(snapshot))
        throw Object.assign(new Error('read-only'), { code: 'EROFS' });
    });
    await store.bind(scope);
    await downloaded();
    const copy = await copied();

    expect(copy).toMatchObject({
      status: 'failed',
      error: { code: 'copy_failed' },
    });
    expect(store.get(scope, copy.id)).toMatchObject({ status: 'failed' });
    // The file itself was saved; only its record was not.
    expect(
      await readFile(join(workspace, 'exports', 'report.csv'), 'utf8'),
    ).toBe('a,b\n1,2\n');
  });

  it('reports a copy as running until its final record is saved', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = (): void => undefined;
    const finalWrite = new Promise<void>((resolve) => {
      reached = resolve;
    });
    store = create('linux', async (snapshot) => {
      if (!namesCompleteCopy(snapshot)) return;
      reached();
      await held;
      throw Object.assign(new Error('read-only'), { code: 'EROFS' });
    });
    await store.bind(scope);
    await downloaded();
    const started = store.startCopy(scope, {
      browserId: runtime.browserId,
      downloadId: 'one',
      source: 'agent',
      destinationName: 'exports/report.csv',
      destination: await destination('exports/report.csv'),
      overwrite: false,
    });
    if (!started.ok) throw new Error(started.error.message);
    const { id } = started.transfer;
    await finalWrite;

    // A caller that stops waiting now, as save_download does at its timeout,
    // must not read a copy whose record may still fail as complete.
    expect(store.get(scope, id)).toMatchObject({ status: 'in_progress' });
    release();
    const settled = await store.waitForTransfer(scope, id, {
      signal: new AbortController().signal,
    });
    expect(settled).toMatchObject({
      status: 'failed',
      error: { code: 'copy_failed' },
    });
    expect(store.get(scope, id)).toMatchObject({ status: 'failed' });
    expect(
      events.some(
        (event) =>
          event.type === 'transfer' &&
          event.transfer.id === id &&
          event.transfer.status === 'complete',
      ),
    ).toBe(false);
  });

  it('cancels the task’s running copies before it removes the task', async () => {
    await downloaded('one', Buffer.alloc(16 * 1024 * 1024, 7));
    const started = store.startCopy(scope, {
      browserId: 'tab',
      downloadId: 'one',
      source: 'user',
      destinationName: 'large.bin',
      destination: await destination('large.bin'),
      overwrite: false,
    });
    if (!started.ok) throw new Error(started.error.message);
    await store.removeTask(scope);

    expect(await readdir(workspace)).toEqual([]);
    expect(
      store.startCopy(scope, {
        browserId: 'tab',
        downloadId: 'one',
        source: 'user',
        destinationName: 'again.bin',
        destination: await destination('again.bin'),
        overwrite: false,
      }).ok,
    ).toBe(false);
  });
});
