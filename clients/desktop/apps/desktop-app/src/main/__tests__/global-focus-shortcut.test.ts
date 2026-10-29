jest.mock('electron', () => ({
  globalShortcut: {
    register: jest.fn(),
    unregister: jest.fn(),
    unregisterAll: jest.fn(),
  },
  ipcMain: { on: jest.fn(), removeListener: jest.fn() },
}));

import type { GlobalFocusShortcutStatus } from '@canopy/desktop-shared/types';
import {
  createE2eGlobalShortcutRegistrar,
  GlobalFocusShortcutService,
  parseE2eGlobalShortcutFlow,
  withRefusedAccelerators,
  type GlobalShortcutRegistrar,
} from '../lifecycle/global-focus-shortcut';

interface FakeRegistrar extends GlobalShortcutRegistrar {
  registered: Map<string, () => void>;
  refuse: Set<string>;
  throwOn: Set<string>;
  calls: string[];
}

function fakeRegistrar(): FakeRegistrar {
  const registered = new Map<string, () => void>();
  const refuse = new Set<string>();
  const throwOn = new Set<string>();
  const calls: string[] = [];
  return {
    registered,
    refuse,
    throwOn,
    calls,
    register(accelerator, callback): boolean {
      calls.push(`register:${accelerator}`);
      if (throwOn.has(accelerator)) throw new Error('bad accelerator');
      if (refuse.has(accelerator) || registered.has(accelerator)) return false;
      registered.set(accelerator, callback);
      return true;
    },
    unregister(accelerator): void {
      calls.push(`unregister:${accelerator}`);
      registered.delete(accelerator);
    },
  };
}

const DEFAULT = 'CommandOrControl+Shift+O';
const OTHER = 'CommandOrControl+Shift+P';

function createService(options?: {
  registrar?: FakeRegistrar;
  platform?: NodeJS.Platform;
  onTrigger?: () => void;
  onStatusChanged?: (status: GlobalFocusShortcutStatus) => void;
  now?: () => Date;
}): { service: GlobalFocusShortcutService; registrar: FakeRegistrar } {
  const registrar = options?.registrar ?? fakeRegistrar();
  const service = new GlobalFocusShortcutService({
    registrar,
    platform: options?.platform ?? 'darwin',
    onTrigger: options?.onTrigger ?? ((): void => undefined),
    onStatusChanged: options?.onStatusChanged,
    now: options?.now,
  });
  return { service, registrar };
}

