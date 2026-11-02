import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type CrashDumpFilter,
  type FakeModule,
  type FakeModuleRegistry,
  bridgeConfigReplies,
  loadPatchedCjsInternals,
} from './patched-datadog-sdk';

describe('patched Datadog Electron SDK variant tags', () => {
  it('emits the normalized variant in main-process RUM ddtags', () => {
    const { internals } = loadPatchedCjsInternals();
    const configuration = internals.buildConfiguration({
      applicationId: 'application-id',
      clientToken: 'client-token',
      service: 'canopy-desktop',
      site: 'datadoghq.com',
      variant: 'internal-canopy',
    });
    const hooks = internals.createFormatHooks();

    internals.registerCommonContext(configuration, hooks);

    expect(hooks.triggerRum({}).ddtags).toBe(
      'sdk_version:0.2.0,variant:internal-canopy',
    );
  });

  it('normalizes the variant in the patched MJS bundle too', () => {
    const { bundlePath } = loadPatchedCjsInternals();
    const mjsSource = readFileSync(
      join(dirname(bundlePath), 'index.mjs'),
      'utf8',
    );

    expect(mjsSource).toContain(
      'variant: validateOptionalString(initConfig.variant)',
    );
  });

  it('preserves Browser RUM ddtags on bridged renderer events', () => {
    const { internals } = loadPatchedCjsInternals();
    const assembly = new internals.Assembly(
      {
        registerHandler: (): { unsubscribe: () => void } => ({
          unsubscribe: (): void => undefined,
        }),
      },
      {
        triggerRum: (): Record<string, unknown> => ({
          application: { id: 'main-application-id' },
          ddtags: 'sdk_version:0.2.0,variant:internal-canopy',
          session: { id: 'main-session-id' },
          view: { id: 'main-view-id' },
        }),
      },
    );

    const result = assembly.assembleRendererRumEvent({
      data: {
        application: { id: 'renderer-application-id' },
        date: 1,
        ddtags: 'sdk_version:7.1.0,variant:internal-canopy',
        session: { id: 'renderer-session-id' },
        type: 'view',
      },
    });

    expect(result.data.ddtags).toBe(
      'sdk_version:7.1.0,variant:internal-canopy',
    );
    expect(result.data.application).toEqual({ id: 'main-application-id' });
    expect(result.data.session).toEqual({ id: 'main-session-id' });
  });

  it('preserves renderer ddtags in the patched MJS bundle too', () => {
    const { bundlePath } = loadPatchedCjsInternals();
    const mjsSource = readFileSync(
      join(dirname(bundlePath), 'index.mjs'),
      'utf8',
    );

    expect(mjsSource).not.toContain('ddtags: [event.data.ddtags, ddtags]');
  });
});

const STUB_CRASH_REPORT = {
  crash_info: { type: 'EXC_CRASH', crashing_thread: 0 },
  system_info: { cpu: 'arm64', os: 'Mac OS X' },
  threads: [],
  modules: [],
};

/** Mimics Node: a module is loaded once, then served from the cache until evicted. */
function createProcessorRegistry(
  options: { failing?: boolean } = {},
): FakeModuleRegistry & { loads: number } {
  const id = '/virtual/@datadog/electron-sdk/dist/wasm.chunk.cjs';
  const registry = {
    cache: {} as Record<string, FakeModule | undefined>,
    children: [] as FakeModule[],
    loads: 0,
    resolve: (specifier: string): string => {
      if (specifier !== './wasm.chunk.cjs') throw new Error(specifier);
      return id;
    },
    load: (): unknown => {
      const cached = registry.cache[id];
      if (cached) return cached.exports;
      registry.loads += 1;
      const loaded: FakeModule = {
        id,
        exports: {
          processMinidump: (): Promise<typeof STUB_CRASH_REPORT> =>
            options.failing
              ? Promise.reject(new Error('unprocessable dump'))
              : Promise.resolve(STUB_CRASH_REPORT),
        },
      };
      registry.cache[id] = loaded;
      registry.children.push(loaded);
      return loaded.exports;
    },
  };
  return registry;
}

