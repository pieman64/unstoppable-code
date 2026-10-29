import { resolvePlatformText, type PlatformText } from '../platform-text';
import { uiText } from '../ui-text';

describe('resolvePlatformText', () => {
  it('returns the platform-specific value when defined', (): void => {
    const value: PlatformText<string> = {
      default: 'default text',
      darwin: 'mac text',
      win32: 'windows text',
      linux: 'linux text',
    };

    expect(resolvePlatformText(value, 'darwin')).toBe('mac text');
    expect(resolvePlatformText(value, 'win32')).toBe('windows text');
    expect(resolvePlatformText(value, 'linux')).toBe('linux text');
  });

  it('falls back to default when the platform override is missing', (): void => {
    const value: PlatformText<string> = {
      default: 'default text',
      darwin: 'mac text',
    };

    expect(resolvePlatformText(value, 'win32')).toBe('default text');
    expect(resolvePlatformText(value, 'linux')).toBe('default text');
  });

  it('returns plain strings unchanged', (): void => {
    expect(resolvePlatformText('hello', 'darwin')).toBe('hello');
    expect(resolvePlatformText('hello', 'win32')).toBe('hello');
    expect(resolvePlatformText('hello', undefined)).toBe('hello');
  });

  it('falls back to default when platform is undefined', (): void => {
    const value: PlatformText<string> = {
      default: 'default text',
      darwin: 'mac text',
      win32: 'windows text',
    };

    expect(resolvePlatformText(value, undefined)).toBe('default text');
  });

  it('does not mutate the input', (): void => {
    const value: PlatformText<string> = {
      default: 'default text',
      darwin: 'mac text',
      win32: 'windows text',
    };
    const snapshot = JSON.stringify(value);

    resolvePlatformText(value, 'darwin');
    resolvePlatformText(value, 'win32');
    resolvePlatformText(value, undefined);

    expect(JSON.stringify(value)).toBe(snapshot);
  });

  it('supports non-string payloads', (): void => {
    const value: PlatformText<number> = {
      default: 0,
      darwin: 1,
      win32: 2,
    };

    expect(resolvePlatformText(value, 'darwin')).toBe(1);
    expect(resolvePlatformText(value, 'win32')).toBe(2);
    expect(resolvePlatformText(value, 'linux')).toBe(0);
  });
});

describe('uiText.pipelineShell.unsetDefault', () => {
  it('mentions PowerShell on Windows', (): void => {
    expect(
      resolvePlatformText(uiText.pipelineShell.unsetDefault, 'win32'),
    ).toBe('Default (PowerShell)');
  });

  it('mentions Bash on macOS', (): void => {
    expect(
      resolvePlatformText(uiText.pipelineShell.unsetDefault, 'darwin'),
    ).toBe('Default (Bash)');
  });

  it('mentions Bash on Linux', (): void => {
    expect(
      resolvePlatformText(uiText.pipelineShell.unsetDefault, 'linux'),
    ).toBe('Default (Bash)');
  });

  it('falls back to a generic label when the platform is unknown', (): void => {
    expect(
      resolvePlatformText(uiText.pipelineShell.unsetDefault, undefined),
    ).toBe('Default');
  });
});

describe('uiText.fileManager.openItem', () => {
  it('uses native file manager wording on macOS and Windows', (): void => {
    expect(resolvePlatformText(uiText.fileManager.openItem, 'darwin')).toBe(
      'Open in Finder',
    );
    expect(resolvePlatformText(uiText.fileManager.openItem, 'win32')).toBe(
      'Open in File Explorer',
    );
  });
});

describe('uiText.shellIntegration platform variants', () => {
  it('keeps macOS conflict copy specific to /usr/local/bin/canopy', (): void => {
    expect(
      resolvePlatformText(uiText.shellIntegration.foreignSymlink, 'darwin'),
    ).toContain('/usr/local/bin/canopy');
    expect(
      resolvePlatformText(uiText.shellIntegration.regularFile, 'darwin'),
    ).toContain('/usr/local/bin/canopy');
    expect(
      resolvePlatformText(
        uiText.shellIntegration.manualRemovalHelper,
        'darwin',
      ),
    ).toContain('/usr/local/bin/canopy');
    expect(
      resolvePlatformText(uiText.shellIntegration.managedPathLabel, 'darwin'),
    ).toBe('/usr/local/bin/canopy');
  });

  it('keeps Windows conflict copy specific to the user PATH entry', (): void => {
    const foreign = resolvePlatformText(
      uiText.shellIntegration.foreignSymlink,
      'win32',
    );
    const regular = resolvePlatformText(
      uiText.shellIntegration.regularFile,
      'win32',
    );
    const removal = resolvePlatformText(
      uiText.shellIntegration.manualRemovalHelper,
      'win32',
    );
    const label = resolvePlatformText(
      uiText.shellIntegration.managedPathLabel,
      'win32',
    );

    for (const text of [foreign, regular, removal, label]) {
      expect(text).toMatch(/user PATH/);
      expect(text).not.toContain('/usr/local/bin');
    }
  });
});
