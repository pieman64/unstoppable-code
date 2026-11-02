import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import type * as DesktopInstrumentationMainModule from '../main';

export interface PatchedSdkInternals {
  Assembly: new (
    eventManager: {
      registerHandler: (handler: unknown) => { unsubscribe: () => void };
    },
    hooks: {
      triggerRum: (params: Record<string, unknown>) => unknown;
    },
  ) => {
    assembleRendererRumEvent: (event: { data: Record<string, unknown> }) => {
      data: Record<string, unknown>;
    };
  };
  buildConfiguration: (configuration: Record<string, unknown>) => unknown;
  createFormatHooks: () => {
    triggerRum: (params: Record<string, never>) => {
      ddtags?: string;
    };
  };
  registerCommonContext: (
    configuration: unknown,
    hooks: ReturnType<PatchedSdkInternals['createFormatHooks']>,
  ) => void;
  CrashCollection: new (eventManager: { notify: (event: unknown) => void }) => {
    processCrashFiles: () => Promise<void>;
  };
  setCrashDumpFilter: (filter: CrashDumpFilter | undefined) => void;
  BridgeHandler: new (eventManager: unknown, bridgeOptions: unknown) => unknown;
}

const BRIDGE_CONFIG_CHANNEL = 'datadog:bridge-config';

/**
 * Sends one `datadog:bridge-config` request through the patched SDK's real
 * `BridgeHandler`, modeling Electron's sync reply: assigning `returnValue`
 * structured-clones the value and throws without replying when it cannot.
 * As in Electron 42, an assignment after a failed one sends nothing either.
 * Returns every reply that went out, so an empty array is a preload left
 * blocked forever.
 */
export function bridgeConfigReplies(bridgeOptions: unknown): unknown[] {
  const handlers = new Map<string, (event: unknown) => void>();
  const electron = {
    ipcMain: {
      on: (channel: string, handler: (event: unknown) => void): void => {
        handlers.set(channel, handler);
      },
    },
  };
  const { internals } = loadPatchedCjsInternals({ electron });
  new internals.BridgeHandler({ notify: (): void => undefined }, bridgeOptions);

  const replies: unknown[] = [];
  let replyFailed = false;
  const event = {};
  Object.defineProperty(event, 'returnValue', {
    set: (value: unknown): void => {
      if (replyFailed) return;
      try {
        replies.push(structuredClone(value));
      } catch (error) {
        replyFailed = true;
        throw error;
      }
    },
  });
  const handler = handlers.get(BRIDGE_CONFIG_CHANNEL);
  if (!handler) throw new Error('BridgeHandler registered no config handler');
  handler(event);
  return replies;
}

export type CrashDumpFilter = (
  filePath: string,
) => Promise<'process' | 'discard'>;

export interface FakeModule {
  readonly id: string;
  readonly exports: unknown;
}

/** A stand-in for Node's module registry, so a test can watch `require.cache`. */
export interface FakeModuleRegistry {
  readonly cache: Record<string, FakeModule | undefined>;
  readonly children: FakeModule[];
  readonly resolve: (specifier: string) => string;
  readonly load: (specifier: string) => unknown;
}

export function loadPatchedCjsInternals(
  options: { electron?: unknown; registry?: FakeModuleRegistry } = {},
): {
  bundlePath: string;
  internals: PatchedSdkInternals;
} {
  const bundlePath = require.resolve('@datadog/electron-sdk');
  const source = readFileSync(bundlePath, 'utf8');
  const moduleContainer: {
    exports: { __patchTest?: PatchedSdkInternals };
    children: FakeModule[];
  } = { exports: {}, children: options.registry?.children ?? [] };
  const bundleRequire = createRequire(bundlePath);
  const registry = options.registry;
  const sandboxRequire = Object.assign(
    (specifier: string): unknown => {
      if (specifier === 'electron') return options.electron ?? {};
      if (registry && specifier === './wasm.chunk.cjs')
        return registry.load(specifier);
      return bundleRequire(specifier);
    },
    {
      cache: registry?.cache ?? {},
      resolve: (specifier: string): string =>
        registry
          ? registry.resolve(specifier)
          : bundleRequire.resolve(specifier),
    },
  );

  runInNewContext(
    `${source}
module.exports.__patchTest = {
  Assembly,
  buildConfiguration,
  createFormatHooks,
  registerCommonContext,
  CrashCollection,
  BridgeHandler,
  setCrashDumpFilter: (filter) => {
    currentCrashDumpFilter = filter;
  },
};`,
    {
      Buffer,
      URL,
      clearInterval,
      clearTimeout,
      console,
      exports: moduleContainer.exports,
      module: moduleContainer,
      process,
      require: sandboxRequire,
      setInterval,
      setTimeout,
      structuredClone,
    },
  );

  const internals = moduleContainer.exports.__patchTest;
  if (!internals) {
    throw new Error('Failed to expose patched Datadog SDK internals');
  }

  return { bundlePath, internals };
}

const DATADOG_ENABLED_BUILD_CONSTANTS = {
  __CANOPY_DATADOG_ENABLED__: true,
  __CANOPY_DATADOG_CLIENT_TOKEN__: 'client-token',
  __CANOPY_DATADOG_APPLICATION_ID__: 'application-id',
};

/**
 * Runs `options` through the real wrapper, the patched SDK's
 * `buildConfiguration` and its `BridgeHandler`, returning the
 * `datadog:bridge-config` reply every preload receives.
 */
export async function patchedSdkBridgeConfigFor(
  options: Parameters<
    typeof DesktopInstrumentationMainModule.initializeDesktopInstrumentationMain
  >[0],
): Promise<unknown> {
  const sdkInit = jest.fn<Promise<boolean>, [Record<string, unknown>]>(() =>
    Promise.resolve(true),
  );
  const previousGlobals = Object.keys(DATADOG_ENABLED_BUILD_CONSTANTS).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.assign(globalThis, DATADOG_ENABLED_BUILD_CONSTANTS);
  try {
    await jest.isolateModulesAsync(async () => {
      jest.doMock('@datadog/electron-sdk', () => ({
        init: sdkInit,
        setUser: jest.fn(),
      }));
      const wrapper =
        jest.requireActual<typeof DesktopInstrumentationMainModule>('../main');
      await wrapper.initializeDesktopInstrumentationMain(options);
    });
  } finally {
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
  expect(sdkInit).toHaveBeenCalledTimes(1);
  const replies = bridgeConfigReplies(
    loadPatchedCjsInternals().internals.buildConfiguration(
      sdkInit.mock.calls[0]?.[0] ?? {},
    ),
  );
  expect(replies).toHaveLength(1);
  return replies[0];
}