describe('GlobalFocusShortcutService.apply', () => {
  it('registers an enabled chord and reports it active', () => {
    const { service, registrar } = createService();

    const result = service.apply({ enabled: true, accelerator: DEFAULT });

    expect(result.ok).toBe(true);
    expect(registrar.registered.has(DEFAULT)).toBe(true);
    expect(service.getStatus()).toEqual({
      enabled: true,
      accelerator: DEFAULT,
      registered: true,
      platform: 'darwin',
    });
  });

  it('does not re-register when the same config is applied again', () => {
    const { service, registrar } = createService();
    service.apply({ enabled: true, accelerator: DEFAULT });

    service.apply({ enabled: true, accelerator: DEFAULT });

    expect(registrar.calls).toEqual([`register:${DEFAULT}`]);
  });

  it('unregisters when disabled and reports inactive without a failure', () => {
    const { service, registrar } = createService();
    service.apply({ enabled: true, accelerator: DEFAULT });

    const result = service.apply({ enabled: false, accelerator: DEFAULT });

    expect(result.ok).toBe(true);
    expect(registrar.registered.size).toBe(0);
    expect(service.getStatus()).toEqual({
      enabled: false,
      accelerator: DEFAULT,
      registered: false,
      platform: 'darwin',
    });
  });

  it('canonicalizes a disabled chord and falls back to the default when it is invalid', () => {
    // The preference writer would fall back on read; the live status must
    // not show a value that will never be persisted.
    const { service } = createService();

    service.apply({ enabled: false, accelerator: 'shift+cmdorctrl+p' });
    expect(service.getStatus().accelerator).toBe(OTHER);

    service.apply({ enabled: false, accelerator: 'O' });
    expect(service.getStatus().accelerator).toBe(DEFAULT);
  });

  it('keeps the previous working chord when the OS refuses the new one', () => {
    const { service, registrar } = createService();
    service.apply({ enabled: true, accelerator: DEFAULT });
    registrar.refuse.add(OTHER);

    const result = service.apply({ enabled: true, accelerator: OTHER });

    expect(result).toMatchObject({
      ok: false,
      reason: 'in-use',
      accelerator: OTHER,
    });
    // The prior registration was released to try the new chord, then put
    // back so the user never loses a binding that worked.
    expect(registrar.calls).toEqual([
      `register:${DEFAULT}`,
      `unregister:${DEFAULT}`,
      `register:${OTHER}`,
      `register:${DEFAULT}`,
    ]);
    expect(registrar.registered.has(DEFAULT)).toBe(true);
    expect(service.getActiveAccelerator()).toBe(DEFAULT);
    expect(service.getStatus()).toEqual({
      enabled: true,
      accelerator: OTHER,
      registered: false,
      failure: 'in-use',
      platform: 'darwin',
    });
  });

  it('refuses reserved, modifier-less, and unparseable chords without touching the OS', () => {
    const { service, registrar } = createService();
    service.apply({ enabled: true, accelerator: DEFAULT });
    const callsBefore = registrar.calls.length;

    expect(
      service.apply({ enabled: true, accelerator: 'CommandOrControl+Space' }),
    ).toMatchObject({ ok: false, reason: 'reserved' });
    expect(service.apply({ enabled: true, accelerator: 'O' })).toMatchObject({
      ok: false,
      reason: 'needs-modifier',
    });
    expect(
      service.apply({ enabled: true, accelerator: 'Bogus+Q' }),
    ).toMatchObject({ ok: false, reason: 'invalid' });

    expect(registrar.calls).toHaveLength(callsBefore);
    expect(service.getActiveAccelerator()).toBe(DEFAULT);
  });

  it('treats a registrar throw as an invalid chord and keeps the previous one', () => {
    const { service, registrar } = createService();
    service.apply({ enabled: true, accelerator: DEFAULT });
    registrar.throwOn.add(OTHER);

    const result = service.apply({ enabled: true, accelerator: OTHER });

    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    expect(service.getActiveAccelerator()).toBe(DEFAULT);
    expect(registrar.registered.has(DEFAULT)).toBe(true);
  });

  it('reports a startup failure when the saved chord cannot be registered', () => {
    const { service, registrar } = createService();
    registrar.refuse.add(DEFAULT);

    const result = service.apply({ enabled: true, accelerator: DEFAULT });

    expect(result).toMatchObject({ ok: false, reason: 'in-use' });
    expect(service.getActiveAccelerator()).toBeNull();
    expect(service.getStatus()).toMatchObject({
      enabled: true,
      accelerator: DEFAULT,
      registered: false,
      failure: 'in-use',
    });
  });

  it('notifies status listeners only when the status changes', () => {
    const onStatusChanged = jest.fn<void, [GlobalFocusShortcutStatus]>();
    const { service } = createService({ onStatusChanged });

    service.apply({ enabled: true, accelerator: DEFAULT });
    service.apply({ enabled: true, accelerator: DEFAULT });
    service.apply({ enabled: false, accelerator: DEFAULT });

    expect(onStatusChanged).toHaveBeenCalledTimes(2);
    expect(onStatusChanged.mock.calls[1]?.[0]).toMatchObject({
      enabled: false,
      registered: false,
    });
  });
});