describe('patched Datadog Electron SDK crash processing', () => {
  function crashDumpsWithOneDump(): string {
    const crashDumps = mkdtempSync(join(tmpdir(), 'dd-crash-dumps-'));
    mkdirSync(join(crashDumps, 'pending'));
    writeFileSync(join(crashDumps, 'pending', 'crash.dmp'), 'MDMP');
    return crashDumps;
  }

  it('releases the minidump processor once the dumps are processed', async () => {
    const registry = createProcessorRegistry();
    let crashDumps = crashDumpsWithOneDump();
    const electron = {
      app: {
        getName: (): string => 'Canopy',
        getPath: (): string => crashDumps,
      },
    };
    const { internals } = loadPatchedCjsInternals({ electron, registry });
    const notify = jest.fn();
    const collection = new internals.CrashCollection({ notify });

    await collection.processCrashFiles();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(registry.loads).toBe(1);
    expect(Object.values(registry.cache)).toEqual([]);
    expect(registry.children).toEqual([]);

    // A later scan loads the processor again and releases it again.
    crashDumps = crashDumpsWithOneDump();
    await collection.processCrashFiles();

    expect(notify).toHaveBeenCalledTimes(2);
    expect(registry.loads).toBe(2);
    expect(Object.values(registry.cache)).toEqual([]);
    expect(registry.children).toEqual([]);
  });

  function crashDumpsWith(names: readonly string[]): string {
    const crashDumps = mkdtempSync(join(tmpdir(), 'dd-crash-dumps-'));
    mkdirSync(join(crashDumps, 'pending'));
    for (const name of names) {
      writeFileSync(join(crashDumps, 'pending', name), 'MDMP');
    }
    return crashDumps;
  }

  function electronFor(crashDumps: string): unknown {
    return {
      app: {
        getName: (): string => 'Canopy',
        getPath: (): string => crashDumps,
      },
    };
  }

  it('unlinks dumps the host filter discards without loading the processor', async () => {
    const registry = createProcessorRegistry();
    const crashDumps = crashDumpsWith(['foreign-1.dmp', 'foreign-2.dmp']);
    const { internals } = loadPatchedCjsInternals({
      electron: electronFor(crashDumps),
      registry,
    });
    const filter = jest.fn<Promise<'process' | 'discard'>, [string]>(() =>
      Promise.resolve('discard'),
    );
    internals.setCrashDumpFilter(filter);
    const notify = jest.fn();

    await new internals.CrashCollection({ notify }).processCrashFiles();

    expect(filter).toHaveBeenCalledTimes(2);
    expect(registry.loads).toBe(0);
    expect(notify).not.toHaveBeenCalled();
    expect(readdirSync(join(crashDumps, 'pending'))).toEqual([]);
  });

  it('processes only the dumps the host filter keeps', async () => {
    const registry = createProcessorRegistry();
    const crashDumps = crashDumpsWith(['canopy.dmp', 'foreign.dmp']);
    const { internals } = loadPatchedCjsInternals({
      electron: electronFor(crashDumps),
      registry,
    });
    internals.setCrashDumpFilter((filePath) =>
      Promise.resolve(filePath.endsWith('foreign.dmp') ? 'discard' : 'process'),
    );
    const notify = jest.fn();

    await new internals.CrashCollection({ notify }).processCrashFiles();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(registry.loads).toBe(1);
    expect(readdirSync(join(crashDumps, 'pending'))).toEqual([]);
    expect(Object.values(registry.cache)).toEqual([]);
  });

  it('processes a dump when the host filter throws or rejects', async () => {
    const registry = createProcessorRegistry();
    const crashDumps = crashDumpsWith(['a.dmp', 'b.dmp']);
    const { internals } = loadPatchedCjsInternals({
      electron: electronFor(crashDumps),
      registry,
    });
    internals.setCrashDumpFilter((filePath) => {
      if (filePath.endsWith('a.dmp')) throw new Error('filter failed');
      return Promise.reject(new Error('filter rejected'));
    });
    const notify = jest.fn();

    await new internals.CrashCollection({ notify }).processCrashFiles();

    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('releases the processor even when a dump fails to process', async () => {
    const registry = createProcessorRegistry({ failing: true });
    const crashDumps = crashDumpsWith(['corrupt.dmp']);
    const { internals } = loadPatchedCjsInternals({
      electron: electronFor(crashDumps),
      registry,
    });

    await new internals.CrashCollection({
      notify: jest.fn(),
    }).processCrashFiles();

    expect(registry.loads).toBe(1);
    expect(Object.values(registry.cache)).toEqual([]);
    expect(registry.children).toEqual([]);
    // The SDK keeps a dump it could not process.
    expect(readdirSync(join(crashDumps, 'pending'))).toEqual(['corrupt.dmp']);
  });

  it('accepts only a function as the crash dump filter', () => {
    const { internals } = loadPatchedCjsInternals();
    const required = {
      applicationId: 'application-id',
      clientToken: 'client-token',
      service: 'canopy-desktop',
      site: 'datadoghq.com',
    };
    const filter: CrashDumpFilter = () => Promise.resolve('process');

    expect(
      internals.buildConfiguration({ ...required, crashDumpFilter: filter }),
    ).toMatchObject({ crashDumpFilter: filter });
    expect(
      internals.buildConfiguration({ ...required, crashDumpFilter: 'nope' }),
    ).toMatchObject({ crashDumpFilter: undefined });
  });

  it('installs the filter before crash collection starts', () => {
    const { bundlePath } = loadPatchedCjsInternals();
    for (const file of ['index.cjs', 'index.mjs']) {
      const source = readFileSync(join(dirname(bundlePath), file), 'utf8');
      const install = source.indexOf(
        'currentCrashDumpFilter = config.crashDumpFilter;',
      );
      expect(install).toBeGreaterThan(-1);
      expect(install).toBeLessThan(
        source.indexOf('await RumCollection.start(eventManager, hooks)'),
      );
    }
  });

  it('never loads the processor when there are no dumps', async () => {
    const registry = createProcessorRegistry();
    const crashDumps = mkdtempSync(join(tmpdir(), 'dd-crash-dumps-'));
    const electron = {
      app: {
        getName: (): string => 'Canopy',
        getPath: (): string => crashDumps,
      },
    };
    const { internals } = loadPatchedCjsInternals({ electron, registry });

    await new internals.CrashCollection({
      notify: jest.fn(),
    }).processCrashFiles();

    expect(registry.loads).toBe(0);
  });
});

// Every preload blocks in a sync `datadog:bridge-config` request. A reply that
// cannot be cloned is never sent, and the window hangs before the UI mounts.
describe('patched Datadog Electron SDK preload bridge config', () => {
  const required = {
    applicationId: 'application-id',
    clientToken: 'client-token',
    service: 'canopy-desktop',
    site: 'datadoghq.com',
  };

  it('replies with only the fields the preload reads, alongside a crash dump filter', () => {
    const { internals } = loadPatchedCjsInternals();
    const filter: CrashDumpFilter = () => Promise.resolve('process');
    const configuration = internals.buildConfiguration({
      ...required,
      allowedWebViewHosts: ['docs.example.com'],
      crashDumpFilter: filter,
      defaultPrivacyLevel: 'allow',
      proxy: 'https://proxy.example.com',
    });

    expect(bridgeConfigReplies(configuration)).toEqual([
      {
        allowedWebViewHosts: ['docs.example.com'],
        defaultPrivacyLevel: 'allow',
      },
    ]);
  });

  it('replies null, which the preload treats as masked defaults, when the reply cannot be cloned', () => {
    const uncloneableHosts = [(): void => undefined];

    expect(
      bridgeConfigReplies({
        allowedWebViewHosts: uncloneableHosts,
        defaultPrivacyLevel: 'allow',
      }),
    ).toEqual([null]);
  });

  it('applies the same reply in the patched MJS bundle', () => {
    const { bundlePath } = loadPatchedCjsInternals();
    const cjsSource = readFileSync(bundlePath, 'utf8');
    const mjsSource = readFileSync(
      join(dirname(bundlePath), 'index.mjs'),
      'utf8',
    );
    const handlerOf = (source: string): string =>
      source.slice(
        source.indexOf('ipcMain.on(CONFIG_CHANNEL'),
        source.indexOf('onBridgeMessage(msg) {'),
      );

    expect(handlerOf(cjsSource)).toContain('structuredClone({');
    expect(handlerOf(mjsSource)).toBe(handlerOf(cjsSource));
  });
});

// The stub registry above proves the patch evicts the processor; this proves
// that eviction is enough for the real chunk's WebAssembly instance and memory
// to become collectable. It observes the objects WebAssembly.instantiate
// creates, weakly. It measures eligibility for GC, not RSS release.
const COLLECTABILITY_PROBE = `
const chunkPath = process.argv[1];
const evict = process.argv[2] !== 'keep';
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const refs = {};
const instantiate = WebAssembly.instantiate;
WebAssembly.instantiate = async function (...args) {
  const result = await instantiate.apply(this, args);
  const instance = result instanceof WebAssembly.Instance ? result : result.instance;
  refs.instance = new WeakRef(instance);
  const memory = Object.values(instance.exports).find((value) => value instanceof WebAssembly.Memory);
  if (memory) refs.memory = new WeakRef(memory);
  return result;
};
async function loadProcessOnceAndEvict() {
  const chunk = require(chunkPath);
  refs.exports = new WeakRef(chunk);
  const bytes = new Uint8Array(64);
  bytes.set([0x4d, 0x44, 0x4d, 0x50]);
  try { await chunk.processMinidump(bytes); } catch {}
  if (!evict) return;
  const cached = require.cache[chunkPath];
  delete require.cache[chunkPath];
  const siblings = (cached && cached.parent && cached.parent.children) || [];
  const index = siblings.indexOf(cached);
  if (index !== -1) siblings.splice(index, 1);
}
(async () => {
  await loadProcessOnceAndEvict();
  WebAssembly.instantiate = instantiate;
  const observed = Object.keys(refs).sort();
  // deref() keeps its target alive for the current job, so collect and check
  // in separate event-loop turns, with a bounded number of rounds.
  let alive = observed;
  for (let round = 0; round < 10 && alive.length > 0; round += 1) {
    await tick();
    global.gc();
    await tick();
    alive = observed.filter((key) => refs[key].deref() !== undefined);
  }
  process.stdout.write(JSON.stringify({ observed, alive }));
})();
`;

describe('patched Datadog Electron SDK processor release', () => {
  function runProbe(mode: 'evict' | 'keep'): unknown {
    const chunkPath = join(
      dirname(require.resolve('@datadog/electron-sdk')),
      'wasm.chunk.cjs',
    );
    const result = spawnSync(
      process.execPath,
      ['--expose-gc', '-e', COLLECTABILITY_PROBE, chunkPath, mode],
      { encoding: 'utf8', timeout: 60_000 },
    );
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout);
  }

  it('lets the real processor, its WebAssembly instance and memory be collected once evicted', () => {
    expect(runProbe('evict')).toEqual({
      observed: ['exports', 'instance', 'memory'],
      alive: [],
    });
  });

  it('keeps all three alive without the eviction, so the probe can detect retention', () => {
    expect(runProbe('keep')).toEqual({
      observed: ['exports', 'instance', 'memory'],
      alive: ['exports', 'instance', 'memory'],
    });
  });
});
