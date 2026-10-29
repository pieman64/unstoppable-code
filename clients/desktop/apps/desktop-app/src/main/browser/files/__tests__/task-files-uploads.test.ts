import { createHash } from 'node:crypto';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BrowserEvent,
  BrowserUploadTransfer,
} from '@canopy/desktop-shared/types/browser';
import { BrowserTaskFiles, type BrowserFilesSessionEvent } from '../task-files';
import { workspaceUploadSource, type UploadSource } from '../uploads';

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
  beforeCatalogWrite?: (snapshot: string) => Promise<void> | void,
): BrowserTaskFiles {
  return new BrowserTaskFiles({
    taskDir: () => root,
    platform: 'linux',
    emit: (event) => events.push(event),
    ...(beforeCatalogWrite
      ? {
          beforeCatalogWrite: (_scope, snapshot): Promise<void> | void =>
            beforeCatalogWrite(snapshot),
        }
      : {}),
  });
}
function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}
function source(path = 'report.csv'): UploadSource {
  const result = workspaceUploadSource(workspace, path);
  if (!result.ok) throw new Error(result.error.message);
  return result.source;
}
function start(sources: UploadSource[] = [source()]): BrowserUploadTransfer {
  const started = store.startUpload(scope, {
    browserId: 'tab',
    actionId: 'upload-1',
    frameOrigin: 'https://upload.example',
    topOrigin: 'https://app.example',
    sources,
  });
  if (!started.ok) throw new Error(started.error.message);
  return started.transfer;
}
async function staged(id: string): Promise<BrowserUploadTransfer> {
  const transfer = await store.waitForTransfer(scope, id, {
    signal: new AbortController().signal,
    staged: true,
  });
  if (transfer?.kind !== 'upload') throw new Error('Not an upload');
  return transfer;
}
function uploadsFolder(): string {
  return join(root, 'browser-files', 'uploads');
}
async function downloaded(id = 'one', bytes = 'from the web'): Promise<void> {
  const admitted = store.admitDownload({
    scope,
    runtime,
    downloadId: id,
    suggestedName: 'page.txt',
    url: 'https://example.com/page',
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

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'task-files-uploads-'));
  root = join(base, 'task');
  workspace = join(base, 'workspace');
  await mkdir(root);
  await mkdir(workspace);
  await writeFile(join(workspace, 'report.csv'), 'a,b\n1,2\n');
  await writeFile(join(workspace, 'notes.txt'), 'notes');
  events = [];
  store = create();
  await store.bind(scope);
});
afterEach(async () => {
  // Staged copies are read-only; make their folders removable.
  for (const id of existsSync(uploadsFolder())
    ? await readdir(uploadsFolder())
    : [])
    for (const index of await readdir(join(uploadsFolder(), id)).catch(
      () => [],
    ))
      await chmod(join(uploadsFolder(), id, index), 0o700).catch(
        () => undefined,
      );
  await rm(base, { recursive: true, force: true });
});

