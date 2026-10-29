import { EventEmitter } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { OllamaInstallProgress } from '@canopy/desktop-shared/types';

const writeOllamaConfigurationPreferenceMock = jest.fn();
const readOllamaPreferencesMock = jest.fn();
const getLoginShellPathMock = jest.fn();
const logMainProcessWarnMock = jest.fn<void, [string, unknown?]>();

class MockDownloadRequest extends EventEmitter {
  destroy = jest.fn((error?: Error): this => {
    this.emit('error', error ?? new Error('aborted'));
    this.emit('close');
    return this;
  });
}

class MockDownloadResponse extends Readable {
  statusCode = 200;
  headers: Record<string, string> = { 'content-length': '4' };
  private sent = false;

  _read(): void {
    if (this.sent) {
      return;
    }
    this.sent = true;
    this.push(Buffer.from('test'));
    this.push(null);
  }
}

class MockFailedDownloadResponse extends Readable {
  statusCode = 500;
  headers: Record<string, string> = {};

  _read(): void {
    this.push(null);
  }
}

class MockErroredDownloadResponse extends Readable {
  statusCode = 200;
  headers: Record<string, string> = { 'content-length': '4' };

  _read(): void {
    this.destroy(new Error('response failed'));
  }
}

jest.mock('../ollama/preferences', () => ({
  readOllamaPreferences: readOllamaPreferencesMock,
  writeOllamaConfigurationPreference: writeOllamaConfigurationPreferenceMock,
}));

jest.mock('../pipelines/config-paths', () => ({
  getLoginShellPath: getLoginShellPathMock,
}));

jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: logMainProcessWarnMock,
}));

async function createExecutable(
  dir: string,
  name: string,
  body: string,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, name);
  await writeFile(filePath, `#!/usr/bin/env node\n${body}\n`, 'utf8');
  await chmod(filePath, 0o755);
  return filePath;
}

function overridePlatform(platform: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });
  return () => {
    if (original) {
      Object.defineProperty(process, 'platform', original);
    }
  };
}

