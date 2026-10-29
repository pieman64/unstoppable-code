import { resolveSettingsSection } from '../settings-section-resolution';

function setOllamaSupported(supported: boolean): void {
  (globalThis as Record<string, unknown>).__CANOPY_OLLAMA_ENABLED__ = supported;
}

describe('resolveSettingsSection — Ollama platform-support gate', () => {
  afterEach(() => {
    // Restore the supported default the rest of the suite assumes.
    setOllamaSupported(true);
  });

  it('keeps the ollama section on macOS when supported', () => {
    setOllamaSupported(true);
    expect(resolveSettingsSection('ollama', 'darwin')).toBe('ollama');
  });

  it('keeps the ollama section on Windows when supported', () => {
    // Windows is now a supported Ollama platform.
    setOllamaSupported(true);
    expect(resolveSettingsSection('ollama', 'win32')).toBe('ollama');
  });

  it('downgrades a requested ollama section to canopy when unsupported', () => {
    setOllamaSupported(false);
    expect(resolveSettingsSection('ollama', 'win32')).toBe('canopy');
    expect(resolveSettingsSection('ollama', 'darwin')).toBe('canopy');
    expect(resolveSettingsSection('ollama', 'linux')).toBe('canopy');
  });

  it('does not affect other sections when Ollama is unsupported', () => {
    setOllamaSupported(false);
    expect(resolveSettingsSection('git', 'win32')).toBe('git');
    expect(resolveSettingsSection('claude', 'win32')).toBe('claude');
    expect(resolveSettingsSection(undefined, 'win32')).toBe('canopy');
  });

  it('downgrades a requested Claude section when no Claude settings sections are available', () => {
    expect(
      resolveSettingsSection('claude', 'win32', {
        claudeSettingsAvailable: false,
      }),
    ).toBe('canopy');
  });
});

describe('resolveSettingsSection — Code Graph availability', () => {
  it('keeps the code-graph section when the code-graph flag is on', () => {
    expect(
      resolveSettingsSection('code-graph', 'darwin', {
        codeGraphEnabled: true,
      }),
    ).toBe('code-graph');
  });

  it('downgrades the code-graph section to canopy when the flag is off', () => {
    expect(
      resolveSettingsSection('code-graph', 'darwin', {
        codeGraphEnabled: false,
      }),
    ).toBe('canopy');
  });
});

describe('resolveSettingsSection — Experiments availability', () => {
  it('keeps the experiments section when the code-graph flag is off', () => {
    expect(
      resolveSettingsSection('experiments', 'darwin', {
        codeGraphEnabled: false,
      }),
    ).toBe('experiments');
  });

  it('keeps experiments when the flag option is absent', () => {
    expect(resolveSettingsSection('experiments', 'darwin')).toBe('experiments');
  });

  it('does not affect other sections when the code-graph flag is off', () => {
    expect(
      resolveSettingsSection('git', 'darwin', { codeGraphEnabled: false }),
    ).toBe('git');
  });
});

describe('resolveSettingsSection — Remote access availability', () => {
  it('keeps the remote-access section when remote access is available', () => {
    expect(
      resolveSettingsSection('remote-access', 'darwin', {
        remoteAccessEnabled: true,
      }),
    ).toBe('remote-access');
  });

  it('downgrades remote-access to canopy when remote access is unavailable', () => {
    expect(
      resolveSettingsSection('remote-access', 'win32', {
        remoteAccessEnabled: false,
      }),
    ).toBe('canopy');
  });

  it('does not affect other sections when remote access is unavailable', () => {
    expect(
      resolveSettingsSection('privacy', 'darwin', {
        remoteAccessEnabled: false,
      }),
    ).toBe('privacy');
  });
});

describe('resolveSettingsSection — hosted settings availability', () => {
  it('resolves notifications to canopy when hosted settings are available', () => {
    expect(
      resolveSettingsSection('notifications', 'darwin', {
        hostedSettingsAvailable: true,
      }),
    ).toBe('canopy');
  });

  it.each([false, undefined])(
    'keeps the local notifications section when hosted availability is %s',
    (hostedSettingsAvailable) => {
      expect(
        resolveSettingsSection('notifications', 'darwin', {
          hostedSettingsAvailable,
        }),
      ).toBe('notifications');
    },
  );

  it('keeps every other section when hosted settings are available', () => {
    for (const section of ['account', 'privacy', 'display'] as const) {
      expect(
        resolveSettingsSection(section, 'darwin', {
          hostedSettingsAvailable: true,
        }),
      ).toBe(section);
    }
  });
});
