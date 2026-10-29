import { DefaultBrowserRegistrationService } from '../browser/default-browser-registration';

function makeRegistrar(): {
  defaults: Set<string>;
  registrar: {
    setAsDefaultProtocolClient: jest.Mock<
      boolean,
      [string, string?, string[]?]
    >;
    removeAsDefaultProtocolClient: jest.Mock<
      boolean,
      [string, string?, string[]?]
    >;
    isDefaultProtocolClient: jest.Mock<boolean, [string, string?, string[]?]>;
    getApplicationInfoForProtocol: jest.Mock<
      Promise<{ path: string }>,
      [string]
    >;
  };
} {
  const defaults = new Set<string>();
  return {
    defaults,
    registrar: {
      setAsDefaultProtocolClient: jest.fn((protocol: string) => {
        defaults.add(protocol);
        return true;
      }),
      removeAsDefaultProtocolClient: jest.fn((protocol: string) => {
        defaults.delete(protocol);
        return true;
      }),
      isDefaultProtocolClient: jest.fn((protocol: string) =>
        defaults.has(protocol),
      ),
      getApplicationInfoForProtocol: jest.fn((url: string) => {
        const protocol = new URL(url).protocol.slice(0, -1);
        return Promise.resolve({
          path: defaults.has(protocol)
            ? 'C:\\Program Files\\Canopy\\Canopy.exe'
            : 'C:\\Program Files\\Other\\Browser.exe',
        });
      }),
    },
  };
}

