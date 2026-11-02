import { hasHostAbsolutePath } from '@canopy/protocol/canopy-core/core';
import {
  normalizeW5HostPath,
  projectW5HostPathFingerprint,
  W5HostPathProjectionError,
} from '../host-path-fingerprint';

describe('projectW5HostPathFingerprint', () => {
  it('pins the token, so retry identities survive restarts and upgrades', () => {
    expect(
      projectW5HostPathFingerprint('/Users/alex/projects/acme/', 'posix'),
    ).toBe(
      'host-path:v1:sha256:5d7f6b360533aef3811ad25d0530393df1d887ff5c4f34114af47cea254bf50c',
    );
    expect(projectW5HostPathFingerprint('c:/Users/alex/acme', 'win32')).toBe(
      'host-path:v1:sha256:4fa369e7184a30210665aa2cec99f5a67131905b8b855c22ec06f05fc43fa440',
    );
  });

  it.each([
    ['/Users/alex/acme', '/Users/alex/acme'],
    ['/Users/alex/acme/', '/Users/alex/acme'],
    ['/Users//alex/./acme//', '/Users/alex/acme'],
    ['/Users/alex/tmp/../acme', '/Users/alex/tmp/../acme'],
    ['/Users/alex/tmp/../acme/.', '/Users/alex/tmp/../acme'],
    ['//Users/alex/acme', '/Users/alex/acme'],
    ['/', '/'],
    ['///', '/'],
  ])('normalizes the posix spelling %j', (path, normalized) => {
    expect(normalizeW5HostPath(path, 'posix')).toBe(normalized);
    expect(projectW5HostPathFingerprint(path, 'posix')).toBe(
      projectW5HostPathFingerprint(normalized, 'posix'),
    );
  });

  it.each([
    ['C:\\Users\\alex\\acme', 'C:\\Users\\alex\\acme'],
    ['c:\\Users\\alex\\acme\\', 'C:\\Users\\alex\\acme'],
    ['C:/Users/alex/./acme/', 'C:\\Users\\alex\\acme'],
    ['C:\\Users\\alex\\tmp\\..\\acme', 'C:\\Users\\alex\\acme'],
    ['C:\\', 'C:\\'],
    ['c:/', 'C:\\'],
    ['\\\\server\\share\\acme\\', '\\\\server\\share\\acme'],
    ['//server/share/acme', '\\\\server\\share\\acme'],
    ['\\\\server\\share', '\\\\server\\share\\'],
  ])('normalizes the win32 spelling %j', (path, normalized) => {
    expect(normalizeW5HostPath(path, 'win32')).toBe(normalized);
    expect(projectW5HostPathFingerprint(path, 'win32')).toBe(
      projectW5HostPathFingerprint(normalized, 'win32'),
    );
  });

  it('keeps distinct folders, cases and flavors distinct', () => {
    const tokens = [
      projectW5HostPathFingerprint('/Users/alex/acme', 'posix'),
      projectW5HostPathFingerprint('/Users/alex/Acme', 'posix'),
      projectW5HostPathFingerprint('/Users/alex/acme2', 'posix'),
      projectW5HostPathFingerprint('/Users/alex', 'posix'),
      projectW5HostPathFingerprint('C:\\Users\\alex\\acme', 'win32'),
      projectW5HostPathFingerprint('C:\\Users\\alex\\Acme', 'win32'),
      projectW5HostPathFingerprint('D:\\Users\\alex\\acme', 'win32'),
      // Only the drive letter folds; a posix path with backslashes is one name.
      projectW5HostPathFingerprint('/Users/alex\\acme', 'posix'),
    ];
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('never equates a posix `..` spelling with another folder', () => {
    // The kernel resolves `link/..` from the symlink's target, so
    // `/Users/alex/link/../acme` can be a different folder than
    // `/Users/alex/acme`; only a refused retry is safe.
    expect(
      projectW5HostPathFingerprint('/Users/alex/link/../acme', 'posix'),
    ).not.toBe(projectW5HostPathFingerprint('/Users/alex/acme', 'posix'));
    expect(projectW5HostPathFingerprint('/../acme', 'posix')).not.toBe(
      projectW5HostPathFingerprint('/acme', 'posix'),
    );
  });

  it('is a path-free token', () => {
    for (const [path, flavor] of [
      ['/Users/alex/acme', 'posix'],
      ['C:\\Users\\alex\\acme', 'win32'],
      ['\\\\server\\share\\acme', 'win32'],
    ] as const) {
      const token = projectW5HostPathFingerprint(path, flavor);
      expect(token).toMatch(/^host-path:v1:sha256:[0-9a-f]{64}$/);
      expect(hasHostAbsolutePath(token)).toBe(false);
      expect(token).not.toContain('alex');
    }
  });

  it.each([
    ['', 'posix'],
    ['Users/alex/acme', 'posix'],
    ['./acme', 'posix'],
    ['~/acme', 'posix'],
    ['C:\\acme', 'posix'],
    ['/Users/alex\0/acme', 'posix'],
    ['', 'win32'],
    ['acme', 'win32'],
    ['C:acme', 'win32'],
    ['\\acme', 'win32'],
    ['/acme', 'win32'],
    ['\\\\server', 'win32'],
    ['C:\\acme\0', 'win32'],
    // Device and verbatim namespaces: Windows does not normalize them.
    ['\\\\?\\C:\\acme\\..\\other', 'win32'],
    ['//?/C:/acme', 'win32'],
    ['\\\\?\\UNC\\server\\share\\acme', 'win32'],
    ['\\\\.\\C:\\acme', 'win32'],
    ['\\\\.\\pipe\\acme', 'win32'],
  ] as const)('refuses the unprojected path %j (%s)', (path, flavor) => {
    expect(() => projectW5HostPathFingerprint(path, flavor)).toThrow(
      W5HostPathProjectionError,
    );
    expect(() => projectW5HostPathFingerprint(path, flavor)).toThrow(
      `A trusted ${flavor} host path must be an ordinary absolute path.`,
    );
  });
});
