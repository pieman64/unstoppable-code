import { advertiseWindowsDefaultBrowserCapabilities } from '../browser/windows-default-browser-capabilities';

describe('advertiseWindowsDefaultBrowserCapabilities', () => {
  it('advertises a ZIP executable without claiming the HTTP(S) association', async () => {
    const run = jest
      .fn<Promise<void>, [string[]]>()
      .mockResolvedValue(undefined);

    await advertiseWindowsDefaultBrowserCapabilities(
      {
        appId: 'com.canopy.ui',
        appName: 'Canopy',
        description: 'Agentic development environment',
        executablePath: 'C:\\Portable\\Canopy.exe',
      },
      run,
    );

    expect(run).toHaveBeenCalledWith([
      'ADD',
      'HKCU\\Software\\RegisteredApplications',
      '/v',
      'com.canopy.ui',
      '/d',
      'Software\\Clients\\StartMenuInternet\\com.canopy.ui\\Capabilities',
      '/f',
    ]);
    expect(run).toHaveBeenCalledWith([
      'ADD',
      'HKCU\\Software\\Clients\\StartMenuInternet\\com.canopy.ui\\Capabilities\\URLAssociations',
      '/v',
      'http',
      '/d',
      'com.canopy.ui.URL',
      '/f',
    ]);
    expect(run).toHaveBeenCalledWith([
      'ADD',
      'HKCU\\Software\\Classes\\com.canopy.ui.URL\\shell\\open\\command',
      '/ve',
      '/d',
      '"C:\\Portable\\Canopy.exe" "%1"',
      '/f',
    ]);
    expect(run.mock.calls.flatMap(([args]) => args)).not.toContain('http=');
  });
});