describe('DefaultBrowserRegistrationService', () => {
  it('refreshes persisted startup intent without reclaiming web protocols', async () => {
    const { registrar } = makeRegistrar();
    const service = new DefaultBrowserRegistrationService({
      registrar,
      platform: 'darwin',
      isPackaged: true,
      isE2e: false,
      initialEnabled: true,
    });

    await expect(service.refresh()).resolves.toEqual({
      enabled: true,
      registered: false,
      platform: 'darwin',
      failure: 'registration-refused',
    });
    expect(registrar.setAsDefaultProtocolClient).not.toHaveBeenCalled();
    expect(registrar.removeAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  it('reports Linux registration as unsupported without claiming web protocols', async () => {
    const { registrar } = makeRegistrar();
    const service = new DefaultBrowserRegistrationService({
      registrar,
      platform: 'linux',
      isPackaged: true,
      isE2e: false,
    });

    await expect(service.apply({ enabled: true })).resolves.toEqual({
      enabled: true,
      registered: false,
      platform: 'linux',
      failure: 'unsupported',
    });
    expect(registrar.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  it('registers and verifies both web protocols when enabled', async () => {
    const { registrar } = makeRegistrar();
    const service = new DefaultBrowserRegistrationService({
      registrar,
      platform: 'darwin',
      isPackaged: true,
      isE2e: false,
    });

    await expect(service.apply({ enabled: true })).resolves.toEqual({
      enabled: true,
      registered: true,
      platform: 'darwin',
    });
    expect(registrar.setAsDefaultProtocolClient).toHaveBeenCalledTimes(2);
    expect(registrar.isDefaultProtocolClient).toHaveBeenCalledWith('http');
    expect(registrar.isDefaultProtocolClient).toHaveBeenCalledWith('https');
  });

  it('unregisters both protocols when disabled', async () => {
    const { registrar } = makeRegistrar();
    const service = new DefaultBrowserRegistrationService({
      registrar,
      platform: 'darwin',
      isPackaged: true,
      isE2e: false,
    });
    await service.apply({ enabled: true });

    await expect(service.apply({ enabled: false })).resolves.toEqual({
      enabled: false,
      registered: false,
      platform: 'darwin',
    });
    expect(registrar.removeAsDefaultProtocolClient).toHaveBeenCalledTimes(2);
  });

  it('reports a failed disable when either web protocol remains registered', async () => {
    const { defaults, registrar } = makeRegistrar();
    defaults.add('http');
    defaults.add('https');
    registrar.removeAsDefaultProtocolClient.mockImplementation(
      (protocol: string) => {
        if (protocol === 'http') defaults.delete(protocol);
        return protocol === 'http';
      },
    );
    const service = new DefaultBrowserRegistrationService({
      registrar,
      platform: 'win32',
      isPackaged: true,
      isE2e: false,
      executablePath: 'C:\\Program Files\\Canopy\\Canopy.exe',
    });

    await expect(service.apply({ enabled: false })).resolves.toEqual({
      enabled: false,
      registered: true,
      platform: 'win32',
      failure: 'registration-refused',
    });
    expect(registrar.getApplicationInfoForProtocol).toHaveBeenCalledWith(
      'http://canopy-default-check.invalid',
    );
    expect(registrar.getApplicationInfoForProtocol).toHaveBeenCalledWith(
      'https://canopy-default-check.invalid',
    );
  });

  it('clears failed-disable guidance after the user changes the OS default', async () => {
    const { defaults, registrar } = makeRegistrar();
    defaults.add('http');
    defaults.add('https');
    registrar.removeAsDefaultProtocolClient.mockReturnValue(false);
    const service = new DefaultBrowserRegistrationService({
      registrar,
      platform: 'win32',
      isPackaged: true,
      isE2e: false,
      executablePath: 'C:\\Program Files\\Canopy\\Canopy.exe',
    });

    await expect(service.apply({ enabled: false })).resolves.toMatchObject({
      enabled: false,
      registered: true,
      failure: 'registration-refused',
    });

    defaults.clear();
    await expect(service.refresh()).resolves.toEqual({
      enabled: false,
      registered: false,
      platform: 'win32',
    });
  });

  it('reports Windows guidance and opens Settings only for a user change', async () => {
    const { registrar } = makeRegistrar();
    const advertiseWindowsCapabilities = jest.fn().mockResolvedValue(undefined);
    const openWindowsSettings = jest.fn().mockResolvedValue(undefined);
    const service = new DefaultBrowserRegistrationService({
      registrar,
      platform: 'win32',
      isPackaged: true,
      isE2e: false,
      registrationPath: 'C:\\Program Files\\Canopy\\Canopy.exe',
      advertiseWindowsCapabilities,
      openWindowsSettings,
    });

    await expect(service.apply({ enabled: true })).resolves.toEqual({
      enabled: true,
      registered: false,
      platform: 'win32',
      failure: 'user-action-required',
    });
    expect(openWindowsSettings).not.toHaveBeenCalled();

    await service.apply({ enabled: true, promptForWindowsSettings: true });
    expect(advertiseWindowsCapabilities).toHaveBeenCalledTimes(2);
    expect(openWindowsSettings).toHaveBeenCalledTimes(1);
    expect(registrar.setAsDefaultProtocolClient).not.toHaveBeenCalled();
    expect(registrar.getApplicationInfoForProtocol).toHaveBeenCalledWith(
      'http://canopy-default-check.invalid',
    );
    expect(registrar.getApplicationInfoForProtocol).toHaveBeenCalledWith(
      'https://canopy-default-check.invalid',
    );
  });

  it('refreshes the verified state after the user changes the OS default', async () => {
    const { defaults, registrar } = makeRegistrar();
    registrar.isDefaultProtocolClient.mockReturnValue(false);
    const onStatusChanged = jest.fn();
    const service = new DefaultBrowserRegistrationService({
      registrar,
      platform: 'win32',
      isPackaged: true,
      isE2e: false,
      executablePath: 'C:\\Program Files\\Canopy\\Canopy.exe',
      onStatusChanged,
    });
    await service.apply({ enabled: true });
    defaults.add('http');
    defaults.add('https');
    registrar.isDefaultProtocolClient.mockImplementation((protocol: string) =>
      defaults.has(protocol),
    );

    await expect(service.refresh()).resolves.toEqual({
      enabled: true,
      registered: true,
      platform: 'win32',
    });
    expect(onStatusChanged).toHaveBeenLastCalledWith({
      enabled: true,
      registered: true,
      platform: 'win32',
    });
  });

  it('does not let an older refresh overwrite a newer apply intent', async () => {
    const { defaults, registrar } = makeRegistrar();
    defaults.add('http');
    defaults.add('https');
    const service = new DefaultBrowserRegistrationService({
      registrar,
      platform: 'win32',
      isPackaged: true,
      isE2e: false,
      executablePath: 'C:\\Program Files\\Canopy\\Canopy.exe',
    });
    await service.apply({ enabled: true });

    let releaseRefresh: () => void = () => undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let associationChecks = 0;
    registrar.getApplicationInfoForProtocol.mockImplementation(async () => {
      associationChecks += 1;
      if (associationChecks <= 2) {
        await refreshGate;
        return { path: 'C:\\Program Files\\Canopy\\Canopy.exe' };
      }
      return { path: 'C:\\Program Files\\Other\\Browser.exe' };
    });

    const staleRefresh = service.refresh();
    await Promise.resolve();
    await expect(service.apply({ enabled: false })).resolves.toEqual({
      enabled: false,
      registered: false,
      platform: 'win32',
    });
    releaseRefresh();

    await expect(staleRefresh).resolves.toEqual({
      enabled: false,
      registered: false,
      platform: 'win32',
    });
    expect(service.getStatus()).toEqual({
      enabled: false,
      registered: false,
      platform: 'win32',
    });
  });

  it('does not let a refresh started during apply restore the old intent', async () => {
    const { registrar } = makeRegistrar();
    let releaseAdvertisement: () => void = () => undefined;
    const advertisementGate = new Promise<void>((resolve) => {
      releaseAdvertisement = resolve;
    });
    let advertisementFinished = false;
    const advertiseWindowsCapabilities = jest.fn(async () => {
      await advertisementGate;
      advertisementFinished = true;
    });
    let releaseEarlyRefresh: () => void = () => undefined;
    const earlyRefreshGate = new Promise<void>((resolve) => {
      releaseEarlyRefresh = resolve;
    });
    registrar.getApplicationInfoForProtocol.mockImplementation(async () => {
      if (!advertisementFinished) await earlyRefreshGate;
      return { path: 'C:\\Program Files\\Other\\Browser.exe' };
    });
    const service = new DefaultBrowserRegistrationService({
      registrar,
      platform: 'win32',
      isPackaged: true,
      isE2e: false,
      executablePath: 'C:\\Program Files\\Canopy\\Canopy.exe',
      advertiseWindowsCapabilities,
    });

    const applying = service.apply({ enabled: true });
    await Promise.resolve();
    const refreshing = service.refresh();
    releaseAdvertisement();
    await expect(applying).resolves.toMatchObject({ enabled: true });
    releaseEarlyRefresh();
    await refreshing;

    expect(service.getStatus()).toEqual({
      enabled: true,
      registered: false,
      platform: 'win32',
      failure: 'user-action-required',
    });
  });

  it('does not mutate OS registration in E2E or unpackaged macOS', async () => {
    for (const options of [
      { platform: 'darwin' as const, isPackaged: true, isE2e: true },
      { platform: 'darwin' as const, isPackaged: false, isE2e: false },
    ]) {
      const { registrar } = makeRegistrar();
      const service = new DefaultBrowserRegistrationService({
        registrar,
        ...options,
      });

      await expect(service.apply({ enabled: true })).resolves.toEqual({
        enabled: true,
        registered: false,
        platform: 'darwin',
        failure: 'unsupported',
      });
      expect(registrar.setAsDefaultProtocolClient).not.toHaveBeenCalled();
    }
  });

  it('contains registrar and Windows Settings failures in verified status', async () => {
    const { registrar } = makeRegistrar();
    registrar.setAsDefaultProtocolClient.mockImplementation(() => {
      throw new Error('registrar unavailable');
    });
    const service = new DefaultBrowserRegistrationService({
      registrar,
      platform: 'darwin',
      isPackaged: true,
      isE2e: false,
    });

    await expect(service.apply({ enabled: true })).resolves.toEqual({
      enabled: true,
      registered: false,
      platform: 'darwin',
      failure: 'registration-refused',
    });

    const windowsRegistrar = makeRegistrar().registrar;
    windowsRegistrar.isDefaultProtocolClient.mockReturnValue(false);
    const windowsService = new DefaultBrowserRegistrationService({
      registrar: windowsRegistrar,
      platform: 'win32',
      isPackaged: true,
      isE2e: false,
      executablePath: 'C:\\Program Files\\Canopy\\Canopy.exe',
      openWindowsSettings: jest
        .fn()
        .mockRejectedValue(new Error('settings unavailable')),
    });
    await expect(
      windowsService.apply({
        enabled: true,
        promptForWindowsSettings: true,
      }),
    ).resolves.toEqual({
      enabled: true,
      registered: false,
      platform: 'win32',
      failure: 'user-action-required',
    });
  });
});