describe('GlobalFocusShortcutService trigger + dispose', () => {
  it('runs the trigger handler and stamps lastTriggeredAt when the OS fires the chord', () => {
    const onTrigger = jest.fn<void, []>();
    const onStatusChanged = jest.fn<void, [GlobalFocusShortcutStatus]>();
    const { service, registrar } = createService({
      onTrigger,
      onStatusChanged,
      now: () => new Date('2026-09-10T12:00:00.000Z'),
    });
    service.apply({ enabled: true, accelerator: DEFAULT });

    registrar.registered.get(DEFAULT)?.();

    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(service.getStatus().lastTriggeredAt).toBe(
      '2026-09-10T12:00:00.000Z',
    );
    expect(onStatusChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ lastTriggeredAt: '2026-09-10T12:00:00.000Z' }),
    );
  });

  it('broadcasts the proof once per registration and stays quiet on repeats', () => {
    // macOS auto-repeats a held hot key; every delivery must reach the
    // trigger handler, but the status only transitions to "Working" once.
    const onTrigger = jest.fn<void, []>();
    const onStatusChanged = jest.fn<void, [GlobalFocusShortcutStatus]>();
    let tick = 0;
    const { service, registrar } = createService({
      onTrigger,
      onStatusChanged,
      now: () => new Date(Date.UTC(2026, 8, 10, 12, 0, tick++)),
    });
    service.apply({ enabled: true, accelerator: DEFAULT });
    const pushesAfterApply = onStatusChanged.mock.calls.length;

    registrar.registered.get(DEFAULT)?.();
    registrar.registered.get(DEFAULT)?.();
    registrar.registered.get(DEFAULT)?.();

    expect(onTrigger).toHaveBeenCalledTimes(3);
    expect(onStatusChanged).toHaveBeenCalledTimes(pushesAfterApply + 1);
    expect(service.getStatus().lastTriggeredAt).toBe(
      '2026-09-10T12:00:00.000Z',
    );
  });

  it('clears the proof timestamp when the registration is released', () => {
    // A remapped chord must be proven again; inheriting the old timestamp
    // would show "Working" before the OS ever delivered the new binding.
    const { service, registrar } = createService({
      now: () => new Date('2026-09-10T12:00:00.000Z'),
    });
    service.apply({ enabled: true, accelerator: DEFAULT });
    registrar.registered.get(DEFAULT)?.();
    expect(service.getStatus().lastTriggeredAt).toBeDefined();

    service.apply({ enabled: true, accelerator: OTHER });

    expect(service.getStatus().lastTriggeredAt).toBeUndefined();
    expect(service.getStatus()).toMatchObject({
      accelerator: OTHER,
      registered: true,
    });
  });

  it('keeps the proof of the unchanged chord when a remap is refused', () => {
    // The proof is cleared for a real remap, but a refused one puts the same
    // registration straight back; that chord was proven and still is.
    const { service, registrar } = createService({
      now: () => new Date('2026-09-10T12:00:00.000Z'),
    });
    service.apply({ enabled: true, accelerator: DEFAULT });
    registrar.registered.get(DEFAULT)?.();
    registrar.refuse.add(OTHER);

    service.apply({ enabled: true, accelerator: OTHER });
    service.apply({ enabled: true, accelerator: DEFAULT });

    expect(service.getStatus()).toMatchObject({
      accelerator: DEFAULT,
      registered: true,
      lastTriggeredAt: '2026-09-10T12:00:00.000Z',
    });
  });

  it('dispose releases the OS registration', () => {
    const { service, registrar } = createService();
    service.apply({ enabled: true, accelerator: DEFAULT });

    service.dispose();

    expect(registrar.registered.size).toBe(0);
    expect(service.getStatus()).toMatchObject({ registered: false });
  });
});

describe('E2E registrar fake', () => {
  it('parses the in-use flow into canonical accelerators', () => {
    expect(
      parseE2eGlobalShortcutFlow(
        'in-use:cmdorctrl+shift+p, CommandOrControl+Shift+O',
      ),
    ).toEqual({ inUse: [OTHER, DEFAULT] });
    expect(parseE2eGlobalShortcutFlow(undefined)).toEqual({ inUse: [] });
    expect(parseE2eGlobalShortcutFlow('garbage')).toEqual({ inUse: [] });
  });

  it('refuses the in-use chords, accepts the rest, and can fire the registered callback', () => {
    const registrar = createE2eGlobalShortcutRegistrar({ inUse: [OTHER] });
    const callback = jest.fn();

    expect(registrar.register(OTHER, callback)).toBe(false);
    expect(registrar.register(DEFAULT, callback)).toBe(true);
    registrar.trigger();
    expect(callback).toHaveBeenCalledTimes(1);

    registrar.unregister(DEFAULT);
    registrar.trigger();
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

describe('withRefusedAccelerators (local QA override)', () => {
  it('refuses only the listed chords and passes everything else to the real registrar', () => {
    const real = fakeRegistrar();
    const wrapped = withRefusedAccelerators(real, { inUse: [OTHER] });
    const callback = jest.fn<void, []>();

    expect(wrapped.register('shift+cmdorctrl+p', callback)).toBe(false);
    expect(real.calls).toEqual([]);

    expect(wrapped.register(DEFAULT, callback)).toBe(true);
    wrapped.unregister(DEFAULT);
    expect(real.calls).toEqual([
      `register:${DEFAULT}`,
      `unregister:${DEFAULT}`,
    ]);
  });

  it('returns the real registrar untouched when nothing is listed', () => {
    const real = fakeRegistrar();
    expect(withRefusedAccelerators(real, { inUse: [] })).toBe(real);
  });
});
