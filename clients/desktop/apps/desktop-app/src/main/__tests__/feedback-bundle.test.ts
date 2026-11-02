import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
  utimes,
  readdir,
} from 'node:fs/promises';
import io from 'node:fs/promises';
import fileSystem from 'node:fs';
import { ZipFile } from 'yazl';
import { submitFeedback } from '../feedback/feedback-submit';
import { requestCanopyCloudJson } from '../canopy-cloud/client';
jest.mock('../canopy-cloud/client', () => ({
  requestCanopyCloudJson: jest.fn(),
}));
import { tmpdir, EOL } from 'node:os';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import {
  AsyncMainLogSink,
  type MainLogFlushResult,
} from '../lib/async-main-log-sink';
import { flushMainProcessLogging } from '../lib/main-process-logging';
import type * as MainProcessLogging from '../lib/main-process-logging';
import { dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import {
  STANDALONE_CHAT_PROJECT_ID,
  type FeedbackPrepareRequest,
} from '@canopy/desktop-shared/types';
import {
  getAgentObservabilityTranscriptFilePath,
  getChatProjectProjectFilePath,
  getDataDir,
  getHookInvocationsDir,
  getWorkspaceChatHistoryConversationFilePath,
  getWorkspaceChatHistoryMetaFilePath,
  getWorkspaceChatHistoryRootDir,
  getWorkspaceChatHistorySummaryFilePath,
  getWorkspaceChatTabsFilePath,
  getWorkspaceConfigPath,
  getWorkspaceTrackedPlansFilePath,
  getWorkspaceWorktreesFilePath,
  getWorktreeSummaryFilePath,
  getWorkspaceScriptRunDir,
} from '../lib/paths';
import { COWORK_HOME_WORKTREE_ID } from '@canopy/desktop-shared/types';
import {
  MAX_FILE_BYTES,
  prepareFeedbackBundle,
  cleanupStaleTemporaryFeedbackBundles,
  releaseTemporaryFeedbackBundle,
} from '../feedback/feedback-bundle';
import { registerWorkspaceTypes } from '../lib/workspace-registry';
import { ChatStorageV2, type ChatMigrationEntry } from '../lib/chat-storage-v2';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';

jest.mock('../lib/main-process-logging', () => ({
  flushMainProcessLogging: jest.fn(),
  logMainProcessWarn: jest.fn(),
}));
const mockFlushMainProcessLogging = jest.mocked(flushMainProcessLogging);

const mockGetPath = jest.fn<string, [string]>();
const originalCanopyDataDir = process.env.CANOPY_DATA_DIR;
const originalFeedbackBundleHomeDir =
  process.env.FEEDBACK_BUNDLE_HOME_DIR_FOR_TEST;

jest.mock('electron', () => ({
  app: {
    getPath: (name: string): string => mockGetPath(name),
    getVersion: jest.fn(() => '0.21.19-test'),
    isPackaged: false,
  },
}));

describe('prepareFeedbackBundle', () => {
  let tempRoot: string;
  let tempRootCreated = false;
  let downloadsDir: string;

  beforeEach(async () => {
    mockFlushMainProcessLogging.mockReset();
    mockFlushMainProcessLogging.mockResolvedValue({
      throughSequence: 0,
      writtenRecords: 0,
      failedRecords: 0,
      droppedRecords: 0,
      failedGapNotices: 0,
    });
    tempRootCreated = false;
    tempRoot = await mkdtemp(join(tmpdir(), 'canopy-feedback-test-'));
    tempRootCreated = true;
    const testDataDir = join(tempRoot, 'data');
    process.env.CANOPY_DATA_DIR = testDataDir;
    process.env.FEEDBACK_BUNDLE_HOME_DIR_FOR_TEST = join(tempRoot, 'home');
    downloadsDir = join(tempRoot, 'downloads');
    mockGetPath.mockImplementation((name) => {
      if (name === 'logs') {
        return hostPlatformOperatingSystem() === 'darwin'
          ? join(tempRoot, 'home', 'Library', 'Logs', 'canopy-ui')
          : join(tempRoot, 'xdg-config', 'canopy-ui', 'logs');
      }
      if (name === 'crashDumps') return join(tempRoot, 'crash-dumps');
      return downloadsDir;
    });
    expect(getDataDir()).toBe(testDataDir);
    await mkdir(downloadsDir, { recursive: true });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    if (originalCanopyDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalCanopyDataDir;
    }
    if (originalFeedbackBundleHomeDir === undefined) {
      delete process.env.FEEDBACK_BUNDLE_HOME_DIR_FOR_TEST;
    } else {
      process.env.FEEDBACK_BUNDLE_HOME_DIR_FOR_TEST =
        originalFeedbackBundleHomeDir;
    }
    resetResolvedCanopyDataDirForTests();
    registerWorkspaceTypes(new Map());
    if (tempRootCreated) {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it.each([
    ['growth', 'original', 'original plus new bytes', 'original'],
    ['shrink', 'original', 'tiny', 'tiny'],
    ['truncate', 'original', '', ''],
    ['initially empty', '', 'later bytes', ''],
  ])(
    'captures %s within the collection-time range',
    async (_case, initial, changed, expected) => {
      await seedDefaultDiagnostics();
      const source = join(
        getDataDir(),
        'agent-observability',
        'diagnostics',
        'app-events',
        '2026-05-05.jsonl',
      );
      await writeFile(source, initial);
      const realLstat = io.lstat;
      let mutated = false;
      jest.spyOn(io, 'lstat').mockImplementation(async (...args) => {
        const result = await realLstat(...args);
        if (args[0] === source && !mutated) {
          mutated = true;
          await writeFile(source, changed);
        }
        return result;
      });
      const response = await prepareFeedbackBundle({
        description: 'mutable log',
        area: 'overview',
      });
      const zip = await readZip(response.absolutePath);
      expect(
        zip
          .get('agent-observability/diagnostics/app-events/2026-05-05.jsonl')
          ?.toString(),
      ).toBe(expected);
      const manifest = readManifest(zip);
      const zipPath =
        'agent-observability/diagnostics/app-events/2026-05-05.jsonl';
      expect(getManifestValue(manifest, 'includedFiles')).toContain(zipPath);
      expect(getManifestValue(manifest, 'skippedFiles')).not.toContainEqual(
        expect.objectContaining({ path: zipPath }),
      );
    },
  );

  it.each(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'])(
    'records deferred %s as a skipped placeholder',
    async (code) => {
      await seedDefaultDiagnostics();
      const source = join(
        getDataDir(),
        'agent-observability',
        'diagnostics',
        'app-events',
        '2026-05-05.jsonl',
      );
      const realOpen = io.open;
      jest.spyOn(io, 'open').mockImplementation(async (...args) => {
        if (args[0] === source)
          throw Object.assign(new Error('deferred failure'), { code });
        return realOpen(...args);
      });
      const result = await prepareFeedbackBundle({
        description: 'late skip',
        area: 'overview',
      });
      const zip = await readZip(result.absolutePath);
      const zipPath =
        'agent-observability/diagnostics/app-events/2026-05-05.jsonl';
      expect(zip.get(zipPath)?.byteLength).toBe(0);
      const manifest = readManifest(zip);
      expect(getManifestValue(manifest, 'includedFiles')).not.toContain(
        zipPath,
      );
      expect(getManifestValue(manifest, 'skippedFiles')).toContainEqual({
        path: zipPath,
        reason:
          code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'inaccessible',
      });
      expect(getManifestValue(manifest, 'includedFiles')).toContain(
        'preferences.json',
      );
    },
  );

  it.each(['EIO', 'EMFILE'])(
    'rejects deferred %s and removes its archive',
    async (code) => {
      await seedDefaultDiagnostics();
      const realOpen = io.open;
      jest.spyOn(io, 'open').mockImplementation(async (...args) => {
        if (String(args[0]).endsWith('2026-05-05.jsonl'))
          throw Object.assign(new Error('source open failed'), { code });
        return realOpen(...args);
      });
      await expect(
        prepareFeedbackBundle({
          description: 'open failure',
          area: 'overview',
        }),
      ).rejects.toThrow('source open failed');
      expect(await readdir(downloadsDir)).toEqual([]);
    },
  );

  it.each(['symlink', 'directory', 'parent symlink'])(
    'does not read a deferred %s replacement',
    async (replacement) => {
      await seedDefaultDiagnostics();
      const source = join(
        getDataDir(),
        'agent-observability',
        'diagnostics',
        'app-events',
        '2026-05-05.jsonl',
      );
      const secret = join(tempRoot, 'secret');
      await writeFile(secret, 'must never appear');
      const realLstat = io.lstat;
      let replaced = false;
      jest.spyOn(io, 'lstat').mockImplementation(async (...args) => {
        const stats = await realLstat(...args);
        if (args[0] === source && !replaced) {
          replaced = true;
          if (replacement === 'parent symlink') {
            await rm(dirname(source), { recursive: true });
            await mkdir(join(tempRoot, 'outside'));
            await writeFile(
              join(tempRoot, 'outside', '2026-05-05.jsonl'),
              'must never appear',
            );
            await symlink(join(tempRoot, 'outside'), dirname(source), 'dir');
          } else {
            await rm(source);
            if (replacement === 'directory') await mkdir(source);
            else await symlink(secret, source);
          }
        }
        return stats;
      });
      const preparation = prepareFeedbackBundle({
        description: 'replacement',
        area: 'overview',
      });
      if (replacement === 'directory') {
        await expect(preparation).rejects.toThrow();
        expect(await readdir(downloadsDir)).toEqual([]);
      } else {
        const result = await preparation;
        const zip = await readZip(result.absolutePath);
        const zipPath =
          'agent-observability/diagnostics/app-events/2026-05-05.jsonl';
        expect(zip.get(zipPath)?.byteLength).toBe(0);
        expect(
          getManifestValue(readManifest(zip), 'skippedFiles'),
        ).toContainEqual({ path: zipPath, reason: 'symlink' });
      }
    },
  );

  it('removes an owned output when final metadata fails and preserves the primary failure', async () => {
    await seedDefaultDiagnostics();
    const realStat = io.stat;
    jest.spyOn(io, 'stat').mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('.zip'))
        throw new Error('final metadata failure');
      return realStat(...args);
    });
    await expect(
      prepareFeedbackBundle({ description: 'stat failure', area: 'overview' }),
    ).rejects.toThrow('final metadata failure');
    expect(await readdir(downloadsDir)).toEqual([]);
  });

  it('handles synchronous lazy registration failure without leaving an archive', async () => {
    await seedDefaultDiagnostics();
    jest
      .spyOn(ZipFile.prototype, 'addReadStreamLazy')
      .mockImplementationOnce(() => {
        throw new Error('registration failure');
      });
    await expect(
      prepareFeedbackBundle({
        description: 'registration failure',
        area: 'overview',
      }),
    ).rejects.toThrow('registration failure');
    expect(await readdir(downloadsDir)).toEqual([]);
  });

  it.each([
    'source',
    'zip',
    'destination',
    'manifest',
    'source construction',
    'destination construction',
  ])('handles %s failure and deletes the owned archive', async (failure) => {
    await seedDefaultDiagnostics();
    const realOpen = io.open;
    const openedHandles: Awaited<ReturnType<typeof open>>[] = [];
    // eslint-disable-next-line @typescript-eslint/unbound-method -- invoked with apply and its original ZipFile receiver
    const realEnd = ZipFile.prototype.end;
    const realStringify = JSON.stringify;
    if (failure === 'manifest') {
      jest.spyOn(JSON, 'stringify').mockImplementation((value, ...args) => {
        if (
          typeof value === 'object' &&
          value !== null &&
          'includedFiles' in value
        )
          throw new Error('manifest failure');
        return realStringify(value, ...args);
      });
    }
    if (failure === 'zip') {
      jest.spyOn(ZipFile.prototype, 'end').mockImplementation(function (
        this: ZipFile,
        ...args
      ) {
        realEnd.apply(this, args);
        this.emit('error', new Error('zip failure'));
        this.emit('error', new Error('secondary zip failure'));
      });
    }
    jest.spyOn(io, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      openedHandles.push(handle);
      if (failure === 'destination construction' && args[1] === 'wx') {
        jest.spyOn(handle, 'createWriteStream').mockImplementation(() => {
          throw new Error('destination construction failure');
        });
      }
      if (failure === 'source construction' && args[1] !== 'wx') {
        jest.spyOn(handle, 'createReadStream').mockImplementation(() => {
          throw new Error('source construction failure');
        });
      }
      if (failure === 'destination' && args[1] === 'wx') {
        const realCreate = handle.createWriteStream.bind(handle);
        jest
          .spyOn(handle, 'createWriteStream')
          .mockImplementation((options) => {
            const stream = realCreate(options);
            queueMicrotask(() =>
              stream.destroy(new Error('destination failure')),
            );
            return stream;
          });
      }
      if (failure === 'source' && args[1] !== 'wx') {
        const realCreate = handle.createReadStream.bind(handle);
        jest.spyOn(handle, 'createReadStream').mockImplementation((options) => {
          const stream = realCreate(options);
          stream.once('data', () => {
            stream.destroy(new Error('source failure'));
            queueMicrotask(() =>
              stream.emit('error', new Error('secondary source failure')),
            );
          });
          return stream;
        });
      }
      return handle;
    });
    await expect(
      prepareFeedbackBundle({ description: 'lifecycle', area: 'overview' }),
    ).rejects.toThrow(`${failure} failure`);
    expect(await readdir(downloadsDir)).toEqual([]);
    expect(openedHandles.length).toBeGreaterThan(0);
    for (const handle of openedHandles) {
      await expect(handle.stat()).rejects.toThrow();
    }
  });

  it('waits for an outstanding open after failure and closes it without starting a reader', async () => {
    await seedDefaultDiagnostics();
    const realOpen = io.open;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- invoked with apply and its original ZipFile receiver
    const realEnd = ZipFile.prototype.end;
    let failArchive: (() => void) | undefined;
    let releaseOpen: () => void = () => {};
    let notifyOpen: () => void = () => {};
    const openStarted = new Promise<void>((resolve) => {
      notifyOpen = resolve;
    });
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    let heldHandle: Awaited<ReturnType<typeof open>> | undefined;
    const readerStarted = jest.fn();
    jest.spyOn(ZipFile.prototype, 'end').mockImplementation(function (
      this: ZipFile,
      ...args
    ) {
      failArchive = (): void => {
        this.emit('error', new Error('primary failure'));
        this.emit('error', new Error('secondary failure'));
      };
      realEnd.apply(this, args);
    });
    jest.spyOn(io, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (args[1] !== 'wx') {
        heldHandle = handle;
        const realCreate = handle.createReadStream.bind(handle);
        jest.spyOn(handle, 'createReadStream').mockImplementation((options) => {
          readerStarted();
          return realCreate(options);
        });
        notifyOpen();
        await openGate;
      }
      return handle;
    });
    const preparation = prepareFeedbackBundle({
      description: 'pending open',
      area: 'overview',
    });
    const rejected = expect(preparation).rejects.toThrow('primary failure');
    await openStarted;
    try {
      if (failArchive === undefined) throw new Error('archive not started');
      failArchive();
    } finally {
      releaseOpen();
    }
    await rejected;
    expect(readerStarted).not.toHaveBeenCalled();
    expect(heldHandle).toBeDefined();
    await expect(heldHandle?.stat()).rejects.toThrow();
    expect(await readdir(downloadsDir)).toEqual([]);
  });

  it.each(['success', 'read failure'])(
    'bounds source descriptors until asynchronous close on %s',
    async (outcome) => {
      await seedDefaultDiagnostics();
      for (let index = 0; index < 12; index++) {
        await writeText(
          join(
            getDataDir(),
            'agent-observability',
            'diagnostics',
            'app-events',
            `extra-${index}.jsonl`,
          ),
          'record',
        );
      }
      const realOpen = io.open;
      let live = 0;
      let peak = 0;
      let sourceOpens = 0;
      jest.spyOn(io, 'open').mockImplementation(async (...args) => {
        const handle = await realOpen(...args);
        if (args[1] !== 'wx') {
          live++;
          sourceOpens++;
          peak = Math.max(peak, live);
          const failThisSource =
            outcome === 'read failure' && sourceOpens === 4;
          const realCreate = handle.createReadStream.bind(handle);
          jest
            .spyOn(handle, 'createReadStream')
            .mockImplementation((options) => {
              const stream = realCreate(options);
              stream.once('close', () => live--);
              if (failThisSource) {
                stream.once('data', () => {
                  stream.destroy(new Error('bounded read failure'));
                });
              }
              return stream;
            });
        }
        return handle;
      });
      const preparation = prepareFeedbackBundle({
        description: 'many files',
        area: 'overview',
      });
      if (outcome === 'success') {
        const result = await preparation;
        expect((await readZip(result.absolutePath)).size).toBeGreaterThan(12);
      } else {
        await expect(preparation).rejects.toThrow('bounded read failure');
        expect(await readdir(downloadsDir)).toEqual([]);
        expect(sourceOpens).toBe(4);
      }
      expect(peak).toBe(1);
      expect(live).toBe(0);
    },
  );

  it('does not mask a primary failure when archive removal fails', async () => {
    await seedDefaultDiagnostics();
    jest.spyOn(ZipFile.prototype, 'end').mockImplementation(() => {
      throw new Error('primary failure');
    });
    const realRm = io.rm;
    jest.spyOn(io, 'rm').mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('.zip')) throw new Error('cleanup failure');
      return realRm(...args);
    });
    await expect(
      prepareFeedbackBundle({ description: 'cleanup', area: 'overview' }),
    ).rejects.toThrow('primary failure');
  });

  it('sweeps only old regular temporary bundles and preserves active outputs until release', async () => {
    const tempDir = join(tempRoot, 'temporary');
    await mkdir(tempDir);
    const originalGetPath = mockGetPath.getMockImplementation();
    mockGetPath.mockImplementation((name) =>
      name === 'temp' ? tempDir : (originalGetPath?.(name) ?? downloadsDir),
    );
    const now = Date.now();
    const old = new Date(now - 3600001);
    const eligible = 'canopy-feedback-20260505T120000000Z-99.zip';
    const boundary = 'canopy-feedback-20260505T120000001Z.zip';
    const fresh = 'canopy-feedback-20260505T120000002Z.zip';
    const directory = 'canopy-feedback-20260505T120000003Z.zip';
    const link = 'canopy-feedback-20260505T120000004Z.zip';
    for (const name of [eligible, boundary, fresh, 'unrelated.zip']) {
      await writeFile(join(tempDir, name), 'keep');
      await utimes(join(tempDir, name), old, old);
    }
    await utimes(
      join(tempDir, boundary),
      new Date(now - 3600000),
      new Date(now - 3600000),
    );
    await utimes(join(tempDir, fresh), new Date(now), new Date(now));
    await mkdir(join(tempDir, directory));
    await symlink(join(tempDir, eligible), join(tempDir, link));
    await writeFile(join(downloadsDir, eligible), 'export');
    await utimes(join(downloadsDir, eligible), old, old);
    await seedDefaultDiagnostics();
    const active = await prepareFeedbackBundle(
      { description: 'active upload', area: 'overview' },
      { destination: 'temp' },
    );
    await utimes(active.absolutePath, old, old);
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(
        (await io.lstat(join(tempDir, boundary))).mtimeMs + 3600000,
      );
    await cleanupStaleTemporaryFeedbackBundles();
    expect(await readdir(tempDir)).toEqual(
      expect.arrayContaining([
        active.filename,
        boundary,
        fresh,
        directory,
        link,
        'unrelated.zip',
      ]),
    );
    expect(await readdir(tempDir)).not.toContain(eligible);
    expect(await readFile(join(downloadsDir, eligible), 'utf8')).toBe('export');
    releaseTemporaryFeedbackBundle(active.absolutePath);
    await cleanupStaleTemporaryFeedbackBundles();
    expect(await readdir(tempDir)).not.toContain(active.filename);
  });

  it.each(['enumeration', 'metadata', 'removal'])(
    'tolerates stale cleanup %s failure',
    async (failure) => {
      const tempDir = join(tempRoot, 'temporary');
      await mkdir(tempDir);
      const originalGetPath = mockGetPath.getMockImplementation();
      mockGetPath.mockImplementation((name) =>
        name === 'temp' ? tempDir : (originalGetPath?.(name) ?? downloadsDir),
      );
      const path = join(tempDir, 'canopy-feedback-20260505T120000000Z.zip');
      await writeFile(path, 'old');
      await utimes(path, new Date(0), new Date(0));
      if (failure === 'enumeration')
        jest
          .spyOn(io, 'readdir')
          .mockRejectedValueOnce(new Error('enumeration failed'));
      if (failure === 'metadata')
        jest
          .spyOn(io, 'lstat')
          .mockRejectedValueOnce(new Error('metadata failed'));
      if (failure === 'removal')
        jest.spyOn(io, 'rm').mockRejectedValueOnce(new Error('removal failed'));
      await expect(
        cleanupStaleTemporaryFeedbackBundles(),
      ).resolves.toBeUndefined();
      expect(await readFile(path, 'utf8')).toBe('old');
    },
  );

  it.each(['open', 'read'])(
    'continues after an audit source %s error and closes the source',
    async (failure) => {
      await seedDefaultDiagnostics();
      const audit = join(
        getDataDir(),
        'agent-observability',
        'audit',
        '2026-05-05.jsonl',
      );
      await writeFile(audit, '{"event":"audit"}\n');
      const realCreate = fileSystem.createReadStream;
      let auditSource: ReturnType<typeof realCreate> | undefined;
      jest
        .spyOn(fileSystem, 'createReadStream')
        .mockImplementation((path, options) => {
          const source = realCreate(path, options);
          if (path === audit) {
            auditSource = source;
            if (failure === 'open')
              queueMicrotask(() => source.destroy(new Error('open failed')));
            else
              source.once('data', () =>
                source.destroy(new Error('read failed')),
              );
          }
          return source;
        });
      const result = await prepareFeedbackBundle({
        description: 'audit best effort',
        area: 'worktrees',
        workspaceSelections: [
          { workspaceId: 'workspace-a', worktreeIds: ['worktree-a'] },
        ],
        includeChatDetails: true,
      });
      expect((await readZip(result.absolutePath)).has('feedback.json')).toBe(
        true,
      );
      expect(auditSource?.closed).toBe(true);
    },
  );

  it('protects an uploading archive while another submission sweeps temporary files', async () => {
    await seedDefaultDiagnostics();
    const tempDir = join(tempRoot, 'temporary');
    await mkdir(tempDir);
    const originalGetPath = mockGetPath.getMockImplementation();
    mockGetPath.mockImplementation((name) =>
      name === 'temp' ? tempDir : (originalGetPath?.(name) ?? downloadsDir),
    );
    jest.mocked(requestCanopyCloudJson).mockResolvedValue({
      reportId: 'report',
      uploadUrl: 'https://upload.example',
      filePath: 'feedback.zip',
    });
    let notifyUpload: () => void = () => {};
    let releaseUpload: () => void = () => {};
    const uploadStarted = new Promise<void>((resolve) => {
      notifyUpload = resolve;
    });
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const originalFetch = global.fetch;
    const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn();
    fetchMock.mockImplementationOnce(async () => {
      notifyUpload();
      await uploadGate;
      return new Response(null, { status: 200 });
    });
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    global.fetch = fetchMock;
    const request = {
      type: 'bug',
      description: 'concurrent upload',
      includeDiagnostics: true,
      context: { activePage: 'main' },
    } satisfies Parameters<typeof submitFeedback>[0];
    const first = submitFeedback(request);
    try {
      await uploadStarted;
      const [filename] = await readdir(tempDir);
      const firstPath = join(tempDir, filename);
      await utimes(firstPath, new Date(0), new Date(0));
      await expect(submitFeedback(request)).resolves.toEqual({
        submitted: true,
      });
      expect((await readFile(firstPath)).byteLength).toBeGreaterThan(0);
      expect(await readdir(tempDir)).toEqual([filename]);
    } finally {
      releaseUpload();
      try {
        await first;
      } finally {
        global.fetch = originalFetch;
      }
    }
    expect(await readdir(tempDir)).toEqual([]);
  });

  it.each(['write', 'reservation'])(
    'preserves a collision candidate on %s failure',
    async (failure) => {
      await seedDefaultDiagnostics();
      jest
        .spyOn(Date.prototype, 'toISOString')
        .mockReturnValue('2026-05-05T18:15:23.456Z');
      const existing = join(
        downloadsDir,
        'canopy-feedback-20260505T181523456Z.zip',
      );
      await writeFile(existing, 'existing export');
      if (failure === 'write') {
        jest.spyOn(ZipFile.prototype, 'end').mockImplementation(() => {
          throw new Error('write failed');
        });
      } else {
        const realOpen = io.open;
        jest.spyOn(io, 'open').mockImplementation(async (...args) => {
          if (String(args[0]).endsWith('-1.zip'))
            throw new Error('reservation failed');
          return realOpen(...args);
        });
      }
      await expect(
        prepareFeedbackBundle({
          description: 'collision failure',
          area: 'overview',
        }),
      ).rejects.toThrow(
        failure === 'write' ? 'write failed' : 'reservation failed',
      );
      expect(await readFile(existing, 'utf8')).toBe('existing export');
      expect(await readdir(downloadsDir)).toEqual([
        'canopy-feedback-20260505T181523456Z.zip',
      ]);
    },
  );

  it('does not sweep a temp projection that aliases Downloads', async () => {
    const exportPath = join(
      downloadsDir,
      'canopy-feedback-20260505T120000000Z.zip',
    );
    await writeFile(exportPath, 'offline export');
    await utimes(exportPath, new Date(0), new Date(0));
    await cleanupStaleTemporaryFeedbackBundles();
    expect(await readFile(exportPath, 'utf8')).toBe('offline export');
  });

  it('rejects empty descriptions', async () => {
    await expect(
      prepareFeedbackBundle({ description: '  ', area: 'overview' }),
    ).rejects.toThrow('Feedback description is required');
  });

  it('rejects invalid areas', async () => {
    await expect(
      prepareFeedbackBundle({
        description: 'Something broke',
        // @ts-expect-error Runtime validation still protects IPC payloads.
        area: 'bogus',
      }),
    ).rejects.toThrow('Invalid feedback area');
  });

  it('rejects unsafe project, worktree, and chat project ids', async () => {
    await expect(
      prepareFeedbackBundle({
        description: 'Something broke',
        area: 'worktrees',
        workspaceSelections: [{ workspaceId: '../bad', worktreeIds: [] }],
      }),
    ).rejects.toThrow('Invalid workspaceId');

    await expect(
      prepareFeedbackBundle({
        description: 'Something broke',
        area: 'worktrees',
        workspaceSelections: [
          { workspaceId: 'workspace-a', worktreeIds: ['Bad'] },
        ],
      }),
    ).rejects.toThrow('Invalid worktreeId');

    await expect(
      prepareFeedbackBundle({
        description: 'Something broke',
        area: 'chat',
        chatProjectIds: ['bad/project'],
      }),
    ).rejects.toThrow('Invalid chatProjectId');
  });

  it('writes a zip with the expected filename and default diagnostics', async () => {
    await seedDefaultDiagnostics();
    await writeText(join(getDataDir(), 'secure', 'secret.txt'), 'secret');
    await writeText(join(getDataDir(), 'mcp-oauth-tokens.json'), '{}');

    const response = await prepareFeedbackBundle({
      description: '  Default diagnostics please  ',
      area: 'overview',
      includeChatDetails: true,
    });

    expect(response.filename).toMatch(/^canopy-feedback-\d{8}T\d{9}Z\.zip$/);
    expect(response.absolutePath).toBe(join(downloadsDir, response.filename));

    const zip = await readZip(response.absolutePath);
    expect(zip.has('feedback.json')).toBe(true);
    expect(
      zip.has('agent-observability/diagnostics/app-events/2026-05-05.jsonl'),
    ).toBe(true);
    expect(zip.has('agent-observability/audit/2026-05-05.jsonl')).toBe(true);
    expect(zip.has('agent-observability/snapshot.json')).toBe(true);
    expect(zip.has('preferences.json')).toBe(true);
    expect(zip.has('workspaces/index.json')).toBe(true);
    expect(zip.has('secure/secret.txt')).toBe(false);
    expect(zip.has('mcp-oauth-tokens.json')).toBe(false);
    expect(hasEntryEnding(zip, 'conversation.json')).toBe(false);
    expect(hasEntryEnding(zip, 'chat-tabs.json')).toBe(false);
    expect(hasEntryStarting(zip, 'agent-observability/transcripts/')).toBe(
      false,
    );

    const manifest = readManifest(zip);
    expect(getManifestValue(manifest, 'description')).toBe(
      'Default diagnostics please',
    );
    expect(getManifestValue(manifest, 'includeChatDetails')).toBe(false);
    expect(getManifestValue(manifest, 'includePipelineExecutions')).toBe(false);
  });

  it('writes the zip to the temp directory when destination is temp', async () => {
    await seedDefaultDiagnostics();
    const tempOutputDir = join(tempRoot, 'os-temp');
    await mkdir(tempOutputDir, { recursive: true });
    mockGetPath.mockImplementation((name: string): string =>
      name === 'temp' ? tempOutputDir : downloadsDir,
    );

    const response = await prepareFeedbackBundle(
      { description: 'Temp output please', area: 'overview' },
      { destination: 'temp' },
    );

    expect(response.absolutePath).toBe(join(tempOutputDir, response.filename));
    expect(response.absolutePath.startsWith(downloadsDir)).toBe(false);
    expect(response.sizeBytes).toBeGreaterThan(0);

    const zip = await readZip(response.absolutePath);
    expect(zip.has('feedback.json')).toBe(true);
  });

  it('includes the macOS UI main log even when DiagnosticReports is absent', async () => {
    await withProcessPlatform('darwin', async () => {
      await seedDefaultDiagnostics();
      await writeText(
        join(
          process.env.FEEDBACK_BUNDLE_HOME_DIR_FOR_TEST ?? '',
          'Library',
          'Logs',
          'canopy-ui',
          'main.log',
        ),
        'main log contents',
      );

      const response = await prepareFeedbackBundle({
        description: 'UI log please',
        area: 'overview',
      });

      const zip = await readZip(response.absolutePath);
      expect(zip.get('system-logs/canopy-ui/main.log')?.toString()).toBe(
        'main log contents',
      );
    });
  });

  it('includes only the configured Linux main log and its flush receipt', async () => {
    await withProcessPlatform('linux', async () => {
      const logsDir = mockGetPath('logs');
      await writeText(join(logsDir, 'main.log'), 'Linux main log contents');
      await writeText(join(logsDir, 'main.old.log'), 'rotated log');
      await writeText(join(logsDir, 'unrelated.log'), 'unrelated log');
      await writeText(
        join(tempRoot, 'crash-dumps', 'pending', 'crash.dmp'),
        'dump',
      );
      await writeText(
        join(
          process.env.FEEDBACK_BUNDLE_HOME_DIR_FOR_TEST ?? '',
          'Library',
          'Logs',
          'canopy-ui',
          'main.log',
        ),
        'wrong platform log',
      );

      const response = await prepareFeedbackBundle({
        description: 'Linux app diagnostics',
        area: 'overview',
      });
      const zip = await readZip(response.absolutePath);
      expect(zip.get('system-logs/canopy-ui/main.log')?.toString()).toBe(
        'Linux main log contents',
      );
      expect(
        readJsonEntry(zip, 'system-logs/canopy-ui/main-log-flush.json'),
      ).toMatchObject({
        status: 'settled',
        logPath: 'system-logs/canopy-ui/main.log',
      });
      expect(mockFlushMainProcessLogging).toHaveBeenCalledTimes(1);
      expect(mockGetPath).not.toHaveBeenCalledWith('crashDumps');
      expect(
        Array.from(zip.keys())
          .filter((name) => name.startsWith('system-logs/'))
          .sort(),
      ).toEqual([
        'system-logs/canopy-ui/main-log-flush.json',
        'system-logs/canopy-ui/main.log',
      ]);
      expect(getManifestValue(readManifest(zip), 'app')).toMatchObject({
        platform: 'linux',
      });
      expect(getManifestValue(readManifest(zip), 'includedFiles')).toContain(
        'system-logs/canopy-ui/main.log',
      );
    });
  });

  it.each(['missing', 'too-large', 'symlink'] as const)(
    'records a %s Linux main log without bundling it',
    async (reason) => {
      await withProcessPlatform('linux', async () => {
        const logPath = join(mockGetPath('logs'), 'main.log');
        await mkdir(dirname(logPath), { recursive: true });
        if (reason === 'too-large') {
          const file = await open(logPath, 'w');
          try {
            await file.truncate(MAX_FILE_BYTES + 1);
          } finally {
            await file.close();
          }
        } else if (reason === 'symlink') {
          const target = join(tempRoot, 'private.log');
          await writeText(target, 'private contents');
          await symlink(target, logPath);
        }
        const response = await prepareFeedbackBundle({
          description: 'Linux log guards',
          area: 'overview',
        });
        const zip = await readZip(response.absolutePath);
        expect(zip.has('system-logs/canopy-ui/main.log')).toBe(false);
        expect(
          getManifestValue(readManifest(zip), 'skippedFiles'),
        ).toContainEqual({
          path: 'system-logs/canopy-ui/main.log',
          reason,
        });
        expect(zip.has('system-logs/canopy-ui/main-log-flush.json')).toBe(true);
      });
    },
  );

  it('awaits the finite main-log admission fence and keeps later admission open', async () => {
    await withProcessPlatform('darwin', async () => {
      const logPath = join(
        process.env.FEEDBACK_BUNDLE_HOME_DIR_FOR_TEST ?? '',
        'Library',
        'Logs',
        'canopy-ui',
        'main.log',
      );
      await writeText(logPath, 'existing\n');
      let releaseFirst = (): void => undefined;
      let releaseLater = (): void => undefined;
      let markFirstStarted = (): void => undefined;
      let markFenceCalled = (): void => undefined;
      const firstBlocked = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const laterBlocked = new Promise<void>((resolve) => {
        releaseLater = resolve;
      });
      const firstStarted = new Promise<void>((resolve) => {
        markFirstStarted = resolve;
      });
      const fenceCalled = new Promise<void>((resolve) => {
        markFenceCalled = resolve;
      });
      const realAppend = io.appendFile;
      let call = 0;
      jest
        .spyOn(io, 'appendFile')
        .mockImplementation(async (...args): Promise<void> => {
          if (args[0] === logPath) {
            call += 1;
            if (call === 1) {
              markFirstStarted();
              await firstBlocked;
            } else if (call === 2) {
              await laterBlocked;
            }
          }
          await realAppend(...args);
        });
      const sink = new AsyncMainLogSink({
        path: logPath,
        maxSize: 1000,
        maxPendingBytes: 1000,
        fallback: jest.fn(),
      });
      mockFlushMainProcessLogging.mockImplementation(() => {
        const fence = sink.flush();
        markFenceCalled();
        return fence;
      });
      sink.append('pending before capture');
      await firstStarted;
      const capture = prepareFeedbackBundle({
        description: 'Pending log tail',
        area: 'overview',
      });
      try {
        // Unchanged feedback source finishes instead of ever requesting the fence.
        expect(
          await Promise.race([
            fenceCalled.then(() => true),
            capture.then(() => false),
          ]),
        ).toBe(true);
        sink.append('later still admitted');
        releaseFirst();
        const response = await capture; // Must not wait for post-fence admitted work.
        const zip = await readZip(response.absolutePath);
        expect(zip.get('system-logs/canopy-ui/main.log')?.toString()).toBe(
          'existing\npending before capture' + EOL,
        );
        expect(
          readJsonEntry(zip, 'system-logs/canopy-ui/main-log-flush.json'),
        ).toMatchObject({
          status: 'settled',
          result: { throughSequence: 1, writtenRecords: 1, failedRecords: 0 },
        });
        releaseLater();
        expect(await sink.flush()).toMatchObject({
          throughSequence: 2,
          writtenRecords: 2,
          droppedRecords: 0,
        });
        expect(await io.readFile(logPath, 'utf8')).toBe(
          'existing\npending before capture' +
            EOL +
            'later still admitted' +
            EOL,
        );
      } finally {
        releaseFirst();
        releaseLater();
        await sink.drain();
        await capture;
      }
    });
  });

  it('bounds a hung finite fence and retains existing bytes with an explicit timeout', async () => {
    await withProcessPlatform('darwin', async () => {
      await writeText(
        join(
          process.env.FEEDBACK_BUNDLE_HOME_DIR_FOR_TEST ?? '',
          'Library',
          'Logs',
          'canopy-ui',
          'main.log',
        ),
        'stale before hung append',
      );
      let markFenceCalled = (): void => undefined;
      const fenceCalled = new Promise<void>((resolve) => {
        markFenceCalled = resolve;
      });
      mockFlushMainProcessLogging.mockImplementation(() => {
        markFenceCalled();
        return new Promise<MainLogFlushResult>(() => undefined);
      });
      jest.useFakeTimers({
        doNotFake: ['nextTick', 'setImmediate', 'performance'],
      });
      try {
        const capture = prepareFeedbackBundle({
          description: 'Hung log tail',
          area: 'overview',
        });
        expect(
          await Promise.race([
            fenceCalled.then(() => true),
            capture.then(() => false),
          ]),
        ).toBe(true);
        await jest.advanceTimersByTimeAsync(1000);
        const response = await capture;
        const zip = await readZip(response.absolutePath);
        expect(zip.get('system-logs/canopy-ui/main.log')?.toString()).toBe(
          'stale before hung append',
        );
        expect(
          readJsonEntry(zip, 'system-logs/canopy-ui/main-log-flush.json'),
        ).toMatchObject({
          status: 'timed_out',
          timeoutMs: 1000,
        });
        expect(getManifestValue(readManifest(zip), 'includedFiles')).toContain(
          'system-logs/canopy-ui/main.log',
        );
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  it('reports fence failure without silently qualifying the main log or leaking raw error text', async () => {
    await withProcessPlatform('darwin', async () => {
      await writeText(
        join(
          process.env.FEEDBACK_BUNDLE_HOME_DIR_FOR_TEST ?? '',
          'Library',
          'Logs',
          'canopy-ui',
          'main.log',
        ),
        'existing before rejected fence',
      );
      mockFlushMainProcessLogging.mockRejectedValue(
        new Error('PRIVATE_LOGGER_ERROR_SENTINEL'),
      );
      const response = await prepareFeedbackBundle({
        description: 'Failed log fence',
        area: 'overview',
      });
      const zip = await readZip(response.absolutePath);
      expect(
        readJsonEntry(zip, 'system-logs/canopy-ui/main-log-flush.json'),
      ).toMatchObject({ status: 'failed' });
      expect(zip.get('system-logs/canopy-ui/main.log')?.toString()).toBe(
        'existing before rejected fence',
      );
      expect(getManifestValue(readManifest(zip), 'includedFiles')).toContain(
        'system-logs/canopy-ui/main.log',
      );
      expect(
        Array.from(zip.values())
          .map((value) => value.toString())
          .join('\n'),
      ).not.toContain('PRIVATE_LOGGER_ERROR_SENTINEL');
    });
  });

  it('records settled fence loss counters without claiming lossless capture', async () => {
    await withProcessPlatform('darwin', async () => {
      mockFlushMainProcessLogging.mockResolvedValue({
        throughSequence: 3,
        writtenRecords: 2,
        failedRecords: 1,
        droppedRecords: 4,
        failedGapNotices: 1,
      });
      const response = await prepareFeedbackBundle({
        description: 'Loss-accounted log',
        area: 'overview',
      });
      const zip = await readZip(response.absolutePath);
      expect(
        readJsonEntry(zip, 'system-logs/canopy-ui/main-log-flush.json'),
      ).toMatchObject({
        status: 'settled',
        result: {
          throughSequence: 3,
          writtenRecords: 2,
          failedRecords: 1,
          droppedRecords: 4,
          failedGapNotices: 1,
        },
      });
      expect(getManifestValue(readManifest(zip), 'includedFiles')).toContain(
        'system-logs/canopy-ui/main-log-flush.json',
      );
    });
  });

  it('keeps Windows app-log collection unchanged', async () => {
    await withProcessPlatform('win32', async () => {
      const response = await prepareFeedbackBundle({
        description: 'Other platform',
        area: 'overview',
      });
      expect(mockFlushMainProcessLogging).not.toHaveBeenCalled();
      expect(
        (await readZip(response.absolutePath)).has(
          'system-logs/canopy-ui/main-log-flush.json',
        ),
      ).toBe(false);
    });
  });

  it('accepts the actual uninitialized logger zero fence without creating or closing a sink', async () => {
    await withProcessPlatform('darwin', async () => {
      const actual = jest.requireActual<typeof MainProcessLogging>(
        '../lib/main-process-logging',
      );
      mockFlushMainProcessLogging.mockImplementation(
        actual.flushMainProcessLogging,
      );
      const response = await prepareFeedbackBundle({
        description: 'No initialized logger',
        area: 'overview',
      });
      const zip = await readZip(response.absolutePath);
      expect(
        readJsonEntry(zip, 'system-logs/canopy-ui/main-log-flush.json'),
      ).toMatchObject({
        status: 'settled',
        result: {
          throughSequence: 0,
          writtenRecords: 0,
          failedRecords: 0,
          droppedRecords: 0,
          failedGapNotices: 0,
        },
      });
      expect(await actual.flushMainProcessLogging()).toMatchObject({
        throughSequence: 0,
      });
    });
  });

  it('includes only crash reports owned by the active brand', async () => {
    await withProcessPlatform('darwin', async () => {
      await seedDefaultDiagnostics();
      const reportsDir = join(
        process.env.FEEDBACK_BUNDLE_HOME_DIR_FOR_TEST ?? '',
        'Library',
        'Logs',
        'DiagnosticReports',
      );
      const ownedName = 'Canopy Helper (Renderer)-2026-08-18-120000.ips';
      const foreignName = 'Canopy Helper (GPU)-2026-08-18-120001.ips';
      await writeText(
        join(reportsDir, ownedName),
        `${JSON.stringify({ bundleID: 'com.canopy.ui.helper.Renderer' })}\n{}`,
      );
      await writeText(
        join(reportsDir, foreignName),
        `${JSON.stringify({ bundleID: 'com.canopy.ui.evil' })}\n{}`,
      );

      const response = await prepareFeedbackBundle({
        description: 'Owned crash reports only',
        area: 'overview',
      });

      const zip = await readZip(response.absolutePath);
      expect(zip.has(`system-logs/DiagnosticReports/${ownedName}`)).toBe(true);
      expect(zip.has(`system-logs/DiagnosticReports/${foreignName}`)).toBe(
        false,
      );
    });
  });

  it('does not include compatible brand UI logs when the primary UI log is absent', async () => {
    await withProcessPlatform('darwin', async () => {
      await seedDefaultDiagnostics();
      await writeText(
        join(
          process.env.FEEDBACK_BUNDLE_HOME_DIR_FOR_TEST ?? '',
          'Library',
          'Logs',
          'canopy-dev-ui',
          'main.log',
        ),
        'dev alias log contents',
      );

      const response = await prepareFeedbackBundle({
        description: 'Fallback UI log please',
        area: 'overview',
      });

      const zip = await readZip(response.absolutePath);
      expect(zip.has('system-logs/canopy-ui/main.log')).toBe(false);
      expect(zip.has('system-logs/canopy-dev-ui/main.log')).toBe(false);
      const manifest = readManifest(zip);
      expect(
        JSON.stringify(getManifestValue(manifest, 'skippedFiles')),
      ).toContain('system-logs/canopy-ui/main.log');
      expect(
        JSON.stringify(getManifestValue(manifest, 'skippedFiles')),
      ).not.toContain('system-logs/canopy-dev-ui/main.log');
    });
  });

  it('does not reuse an existing output path for the same timestamp', async () => {
    const toISOStringSpy = jest
      .spyOn(Date.prototype, 'toISOString')
      .mockReturnValue('2026-05-05T18:15:23.456Z');
    try {
      await seedDefaultDiagnostics();

      const firstResponse = await prepareFeedbackBundle({
        description: 'First diagnostics',
        area: 'overview',
      });
      const firstContents = await readFile(firstResponse.absolutePath);

      const secondResponse = await prepareFeedbackBundle({
        description: 'Second diagnostics',
        area: 'overview',
      });

      expect(firstResponse.filename).toBe(
        'canopy-feedback-20260505T181523456Z.zip',
      );
      expect(secondResponse.filename).toBe(
        'canopy-feedback-20260505T181523456Z-1.zip',
      );
      await expect(readFile(firstResponse.absolutePath)).resolves.toEqual(
        firstContents,
      );
      expect(secondResponse.absolutePath).toBe(
        join(downloadsDir, secondResponse.filename),
      );
    } finally {
      toISOStringSpy.mockRestore();
    }
  });

  it('ignores project and chat selections outside their matching areas', async () => {
    await seedDefaultDiagnostics();
    await writeJson(getWorkspaceConfigPath('workspace-a'), {
      id: 'workspace-a',
    });
    await writeJson(getWorkspaceWorktreesFilePath('workspace-a'), []);
    await writeJson(getChatProjectProjectFilePath('project-a'), {
      id: 'project-a',
    });

    const response = await prepareFeedbackBundle({
      description: 'Overview only',
      area: 'overview',
      workspaceSelections: [
        { workspaceId: 'workspace-a', worktreeIds: ['worktree-a'] },
      ],
      chatProjectIds: ['project-a'],
      includeChatDetails: true,
    });

    const zip = await readZip(response.absolutePath);
    const manifest = readManifest(zip);
    expect(getManifestValue(manifest, 'workspaceSelections')).toEqual([]);
    expect(getManifestValue(manifest, 'chatProjectIds')).toEqual([]);
    expect(getManifestValue(manifest, 'includeChatDetails')).toBe(false);
    expect(getManifestValue(manifest, 'includePipelineExecutions')).toBe(false);
    expect(zip.has('workspaces/workspace-a/workspace.json')).toBe(false);
    expect(zip.has('standalone-chat/projects/project-a/project.json')).toBe(
      false,
    );
  });

  it('redacts persisted chat badge content unless chat details are included', async () => {
    await seedDefaultDiagnostics();
    await writeJson(getWorkspaceConfigPath('workspace-a'), {
      id: 'workspace-a',
    });
    await writeJson(getWorkspaceWorktreesFilePath('workspace-a'), {
      version: 1,
      worktrees: [
        {
          id: 'worktree-a',
          branchName: 'feature/private-chat',
          createdAt: '2026-07-17T00:00:00.000Z',
          chatBadges: {
            version: 1,
            unreadChats: [
              {
                chatId: 'chat-a',
                title: 'Private chat title',
                providerType: 'claude',
                preview: 'Private assistant response',
                markedUnread: true,
              },
            ],
            approvalChats: [
              { chatId: 'chat-b', title: 'Private approval title' },
            ],
            needsHydration: true,
            updatedAt: '2026-07-17T00:00:00.000Z',
          },
        },
      ],
    });
    const request: FeedbackPrepareRequest = {
      description: 'Worktree diagnostics',
      area: 'worktrees',
      workspaceSelections: [
        { workspaceId: 'workspace-a', worktreeIds: ['worktree-a'] },
      ],
    };

    const redactedResponse = await prepareFeedbackBundle(request);
    const redactedZip = await readZip(redactedResponse.absolutePath);
    const redactedWorktrees = readJsonEntry(
      redactedZip,
      'workspaces/workspace-a/worktrees.json',
    );
    const redactedJson = JSON.stringify(redactedWorktrees);
    expect(redactedJson).toContain('chat-a');
    expect(redactedJson).toContain('claude');
    expect(redactedJson).toContain('"markedUnread":true');
    expect(redactedJson).not.toContain('Private chat title');
    expect(redactedJson).not.toContain('Private assistant response');
    expect(redactedJson).not.toContain('Private approval title');

    const detailedResponse = await prepareFeedbackBundle({
      ...request,
      includeChatDetails: true,
    });
    const detailedZip = await readZip(detailedResponse.absolutePath);
    const detailedWorktrees = readJsonEntry(
      detailedZip,
      'workspaces/workspace-a/worktrees.json',
    );
    const detailedJson = JSON.stringify(detailedWorktrees);
    expect(detailedJson).toContain('Private chat title');
    expect(detailedJson).toContain('Private assistant response');
    expect(detailedJson).toContain('Private approval title');
  });

  it('includes selected worktree chats and matching transcript sidecars when opted in', async () => {
    await seedDefaultDiagnostics();
    await writeJson(getWorkspaceConfigPath('workspace-a'), {
      id: 'workspace-a',
    });
    await writeJson(getWorkspaceWorktreesFilePath('workspace-a'), []);
    await writeJson(getWorkspaceChatTabsFilePath('workspace-a', 'worktree-a'), [
      { role: 'user', content: 'hello' },
    ]);
    await writeJson(getWorktreeSummaryFilePath('workspace-a', 'worktree-a'), {
      summary: 'summary',
    });
    await writeJson(
      getWorkspaceTrackedPlansFilePath('workspace-a', 'worktree-a'),
      { plans: [] },
    );
    await writeText(
      join(getWorkspaceScriptRunDir('workspace-a', 'worktree-a'), 'run.log'),
      'script output',
    );
    await writeText(
      join(getHookInvocationsDir('workspace-a', 'worktree-a'), 'hook.json'),
      '{}',
    );

    const transcriptPath = getAgentObservabilityTranscriptFilePath({
      id: 'audit-worktree',
      eventType: 'worktree_chat',
      startedAt: '2026-05-05T12:00:00.000Z',
    });
    await writeText(transcriptPath, '{"type":"message"}\n');
    await appendAuditLine({
      id: 'audit-worktree',
      eventType: 'worktree_chat',
      startedAt: '2026-05-05T12:00:00.000Z',
      hasTranscript: true,
      projectId: 'workspace-a',
      worktreeId: 'worktree-a',
    });

    const response = await prepareFeedbackBundle({
      description: 'Worktree details',
      area: 'worktrees',
      workspaceSelections: [
        { workspaceId: 'workspace-a', worktreeIds: ['worktree-a'] },
      ],
      includeChatDetails: true,
    });

    const zip = await readZip(response.absolutePath);
    expect(zip.has('workspaces/workspace-a/chats/worktree-a.json')).toBe(true);
    expect(zip.has('workspaces/workspace-a/summaries/worktree-a.json')).toBe(
      true,
    );
    expect(zip.has('workspaces/workspace-a/plans/worktree-a.json')).toBe(true);
    expect(
      zip.has('workspaces/workspace-a/script-runs/worktree-a/run.log'),
    ).toBe(true);
    expect(
      zip.has(
        'workspaces/workspace-a/worktree-data/worktree-a/hook-invocations/hook.json',
      ),
    ).toBe(true);
    expect(
      hasEntryStarting(zip, 'agent-observability/transcripts/2026-05-05/'),
    ).toBe(true);
  });

  it('includes the selected v2 storage closure only when chat details are requested', async () => {
    await seedDefaultDiagnostics();
    const prefix = 'workspaces/workspace-a';
    const closure = [
      `${prefix}/chat-storage-manifests/worktree-a.json`,
      ...[
        'live-index.json',
        'archive-index.json',
        'recovery-index.json',
        'metadata-journal.jsonl',
        'transcripts/chat.jsonl',
        'transcripts/chat.active.json',
        'transcripts/tool-output/chat/output.txt',
        'transcripts/visuals/chat/sha256-v1-visual.html',
        'pending-transcripts/transaction/0.jsonl',
      ].map((file) => `${prefix}/chat-storage-v2/worktree-a/${file}`),
    ];
    const stagedVisual = `${prefix}/chat-storage-v2/worktree-a/visual-staging/chat/document.html`;
    for (const file of closure)
      await writeText(join(getDataDir(), file), 'retained evidence');
    await writeText(join(getDataDir(), stagedVisual), 'staged visual');
    await writeText(
      join(
        getDataDir(),
        prefix,
        'chat-storage-v2/unselected/transcripts/private.jsonl',
      ),
      'unselected chat',
    );
    for (const includeChatDetails of [false, true]) {
      const response = await prepareFeedbackBundle({
        description: 'V2 persistence evidence',
        area: 'worktrees',
        workspaceSelections: [
          { workspaceId: 'workspace-a', worktreeIds: ['worktree-a'] },
        ],
        includeChatDetails,
      });
      const zip = await readZip(response.absolutePath);
      for (const file of closure)
        expect(zip.has(file)).toBe(includeChatDetails);
      expect(zip.has(stagedVisual)).toBe(false);
      expect(
        zip.has(
          `${prefix}/chat-storage-v2/unselected/transcripts/private.jsonl`,
        ),
      ).toBe(false);
    }
  });

  it('carries the records a delta-journal checkpoint does not hold yet', async () => {
    await seedDefaultDiagnostics();
    const scope = { projectId: 'workspace-a', worktreeId: 'worktree-a' };
    const tabs = getWorkspaceChatTabsFilePath(
      scope.projectId,
      scope.worktreeId,
    );
    const paths = {
      tabs,
      archives: join(
        dirname(dirname(tabs)),
        'chat-archives',
        'worktree-a.json',
      ),
      journal: join(
        dirname(dirname(tabs)),
        'chat-journals',
        'worktree-a.jsonl',
      ),
    };
    await ChatStorageV2.fromLegacyPaths(paths).migrate(() =>
      Promise.resolve({
        revision: 0,
        index: { activeTabId: 'chat', runtimeByChatId: {} },
        recovery: {
          receipts: [],
          mutationIds: [],
          removedTabIds: [],
          removedArchiveEntryIds: [],
          removedMessageIds: [],
        },
        chats: (async function* (): AsyncGenerator<ChatMigrationEntry> {
          yield await Promise.resolve({
            metadata: { id: 'chat', title: 'Chat', createdAt: '2026-10-01' },
            messages: (async function* (): AsyncGenerator<never> {})(),
          });
        })(),
      }),
    );

    const repository = new ChatStateV2Repository({
      resolvePaths: (): typeof paths => paths,
    });
    try {
      await repository.transact(
        scope,
        [
          {
            type: 'tab.metadata_patched',
            tabId: 'chat',
            patch: { title: 'Journaled only' },
          },
        ],
        { source: 'provider', mutationId: 'journaled' },
      );
      const prefix = 'workspaces/workspace-a';
      const journal = join(
        getDataDir(),
        prefix,
        'chat-storage-v2/worktree-a/delta-journal.log',
      );
      const response = await prepareFeedbackBundle({
        description: 'Delta journal evidence',
        area: 'worktrees',
        workspaceSelections: [
          { workspaceId: 'workspace-a', worktreeIds: ['worktree-a'] },
        ],
        includeChatDetails: true,
      });
      const zip = await readZip(response.absolutePath);
      // The raw closure includes the journal: checkpoint plus records.
      expect(
        zip.get(`${prefix}/chat-storage-v2/worktree-a/delta-journal.log`),
      ).toEqual(await readFile(journal));
      expect(
        zip.get(`${prefix}/chat-storage-manifests/worktree-a.json`)?.toString(),
      ).toContain('"version":3');
    } finally {
      await repository.drainAll();
    }
  });

  it('keeps scanning transcripts after one malformed audit entry', async () => {
    await seedDefaultDiagnostics();
    const transcriptPath = getAgentObservabilityTranscriptFilePath({
      id: 'audit-good',
      eventType: 'worktree_chat',
      startedAt: '2026-05-05T12:00:00.000Z',
    });
    await writeText(transcriptPath, '{"type":"message"}\n');
    await appendAuditLine({
      id: 'audit-bad',
      eventType: 'worktree_chat',
      startedAt: 'not-a-date',
      hasTranscript: true,
      projectId: 'workspace-a',
      worktreeId: 'worktree-a',
    });
    await appendAuditLine({
      id: 'audit-good',
      eventType: 'worktree_chat',
      startedAt: '2026-05-05T12:00:00.000Z',
      hasTranscript: true,
      projectId: 'workspace-a',
      worktreeId: 'worktree-a',
    });

    const response = await prepareFeedbackBundle({
      description: 'Worktree details',
      area: 'worktrees',
      workspaceSelections: [
        { workspaceId: 'workspace-a', worktreeIds: ['worktree-a'] },
      ],
      includeChatDetails: true,
    });

    const zip = await readZip(response.absolutePath);
    expect(
      hasEntryStarting(zip, 'agent-observability/transcripts/2026-05-05/'),
    ).toBe(true);
  });

  it('includes selected standalone chat details and matching transcript sidecars when opted in', async () => {
    await seedDefaultDiagnostics();
    await writeJson(getChatProjectProjectFilePath('project-a'), {
      id: 'project-a',
    });
    await writeJson(
      getWorkspaceChatTabsFilePath('project-a', COWORK_HOME_WORKTREE_ID),
      [{ title: 'Active chat' }],
    );
    await writeJson(
      getWorkspaceChatHistoryMetaFilePath('project-a', 'chat-a'),
      {
        id: 'chat-a',
      },
    );
    await writeText(
      getWorkspaceChatHistorySummaryFilePath('project-a', 'chat-a'),
      'summary',
    );
    await writeJson(
      getWorkspaceChatHistoryConversationFilePath('project-a', 'chat-a'),
      [{ role: 'user', content: 'chat transcript' }],
    );

    const transcriptPath = getAgentObservabilityTranscriptFilePath({
      id: 'audit-chat',
      eventType: 'standalone_chat',
      startedAt: '2026-05-05T13:00:00.000Z',
    });
    await writeText(transcriptPath, '{"type":"message"}\n');
    await appendAuditLine({
      id: 'audit-chat',
      eventType: 'standalone_chat',
      startedAt: '2026-05-05T13:00:00.000Z',
      hasTranscript: true,
      projectId: STANDALONE_CHAT_PROJECT_ID,
      worktreeId: 'project-a',
    });

    const response = await prepareFeedbackBundle({
      description: 'Chat details',
      area: 'chat',
      chatProjectIds: ['project-a'],
      includeChatDetails: true,
    });

    const zip = await readZip(response.absolutePath);
    expect(zip.has('standalone-chat/projects/project-a/project.json')).toBe(
      true,
    );
    expect(zip.has('workspaces/project-a/chats/home.json')).toBe(true);
    expect(zip.has('workspaces/project-a/chat-history/chat-a/meta.json')).toBe(
      true,
    );
    expect(zip.has('workspaces/project-a/chat-history/chat-a/summary.md')).toBe(
      true,
    );
    expect(
      zip.has('workspaces/project-a/chat-history/chat-a/conversation.json'),
    ).toBe(true);
    expect(
      hasEntryStarting(zip, 'agent-observability/transcripts/2026-05-05/'),
    ).toBe(true);
  });

  it('collects cowork and archived-history v2 files only for an opted-in project', async () => {
    await seedDefaultDiagnostics();
    const files = [
      'workspaces/project-a/chat-storage-manifests/home.json',
      'workspaces/project-a/chat-storage-v2/home/transcripts/chat.jsonl',
      'workspaces/project-a/chat-history/chat-a/chat-storage-manifests/chat-a.json',
      'workspaces/project-a/chat-history/chat-a/chat-storage-v2/chat-a/transcripts/chat.jsonl',
    ];
    for (const file of files)
      await writeText(join(getDataDir(), file), 'canonical evidence');
    for (const includeChatDetails of [false, true]) {
      const response = await prepareFeedbackBundle({
        description: 'Cowork evidence',
        area: 'chat',
        chatProjectIds: ['project-a'],
        includeChatDetails,
      });
      const zip = await readZip(response.absolutePath);
      for (const file of files) expect(zip.has(file)).toBe(includeChatDetails);
    }
  });

  it('includes matching transcript sidecars for a real cowork project id keyed to the home worktree', async () => {
    await seedDefaultDiagnostics();
    registerWorkspaceTypes(new Map([['cowork-default', 'cowork']]));
    await writeJson(
      getWorkspaceChatTabsFilePath('cowork-default', COWORK_HOME_WORKTREE_ID),
      [{ title: 'Active chat' }],
    );
    await writeJson(
      getWorkspaceChatHistoryMetaFilePath('cowork-default', 'chat-a'),
      { id: 'chat-a' },
    );

    // New cowork turns are audited as (projectId=workspace id,
    // worktreeId='home'), not the legacy sentinel-keyed shape.
    const transcriptPath = getAgentObservabilityTranscriptFilePath({
      id: 'audit-chat-cowork',
      eventType: 'standalone_chat',
      startedAt: '2026-05-06T13:00:00.000Z',
    });
    await writeText(transcriptPath, '{"type":"message"}\n');
    await appendAuditLine({
      id: 'audit-chat-cowork',
      eventType: 'standalone_chat',
      startedAt: '2026-05-06T13:00:00.000Z',
      hasTranscript: true,
      projectId: 'cowork-default',
      worktreeId: COWORK_HOME_WORKTREE_ID,
    });

    const response = await prepareFeedbackBundle({
      description: 'Cowork chat details',
      area: 'chat',
      chatProjectIds: ['cowork-default'],
      includeChatDetails: true,
    });

    const zip = await readZip(response.absolutePath);
    expect(zip.has('workspaces/cowork-default/chats/home.json')).toBe(true);
    expect(
      hasEntryStarting(zip, 'agent-observability/transcripts/2026-05-06/'),
    ).toBe(true);
  });

  it('includes chat_handoff_summary transcript sidecars', async () => {
    // The handoff-summary helper seeds a real transcript sidecar. Its event
    // type must be in the transcript-scope maps, or the bundle keeps the audit
    // row and silently drops the transcript that explains it — exactly the
    // report ("the handoff summary lost my context") the bundle is meant to
    // diagnose.
    await seedDefaultDiagnostics();
    registerWorkspaceTypes(new Map([['cowork-default', 'cowork']]));
    await writeJson(
      getWorkspaceChatTabsFilePath('cowork-default', COWORK_HOME_WORKTREE_ID),
      [{ title: 'Active chat' }],
    );

    const transcriptPath = getAgentObservabilityTranscriptFilePath({
      id: 'audit-handoff',
      eventType: 'chat_handoff_summary',
      startedAt: '2026-05-07T13:00:00.000Z',
    });
    await writeText(transcriptPath, '{"type":"message"}\n');
    await appendAuditLine({
      id: 'audit-handoff',
      eventType: 'chat_handoff_summary',
      startedAt: '2026-05-07T13:00:00.000Z',
      hasTranscript: true,
      projectId: 'cowork-default',
      worktreeId: COWORK_HOME_WORKTREE_ID,
    });

    const response = await prepareFeedbackBundle({
      description: 'Handoff summary details',
      area: 'chat',
      chatProjectIds: ['cowork-default'],
      includeChatDetails: true,
    });

    const zip = await readZip(response.absolutePath);
    expect(
      hasEntryStarting(zip, 'agent-observability/transcripts/2026-05-07/'),
    ).toBe(true);
  });

  it('skips invalid standalone chat history directories without failing', async () => {
    await seedDefaultDiagnostics();
    await writeJson(getChatProjectProjectFilePath('project-a'), {
      id: 'project-a',
    });
    await writeJson(
      getWorkspaceChatTabsFilePath('project-a', COWORK_HOME_WORKTREE_ID),
      [{ title: 'Active chat' }],
    );
    await writeJson(
      getWorkspaceChatHistoryMetaFilePath('project-a', 'chat-a'),
      {
        id: 'chat-a',
      },
    );
    await mkdir(join(getWorkspaceChatHistoryRootDir('project-a'), 'Bad Chat'), {
      recursive: true,
    });

    const response = await prepareFeedbackBundle({
      description: 'Chat details',
      area: 'chat',
      chatProjectIds: ['project-a'],
      includeChatDetails: true,
    });

    const zip = await readZip(response.absolutePath);
    expect(zip.has('workspaces/project-a/chat-history/chat-a/meta.json')).toBe(
      true,
    );
    const manifest = readManifest(zip);
    const skipped = getManifestValue(manifest, 'skippedFiles');
    expect(JSON.stringify(skipped)).toContain(
      'workspaces/project-a/chat-history/Bad Chat',
    );
    expect(JSON.stringify(skipped)).toContain('inaccessible');
  });

  it('does not include all chat transcripts when details are enabled without selections', async () => {
    await seedDefaultDiagnostics();
    const transcriptPath = getAgentObservabilityTranscriptFilePath({
      id: 'audit-unselected',
      eventType: 'worktree_chat',
      startedAt: '2026-05-05T14:00:00.000Z',
    });
    await writeText(transcriptPath, '{"type":"message"}\n');
    await appendAuditLine({
      id: 'audit-unselected',
      eventType: 'worktree_chat',
      startedAt: '2026-05-05T14:00:00.000Z',
      hasTranscript: true,
      projectId: 'workspace-a',
      worktreeId: 'worktree-a',
    });

    const response = await prepareFeedbackBundle({
      description: 'No selections',
      area: 'worktrees',
      includeChatDetails: true,
      workspaceSelections: [{ workspaceId: 'workspace-a', worktreeIds: [] }],
    });

    const zip = await readZip(response.absolutePath);
    expect(hasEntryStarting(zip, 'agent-observability/transcripts/')).toBe(
      false,
    );
  });

  it('includes pipeline execution root files and step artifacts', async () => {
    await seedDefaultDiagnostics();
    await writeJson(join(getDataDir(), 'pipeline-executions', 'index.json'), {
      executions: ['execution-a'],
    });
    await writeJson(
      join(
        getDataDir(),
        'pipeline-executions',
        'execution-a',
        'change-summary.json',
      ),
      { changed: true },
    );
    await writeText(
      join(
        getDataDir(),
        'pipeline-executions',
        'execution-a',
        'workspace.diff',
      ),
      'diff --git a/file.ts b/file.ts',
    );
    await writeText(
      join(
        getDataDir(),
        'pipeline-executions',
        'execution-a',
        '3',
        'json-response.json',
      ),
      '{"ok":true}\n',
    );
    await writeText(
      join(
        getDataDir(),
        'pipeline-executions',
        'execution-a',
        'logs',
        'stdout.log',
      ),
      'pipeline output',
    );

    const response = await prepareFeedbackBundle({
      description: 'Pipeline failed review',
      area: 'pipelines',
    });

    const zip = await readZip(response.absolutePath);
    expect(zip.has('pipeline-executions/index.json')).toBe(true);
    expect(readJsonEntry(zip, 'pipeline-executions/index.json')).toEqual({
      executions: ['execution-a'],
    });
    expect(zip.has('pipeline-executions/execution-a/change-summary.json')).toBe(
      true,
    );
    expect(zip.has('pipeline-executions/execution-a/workspace.diff')).toBe(
      true,
    );
    expect(
      zip.has('pipeline-executions/execution-a/3/json-response.json'),
    ).toBe(true);
    expect(zip.has('pipeline-executions/execution-a/logs/stdout.log')).toBe(
      true,
    );
  });

  it('sanitizes pipeline execution state in pipeline and worktree scopes', async () => {
    await seedDefaultDiagnostics();
    await writeJson(
      join(getDataDir(), 'pipeline-executions', 'execution-a.json'),
      {
        version: 3,
        id: 'execution-a',
        pipeline_id: 'pipeline-a',
        pipeline_snapshot: {
          name: 'Review Pipeline',
          prompt: 'SENTINEL_PIPELINE_SNAPSHOT_SECRET',
        },
        status: 'failure',
        started_at: '2026-05-05T12:00:00.000Z',
        completed_at: '2026-05-05T12:01:00.000Z',
        cwd: '/private/SENTINEL_CWD_SECRET',
        env: { SECRET_TOKEN: 'SENTINEL_ENV_SECRET' },
        inputs: { prompt: 'SENTINEL_INPUT_SECRET' },
        event_data: { payload: 'SENTINEL_EVENT_SECRET' },
        rerun_context: { reason: 'SENTINEL_RERUN_SECRET' },
        trigger_source: {
          type: 'pipeline',
          name: 'Pipeline event',
          event_name: 'task_ready',
          event_payload: 'SENTINEL_TRIGGER_SECRET',
        },
        project_id: 'workspace-a',
        worktree_id: 'worktree-a',
        jobs: {
          build: {
            status: 'failure',
            report_outputs: {
              report_file: '/Users/tirish/SENTINEL_JOB_REPORT_PATH/report.md',
              report_json_file:
                '/Users/tirish/SENTINEL_JOB_REPORT_JSON_PATH/report.json',
            },
            outputs: { token: 'SENTINEL_JOB_OUTPUT_SECRET' },
            steps: {
              run: {
                status: 'failure',
                exit_code: 1,
                error: 'command failed',
                log_file: '/Users/tirish/SENTINEL_LOG_PATH/run.log',
                report_outputs: {
                  report_file: '/Users/tirish/SENTINEL_REPORT_PATH/report.md',
                  report_json_file:
                    '/Users/tirish/SENTINEL_REPORT_JSON_PATH/report.json',
                },
                outputs: { token: 'SENTINEL_STEP_OUTPUT_SECRET' },
                dynamic_env: { TOKEN: 'SENTINEL_DYNAMIC_ENV_SECRET' },
              },
            },
          },
        },
      },
    );

    const pipelineResponse = await prepareFeedbackBundle({
      description: 'Pipeline failed',
      area: 'pipelines',
    });
    expectSanitizedExecutionState(await readZip(pipelineResponse.absolutePath));

    const worktreeResponse = await prepareFeedbackBundle({
      description: 'Worktree pipeline failed',
      area: 'worktrees',
      workspaceSelections: [
        { workspaceId: 'workspace-a', worktreeIds: ['worktree-a'] },
      ],
      includePipelineExecutions: true,
    });
    expectSanitizedExecutionState(await readZip(worktreeResponse.absolutePath));
  });

  it('records malformed pipeline execution state files as skipped', async () => {
    await seedDefaultDiagnostics();
    await writeText(
      join(getDataDir(), 'pipeline-executions', 'execution-a.json'),
      '{"id":',
    );

    const response = await prepareFeedbackBundle({
      description: 'Pipeline failed',
      area: 'pipelines',
    });

    const zip = await readZip(response.absolutePath);
    expect(zip.has('pipeline-executions/execution-a.json')).toBe(false);
    const manifest = readManifest(zip);
    const skipped = getManifestValue(manifest, 'skippedFiles');
    expect(skipped).toEqual(
      expect.arrayContaining([
        {
          path: 'pipeline-executions/execution-a.json',
          reason: 'inaccessible',
        },
      ]),
    );
  });

  it('records and skips policy-excluded directories without including their files', async () => {
    await seedDefaultDiagnostics();
    await writeText(
      join(
        getDataDir(),
        'pipeline-executions',
        'execution-a',
        'logs',
        'run.log',
      ),
      'pipeline log',
    );
    await writeText(
      join(
        getDataDir(),
        'pipeline-executions',
        'execution-a',
        'artifacts',
        'secret.txt',
      ),
      'artifact secret',
    );

    const response = await prepareFeedbackBundle({
      description: 'Pipeline details',
      area: 'pipelines',
    });

    const zip = await readZip(response.absolutePath);
    expect(zip.has('pipeline-executions/execution-a/logs/run.log')).toBe(true);
    expect(
      zip.has('pipeline-executions/execution-a/artifacts/secret.txt'),
    ).toBe(false);

    const manifest = readManifest(zip);
    const skipped = getManifestValue(manifest, 'skippedFiles');
    expect(JSON.stringify(skipped)).toContain(
      'pipeline-executions/execution-a/artifacts',
    );
    expect(JSON.stringify(skipped)).toContain('policy-excluded');
  });

  it('includes a minimal pipeline execution summary for selected worktrees by default', async () => {
    await seedDefaultDiagnostics();
    await seedPipelineExecutionState({
      id: 'execution-a',
      pipelineId: 'pipeline-a',
      pipelineName: 'Review Pipeline',
      projectId: 'workspace-a',
      worktreeId: 'worktree-a',
      planId: 'plan-a',
    });
    await writeText(
      join(
        getDataDir(),
        'pipeline-executions',
        'execution-a',
        'workspace.diff',
      ),
      'diff --git a/file.ts b/file.ts',
    );
    await writeText(
      join(
        getDataDir(),
        'pipeline-executions',
        'execution-a',
        'logs',
        'stdout.log',
      ),
      'pipeline output',
    );

    const response = await prepareFeedbackBundle({
      description: 'Worktree pipeline failed',
      area: 'worktrees',
      workspaceSelections: [
        { workspaceId: 'workspace-a', worktreeIds: ['worktree-a'] },
      ],
    });

    const zip = await readZip(response.absolutePath);
    expect(zip.has('pipeline-executions/summary.json')).toBe(true);
    expect(zip.has('pipeline-executions/execution-a.json')).toBe(false);
    expect(zip.has('pipeline-executions/execution-a/workspace.diff')).toBe(
      false,
    );
    expect(zip.has('pipeline-executions/execution-a/logs/stdout.log')).toBe(
      false,
    );

    const manifest = readManifest(zip);
    expect(getManifestValue(manifest, 'includePipelineExecutions')).toBe(false);
    const summary = readJsonEntry(zip, 'pipeline-executions/summary.json');
    expect(getManifestValue(summary, 'executionCount')).toBe(1);
    expect(getManifestValue(summary, 'executions')).toEqual([
      expect.objectContaining({
        id: 'execution-a',
        pipeline_id: 'pipeline-a',
        pipeline_name: 'Review Pipeline',
        status: 'failure',
        project_id: 'workspace-a',
        worktree_id: 'worktree-a',
        plan_id: 'plan-a',
      }),
    ]);
  });

  it('includes full pipeline execution state and directories for selected worktrees when opted in', async () => {
    await seedDefaultDiagnostics();
    await seedPipelineExecutionState({
      id: 'execution-a',
      pipelineId: 'pipeline-a',
      pipelineName: 'Review Pipeline',
      projectId: 'workspace-a',
      worktreeId: 'worktree-a',
    });
    await writeText(
      join(
        getDataDir(),
        'pipeline-executions',
        'execution-a',
        'workspace.diff',
      ),
      'diff --git a/file.ts b/file.ts',
    );
    await writeText(
      join(
        getDataDir(),
        'pipeline-executions',
        'execution-a',
        'logs',
        'stdout.log',
      ),
      'pipeline output',
    );

    const response = await prepareFeedbackBundle({
      description: 'Worktree pipeline failed',
      area: 'worktrees',
      workspaceSelections: [
        { workspaceId: 'workspace-a', worktreeIds: ['worktree-a'] },
      ],
      includePipelineExecutions: true,
    });

    const zip = await readZip(response.absolutePath);
    expect(zip.has('pipeline-executions/summary.json')).toBe(true);
    expect(zip.has('pipeline-executions/execution-a.json')).toBe(true);
    expect(zip.has('pipeline-executions/execution-a/workspace.diff')).toBe(
      true,
    );
    expect(zip.has('pipeline-executions/execution-a/logs/stdout.log')).toBe(
      true,
    );

    const manifest = readManifest(zip);
    expect(getManifestValue(manifest, 'includePipelineExecutions')).toBe(true);
  });

  it('does not include pipeline execution content for unselected worktrees', async () => {
    await seedDefaultDiagnostics();
    await seedPipelineExecutionState({
      id: 'execution-a',
      pipelineId: 'pipeline-a',
      pipelineName: 'Review Pipeline',
      projectId: 'workspace-b',
      worktreeId: 'worktree-b',
    });
    await writeText(
      join(
        getDataDir(),
        'pipeline-executions',
        'execution-a',
        'logs',
        'stdout.log',
      ),
      'pipeline output',
    );

    const response = await prepareFeedbackBundle({
      description: 'Worktree pipeline failed',
      area: 'worktrees',
      workspaceSelections: [
        { workspaceId: 'workspace-a', worktreeIds: ['worktree-a'] },
      ],
      includePipelineExecutions: true,
    });

    const zip = await readZip(response.absolutePath);
    expect(zip.has('pipeline-executions/summary.json')).toBe(true);
    expect(zip.has('pipeline-executions/execution-a.json')).toBe(false);
    expect(zip.has('pipeline-executions/execution-a/logs/stdout.log')).toBe(
      false,
    );

    const summary = readJsonEntry(zip, 'pipeline-executions/summary.json');
    expect(getManifestValue(summary, 'executionCount')).toBe(0);
    expect(getManifestValue(summary, 'executions')).toEqual([]);
  });

  it('includes child pipeline executions for a selected parent execution', async () => {
    await seedDefaultDiagnostics();
    await seedPipelineExecutionState({
      id: 'execution-parent',
      pipelineId: 'pipeline-parent',
      pipelineName: 'Parent Pipeline',
      projectId: 'workspace-a',
      worktreeId: 'worktree-a',
      startedAt: '2026-05-05T12:00:00.000Z',
    });
    await seedPipelineExecutionState({
      id: 'execution-child',
      pipelineId: 'pipeline-child',
      pipelineName: 'Child Pipeline',
      parentExecutionId: 'execution-parent',
      startedAt: '2026-05-05T12:01:00.000Z',
    });
    await writeText(
      join(
        getDataDir(),
        'pipeline-executions',
        'execution-child',
        'logs',
        'stdout.log',
      ),
      'child output',
    );

    const response = await prepareFeedbackBundle({
      description: 'Nested pipeline failed',
      area: 'worktrees',
      workspaceSelections: [
        { workspaceId: 'workspace-a', worktreeIds: ['worktree-a'] },
      ],
      includePipelineExecutions: true,
    });

    const zip = await readZip(response.absolutePath);
    expect(zip.has('pipeline-executions/execution-parent.json')).toBe(true);
    expect(zip.has('pipeline-executions/execution-child.json')).toBe(true);
    expect(zip.has('pipeline-executions/execution-child/logs/stdout.log')).toBe(
      true,
    );

    const summary = readJsonEntry(zip, 'pipeline-executions/summary.json');
    expect(getManifestValue(summary, 'executionCount')).toBe(2);
    expect(JSON.stringify(getManifestValue(summary, 'executions'))).toContain(
      'execution-child',
    );
  });

  it('records missing and symlinked files without failing', async () => {
    await seedDefaultDiagnostics();
    const symlinkTarget = join(tempRoot, 'outside.txt');
    await writeText(symlinkTarget, 'outside');
    await mkdir(getWorkspaceScriptRunDir('workspace-a', 'worktree-a'), {
      recursive: true,
    });
    await symlink(
      symlinkTarget,
      join(getWorkspaceScriptRunDir('workspace-a', 'worktree-a'), 'link.log'),
    );

    const response = await prepareFeedbackBundle({
      description: 'Missing files',
      area: 'worktrees',
      workspaceSelections: [
        { workspaceId: 'workspace-a', worktreeIds: ['worktree-a'] },
      ],
    });

    const manifest = readManifest(await readZip(response.absolutePath));
    const skipped = getManifestValue(manifest, 'skippedFiles');
    expect(Array.isArray(skipped)).toBe(true);
    expect(JSON.stringify(skipped)).toContain(
      'workspaces/workspace-a/workspace.json',
    );
    expect(JSON.stringify(skipped)).toContain('missing');
    expect(JSON.stringify(skipped)).toContain(
      'workspaces/workspace-a/script-runs/worktree-a/link.log',
    );
    expect(JSON.stringify(skipped)).toContain('symlink');
  });

  it('records files that exceed the maximum bundle entry size', async () => {
    await seedDefaultDiagnostics();
    const largeFilePath = join(
      getDataDir(),
      'pipeline-executions',
      'execution-a',
      'logs',
      'large.log',
    );
    await mkdir(dirname(largeFilePath), { recursive: true });
    const largeFileHandle = await open(largeFilePath, 'w');
    try {
      await largeFileHandle.truncate(MAX_FILE_BYTES + 1);
    } finally {
      await largeFileHandle.close();
    }

    const response = await prepareFeedbackBundle({
      description: 'Large pipeline log',
      area: 'pipelines',
    });

    const zip = await readZip(response.absolutePath);
    expect(zip.has('pipeline-executions/execution-a/logs/large.log')).toBe(
      false,
    );

    const manifest = readManifest(zip);
    const skipped = getManifestValue(manifest, 'skippedFiles');
    expect(JSON.stringify(skipped)).toContain(
      'pipeline-executions/execution-a/logs/large.log',
    );
    expect(JSON.stringify(skipped)).toContain('too-large');
  });
});

afterAll(() => {
  expect(process.env.CANOPY_DATA_DIR).toBe(originalCanopyDataDir);
  expect(process.env.FEEDBACK_BUNDLE_HOME_DIR_FOR_TEST).toBe(
    originalFeedbackBundleHomeDir,
  );
});

interface SeedPipelineExecutionStateOptions {
  id: string;
  pipelineId: string;
  pipelineName: string;
  projectId?: string;
  worktreeId?: string;
  planId?: string;
  parentExecutionId?: string;
  startedAt?: string;
}

async function seedDefaultDiagnostics(): Promise<void> {
  await writeText(
    join(
      getDataDir(),
      'agent-observability',
      'diagnostics',
      'app-events',
      '2026-05-05.jsonl',
    ),
    '{"event":"ready"}\n',
  );
  await writeText(
    join(getDataDir(), 'agent-observability', 'audit', '2026-05-05.jsonl'),
    '',
  );
  await writeJson(join(getDataDir(), 'agent-observability', 'snapshot.json'), {
    version: 1,
  });
  await writeJson(join(getDataDir(), 'preferences.json'), { theme: 'system' });
  await writeJson(join(getDataDir(), 'workspaces', 'index.json'), []);
}

async function seedPipelineExecutionState(
  options: SeedPipelineExecutionStateOptions,
): Promise<void> {
  const state: Record<string, unknown> = {
    version: 3,
    id: options.id,
    pipeline_id: options.pipelineId,
    pipeline_snapshot: { name: options.pipelineName },
    status: 'failure',
    jobs: {},
    started_at: options.startedAt ?? '2026-05-05T12:00:00.000Z',
    cwd: '/repo',
    env: {},
    inputs: {},
  };
  if (options.projectId !== undefined) {
    state.project_id = options.projectId;
  }
  if (options.worktreeId !== undefined) {
    state.worktree_id = options.worktreeId;
  }
  if (options.planId !== undefined) {
    state.plan_id = options.planId;
  }
  if (options.parentExecutionId !== undefined) {
    state.parent_execution_id = options.parentExecutionId;
  }
  await writeJson(
    join(getDataDir(), 'pipeline-executions', `${options.id}.json`),
    state,
  );
}

async function appendAuditLine(value: Record<string, unknown>): Promise<void> {
  const path = join(
    getDataDir(),
    'agent-observability',
    'audit',
    '2026-05-05.jsonl',
  );
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`);
}

async function withProcessPlatform<T>(
  platform: NodeJS.Platform,
  callback: () => Promise<T>,
): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {
    configurable: true,
    enumerable: true,
    value: platform,
  });
  try {
    return await callback();
  } finally {
    if (descriptor) {
      Object.defineProperty(process, 'platform', descriptor);
    }
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value)}\n`);
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}

async function readZip(path: string): Promise<Map<string, Buffer>> {
  const buffer = await readFile(path);
  const centralDirectoryOffset = findCentralDirectoryOffset(buffer);
  const entries = new Map<string, Buffer>();
  let cursor = centralDirectoryOffset;
  while (buffer.readUInt32LE(cursor) === 0x02014b50) {
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const filenameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString(
      'utf8',
      cursor + 46,
      cursor + 46 + filenameLength,
    );
    const contents = readLocalEntry(
      buffer,
      localHeaderOffset,
      compressedSize,
      compressionMethod,
    );
    expect(entries.has(name)).toBe(false);
    expect(contents.byteLength).toBe(buffer.readUInt32LE(cursor + 24));
    entries.set(name, contents);
    cursor += 46 + filenameLength + extraLength + commentLength;
  }
  return entries;
}

function findCentralDirectoryOffset(buffer: Buffer): number {
  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      return buffer.readUInt32LE(index + 16);
    }
  }
  throw new Error('ZIP end of central directory was not found');
}

