import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';

interface PatchedSdkInternals {
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
}

function loadPatchedCjsInternals(): {
  bundlePath: string;
  internals: PatchedSdkInternals;
} {
  const bundlePath = require.resolve('@datadog/electron-sdk');
  const source = readFileSync(bundlePath, 'utf8');
  const moduleContainer: {
    exports: { __patchTest?: PatchedSdkInternals };
  } = { exports: {} };
  const bundleRequire = createRequire(bundlePath);

  runInNewContext(
    `${source}
module.exports.__patchTest = {
  Assembly,
  buildConfiguration,
  createFormatHooks,
  registerCommonContext,
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
      require: (specifier: string): unknown =>
        specifier === 'electron' ? {} : bundleRequire(specifier),
      setInterval,
      setTimeout,
    },
  );

  const internals = moduleContainer.exports.__patchTest;
  if (!internals) {
    throw new Error('Failed to expose patched Datadog SDK internals');
  }

  return { bundlePath, internals };
}

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
