import { release } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { ProcessMetric } from 'electron';
import type { HeapInfo, HeapSpaceInfo } from 'node:v8';
import type { MemoryDiagnosticsHost, MemoryDiagnosticsService } from '../index';

type InspectorCallback = (error: Error | null, result?: unknown) => void;
type InspectorParamsOrCallback =
  | Readonly<Record<string, unknown>>
  | InspectorCallback;

interface MockInspectorSession {
  connect(): void;
  disconnect(): void;
  post(
    method: string,
    paramsOrCallback?: InspectorParamsOrCallback,
    callback?: InspectorCallback,
  ): void;
}

interface MockStatFs {
  readonly bavail: number;
  readonly bfree: number;
  readonly bsize: number;
}

interface MockDirectoryEntry {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface MockFileStats {
  readonly size: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface FixtureOptions {
  readonly deferRendererSnapshots?: boolean;
  readonly destroyedRendererIndexes?: readonly number[];
  readonly duplicateRendererPid?: boolean;
  readonly rendererLabels?: readonly string[];
  readonly rendererCount?: number;
  readonly rendererPrivateBytesKb?: number | null;
  readonly rendererWorkingSetKb?: number;
}

interface MemoryDiagnosticsFixture {
  readonly app: {
    readonly getAppMetrics: jest.Mock<ProcessMetric[], []>;
    readonly getVersion: jest.Mock<string, []>;
  };
  readonly directoryModes: Map<string, number>;
  readonly directories: Set<string>;
  readonly fileModes: Map<string, number>;
  readonly files: Map<string, string>;
  readonly fs: {
    readonly chmod: jest.Mock<Promise<void>, [string, number]>;
    readonly mkdir: jest.Mock<
      Promise<void>,
      [string, Readonly<Record<string, unknown>>?]
    >;
    readonly readdir: jest.Mock<
      Promise<string[] | MockDirectoryEntry[]>,
      [string, Readonly<{ withFileTypes?: boolean }>?]
    >;
    readonly rm: jest.Mock<Promise<void>, [string]>;
    readonly stat: jest.Mock<Promise<MockFileStats>, [string]>;
    readonly statfs: jest.Mock<Promise<MockStatFs>, [string]>;
    readonly writeFile: jest.Mock<
      Promise<void>,
      [string, string | Uint8Array, Readonly<Record<string, unknown>>?]
    >;
  };
  readonly inspector: {
    readonly Session: jest.Mock<MockInspectorSession, []>;
  };
  readonly inspectorModuleLoaded: () => boolean;
  readonly order: string[];
  readonly reportsDirectory: string;
  readonly rendererSnapshotStarted: Promise<void>;
  readonly samplingStartRequested: Promise<void>;
  readonly service: MemoryDiagnosticsService;
  readonly symlinks: Map<string, string>;
  readonly logMainProcessError: jest.Mock<void, [string, unknown]>;
  readonly session: {
    readonly connect: jest.Mock<void, []>;
    readonly disconnect: jest.Mock<void, []>;
    readonly post: jest.Mock<
      void,
      [string, InspectorParamsOrCallback?, InspectorCallback?]
    >;
  };
  readonly setFreeDiskBytes: (value: number) => void;
  readonly setHeap: (usedBytes: number, limitBytes: number) => void;
  readonly notifySamplingStartRequested: () => void;
  readonly completeRendererSnapshot: () => void;
  readonly setRendererSnapshotFailure: (error: Error | null) => void;
  readonly v8: {
    readonly getHeapSpaceStatistics: jest.Mock<HeapSpaceInfo[], []>;
    readonly getHeapStatistics: jest.Mock<HeapInfo, []>;
    readonly writeHeapSnapshot: jest.Mock<string, [string]>;
  };
}

let activeFixture: MemoryDiagnosticsFixture | undefined;

function pathIsWithin(path: string, directory: string): boolean {
  return path.startsWith(`${directory}/`);
}

function contentsToString(contents: string | Uint8Array): string {
  return typeof contents === 'string'
    ? contents
    : Buffer.from(contents).toString('utf8');
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(contents: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(contents);
  if (!isJsonObject(parsed)) {
    throw new Error('Expected JSON object');
  }
  return parsed;
}

function jsonObjectField(
  object: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = object[key];
  if (!isJsonObject(value)) {
    throw new Error(`Expected object field ${key}`);
  }
  return value;
}

async function createFixture(
  options: FixtureOptions = {},
): Promise<MemoryDiagnosticsFixture> {
  jest.resetModules();

  const reportsDirectory = '/data/memory-reports';
  const files = new Map<string, string>();
  const directories = new Set<string>([reportsDirectory]);
  const fileModes = new Map<string, number>();
  const directoryModes = new Map<string, number>([[reportsDirectory, 0o700]]);
  const order: string[] = [];
  let freeDiskBytes = 10_000_000_000;
  let heapUsedBytes = 512 * 1024 * 1024;
  let heapLimitBytes = 1024 * 1024 * 1024;
  let rendererSnapshotFailure: Error | null = null;
  const symlinks = new Map<string, string>();
  let resolveRendererSnapshotStarted: (() => void) | undefined;
  let completeDeferredRendererSnapshot: (() => void) | undefined;
  let resolveSamplingStartRequested: (() => void) | undefined;
  const rendererSnapshotStarted = new Promise<void>((resolve) => {
    resolveRendererSnapshotStarted = resolve;
  });
  const samplingStartRequested = new Promise<void>((resolve) => {
    resolveSamplingStartRequested = resolve;
  });

  function directChildren(directory: string): string[] {
    const children = new Set<string>();
    const entries: string[] = [
      ...Array.from(directories),
      ...Array.from(files.keys()),
      ...Array.from(symlinks.keys()),
    ];
    for (const entry of entries) {
      if (dirname(entry) === directory) children.add(basename(entry));
    }
    return Array.from(children);
  }

  function pathExists(path: string): boolean {
    return directories.has(path) || files.has(path) || symlinks.has(path);
  }

  function fileStats(path: string): MockFileStats {
    return {
      size: Buffer.byteLength(files.get(path) ?? ''),
      isDirectory: (): boolean => directories.has(path),
      isFile: (): boolean => files.has(path),
      isSymbolicLink: (): boolean => symlinks.has(path),
    };
  }

  function removePath(path: string): void {
    files.delete(path);
    fileModes.delete(path);
    directories.delete(path);
    directoryModes.delete(path);
    const filePaths: string[] = Array.from(files.keys());
    for (const filePath of filePaths) {
      if (pathIsWithin(filePath, path)) {
        files.delete(filePath);
        fileModes.delete(filePath);
      }
    }
    const directoryPaths: string[] = Array.from(directories);
    for (const directoryPath of directoryPaths) {
      if (pathIsWithin(directoryPath, path)) {
        directories.delete(directoryPath);
        directoryModes.delete(directoryPath);
      }
    }
    const symlinkPaths: string[] = Array.from(symlinks.keys());
    for (const symlinkPath of symlinkPaths) {
      if (symlinkPath === path || pathIsWithin(symlinkPath, path)) {
        symlinks.delete(symlinkPath);
      }
    }
  }

  const writeFile = jest.fn<
    Promise<void>,
    [string, string | Uint8Array, Readonly<Record<string, unknown>>?]
  >(
    (
      filePath: string,
      contents: string | Uint8Array,
      writeOptions?: Readonly<Record<string, unknown>>,
    ): Promise<void> => {
      files.set(filePath, contentsToString(contents));
      const mode = writeOptions?.mode;
      if (typeof mode === 'number') fileModes.set(filePath, mode);
      return Promise.resolve();
    },
  );
  const mkdir = jest.fn<
    Promise<void>,
    [string, Readonly<Record<string, unknown>>?]
  >(
    (
      directory: string,
      mkdirOptions?: Readonly<Record<string, unknown>>,
    ): Promise<void> => {
      if (pathExists(directory) && mkdirOptions?.recursive !== true) {
        const error = new Error(`EEXIST: ${directory}`);
        Object.assign(error, { code: 'EEXIST' });
        throw error;
      }
      directories.add(directory);
      const mode = mkdirOptions?.mode;
      if (typeof mode === 'number') directoryModes.set(directory, mode);
      return Promise.resolve();
    },
  );
  const readdir = jest.fn<
    Promise<string[] | MockDirectoryEntry[]>,
    [string, Readonly<{ withFileTypes?: boolean }>?]
  >(
    (
      directory: string,
      readOptions?: Readonly<{ withFileTypes?: boolean }>,
    ): Promise<string[] | MockDirectoryEntry[]> => {
      const names = directChildren(directory);
      if (readOptions?.withFileTypes !== true) return Promise.resolve(names);
      return Promise.resolve(
        names.map((name) => {
          const child = join(directory, name);
          return {
            name,
            isDirectory: (): boolean => directories.has(child),
            isFile: (): boolean => files.has(child),
            isSymbolicLink: (): boolean => symlinks.has(child),
          };
        }),
      );
    },
  );
  const rm = jest.fn<Promise<void>, [string]>((path: string): Promise<void> => {
    removePath(path);
    return Promise.resolve();
  });
  const unlink = jest.fn<Promise<void>, [string]>(
    (path: string): Promise<void> => {
      files.delete(path);
      fileModes.delete(path);
      return Promise.resolve();
    },
  );
  const rmdir = jest.fn<Promise<void>, [string]>(
    (path: string): Promise<void> => {
      directories.delete(path);
      directoryModes.delete(path);
      return Promise.resolve();
    },
  );
  const stat = jest.fn<Promise<MockFileStats>, [string]>(
    (path: string): Promise<MockFileStats> =>
      Promise.resolve(fileStats(symlinks.get(path) ?? path)),
  );
  const statfs = jest.fn<Promise<MockStatFs>, [string]>(() =>
    Promise.resolve({
      bavail: freeDiskBytes,
      bfree: freeDiskBytes,
      bsize: 1,
    }),
  );
  const chmod = jest.fn<Promise<void>, [string, number]>(
    (path: string, mode: number): Promise<void> => {
      if (directories.has(path)) directoryModes.set(path, mode);
      if (files.has(path)) fileModes.set(path, mode);
      return Promise.resolve();
    },
  );
  const rename = jest.fn<Promise<void>, [string, string]>(
    (from: string, to: string): Promise<void> => {
      const contents = files.get(from);
      if (contents !== undefined) {
        files.delete(from);
        files.set(to, contents);
        const mode = fileModes.get(from);
        fileModes.delete(from);
        if (mode !== undefined) fileModes.set(to, mode);
      }
      return Promise.resolve();
    },
  );
  const fsPromises = {
    chmod,
    mkdir,
    readdir,
    rename,
    rm,
    rmdir,
    stat,
    statfs,
    unlink,
    writeFile,
  };
  const fsSync = {
    existsSync: (path: string): boolean => pathExists(path),
    promises: fsPromises,
    lstatSync: (path: string): MockFileStats => fileStats(path),
    realpathSync: (path: string): string => {
      if (!pathExists(path)) {
        throw new Error(`ENOENT: ${path}`);
      }
      return symlinks.get(path) ?? path;
    },
    statSync: (path: string): MockFileStats =>
      fileStats(symlinks.get(path) ?? path),
  };

  const inspectorPostFailure: Error | null = null;
  let inspectorModuleLoaded = false;
  const session = {
    connect: jest.fn<void, []>((): void => undefined),
    disconnect: jest.fn<void, []>((): void => undefined),
    post: jest.fn<
      void,
      [string, InspectorParamsOrCallback?, InspectorCallback?]
    >(
      (
        method: string,
        paramsOrCallback?: InspectorParamsOrCallback,
        callback?: InspectorCallback,
      ): void => {
        if (method === 'HeapProfiler.startSampling') {
          resolveSamplingStartRequested?.();
        }
        const completion =
          typeof paramsOrCallback === 'function' ? paramsOrCallback : callback;
        if (completion === undefined) return;
        const result: unknown =
          method === 'HeapProfiler.getSamplingProfile'
            ? { profile: { head: { functionName: 'root' }, samples: [] } }
            : {};
        completion(inspectorPostFailure, result);
      },
    ),
  };
  const Session = jest.fn<MockInspectorSession, []>(() => session);
  const inspector = { Session };

  const getHeapStatistics = jest.fn<HeapInfo, []>(() => ({
    does_zap_garbage: 0,
    external_memory: 0,
    heap_size_limit: heapLimitBytes,
    malloced_memory: 0,
    number_of_detached_contexts: 0,
    number_of_native_contexts: 0,
    peak_malloced_memory: 0,
    total_available_size: heapLimitBytes - heapUsedBytes,
    total_global_handles_size: 0,
    total_heap_size: heapUsedBytes,
    total_heap_size_executable: 0,
    total_physical_size: heapUsedBytes,
    used_global_handles_size: 0,
    used_heap_size: heapUsedBytes,
  }));
  const getHeapSpaceStatistics = jest.fn<HeapSpaceInfo[], []>(() => [
    {
      physical_space_size: heapUsedBytes,
      space_available_size: 0,
      space_name: 'old_space',
      space_size: heapUsedBytes,
      space_used_size: heapUsedBytes,
    },
  ]);
  const writeHeapSnapshot = jest.fn<string, [string]>(
    (filePath: string): string => {
      order.push(`main:${filePath}`);
      files.set(filePath, 'main heap snapshot');
      fileModes.set(filePath, 0o644);
      return filePath;
    },
  );
  const v8 = {
    getHeapSpaceStatistics,
    getHeapStatistics,
    writeHeapSnapshot,
  };

  const rendererCount = options.rendererCount ?? 1;
  const rendererPrivateBytesKb =
    options.rendererPrivateBytesKb === undefined
      ? 256
      : options.rendererPrivateBytesKb;
  const rendererWorkingSetKb = options.rendererWorkingSetKb ?? 512;
  const getAppMetrics = jest.fn<ProcessMetric[], []>(() => [
    {
      cpu: {
        cumulativeCPUUsage: 0,
        idleWakeupsPerSecond: 0,
        percentCPUUsage: 0,
      },
      memory: {
        privateBytes: 512,
        workingSetSize: 1024,
        peakWorkingSetSize: 1024,
      },
      creationTime: 0,
      pid: process.pid,
      type: 'Browser' as const,
    },
    ...Array.from({ length: rendererCount }, (_, index) => {
      const memory = {
        ...(rendererPrivateBytesKb === null
          ? {}
          : { privateBytes: rendererPrivateBytesKb }),
        workingSetSize: rendererWorkingSetKb,
        peakWorkingSetSize: rendererWorkingSetKb,
      };
      return {
        cpu: {
          cumulativeCPUUsage: 0,
          idleWakeupsPerSecond: 0,
          percentCPUUsage: 0,
        },
        creationTime: 0,
        memory,
        pid:
          process.pid + (options.duplicateRendererPid === true ? 1 : index + 1),
        type: 'Tab' as const,
      };
    }),
  ]);
  const getVersion = jest.fn<string, []>(() => '9.8.7');
  const app = { getAppMetrics, getVersion };
  const logMainProcessError = jest.fn<void, [string, unknown]>();

  jest.doMock('node:fs/promises', () => ({
    ...fsPromises,
    default: fsPromises,
  }));
  jest.doMock('fs/promises', () => ({ ...fsPromises, default: fsPromises }));
  jest.doMock('node:fs', () => ({ ...fsSync, default: fsSync }));
  jest.doMock('fs', () => ({ ...fsSync, default: fsSync }));
  jest.doMock('node:inspector', () => {
    inspectorModuleLoaded = true;
    return inspector;
  });
  jest.doMock('inspector', () => {
    inspectorModuleLoaded = true;
    return inspector;
  });
  jest.doMock('node:v8', () => ({ ...v8, default: v8 }));
  jest.doMock('v8', () => ({ ...v8, default: v8 }));
  jest.doMock('../../lib/paths', () => ({
    getMemoryReportsDir: (): string => reportsDirectory,
  }));
  jest.doMock('../../lib/main-process-logging', () => ({
    logMainProcessError,
  }));
  let nextRendererIndex = 0;
  jest.doMock('electron', () => ({
    app,
    BrowserWindow: class {
      readonly webContents: {
        readonly getOSProcessId: jest.Mock;
        readonly isDestroyed: jest.Mock;
        readonly takeHeapSnapshot: jest.Mock;
      };

      constructor() {
        const rendererIndex = nextRendererIndex;
        nextRendererIndex += 1;
        const processId =
          process.pid +
          (options.duplicateRendererPid === true ? 1 : rendererIndex + 1);
        this.webContents = {
          getOSProcessId: jest.fn((): number => processId),
          isDestroyed: jest.fn(
            (): boolean =>
              options.destroyedRendererIndexes?.includes(rendererIndex) ??
              false,
          ),
          takeHeapSnapshot: jest.fn((filePath: string): Promise<boolean> => {
            order.push(`renderer:${filePath}`);
            resolveRendererSnapshotStarted?.();
            if (options.deferRendererSnapshots === true) {
              return new Promise<boolean>((resolve, reject) => {
                completeDeferredRendererSnapshot = (): void => {
                  if (rendererSnapshotFailure !== null) {
                    reject(rendererSnapshotFailure);
                    return;
                  }
                  files.set(filePath, 'renderer heap snapshot');
                  fileModes.set(filePath, 0o644);
                  resolve(true);
                };
              });
            }
            if (rendererSnapshotFailure !== null) {
              return Promise.reject(rendererSnapshotFailure);
            }
            files.set(filePath, 'renderer heap snapshot');
            fileModes.set(filePath, 0o644);
            return Promise.resolve(true);
          }),
        };
      }
    },
  }));

  const electron = await import('electron');
  const windows = Array.from(
    { length: options.rendererCount ?? 1 },
    () => new electron.BrowserWindow(),
  );
  const host: MemoryDiagnosticsHost = {
    getAppRenderers: () =>
      windows.map((window, index) => ({
        label: options.rendererLabels?.[index] ?? `renderer-${index + 1}`,
        webContents: window.webContents,
      })),
  };
  const module = await import('../index');
  module.configureMemoryDiagnostics(host);

  const fixture: MemoryDiagnosticsFixture = {
    app,
    directoryModes,
    directories,
    fileModes,
    files,
    fs: { chmod, mkdir, readdir, rm, stat, statfs, writeFile },
    inspector,
    inspectorModuleLoaded: (): boolean => inspectorModuleLoaded,
    order,
    reportsDirectory,
    rendererSnapshotStarted,
    samplingStartRequested,
    service: module.getMemoryDiagnosticsService(),
    symlinks,
    logMainProcessError,
    session,
    setFreeDiskBytes: (value: number): void => {
      freeDiskBytes = value;
    },
    setHeap: (usedBytes: number, limitBytes: number): void => {
      heapUsedBytes = usedBytes;
      heapLimitBytes = limitBytes;
    },
    notifySamplingStartRequested: (): void => {
      resolveSamplingStartRequested?.();
    },
    completeRendererSnapshot: (): void => {
      const complete = completeDeferredRendererSnapshot;
      if (complete === undefined) {
        throw new Error('No renderer snapshot is waiting to complete');
      }
      completeDeferredRendererSnapshot = undefined;
      complete();
    },
    setRendererSnapshotFailure: (error: Error | null): void => {
      rendererSnapshotFailure = error;
    },
    v8,
  };
  activeFixture = fixture;
  return fixture;
}

function automaticDumpDirectories(fixture: MemoryDiagnosticsFixture): string[] {
  const directories: string[] = Array.from(fixture.directories);
  return directories.filter(
    (directory) =>
      dirname(directory) === fixture.reportsDirectory &&
      basename(directory).startsWith('auto-'),
  );
}

function reportDirectories(fixture: MemoryDiagnosticsFixture): string[] {
  const directories: string[] = Array.from(fixture.directories);
  return directories.filter(
    (directory) =>
      dirname(directory) === fixture.reportsDirectory &&
      basename(directory).startsWith('report-'),
  );
}

describe('memory diagnostics service public API', () => {
  afterEach(async () => {
    const fixture = activeFixture;
    activeFixture = undefined;
    if (fixture !== undefined) await fixture.service.dispose();
    jest.useRealTimers();
  });

  it('stays inert while disabled and refuses a report without loading inspector or writing files', async () => {
    jest.useFakeTimers();
    const fixture = await createFixture();

    expect(await fixture.service.getStatus()).toEqual(
      expect.objectContaining({ enabled: false, samplingActive: false }),
    );
    expect(fixture.inspector.Session).not.toHaveBeenCalled();
    expect(fixture.inspectorModuleLoaded()).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
    expect(fixture.fs.mkdir).not.toHaveBeenCalled();
    expect(fixture.fs.writeFile).not.toHaveBeenCalled();
    expect(fixture.v8.writeHeapSnapshot).not.toHaveBeenCalled();
    expect(await fixture.service.createReport()).toEqual(
      expect.objectContaining({ ok: false, reason: 'disabled' }),
    );
    expect(fixture.files.size).toBe(0);
  });

  it('keeps enable and disable transitions idempotent', async () => {
    jest.useFakeTimers();
    const fixture = await createFixture();

    fixture.service.setEnabled(true);
    fixture.service.setEnabled(true);
    await fixture.service.getStatus();

    expect(fixture.inspector.Session).toHaveBeenCalledTimes(1);
    expect(
      fixture.session.post.mock.calls.filter(
        ([method]) => method === 'HeapProfiler.startSampling',
      ),
    ).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(1);

    fixture.service.setEnabled(false);
    fixture.service.setEnabled(false);
    await fixture.service.getStatus();

    expect(
      fixture.session.post.mock.calls.filter(
        ([method]) => method === 'HeapProfiler.stopSampling',
      ),
    ).toHaveLength(1);
    expect(fixture.session.disconnect).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('reports heap status, renderer count, estimate, and the most recent report', async () => {
    jest.useFakeTimers();
    const fixture = await createFixture({ rendererCount: 0 });
    fixture.setHeap(1024 ** 3, 2 * 1024 ** 3);
    fixture.service.setEnabled(true);

    expect(await fixture.service.getStatus()).toEqual(
      expect.objectContaining({
        mainHeapUsedBytes: 1024 ** 3,
        mainHeapLimitBytes: 2 * 1024 ** 3,
        rendererCount: 0,
        estimatedReportSeconds: 25,
        reportInProgress: false,
        lastReport: null,
      }),
    );

    const result = await fixture.service.createReport();
    if (!result.ok) throw new Error(`Report failed: ${result.message}`);
    expect((await fixture.service.getStatus()).lastReport).toEqual(
      result.report,
    );
  });

  it('uses working-set fallback metrics and counts same-process renderers separately from estimates', async () => {
    jest.useFakeTimers();
    const fixture = await createFixture({
      duplicateRendererPid: true,
      rendererCount: 2,
      rendererPrivateBytesKb: null,
      rendererWorkingSetKb: 409_600,
    });
    fixture.setHeap(0, 1024 ** 3);
    fixture.service.setEnabled(true);

    const status = await fixture.service.getStatus();

    expect(status.rendererCount).toBe(2);
    expect(status.estimatedReportSeconds).toBe(10);

    const result = await fixture.service.createReport();
    if (!result.ok) throw new Error(`Report failed: ${result.message}`);
    expect(
      fixture.order.filter((entry) => entry.startsWith('renderer:')),
    ).toHaveLength(2);
  });

  it('starts sampling at the configured interval and stops, disconnects, and clears its timer when disabled', async () => {
    jest.useFakeTimers();
    const fixture = await createFixture();

    fixture.service.setEnabled(true);
    await fixture.service.getStatus();

    expect(fixture.inspector.Session).toHaveBeenCalledTimes(1);
    expect(fixture.session.connect).toHaveBeenCalledTimes(1);
    const postedMethods = fixture.session.post.mock.calls.map(
      ([method]) => method,
    );
    expect(postedMethods).toContain('HeapProfiler.enable');
    expect(postedMethods).toContain('HeapProfiler.startSampling');
    expect(postedMethods.indexOf('HeapProfiler.enable')).toBeLessThan(
      postedMethods.indexOf('HeapProfiler.startSampling'),
    );
    expect(fixture.session.post).toHaveBeenCalledWith(
      'HeapProfiler.startSampling',
      { samplingInterval: 512 * 1024 },
      expect.any(Function),
    );
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    expect(await fixture.service.getStatus()).toEqual(
      expect.objectContaining({ enabled: true, samplingActive: true }),
    );

    fixture.service.setEnabled(false);
    await fixture.service.getStatus();

    expect(fixture.session.post.mock.calls.map(([method]) => method)).toContain(
      'HeapProfiler.stopSampling',
    );
    expect(fixture.session.disconnect).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    expect(await fixture.service.getStatus()).toEqual(
      expect.objectContaining({ enabled: false, samplingActive: false }),
    );
  });

  it('reports inspector startup failures without throwing or disabling heap diagnostics', async () => {
    jest.useFakeTimers();
    const fixture = await createFixture();
    fixture.session.connect.mockImplementation((): never => {
      throw new Error('inspector connection refused');
    });

    expect(() => fixture.service.setEnabled(true)).not.toThrow();
    const status = await fixture.service.getStatus();

    expect(status.enabled).toBe(true);
    expect(status.samplingActive).toBe(false);
    expect(status.samplingUnavailableReason).toContain(
      'inspector connection refused',
    );
    expect(fixture.logMainProcessError).toHaveBeenCalledWith(
      expect.stringContaining('sampling'),
      expect.any(Error),
    );
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    const reportResult = await fixture.service.createReport();
    if (!reportResult.ok) {
      throw new Error(`Report failed: ${reportResult.message}`);
    }
    expect(reportResult.report.samplingIncluded).toBe(false);
  });

  it('does not leave sampling active or a timer behind when it is disabled during startup', async () => {
    jest.useFakeTimers();
    const fixture = await createFixture();
    let finishStartSampling: InspectorCallback | undefined;
    fixture.session.post.mockImplementation(
      (
        method: string,
        paramsOrCallback?: InspectorParamsOrCallback,
        callback?: InspectorCallback,
      ): void => {
        const completion =
          typeof paramsOrCallback === 'function' ? paramsOrCallback : callback;
        if (method === 'HeapProfiler.startSampling') {
          fixture.notifySamplingStartRequested();
          finishStartSampling = completion;
          return;
        }
        if (completion !== undefined) completion(null, {});
      },
    );

    fixture.service.setEnabled(true);
    await fixture.samplingStartRequested;
    const complete = finishStartSampling;
    if (complete === undefined) {
      throw new Error('Sampling startup callback was not captured');
    }
    fixture.service.setEnabled(false);
    complete(null, {});
    await fixture.service.getStatus();

    expect(jest.getTimerCount()).toBe(0);
    expect(fixture.session.disconnect).toHaveBeenCalledTimes(1);
    expect(await fixture.service.getStatus()).toEqual(
      expect.objectContaining({ enabled: false, samplingActive: false }),
    );
  });

  it('disposes the active sampling session and timer', async () => {
    jest.useFakeTimers();
    const fixture = await createFixture();
    fixture.service.setEnabled(true);
    await fixture.service.getStatus();

    await fixture.service.dispose();

    expect(fixture.session.post.mock.calls.map(([method]) => method)).toContain(
      'HeapProfiler.stopSampling',
    );
    expect(fixture.session.disconnect).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('creates an automatic dump at 80 percent of the main heap limit but not below it', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-21T00:00:00.000Z'));
    const fixture = await createFixture({ rendererCount: 0 });
    fixture.service.setEnabled(true);
    await fixture.service.getStatus();
    fixture.setHeap(799, 1000);

    await jest.advanceTimersByTimeAsync(15_000);
    expect(automaticDumpDirectories(fixture)).toHaveLength(0);

    fixture.setHeap(800, 1000);
    await jest.advanceTimersByTimeAsync(15_000);

    expect(automaticDumpDirectories(fixture)).toHaveLength(1);
    const automaticDumpPath = automaticDumpDirectories(fixture)[0];
    if (automaticDumpPath === undefined) {
      throw new Error('Automatic dump directory was not created');
    }
    expect(basename(automaticDumpPath)).toBe('auto-20261021T000030Z');
    expect(fixture.service.resolveReportPath(basename(automaticDumpPath))).toBe(
      automaticDumpPath,
    );
    expect((await fixture.service.getStatus()).lastReport).toMatchObject({
      reportId: 'auto-20261021T000030Z',
      kind: 'auto',
    });
    expect(
      Array.from(fixture.files.keys()).some((filePath: string) =>
        filePath.endsWith('/summary.json'),
      ),
    ).toBe(true);
    expect(
      Array.from(fixture.files.keys()).some((filePath: string) =>
        filePath.endsWith('/main.heapprofile'),
      ),
    ).toBe(true);
  });

  it('rate-limits automatic dumps to five minutes and retains only the newest five', async () => {
    jest.useFakeTimers();
    const fixture = await createFixture({ rendererCount: 0 });
    fixture.service.setEnabled(true);
    await fixture.service.getStatus();
    fixture.setHeap(800, 1000);

    await jest.advanceTimersByTimeAsync(15_000);
    expect(automaticDumpDirectories(fixture)).toHaveLength(1);
    const firstDump = automaticDumpDirectories(fixture)[0] ?? '';

    await jest.advanceTimersByTimeAsync(4 * 60 * 1000 + 45_000);
    expect(automaticDumpDirectories(fixture)).toHaveLength(1);

    for (let index = 0; index < 5; index += 1) {
      await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
    }

    expect(automaticDumpDirectories(fixture)).toHaveLength(5);
    expect(automaticDumpDirectories(fixture)).not.toContain(firstDump);
    expect(fixture.fs.rm).toHaveBeenCalled();
    expect(fixture.fs.writeFile).toHaveBeenCalled();
  });

  it('writes renderer snapshots before the main snapshot and returns an accurate report summary', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-21T00:00:00.000Z'));
    const fixture = await createFixture({
      rendererCount: 2,
      rendererLabels: ['main', 'app-advisor'],
    });
    fixture.service.setEnabled(true);
    await fixture.service.getStatus();

    const result = await fixture.service.createReport();
    if (!result.ok) throw new Error(`Report failed: ${result.message}`);

    const reportDirectory = join(
      fixture.reportsDirectory,
      result.report.reportId,
    );
    const rendererSnapshotEvents = fixture.order.filter((entry) =>
      entry.startsWith('renderer:'),
    );
    const mainSnapshotIndex = fixture.order.findIndex((entry) =>
      entry.startsWith('main:'),
    );
    expect(rendererSnapshotEvents).toHaveLength(2);
    expect(mainSnapshotIndex).toBeGreaterThan(
      fixture.order.findIndex((entry) => entry === rendererSnapshotEvents[1]),
    );
    expect(result.report).toEqual(
      expect.objectContaining({
        kind: 'report',
        reportId: 'report-20261021T000000Z',
        samplingIncluded: true,
      }),
    );
    expect(result.report.fileCount).toBeGreaterThanOrEqual(5);
    expect(result.report.totalBytes).toBeGreaterThan(0);
    expect(result.report.durationMs).toBeGreaterThanOrEqual(0);
    expect(fixture.app.getAppMetrics).toHaveBeenCalled();
    expect(fixture.v8.getHeapSpaceStatistics).toHaveBeenCalled();

    const summaryPath = join(reportDirectory, 'summary.json');
    const summaryContents = fixture.files.get(summaryPath);
    if (summaryContents === undefined) {
      throw new Error('Report summary was not written');
    }
    const summary = parseJsonObject(summaryContents);
    expect(summary.version).toBe(1);
    expect(summary.reportId).toBe(result.report.reportId);
    expect(summary.kind).toBe('report');
    expect(summary.createdAt).toBe('2026-10-21T00:00:00.000Z');
    expect(summary.appVersion).toBe('9.8.7');
    expect(summary.electronVersion).toBe(
      process.versions.electron ?? 'unknown',
    );
    expect(summary.nodeVersion).toBe(process.versions.node);
    expect(summary.chromeVersion).toBe(process.versions.chrome ?? 'unknown');

    const operatingSystem = jsonObjectField(summary, 'operatingSystem');
    expect(operatingSystem.platform).toBe(process.platform);
    expect(operatingSystem.release).toBe(release());
    expect(operatingSystem.arch).toBe(process.arch);

    const processMemoryUsage = jsonObjectField(summary, 'processMemoryUsage');
    expect(typeof processMemoryUsage.rss).toBe('number');
    expect(typeof processMemoryUsage.heapUsed).toBe('number');
    expect(Array.isArray(summary.appMetrics)).toBe(true);
    expect(Array.isArray(summary.heapSpaceStatistics)).toBe(true);
    expect(summaryContents).toContain('"space_name": "old_space"');

    const heapStatistics = jsonObjectField(summary, 'heapStatistics');
    expect(heapStatistics.heap_size_limit).toBe(1024 ** 3);
    expect(heapStatistics.used_heap_size).toBe(512 * 1024 * 1024);

    const rendererMemoryEstimate = jsonObjectField(
      summary,
      'rendererMemoryEstimate',
    );
    expect(rendererMemoryEstimate.source).toBe('privateBytes');
    expect(rendererMemoryEstimate.bytes).toBe(2 * 256 * 1024);
    expect(rendererMemoryEstimate.rendererCount).toBe(2);
    expect(Array.isArray(summary.rendererSnapshots)).toBe(true);
    expect(summaryContents).toContain('"label": "main"');
    expect(summaryContents).toContain(
      '"fileName": "renderer-main.heapsnapshot"',
    );
    expect(summaryContents).toContain('"label": "app-advisor"');
    expect(summaryContents).toContain(
      '"fileName": "renderer-app-advisor.heapsnapshot"',
    );

    const sampling = jsonObjectField(summary, 'sampling');
    expect(sampling.active).toBe(true);
    expect(sampling.included).toBe(true);
    expect(sampling.unavailableReason).toBeNull();

    const reportSummary = jsonObjectField(summary, 'report');
    expect(reportSummary.reportId).toBe(result.report.reportId);
    expect(reportSummary.kind).toBe('report');
    expect(reportSummary.fileCount).toBe(result.report.fileCount);
    expect(reportSummary.totalBytes).toBe(result.report.totalBytes);
    expect(reportSummary.durationMs).toBe(result.report.durationMs);
    expect(reportSummary.samplingIncluded).toBe(true);
    expect(summaryContents).toContain('9.8.7');
    expect(summaryContents).toContain(process.platform);
    expect(summaryContents).toContain(release());
    expect(summaryContents).toMatch(/"electron(?:Version|version)"\s*:/i);
    expect(summaryContents).toContain('"rss"');
    expect(summaryContents).toContain('"heapUsed"');
    expect(summaryContents).toContain('"heap_size_limit"');
    expect(summaryContents).toContain('old_space');
    expect(summaryContents).toContain('privateBytes');
    expect(summaryContents).toContain('workingSetSize');

    const reportFiles: Array<[string, string]> = Array.from(
      fixture.files.entries(),
    ).filter(([filePath]) => pathIsWithin(filePath, reportDirectory));
    expect(result.report.fileCount).toBe(reportFiles.length);
    expect(result.report.totalBytes).toBe(
      reportFiles.reduce(
        (total, [, contents]) => total + Buffer.byteLength(contents),
        0,
      ),
    );
    expect(fixture.directoryModes.get(reportDirectory)).toBe(0o700);
    for (const [filePath] of reportFiles) {
      expect(fixture.fileModes.get(filePath)).toBe(0o600);
    }
    expect(fixture.service.resolveReportPath(result.report.reportId)).toBe(
      reportDirectory,
    );
  });

  it('uses working-set fallback estimates and requires twice the combined heap size in free disk space', async () => {
    jest.useFakeTimers();
    const fixture = await createFixture({
      rendererCount: 1,
      rendererPrivateBytesKb: null,
      rendererWorkingSetKb: 1024,
    });
    fixture.service.setEnabled(true);
    await fixture.service.getStatus();
    const mainHeapBytes = 1024 * 1024;
    const rendererWorkingSetBytes = 1024 * 1024;
    const requiredBytes = 2 * (mainHeapBytes + rendererWorkingSetBytes);
    fixture.setHeap(mainHeapBytes, 16 * 1024 * 1024);
    fixture.setFreeDiskBytes(requiredBytes - 1);
    const diskResult = await fixture.service.createReport();
    expect(diskResult).toEqual(
      expect.objectContaining({ ok: false, reason: 'insufficient-disk' }),
    );
    expect(fixture.service.resolveReportPath('report-20261021T000000Z')).toBe(
      null,
    );
    expect(fixture.fs.mkdir).not.toHaveBeenCalledWith(
      expect.stringMatching(/report-/),
      expect.anything(),
    );
    expect(fixture.fs.writeFile).not.toHaveBeenCalled();

    fixture.setFreeDiskBytes(requiredBytes);
    const enoughDiskResult = await fixture.service.createReport();
    expect(enoughDiskResult.ok).toBe(true);
  });

  it('refuses a concurrent report while a renderer snapshot is in progress', async () => {
    jest.useFakeTimers();
    const fixture = await createFixture({ deferRendererSnapshots: true });
    fixture.service.setEnabled(true);
    await fixture.service.getStatus();

    const firstReport = fixture.service.createReport();
    const state = await Promise.race([
      fixture.rendererSnapshotStarted.then(() => 'started'),
      firstReport.then(() => 'finished'),
    ]);
    if (state !== 'started') {
      throw new Error('Report completed before renderer snapshot started');
    }
    expect(await fixture.service.getStatus()).toEqual(
      expect.objectContaining({ reportInProgress: true }),
    );
    expect(await fixture.service.createReport()).toEqual(
      expect.objectContaining({ ok: false, reason: 'in-progress' }),
    );

    fixture.completeRendererSnapshot();
    const result = await firstReport;
    expect(result.ok).toBe(true);
  });

  it('cleans up a partial report after a renderer snapshot fails', async () => {
    jest.useFakeTimers();
    const fixture = await createFixture();
    fixture.service.setEnabled(true);
    await fixture.service.getStatus();
    fixture.setRendererSnapshotFailure(new Error('renderer snapshot failed'));

    const result = await fixture.service.createReport();

    expect(result).toEqual(
      expect.objectContaining({ ok: false, reason: 'failed' }),
    );
    expect(fixture.fs.rm).toHaveBeenCalled();
    expect(reportDirectories(fixture)).toHaveLength(0);
    expect(
      Array.from(fixture.files.keys()).some((filePath: string) =>
        filePath.startsWith(`${fixture.reportsDirectory}/report-`),
      ),
    ).toBe(false);
    expect(fixture.service.resolveReportPath('report-20261021T000000Z')).toBe(
      null,
    );
  });

  it('retains only the newest three completed reports', async () => {
    jest.useFakeTimers();
    const fixture = await createFixture({ rendererCount: 0 });
    fixture.service.setEnabled(true);
    await fixture.service.getStatus();

    const createdReportDirectories: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      if (index > 0) {
        jest.setSystemTime(new Date(Date.now() + 1000));
      }
      const result = await fixture.service.createReport();
      if (!result.ok) throw new Error(`Report failed: ${result.message}`);
      createdReportDirectories.push(
        join(fixture.reportsDirectory, result.report.reportId),
      );
    }

    expect(reportDirectories(fixture)).toHaveLength(3);
    expect(reportDirectories(fixture)).toEqual(
      createdReportDirectories.slice(1),
    );
    expect(fixture.fs.rm).toHaveBeenCalled();
  });

  it('keeps a new report and automatic dump when an old folder cannot be removed', async () => {
    jest.useFakeTimers();
    const fixture = await createFixture({ rendererCount: 0 });
    fixture.service.setEnabled(true);
    await fixture.service.getStatus();
    const stuckReport = join(
      fixture.reportsDirectory,
      'report-20000101T000000Z',
    );
    const stuckDumps = Array.from({ length: 5 }, (_, index) =>
      join(fixture.reportsDirectory, `auto-2000010${index + 1}T000000Z`),
    );
    for (let index = 0; index < 3; index += 1) {
      fixture.directories.add(
        join(fixture.reportsDirectory, `report-2000010${index + 2}T000000Z`),
      );
    }
    for (const directory of [stuckReport, ...stuckDumps]) {
      fixture.directories.add(directory);
    }
    const busy = Object.assign(new Error('EBUSY: resource busy'), {
      code: 'EBUSY',
    });
    const removeNormally = fixture.fs.rm.getMockImplementation();
    fixture.fs.rm.mockImplementation((path: string) =>
      path === stuckReport || stuckDumps.includes(path)
        ? Promise.reject(busy)
        : (removeNormally?.(path) ?? Promise.resolve()),
    );

    const result = await fixture.service.createReport();
    if (!result.ok) throw new Error(`Report failed: ${result.message}`);
    expect((await fixture.service.getStatus()).lastReport?.reportId).toBe(
      result.report.reportId,
    );
    fixture.setHeap(800, 1000);
    await jest.advanceTimersByTimeAsync(15_000);

    expect(reportDirectories(fixture)).toContain(
      join(fixture.reportsDirectory, result.report.reportId),
    );
    expect((await fixture.service.getStatus()).lastReport?.kind).toBe('auto');
    expect(automaticDumpDirectories(fixture)).toHaveLength(6);
    expect(fixture.logMainProcessError).toHaveBeenCalledWith(
      'Memory diagnostics could not remove an old report',
      busy,
    );
  });

  it('uses UTC second timestamps and collision suffixes for report ids', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-21T00:00:00.000Z'));
    const fixture = await createFixture({ rendererCount: 0 });
    fixture.service.setEnabled(true);
    await fixture.service.getStatus();

    const first = await fixture.service.createReport();
    const second = await fixture.service.createReport();
    if (!first.ok) throw new Error(`First report failed: ${first.message}`);
    if (!second.ok) throw new Error(`Second report failed: ${second.message}`);

    expect(first.report.reportId).toBe('report-20261021T000000Z');
    expect(second.report.reportId).toBe('report-20261021T000000Z-1');
    expect(reportDirectories(fixture)).toHaveLength(2);
  });

  it('skips destroyed renderers when creating a report', async () => {
    jest.useFakeTimers();
    const fixture = await createFixture({
      destroyedRendererIndexes: [0],
      rendererCount: 2,
    });
    fixture.service.setEnabled(true);
    await fixture.service.getStatus();

    const result = await fixture.service.createReport();
    if (!result.ok) throw new Error(`Report failed: ${result.message}`);

    const rendererSnapshots = fixture.order.filter((entry) =>
      entry.startsWith('renderer:'),
    );
    expect(rendererSnapshots).toHaveLength(1);
    expect(rendererSnapshots[0]).toContain('renderer-2');
  });

  it('rejects traversal, separators, and unknown report ids when resolving paths', async () => {
    jest.useFakeTimers();
    const fixture = await createFixture({ rendererCount: 0 });

    for (const reportId of [
      '../report-20261021T000000Z',
      'report-20261021T000000Z/../../outside',
      'report-20261021T000000Z\\..\\outside',
      'unknown-20261021T000000Z',
    ]) {
      expect(fixture.service.resolveReportPath(reportId)).toBeNull();
    }
  });

  it('does not resolve a report id whose directory is a symlink outside the reports root', async () => {
    jest.useFakeTimers();
    const fixture = await createFixture({ rendererCount: 0 });
    const reportId = 'report-20261021T000000Z';
    const reportPath = join(fixture.reportsDirectory, reportId);
    fixture.directories.add('/outside-report');
    fixture.symlinks.set(reportPath, '/outside-report');

    expect(fixture.service.resolveReportPath(reportId)).toBeNull();
  });
});