describe('uploads in the task files store', () => {
  it('stages each file with its hash, then waits for approval, without exposing a host path', async () => {
    const started = start([source(), source('notes.txt')]);
    expect(started).toMatchObject({
      kind: 'upload',
      browserId: 'tab',
      actionId: 'upload-1',
      frameOrigin: 'https://upload.example',
      topOrigin: 'https://app.example',
      status: 'staging',
      totalBytes: 13,
    });
    const upload = await staged(started.id);
    expect(upload).toMatchObject({
      status: 'awaiting_approval',
      stagedBytes: 13,
      files: [
        {
          name: 'report.csv',
          displayPath: 'report.csv',
          sizeBytes: 8,
          sha256: sha256('a,b\n1,2\n'),
        },
        {
          name: 'notes.txt',
          displayPath: 'notes.txt',
          sizeBytes: 5,
          sha256: sha256('notes'),
        },
      ],
    });
    expect(JSON.stringify(upload)).not.toContain(base);
    const paths = store.stagedUploadPaths(scope, started.id) ?? [];
    expect(paths.map((path) => path.split('/').pop())).toEqual([
      'report.csv',
      'notes.txt',
    ]);
    expect(await readFile(paths[0] ?? '', 'utf8')).toBe('a,b\n1,2\n');
    expect((await stat(paths[0] ?? '')).mode & 0o222).toBe(0);
    expect(
      store.list(scope, 'tab', { browserId: 'tab', kind: 'upload' }).transfers,
    ).toEqual([upload]);
    expect(
      events.some(
        (event) =>
          event.type === 'transfer' &&
          event.transfer.kind === 'upload' &&
          event.transfer.status === 'awaiting_approval',
      ),
    ).toBe(true);
  });

  it('records path-free session events when an upload is requested, decided, and attached', async () => {
    const recorded: BrowserFilesSessionEvent[] = [];
    store = new BrowserTaskFiles({
      taskDir: (): string => root,
      platform: 'linux',
      emit: (event): void => {
        events.push(event);
      },
      recordEvent: (_scope, event): void => {
        recorded.push(event);
      },
    });
    await store.bind(scope);
    const allowed = start([source()]);
    await staged(allowed.id);
    expect(store.beginAttach(scope, allowed.id)).toBe(true);
    await store.endUpload(scope, allowed.id, { status: 'attached' });
    const denied = start([source('notes.txt')]);
    await staged(denied.id);
    await store.endUpload(scope, denied.id, {
      status: 'denied',
      error: { code: 'approval_denied', message: 'Not approved.' },
    });
    const report = { name: 'report.csv', sizeBytes: 8 };
    const notes = { name: 'notes.txt', sizeBytes: 5 };
    const origins = {
      origin: 'https://upload.example',
      topOrigin: 'https://app.example',
    };
    expect(recorded).toEqual([
      {
        kind: 'browser_upload_requested',
        ...origins,
        files: [{ ...report, source: 'workspace' }],
      },
      {
        kind: 'browser_upload_decided',
        ...origins,
        decision: 'allow',
        files: [{ ...report, sha256: sha256('a,b\n1,2\n') }],
      },
      {
        kind: 'browser_upload_attached',
        ...origins,
        files: [{ ...report, sha256: sha256('a,b\n1,2\n') }],
      },
      {
        kind: 'browser_upload_requested',
        ...origins,
        files: [{ ...notes, source: 'workspace' }],
      },
      {
        kind: 'browser_upload_decided',
        ...origins,
        decision: 'deny',
        files: [{ ...notes, sha256: sha256('notes') }],
      },
    ]);
    expect(JSON.stringify(recorded)).not.toContain(base);
  });

  it('keeps an attached upload’s files, and removes a denied one’s', async () => {
    const attached = start();
    await staged(attached.id);
    await expect(
      store.endUpload(scope, attached.id, { status: 'attached' }),
    ).resolves.toMatchObject({ status: 'attached' });
    expect(existsSync(join(uploadsFolder(), attached.id))).toBe(true);

    const denied = start();
    await staged(denied.id);
    await expect(
      store.endUpload(scope, denied.id, {
        status: 'denied',
        error: { code: 'approval_denied', message: 'Not approved.' },
      }),
    ).resolves.toMatchObject({
      status: 'denied',
      error: { code: 'approval_denied' },
    });
    expect(existsSync(join(uploadsFolder(), denied.id))).toBe(false);
    // An upload that ended stays as it ended.
    await expect(
      store.endUpload(scope, denied.id, { status: 'attached' }),
    ).resolves.toMatchObject({ status: 'denied' });
  });

  it('checks the staged bytes still match what was hashed', async () => {
    const upload = start();
    await staged(upload.id);
    await expect(store.stagedUploadMatches(scope, upload.id)).resolves.toBe(
      true,
    );
    const path = store.stagedUploadPaths(scope, upload.id)?.[0] ?? '';
    await chmod(path, 0o600);
    await writeFile(path, 'x,y\n3,4\n');
    await expect(store.stagedUploadMatches(scope, upload.id)).resolves.toBe(
      false,
    );
  });

  it('cancels while staging or awaiting approval, never once attached', async () => {
    await writeFile(
      join(workspace, 'large.bin'),
      Buffer.alloc(32 * 1024 * 1024, 1),
    );
    const large = start([source('large.bin')]);
    expect(store.cancelUpload(scope, large.id)).toBe(true);
    await expect(staged(large.id)).resolves.toMatchObject({
      status: 'cancelled',
    });
    expect(existsSync(join(uploadsFolder(), large.id))).toBe(false);

    const waiting = start();
    await staged(waiting.id);
    expect(store.cancelUpload(scope, waiting.id)).toBe(true);
    await store.waitForTransfer(scope, waiting.id, {
      signal: new AbortController().signal,
    });
    expect(store.get(scope, waiting.id)).toMatchObject({ status: 'cancelled' });
    expect(existsSync(join(uploadsFolder(), waiting.id))).toBe(false);

    const attached = start();
    await staged(attached.id);
    await store.endUpload(scope, attached.id, { status: 'attached' });
    expect(store.cancelUpload(scope, attached.id)).toBe(false);
  });

  it('keeps a cancel that arrives while staging’s end is being recorded', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = (): void => undefined;
    const recording = new Promise<void>((resolve) => {
      reached = resolve;
    });
    store = create(async (snapshot) => {
      if (!snapshot.includes('"awaiting_approval"')) return;
      reached();
      await held;
    });
    await store.bind(scope);
    const upload = start();
    await recording;
    expect(store.cancelUpload(scope, upload.id)).toBe(true);
    release();
    await expect(staged(upload.id)).resolves.toMatchObject({
      status: 'cancelled',
    });
    expect(store.get(scope, upload.id)).toMatchObject({ status: 'cancelled' });
    expect(existsSync(join(uploadsFolder(), upload.id))).toBe(false);
    expect(store.beginAttach(scope, upload.id)).toBe(false);
    // The next start reads it as cancelled too.
    store = create();
    await store.bind(scope);
    expect(store.get(scope, upload.id)).toMatchObject({ status: 'cancelled' });
  });

  it('cannot be cancelled once attaching began, and ends only once', async () => {
    const upload = start();
    await staged(upload.id);
    expect(store.beginAttach(scope, upload.id)).toBe(true);
    expect(store.cancelUpload(scope, upload.id)).toBe(false);
    const [attached, cancelled] = await Promise.all([
      store.endUpload(scope, upload.id, { status: 'attached' }),
      store.endUpload(scope, upload.id, { status: 'cancelled' }),
    ]);
    expect(attached).toMatchObject({ status: 'attached' });
    expect(cancelled?.status).not.toBe('cancelled');
    expect(store.get(scope, upload.id)).toMatchObject({ status: 'attached' });
    expect(store.beginAttach(scope, upload.id)).toBe(false);
  });

  it('fails an upload whose source was replaced after its check, leaving nothing', async () => {
    const checked = source();
    await writeFile(join(workspace, 'report.csv.new'), 'other');
    await rename(
      join(workspace, 'report.csv.new'),
      join(workspace, 'report.csv'),
    );
    const upload = start([checked]);
    await expect(staged(upload.id)).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'file_not_eligible' },
    });
    expect(existsSync(join(uploadsFolder(), upload.id))).toBe(false);
  });

  it('uploads a finished task download by its id, and refuses an unfinished or unknown one', async () => {
    await downloaded();
    const result = store.downloadUploadSource(scope, 'tab', 'one');
    expect(result).toMatchObject({
      ok: true,
      source: { name: 'page.txt', displayPath: 'page.txt (downloaded)' },
    });
    if (!result.ok) throw new Error('No source');
    const upload = await staged(start([result.source]).id);
    expect(upload.files[0]?.sha256).toBe(sha256('from the web'));
    expect(store.downloadUploadSource(scope, 'tab', 'missing')).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(store.downloadUploadSource(scope, 'other-tab', 'one')).toMatchObject(
      {
        ok: false,
        error: { code: 'not_found' },
      },
    );
  });

  it('fails uploads a crash interrupted, and removes every staged copy on the next start', async () => {
    const attached = start();
    await staged(attached.id);
    await store.endUpload(scope, attached.id, { status: 'attached' });
    const waiting = start([source('notes.txt')]);
    await staged(waiting.id);

    store = create();
    await store.bind(scope);
    expect(store.get(scope, attached.id)).toMatchObject({ status: 'attached' });
    expect(store.get(scope, waiting.id)).toMatchObject({
      status: 'failed',
      error: { code: 'upload_failed', message: 'The upload was interrupted.' },
    });
    expect(
      existsSync(uploadsFolder()) ? await readdir(uploadsFolder()) : [],
    ).toEqual([]);
  });

  it('removes a browser’s staged copies when it closes', async () => {
    const upload = start();
    await staged(upload.id);
    await store.endUpload(scope, upload.id, { status: 'attached' });
    await store.releaseUploads(scope, 'other-tab');
    expect(existsSync(join(uploadsFolder(), upload.id))).toBe(true);
    await store.releaseUploads(scope, 'tab');
    expect(existsSync(join(uploadsFolder(), upload.id))).toBe(false);
    expect(store.get(scope, upload.id)).toMatchObject({ status: 'attached' });
  });

  it('stops staging before the task is removed', async () => {
    await writeFile(
      join(workspace, 'large.bin'),
      Buffer.alloc(32 * 1024 * 1024, 1),
    );
    start([source('large.bin')]);
    await store.removeTask(scope);
    expect(existsSync(join(root, 'browser-files'))).toBe(false);
  });
});