describe('ollama installation detection', () => {
  const originalEnv = process.env;
  let tempDir: string;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.CANOPY_OLLAMA_BINARY_PATH;
    delete process.env.OLLAMA_EXECUTABLE;
    getLoginShellPathMock.mockReturnValue('');
    tempDir = await mkdtemp(join(tmpdir(), 'ollama-installation-test-'));
  });

  afterEach(async () => {
    process.env = originalEnv;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('validates an executable that reports an Ollama version', async () => {
    const executablePath = await createExecutable(
      tempDir,
      'ollama',
      "console.log('ollama version is 0.14.0');",
    );
    const { validateOllamaExecutable } = await import('../ollama/installation');

    const status = await validateOllamaExecutable(executablePath, 'browse');

    expect(status).toMatchObject({
      ready: true,
      path: executablePath,
      version: '0.14.0',
      source: 'browse',
    });
  });

  it('rejects executables that do not identify Ollama', async () => {
    const executablePath = await createExecutable(
      tempDir,
      'not-ollama',
      "console.log('tool version 1.2.3');",
    );
    const { validateOllamaExecutable } = await import('../ollama/installation');

    const status = await validateOllamaExecutable(executablePath, 'browse');

    expect(status.ready).toBe(false);
    expect(status.error).toContain('did not report an Ollama version');
  });

  it('persists a valid brand-prefixed environment override before other candidates', async () => {
    const executablePath = await createExecutable(
      tempDir,
      'ollama-env',
      "console.log('ollama version is 0.15.1');",
    );
    process.env.CANOPY_OLLAMA_BINARY_PATH = executablePath;
    const { detectOllamaInstallation } = await import('../ollama/installation');

    const status = await detectOllamaInstallation({ force: true });

    expect(status).toMatchObject({
      ready: true,
      path: executablePath,
      version: '0.15.1',
      source: 'environment',
    });
    expect(writeOllamaConfigurationPreferenceMock).toHaveBeenCalledWith({
      executablePath,
    });
  });

  it('can defer persistence of a detected executable', async () => {
    const executablePath = await createExecutable(
      tempDir,
      'ollama-deferred',
      "console.log('ollama version is 0.15.1');",
    );
    process.env.CANOPY_OLLAMA_BINARY_PATH = executablePath;
    const { detectOllamaInstallation } = await import('../ollama/installation');

    const status = await detectOllamaInstallation({
      force: true,
      persistDetectedPath: false,
    });

    expect(status).toMatchObject({ ready: true, path: executablePath });
    expect(writeOllamaConfigurationPreferenceMock).not.toHaveBeenCalled();
  });

  it('falls back to OLLAMA_EXECUTABLE when no brand-prefixed override is set', async () => {
    const executablePath = await createExecutable(
      tempDir,
      'ollama-fallback',
      "console.log('ollama version is 0.15.2');",
    );
    process.env.OLLAMA_EXECUTABLE = executablePath;
    const { detectOllamaInstallation } = await import('../ollama/installation');

    const status = await detectOllamaInstallation({ force: true });

    expect(status).toMatchObject({
      ready: true,
      path: executablePath,
      version: '0.15.2',
      source: 'environment',
    });
  });

  it('shares in-flight detection work across concurrent callers', async () => {
    const executablePath = await createExecutable(
      tempDir,
      'ollama-slow',
      "setTimeout(() => console.log('ollama version is 0.18.0'), 50);",
    );
    process.env.CANOPY_OLLAMA_BINARY_PATH = executablePath;
    const { detectOllamaInstallation } = await import('../ollama/installation');

    const first = detectOllamaInstallation();
    const second = detectOllamaInstallation();

    expect(second).toBe(first);
    await expect(first).resolves.toMatchObject({
      ready: true,
      path: executablePath,
      version: '0.18.0',
    });
  });

  it('bounds command output captured during installer and validation commands', async () => {
    const executablePath = await createExecutable(
      tempDir,
      'verbose-tool',
      "process.stdout.write('x'.repeat(8000)); process.exit(1);",
    );
    const { execFileBounded } = await import('../ollama/installation');

    const result = await execFileBounded(executablePath, [], {
      timeoutMs: 5_000,
      allowNonZeroExit: true,
    });

    expect(result.stdout).toHaveLength(8000);
  });

  it('rejects execution failures even when non-zero exits are allowed', async () => {
    const { execFileBounded } = await import('../ollama/installation');

    await expect(
      execFileBounded(join(tempDir, 'missing-ollama'), [], {
        timeoutMs: 5_000,
        allowNonZeroExit: true,
      }),
    ).rejects.toThrow();
  });

  it('detects a macOS executable from the login-shell PATH', async () => {
    const restorePlatform = overridePlatform('darwin');
    try {
      const executablePath = await createExecutable(
        tempDir,
        'ollama',
        "console.log('ollama version is 0.16.0');",
      );
      getLoginShellPathMock.mockReturnValue(tempDir);
      const { detectOllamaInstallation } =
        await import('../ollama/installation');

      const status = await detectOllamaInstallation({ force: true });

      expect(status).toMatchObject({
        ready: true,
        path: executablePath,
        version: '0.16.0',
        source: 'auto-detected',
      });
    } finally {
      restorePlatform();
    }
  });

  it('awaits the initial login-shell PATH prewarm before Ollama startup detection', async () => {
    const source = await readFile(join(__dirname, '../index.ts'), 'utf8');
    const prewarmStart = source.indexOf(
      'const loginShellPathPrewarm = prewarmLoginShellPath()',
    );
    const prewarmAwait = source.indexOf('await loginShellPathPrewarm');
    const ollamaInitialize = source.indexOf(
      'await getOllamaService().initialize()',
    );

    expect(prewarmStart).toBeGreaterThan(-1);
    expect(prewarmStart).toBeLessThan(prewarmAwait);
    expect(prewarmAwait).toBeLessThan(ollamaInitialize);
  });

  it('includes macOS system and user Applications known-location candidates', async () => {
    const source = await readFile(
      join(__dirname, '../ollama/installation.ts'),
      'utf8',
    );

    expect(source).toContain(
      "'/Applications/Ollama.app/Contents/Resources/ollama'",
    );
    expect(source).toContain("'Applications'");
    expect(source).toContain("'Ollama.app'");
    expect(source).toContain("'/opt/homebrew/bin/ollama'");
    expect(source).toContain("'/usr/local/bin/ollama'");
  });

  it('detects a Windows executable from the official per-user location', async () => {
    const restorePlatform = overridePlatform('win32');
    try {
      process.env.PATH = '';
      process.env.LOCALAPPDATA = tempDir;
      const executablePath = await createExecutable(
        join(tempDir, 'Programs', 'Ollama'),
        'ollama.exe',
        "console.log('ollama version is 0.17.0');",
      );
      const { detectOllamaInstallation } =
        await import('../ollama/installation');

      const status = await detectOllamaInstallation({ force: true });

      expect(status).toMatchObject({
        ready: true,
        path: executablePath,
        version: '0.17.0',
        source: 'auto-detected',
      });
    } finally {
      restorePlatform();
    }
  });

  it('validates a persisted executable path before PATH candidates', async () => {
    const persistedPath = await createExecutable(
      tempDir,
      'persisted-ollama',
      "console.log('ollama version is 0.19.0');",
    );
    const pathExecutable = await createExecutable(
      join(tempDir, 'path-bin'),
      'ollama',
      "console.log('ollama version is 0.20.0');",
    );
    void pathExecutable;
    process.env.PATH = join(tempDir, 'path-bin');
    const { detectOllamaInstallation } = await import('../ollama/installation');

    const status = await detectOllamaInstallation({
      force: true,
      persistedPath,
    });

    expect(status).toMatchObject({
      ready: true,
      path: persistedPath,
      version: '0.19.0',
      source: 'persisted',
    });
  });

  it('detects a Windows executable from PATH before known locations', async () => {
    const restorePlatform = overridePlatform('win32');
    try {
      const pathExecutable = await createExecutable(
        join(tempDir, 'path-bin'),
        'ollama.exe',
        "console.log('ollama version is 0.21.0');",
      );
      process.env.PATH = join(tempDir, 'path-bin');
      process.env.LOCALAPPDATA = tempDir;
      await createExecutable(
        join(tempDir, 'Programs', 'Ollama'),
        'ollama.exe',
        "console.log('ollama version is 0.22.0');",
      );
      const { detectOllamaInstallation } =
        await import('../ollama/installation');

      const status = await detectOllamaInstallation({ force: true });

      expect(status).toMatchObject({
        ready: true,
        path: pathExecutable,
        version: '0.21.0',
        source: 'auto-detected',
      });
    } finally {
      restorePlatform();
    }
  });

  it('excludes the current directory from Windows PATH discovery', async () => {
    const restorePlatform = overridePlatform('win32');
    try {
      const { isSafeOllamaPathDirectory } =
        await import('../ollama/installation');

      expect(isSafeOllamaPathDirectory(tempDir, tempDir)).toBe(false);
      expect(isSafeOllamaPathDirectory('.', tempDir)).toBe(false);
    } finally {
      restorePlatform();
    }
  });
});

