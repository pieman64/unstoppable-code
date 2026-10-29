import { resolveSettingsSection } from '../settings-section-resolution';

describe('resolveSettingsSection', () => {
  it('returns the requested section on macOS', () => {
    expect(resolveSettingsSection('dictation', 'darwin')).toBe('dictation');
    expect(resolveSettingsSection('canopy', 'darwin')).toBe('canopy');
  });

  it('falls back to canopy when dictation is requested on Windows', () => {
    expect(resolveSettingsSection('dictation', 'win32')).toBe('canopy');
  });

  it('falls back to canopy when dictation is requested on Linux', () => {
    expect(resolveSettingsSection('dictation', 'linux')).toBe('canopy');
  });

  it('keeps non-dictation sections untouched on every platform', () => {
    expect(resolveSettingsSection('display', 'win32')).toBe('display');
    expect(resolveSettingsSection('display', 'linux')).toBe('display');
    expect(resolveSettingsSection('chat', 'win32')).toBe('chat');
  });

  it('defaults to canopy when no section is requested', () => {
    expect(resolveSettingsSection(undefined, 'darwin')).toBe('canopy');
    expect(resolveSettingsSection(undefined, 'win32')).toBe('canopy');
  });

  it('migrates the legacy pipeline-advisor section key to app-advisor', () => {
    expect(resolveSettingsSection('pipeline-advisor', 'darwin')).toBe(
      'app-advisor',
    );
    expect(resolveSettingsSection('pipeline-advisor', 'linux')).toBe(
      'app-advisor',
    );
    expect(resolveSettingsSection('pipeline-advisor', 'win32')).toBe(
      'app-advisor',
    );
  });

  it('returns the new app-advisor section untouched', () => {
    expect(resolveSettingsSection('app-advisor', 'darwin')).toBe('app-advisor');
  });

  it('resolves the environment section to Settings → Environments', () => {
    expect(resolveSettingsSection('environment', 'darwin')).toBe('environment');
    expect(resolveSettingsSection('environment', 'win32')).toBe('environment');
    expect(resolveSettingsSection('environment', 'linux')).toBe('environment');
  });
});

describe('resolveSettingsSection — Ollama across platforms', () => {
  function setOllamaSupported(supported: boolean): void {
    (globalThis as Record<string, unknown>).__CANOPY_OLLAMA_ENABLED__ =
      supported;
  }

  afterEach(() => {
    // Restore the supported default the rest of the suite assumes.
    setOllamaSupported(true);
  });

  it('keeps the ollama section on macOS and Windows when supported', () => {
    setOllamaSupported(true);
    // Windows is treated as a supported Ollama platform.
    expect(resolveSettingsSection('ollama', 'darwin')).toBe('ollama');
    expect(resolveSettingsSection('ollama', 'win32')).toBe('ollama');
  });

  it('downgrades ollama to canopy on unsupported desktop platforms', () => {
    setOllamaSupported(false);
    expect(resolveSettingsSection('ollama', 'darwin')).toBe('canopy');
    expect(resolveSettingsSection('ollama', 'win32')).toBe('canopy');
    expect(resolveSettingsSection('ollama', 'linux')).toBe('canopy');
  });
});