function readLocalEntry(
  buffer: Buffer,
  localHeaderOffset: number,
  compressedSize: number,
  compressionMethod: number,
): Buffer {
  if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
    throw new Error('Invalid ZIP local header');
  }
  const filenameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + filenameLength + extraLength;
  const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
  if (compressionMethod === 0) {
    return compressed;
  }
  if (compressionMethod === 8) {
    return inflateRawSync(compressed);
  }
  throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
}

function readManifest(entries: Map<string, Buffer>): unknown {
  const manifest = entries.get('feedback.json');
  if (manifest === undefined) {
    throw new Error('feedback.json was not present in zip');
  }
  return JSON.parse(manifest.toString('utf8'));
}

function readJsonEntry(entries: Map<string, Buffer>, zipPath: string): unknown {
  const content = entries.get(zipPath);
  if (content === undefined) {
    throw new Error(`${zipPath} was not present in zip`);
  }
  return JSON.parse(content.toString('utf8'));
}

function expectSanitizedExecutionState(entries: Map<string, Buffer>): void {
  const state = readJsonEntry(entries, 'pipeline-executions/execution-a.json');
  const serializedZip = Array.from(entries.values())
    .map((entry) => entry.toString('utf8'))
    .join('\n');

  expect(serializedZip).not.toContain('SENTINEL_');
  expect(getManifestValue(state, 'pipeline_name')).toBe('Review Pipeline');
  expect(getManifestValue(state, 'trigger_source')).toEqual({
    type: 'pipeline',
    name: 'Pipeline event',
    event_name: 'task_ready',
  });
  expect(getManifestValue(state, 'env')).toBeUndefined();
  expect(getManifestValue(state, 'inputs')).toBeUndefined();
  expect(getManifestValue(state, 'event_data')).toBeUndefined();
  expect(getManifestValue(state, 'rerun_context')).toBeUndefined();
  expect(getManifestValue(state, 'pipeline_snapshot')).toBeUndefined();
  const serializedJobs = JSON.stringify(getManifestValue(state, 'jobs'));
  expect(serializedJobs).not.toContain('"outputs":');
  expect(serializedJobs).not.toContain('"dynamic_env":');
  expect(serializedJobs).toContain('"log_file":"run.log"');
  expect(serializedJobs).toContain('"report_file":"report.md"');
  expect(serializedJobs).toContain('"report_json_file":"report.json"');
}

function getManifestValue(manifest: unknown, key: string): unknown {
  if (typeof manifest !== 'object' || manifest === null) {
    throw new Error('feedback.json did not contain an object');
  }
  return Reflect.get(manifest, key);
}

function hasEntryEnding(entries: Map<string, Buffer>, suffix: string): boolean {
  return Array.from(entries.keys()).some((entry) => entry.endsWith(suffix));
}

function hasEntryStarting(
  entries: Map<string, Buffer>,
  prefix: string,
): boolean {
  return Array.from(entries.keys()).some((entry) => entry.startsWith(prefix));
}