describe('ollama native installer safeguards', () => {
  const originalEnv = process.env;
  let tempDir: string;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.CANOPY_OLLAMA_BINARY_PATH;
    delete process.env.OLLAMA_EXECUTABLE;
    process.env.PATH = '';
    getLoginShellPathMock.mockReturnValue('');
    tempDir = await mkdtemp(join(tmpdir(), 'ollama-installer-test-'));
  });

  afterEach(async () => {
    jest.dontMock('node:https');
    jest.dontMock('../ollama/install-macos');
    jest.dontMock('../ollama/install-windows');
    jest.dontMock('../ollama/installation');
    process.env = originalEnv;
    await rm(tempDir, { recursive: true, force: true });
  });

  // `codesign -dv --verbose=4` output for the notarized Ollama 0.40.3 app.
  const OLLAMA_MAC_SIGNATURE = [
    'Executable=/private/tmp/extract/Ollama.app/Contents/MacOS/Ollama',
    'Identifier=com.electron.ollama',
    'Format=app bundle with Mach-O universal (x86_64 arm64)',
    'CodeDirectory v=20500 size=52095 flags=0x10000(runtime) hashes=1621+3 location=embedded',
    'Signature size=9066',
    'Authority=Developer ID Application: Infra Technologies, Inc (3MU9H2V9Y9)',
    'Authority=Developer ID Certification Authority',
    'Authority=Apple Root CA',
    'Timestamp=Oct 11, 2026 at 12:17:22 AM',
    'Notarization Ticket=stapled',
    'Info.plist entries=18',
    'TeamIdentifier=3MU9H2V9Y9',
    'Runtime Version=26.4.0',
  ].join('\n');

  it('accepts the Developer ID signature on the official macOS Ollama app', async () => {
    const { isOllamaMacSignature } = await import('../ollama/install-macos');

    expect(isOllamaMacSignature(`\n${OLLAMA_MAC_SIGNATURE}\n`)).toBe(true);
  });

  it.each([
    [
      'another Developer ID team',
      OLLAMA_MAC_SIGNATURE.replaceAll('3MU9H2V9Y9', '22QSRWWPVJ'),
    ],
    [
      'a team identifier that disagrees with the signing certificate',
      OLLAMA_MAC_SIGNATURE.replace(
        'Infra Technologies, Inc (3MU9H2V9Y9)',
        'Ollama Inc. (22QSRWWPVJ)',
      ),
    ],
    [
      'a certificate that is not a Developer ID Application certificate',
      OLLAMA_MAC_SIGNATURE.replace(
        'Developer ID Application: Infra Technologies, Inc (3MU9H2V9Y9)',
        'Apple Development: Infra Technologies, Inc (3MU9H2V9Y9)',
      ),
    ],
    [
      'an ad-hoc signature',
      [
        'Identifier=com.electron.ollama',
        'Signature=adhoc',
        'TeamIdentifier=not set',
      ].join('\n'),
    ],
    ['empty output', ''],
  ])('rejects a macOS signature from %s', async (_label, signatureText) => {
    const { isOllamaMacSignature } = await import('../ollama/install-macos');

    expect(isOllamaMacSignature(signatureText)).toBe(false);
  });

  it('macOS installer source verifies codesign, spctl, and the signer before moving into Applications', async () => {
    const source = await readFile(
      join(__dirname, '../ollama/install-macos.ts'),
      'utf8',
    );

    expect(source).toContain("'codesign'");
    expect(source).toContain("'--verify'");
    expect(source).toContain("'spctl'");
    expect(source).toContain("'--assess'");
    expect(source).toContain('isOllamaMacSignature(');
    expect(source.indexOf('await verifyCodesign(appPath)')).toBeLessThan(
      source.indexOf("isWritable('/Applications')"),
    );
    expect(source).toContain('.Ollama.app.installing-');
    expect(source).toContain('.Ollama.app.backup-');
    expect(source).toContain('rollback');
    expect(source).toContain('backed_up=0');
    expect(source).toContain('installed=0');
    expect(source).toContain('if [ "$installed" -eq 1 ]');
    expect(source).toContain('if [ "$backed_up" -eq 1 ]');
    expect(source).not.toContain('await rm(OLLAMA_APP_DESTINATION');
  });

  // Attributes of the certificate that signs OllamaSetup.exe 0.40.3, one per
  // line and CRLF-separated, which is how Windows decodes a subject name.
  const OLLAMA_WINDOWS_SUBJECT = [
    '1.3.6.1.4.1.311.60.2.1.3=CA',
    '1.3.6.1.4.1.311.60.2.1.2=Ontario',
    '2.5.4.15=Private Organization',
    'SERIALNUMBER=2713355',
    'C=CA',
    'S=Ontario',
    'L=Toronto',
    'O=Ollama Inc.',
    'CN=Ollama Inc.',
  ].join('\r\n');

  function windowsSignatureReport(status: string, subject: string): string {
    return `${JSON.stringify({ status, subject })}\r\n`;
  }

  type ExecFileBoundedMock = jest.Mock<
    Promise<{ stdout: string; stderr: string; exitCode: number | null }>,
    [string, string[], { timeoutMs: number }]
  >;

  function mockExecFileBounded(signatureReport: string): ExecFileBoundedMock {
    const execFileBoundedMock: ExecFileBoundedMock = jest.fn((file) =>
      Promise.resolve({
        stdout: file === 'powershell.exe' ? signatureReport : '',
        stderr: '',
        exitCode: 0,
      }),
    );
    jest.doMock('../ollama/installation', () => ({
      execFileBounded: execFileBoundedMock,
    }));
    return execFileBoundedMock;
  }

  it.each([
    ['CRLF-separated', OLLAMA_WINDOWS_SUBJECT],
    ['LF-separated', OLLAMA_WINDOWS_SUBJECT.replaceAll('\r\n', '\n')],
  ])(
    'accepts a valid Windows signature with a %s Ollama Inc. subject',
    async (_label, subject) => {
      const { isOllamaWindowsSignature } =
        await import('../ollama/install-windows');

      expect(
        isOllamaWindowsSignature(windowsSignatureReport('Valid', subject)),
      ).toBe(true);
    },
  );

  it.each([
    [
      'a signature that is not valid',
      windowsSignatureReport('HashMismatch', OLLAMA_WINDOWS_SUBJECT),
    ],
    [
      'another organization',
      windowsSignatureReport(
        'Valid',
        OLLAMA_WINDOWS_SUBJECT.replace('O=Ollama Inc.', 'O=Other Inc.'),
      ),
    ],
    [
      'an organization that only starts with the Ollama name',
      windowsSignatureReport(
        'Valid',
        OLLAMA_WINDOWS_SUBJECT.replace('O=Ollama Inc.', 'O=Ollama Inc. Ltd'),
      ),
    ],
    [
      'a subject with no organization',
      windowsSignatureReport('Valid', 'CN=Ollama Inc.'),
    ],
    ['a report without a subject', '{"status":"Valid"}'],
    ['output that is not a report', 'Get-AuthenticodeSignature : failed'],
    ['empty output', ''],
  ])('rejects a Windows installer with %s', async (_label, report) => {
    const { isOllamaWindowsSignature } =
      await import('../ollama/install-windows');

    expect(isOllamaWindowsSignature(report)).toBe(false);
  });

  it('runs the Windows installer only after its Authenticode signer is verified', async () => {
    const execFileBoundedMock = mockExecFileBounded(
      windowsSignatureReport('Valid', OLLAMA_WINDOWS_SUBJECT),
    );
    const { installWindowsOllamaPackage } =
      await import('../ollama/install-windows');
    const installerPath = join(tempDir, "Ollama's Setup.exe");
    const onVerified = jest.fn(() => {
      expect(execFileBoundedMock).toHaveBeenCalledTimes(1);
    });

    await installWindowsOllamaPackage(installerPath, onVerified);

    expect(onVerified).toHaveBeenCalledTimes(1);
    expect(execFileBoundedMock.mock.calls.map(([file]) => file)).toEqual([
      'powershell.exe',
      installerPath,
    ]);
    const script = execFileBoundedMock.mock.calls[0]?.[1].at(-1);
    expect(script).toContain(
      `Get-AuthenticodeSignature -LiteralPath '${installerPath.replace("'", "''")}'`,
    );
    expect(execFileBoundedMock.mock.calls[1]?.[1]).toEqual([
      '/VERYSILENT',
      '/NORESTART',
      '/SUPPRESSMSGBOXES',
    ]);
  });

  it('does not run a Windows installer whose signer is not Ollama Inc.', async () => {
    const execFileBoundedMock = mockExecFileBounded(
      windowsSignatureReport(
        'Valid',
        OLLAMA_WINDOWS_SUBJECT.replace('O=Ollama Inc.', 'O=Other Inc.'),
      ),
    );
    const { installWindowsOllamaPackage } =
      await import('../ollama/install-windows');
    const onVerified = jest.fn();

    await expect(
      installWindowsOllamaPackage(join(tempDir, 'OllamaSetup.exe'), onVerified),
    ).rejects.toThrow('valid Authenticode signature from Ollama Inc.');

    expect(onVerified).not.toHaveBeenCalled();
    expect(execFileBoundedMock.mock.calls.map(([file]) => file)).toEqual([
      'powershell.exe',
    ]);
  });

  it('installer sources configure download and installer timeouts for failure bounding', async () => {
    const installationSource = await readFile(
      join(__dirname, '../ollama/installation.ts'),
      'utf8',
    );
    const windowsInstallerSource = await readFile(
      join(__dirname, '../ollama/install-windows.ts'),
      'utf8',
    );

    expect(installationSource).toContain(
      'const DOWNLOAD_TIMEOUT_MS = 30 * 60_000',
    );
    expect(installationSource).toContain(
      'deadlineMs = Date.now() + DOWNLOAD_TIMEOUT_MS',
    );
    expect(installationSource).toContain(
      'const remainingMs = deadlineMs - Date.now()',
    );
    expect(installationSource).toContain('deadlineTimer = setTimeout');
    expect(installationSource).toMatch(/redirectCount \+ 1,\s+deadlineMs/);
    expect(installationSource).not.toContain('request.setTimeout(');
    expect(windowsInstallerSource).toContain(
      'const WINDOWS_INSTALL_TIMEOUT_MS = 10 * 60_000',
    );
    expect(windowsInstallerSource).toContain(
      'timeoutMs: WINDOWS_INSTALL_TIMEOUT_MS',
    );
    expect(installationSource).toContain('MAX_DOWNLOAD_REDIRECTS = 5');
    expect(installationSource).toContain("parsedUrl.protocol !== 'https:'");
  });

  it('rejects concurrent install calls while the first download is in flight and cleanup aborts it', async () => {
    const restorePlatform = overridePlatform('win32');
    const request = new MockDownloadRequest();
    const getMock = jest.fn(() => request);
    jest.doMock('node:https', () => ({ get: getMock }));
    readOllamaPreferencesMock.mockResolvedValue({ executablePath: '' });
    process.env.LOCALAPPDATA = '';
    process.env.ProgramFiles = '';
    process.env['ProgramFiles(x86)'] = '';
    try {
      const { cleanupOllamaInstallationWork, installOllama } =
        await import('../ollama/installation');

      const first = installOllama();
      await expect(installOllama()).rejects.toThrow(/already running/i);

      while (getMock.mock.calls.length === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      await cleanupOllamaInstallationWork();
      await expect(first).resolves.toMatchObject({
        ready: false,
        error: 'Ollama installation cleanup requested.',
      });
      expect(request.destroy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Ollama installation cleanup requested.',
        }),
      );
    } finally {
      restorePlatform();
    }
  });

  it('destroys non-success download responses before reporting failure', async () => {
    const restorePlatform = overridePlatform('win32');
    const request = new MockDownloadRequest();
    const response = new MockFailedDownloadResponse();
    const destroySpy = jest.spyOn(response, 'destroy');
    const getMock = jest.fn(
      (_url: string, callback: (value: MockFailedDownloadResponse) => void) => {
        setImmediate(() => {
          callback(response);
          request.emit('close');
        });
        return request;
      },
    );
    jest.doMock('node:https', () => ({ get: getMock }));
    readOllamaPreferencesMock.mockResolvedValue({ executablePath: '' });
    process.env.LOCALAPPDATA = '';
    process.env.ProgramFiles = '';
    process.env['ProgramFiles(x86)'] = '';
    try {
      const { installOllama } = await import('../ollama/installation');

      await expect(installOllama()).resolves.toMatchObject({
        ready: false,
      });
      expect(destroySpy).toHaveBeenCalled();
    } finally {
      restorePlatform();
    }
  });

  it('settles response and destination streams before cleaning up a failed download', async () => {
    const restorePlatform = overridePlatform('win32');
    const request = new MockDownloadRequest();
    const response = new MockErroredDownloadResponse();
    const getMock = jest.fn(
      (
        _url: string,
        callback: (value: MockErroredDownloadResponse) => void,
      ) => {
        setImmediate(() => {
          callback(response);
          request.emit('close');
        });
        return request;
      },
    );
    jest.doMock('node:https', () => ({ get: getMock }));
    readOllamaPreferencesMock.mockResolvedValue({ executablePath: '' });
    process.env.LOCALAPPDATA = '';
    process.env.ProgramFiles = '';
    process.env['ProgramFiles(x86)'] = '';
    try {
      const { installOllama } = await import('../ollama/installation');

      await expect(installOllama()).resolves.toMatchObject({
        ready: false,
      });
      expect(response.destroyed).toBe(true);
    } finally {
      restorePlatform();
    }
  });

  it('runs post-install detection with the installed Windows executable and removes temporary downloads on success', async () => {
    const restorePlatform = overridePlatform('win32');
    process.env.LOCALAPPDATA = tempDir;
    process.env.ProgramFiles = '';
    process.env['ProgramFiles(x86)'] = '';
    const installedExecutablePath = join(
      tempDir,
      'Programs',
      'Ollama',
      'ollama.exe',
    );
    const request = new MockDownloadRequest();
    const getMock = jest.fn(
      (_url: string, callback: (response: MockDownloadResponse) => void) => {
        const response = new MockDownloadResponse();
        setImmediate(() => {
          callback(response);
          request.emit('close');
        });
        return request;
      },
    );
    const installWindowsOllamaPackageMock = jest.fn(
      async (_downloadPath: string, onVerified?: () => void) => {
        onVerified?.();
        await createExecutable(
          join(tempDir, 'Programs', 'Ollama'),
          'ollama.exe',
          "console.log('ollama version is 0.23.0');",
        );
      },
    );
    jest.doMock('node:https', () => ({ get: getMock }));
    jest.doMock('../ollama/install-windows', () => ({
      installWindowsOllamaPackage: installWindowsOllamaPackageMock,
    }));
    readOllamaPreferencesMock.mockResolvedValue({ executablePath: '' });
    try {
      const { installOllama } = await import('../ollama/installation');

      const status = await installOllama();

      expect(status).toMatchObject({
        ready: true,
        path: installedExecutablePath,
        version: '0.23.0',
        source: 'installed',
      });
      expect(writeOllamaConfigurationPreferenceMock).toHaveBeenCalledWith({
        executablePath: installedExecutablePath,
      });
      expect(installWindowsOllamaPackageMock).toHaveBeenCalledWith(
        expect.stringMatching(/OllamaSetup\.exe$/),
        expect.any(Function),
      );
      const downloadPath = installWindowsOllamaPackageMock.mock.calls[0]?.[0];
      if (!downloadPath) {
        throw new Error('Expected the installer download path');
      }
      await expect(readFile(downloadPath)).rejects.toThrow();
    } finally {
      restorePlatform();
    }
  });

  it('sanitizes renderer-visible installer failures that include temp paths or command output', async () => {
    const restorePlatform = overridePlatform('win32');
    process.env.LOCALAPPDATA = '';
    process.env.ProgramFiles = '';
    process.env['ProgramFiles(x86)'] = '';
    const request = new MockDownloadRequest();
    const getMock = jest.fn(
      (_url: string, callback: (response: MockDownloadResponse) => void) => {
        const response = new MockDownloadResponse();
        setImmediate(() => {
          callback(response);
          request.emit('close');
        });
        return request;
      },
    );
    const installWindowsOllamaPackageMock = jest.fn((downloadPath: string) =>
      Promise.reject(
        new Error(
          `installer failed for ${downloadPath}\n${'raw output '.repeat(40)}`,
        ),
      ),
    );
    jest.doMock('node:https', () => ({ get: getMock }));
    jest.doMock('../ollama/install-windows', () => ({
      installWindowsOllamaPackage: installWindowsOllamaPackageMock,
    }));
    readOllamaPreferencesMock.mockResolvedValue({ executablePath: '' });
    const onProgress = jest.fn<void, [OllamaInstallProgress]>();
    try {
      const { installOllama } = await import('../ollama/installation');

      const status = await installOllama(onProgress);

      expect(status).toMatchObject({
        ready: false,
        error:
          'Ollama installation could not be completed. Try again or install Ollama manually.',
      });
      expect(logMainProcessWarnMock).toHaveBeenCalledTimes(1);
      const [logMessage, logContext] =
        logMainProcessWarnMock.mock.calls[0] ?? [];
      expect(logMessage).toBe('Ollama installation failed');
      expect(logContext).toMatchObject({ phase: 'verifying' });
      expect(JSON.stringify(logContext)).toContain('installer failed for ');
      const failureProgress = onProgress.mock.calls
        .map(([progress]) => progress)
        .find(
          (
            progress,
          ): progress is {
            phase: 'failure';
            error: string;
          } =>
            typeof progress === 'object' &&
            progress !== null &&
            'phase' in progress &&
            progress.phase === 'failure' &&
            'error' in progress &&
            typeof progress.error === 'string',
        );
      expect(failureProgress).toBeDefined();
      expect(failureProgress).toMatchObject({
        error:
          'Ollama installation could not be completed. Try again or install Ollama manually.',
      });
      expect(failureProgress?.error).not.toContain(tempDir);
      expect(failureProgress?.error).not.toContain('raw output');
    } finally {
      restorePlatform();
    }
  });
});
