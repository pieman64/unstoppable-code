import { buildSync } from 'esbuild';
import * as realFs from 'node:fs';
import * as realFsPromises from 'node:fs/promises';
import * as realV8 from 'node:v8';
import { Script } from 'node:vm';
import { join } from 'node:path';
import type { MemoryDiagnosticsHost, MemoryDiagnosticsService } from '../index';

type CompiledServiceModule = {
  createMemoryDiagnosticsService(
    host: MemoryDiagnosticsHost,
  ): MemoryDiagnosticsService;
};

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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class VmCompatibleError extends Error {
  public static override [Symbol.hasInstance](value: unknown): boolean {
    return (
      value instanceof Error ||
      (isObjectRecord(value) && typeof value.message === 'string')
    );
  }
}

function isCompiledServiceModule(
  value: unknown,
): value is CompiledServiceModule {
  return (
    isObjectRecord(value) &&
    typeof value.createMemoryDiagnosticsService === 'function'
  );
}

describe('compiled memory diagnostics service', () => {
  it('starts allocation sampling in a compiled main context without a dynamic import callback', async () => {
    const build = buildSync({
      entryPoints: [join(__dirname, '../service.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      write: false,
    });
    const source = build.outputFiles[0]?.text;
    if (!source) throw new Error('Missing compiled memory diagnostics service');

    const inspectorSession: MockInspectorSession = {
      connect: (): void => undefined,
      disconnect: (): void => undefined,
      post: (
        _method: string,
        paramsOrCallback?: InspectorParamsOrCallback,
        callback?: InspectorCallback,
      ): void => {
        const completion =
          typeof paramsOrCallback === 'function' ? paramsOrCallback : callback;
        completion?.(null, {
          profile: { head: { functionName: 'root' }, samples: [] },
        });
      },
    };
    class MockSession implements MockInspectorSession {
      public connect(): void {
        inspectorSession.connect();
      }

      public disconnect(): void {
        inspectorSession.disconnect();
      }

      public post(
        method: string,
        paramsOrCallback?: InspectorParamsOrCallback,
        callback?: InspectorCallback,
      ): void {
        inspectorSession.post(method, paramsOrCallback, callback);
      }
    }
    const inspectorMock = { Session: MockSession };

    const fileStats = {
      size: 0,
      isDirectory: (): boolean => false,
      isFile: (): boolean => false,
      isSymbolicLink: (): boolean => false,
    };
    const fsSyncMock = {
      ...realFs,
      existsSync: (): boolean => false,
      lstatSync: (): typeof fileStats => fileStats,
      realpathSync: (path: string): string => path,
    };
    const fsPromisesMock = {
      ...realFsPromises,
      chmod: (): Promise<void> => Promise.resolve(),
      mkdir: (): Promise<void> => Promise.resolve(),
      readdir: (): Promise<string[]> => Promise.resolve([]),
      rm: (): Promise<void> => Promise.resolve(),
      stat: (): Promise<typeof fileStats> => Promise.resolve(fileStats),
      statfs: (): Promise<{
        bavail: number;
        bfree: number;
        bsize: number;
      }> =>
        Promise.resolve({
          bavail: 1_000_000,
          bfree: 1_000_000,
          bsize: 1,
        }),
      writeFile: (): Promise<void> => Promise.resolve(),
    };
    const v8Mock = {
      ...realV8,
      getHeapSpaceStatistics: (): ReturnType<
        typeof realV8.getHeapSpaceStatistics
      > => [],
      getHeapStatistics: (): ReturnType<typeof realV8.getHeapStatistics> => ({
        does_zap_garbage: 0,
        external_memory: 0,
        heap_size_limit: 1024,
        malloced_memory: 0,
        number_of_detached_contexts: 0,
        number_of_native_contexts: 0,
        peak_malloced_memory: 0,
        total_available_size: 1024,
        total_global_handles_size: 0,
        total_heap_size: 0,
        total_heap_size_executable: 0,
        total_physical_size: 0,
        used_global_handles_size: 0,
        used_heap_size: 0,
      }),
      writeHeapSnapshot: (): string => '/tmp/memory-diagnostics.heapsnapshot',
    };
    const electronMock = {
      app: {
        getAppMetrics: (): never[] => [],
        getVersion: (): string => 'test-version',
      },
    };
    const loggerMock = {
      debug: (): void => undefined,
      error: (): void => undefined,
      info: (): void => undefined,
      warn: (): void => undefined,
      transports: { file: {} },
    };

    function requireShim(id: string): unknown {
      if (id === 'electron') return electronMock;
      if (id === 'electron-log/main.js') return loggerMock;
      if (id === 'node:fs' || id === 'fs') return fsSyncMock;
      if (id === 'node:fs/promises' || id === 'fs/promises') {
        return fsPromisesMock;
      }
      if (id === 'node:v8' || id === 'v8') return v8Mock;
      if (id === 'node:inspector' || id === 'inspector') return inspectorMock;
      return jest.requireActual(id);
    }

    const contextProcess = {
      ...process,
      getBuiltinModule: (id: string): object | undefined => {
        if (id === 'node:inspector' || id === 'inspector') return inspectorMock;
        return process.getBuiltinModule(id);
      },
    };
    const compiled: { exports: unknown } = { exports: {} };
    new Script(source).runInNewContext({
      require: requireShim,
      module: compiled,
      exports: compiled.exports,
      Buffer,
      Error: VmCompatibleError,
      process: contextProcess,
      setInterval,
      clearInterval,
    });

    if (!isCompiledServiceModule(compiled.exports)) {
      throw new Error('Compiled service did not export its factory');
    }
    const host: MemoryDiagnosticsHost = {
      getAppRenderers: () => [],
    };
    const service = compiled.exports.createMemoryDiagnosticsService(host);
    try {
      service.setEnabled(true);
      const status = await service.getStatus();
      expect({
        samplingActive: status.samplingActive,
        samplingUnavailableReason: status.samplingUnavailableReason,
      }).toEqual({
        samplingActive: true,
        samplingUnavailableReason: null,
      });
    } finally {
      await service.dispose();
    }
  });
});
