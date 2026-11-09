import { interfaceToolDescriptor } from '@canopy/protocol/canopy-core';
import {
  registerInterfaceTools,
  unregisterAllInterfaceTools,
} from '../interface-tools-client';

function stubRelay(invoke: jest.Mock): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { canopyCore: { invoke } },
  });
}

describe('interface tools client (CAN-4131)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('registers catalog descriptors with the given key', async () => {
    const invoke = jest.fn().mockResolvedValue({
      ok: true,
      value: { registrationRevision: 1, effectiveToolNames: [] },
    });
    stubRelay(invoke);
    await registerInterfaceTools(
      ['ui.get_current_ui_state', 'ui.show_files'],
      'key-1',
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith({
      kind: 'request',
      method: 'core.client.tools.register',
      params: {
        tools: [
          interfaceToolDescriptor('ui.get_current_ui_state'),
          interfaceToolDescriptor('ui.show_files'),
        ],
        _meta: { idempotencyKey: 'key-1' },
      },
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    invoke.mockResolvedValueOnce({
      ok: false,
      error: {
        kind: 'invalid_argument',
        message: 'x',
        retry: { kind: 'never' },
      },
    });
    await registerInterfaceTools(['ui.show_files'], 'key-2');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[interface-tools] registration failed',
      'invalid_argument',
    );
  });

  it('unregisters all and ignores failures', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const invoke = jest.fn().mockResolvedValueOnce({
      ok: false,
      error: { kind: 'not_found', message: 'x', retry: { kind: 'never' } },
    });
    stubRelay(invoke);
    await expect(unregisterAllInterfaceTools()).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith({
      kind: 'request',
      method: 'core.client.tools.unregister',
      params: { all: true },
    });
    invoke.mockRejectedValueOnce(new Error('relay closed'));
    await expect(unregisterAllInterfaceTools()).resolves.toBeUndefined();
    await expect(
      registerInterfaceTools(['ui.show_files'], 'key-3'),
    ).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('two contributors share one lease registration', async () => {
    const invoke = jest.fn().mockResolvedValue({
      ok: true,
      value: { registrationRevision: 1, effectiveToolNames: [] },
    });
    stubRelay(invoke);
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { randomUUID: (): string => 'key' },
    });
    const settle = (): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, 0));
    await jest.isolateModulesAsync(async () => {
      const { contributeInterfaceTools } =
        await import('../interface-tools-client');
      const withdrawAdvisor = contributeInterfaceTools([
        'ui.show_files',
        'ui.get_current_ui_state',
      ]);
      const withdrawEditor = contributeInterfaceTools([
        'ui.pipeline_editor.list',
      ]);
      await settle();
      const registered = invoke.mock.calls.map(
        ([request]: [{ params: { tools?: { name: string }[] } }]) =>
          request.params.tools?.map((tool) => tool.name),
      );
      // Each registration names every contributor's tools, never just one.
      expect(registered.at(-1)).toEqual([
        'ui.get_current_ui_state',
        'ui.pipeline_editor.list',
        'ui.show_files',
      ]);
      invoke.mockClear();
      withdrawEditor();
      await settle();
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith({
        kind: 'request',
        method: 'core.client.tools.unregister',
        params: { toolNames: ['ui.pipeline_editor.list'] },
      });
      invoke.mockClear();
      withdrawAdvisor();
      withdrawAdvisor();
      await settle();
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith({
        kind: 'request',
        method: 'core.client.tools.unregister',
        params: { all: true },
      });
    });
  });
});
