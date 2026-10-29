import {
  buildCursorArtifactUrl,
  CURSOR_RUNTIME_TARGETS,
  getCursorRuntimeTarget,
} from '../lib/cursor-runtime-targets';

describe('Cursor runtime target resolution', () => {
  it('resolves both macOS architectures to the same tar.gz layout', () => {
    for (const arch of ['arm64', 'x64']) {
      const target = getCursorRuntimeTarget('darwin', arch);
      expect(target?.key).toBe(`darwin-${arch}`);
      expect(target?.archive).toBe('tar.gz');
      expect(target?.launch).toEqual(['cursor-agent']);
      expect(target?.hookRuntime).toBe('node');
      // The tarball carries mode bits, so the execute-bit check is meaningful.
      expect(target?.executables).toContain('cursor-agent');
      expect(target?.executables).toContain('node');
    }
  });

  it('resolves both Windows architectures to the zip layout that has no cursor-agent binary', () => {
    for (const arch of ['x64', 'arm64']) {
      const target = getCursorRuntimeTarget('win32', arch);
      expect(target?.key).toBe(`win32-${arch}`);
      expect(target?.archive).toBe('zip');
      // The .cmd/.ps1 wrappers only shell out to `node.exe index.js`, so
      // Canopy spawns that directly rather than going through a shell.
      expect(target?.launch).toEqual(['node.exe', 'index.js']);
      expect(target?.hookRuntime).toBe('node.exe');
      expect(target?.required).toEqual(['node.exe', 'index.js']);
      // Zip entries carry no Unix mode bits, so there is nothing to check.
      expect(target?.executables).toEqual([]);
    }
  });

  it('refuses platforms with no inspected artifact', () => {
    expect(getCursorRuntimeTarget('linux', 'x64')).toBeUndefined();
    expect(getCursorRuntimeTarget('darwin', 'ia32')).toBeUndefined();
    expect(getCursorRuntimeTarget('win32', 'ia32')).toBeUndefined();
  });

  it('builds vendor download URLs using the "windows" path segment, not "win32"', () => {
    const version = '2026.09.08-6caf4ff';
    const url = (platform: string, arch: string): string => {
      const target = getCursorRuntimeTarget(platform, arch);
      if (!target) throw new Error(`no target for ${platform}-${arch}`);
      return buildCursorArtifactUrl(target, version);
    };
    expect(url('darwin', 'arm64')).toBe(
      `https://downloads.cursor.com/lab/${version}/darwin/arm64/agent-cli-package.tar.gz`,
    );
    expect(url('win32', 'x64')).toBe(
      `https://downloads.cursor.com/lab/${version}/windows/x64/agent-cli-package.zip`,
    );
    expect(url('win32', 'arm64')).toBe(
      `https://downloads.cursor.com/lab/${version}/windows/arm64/agent-cli-package.zip`,
    );
  });

  it('exposes every supported target exactly once', () => {
    expect(CURSOR_RUNTIME_TARGETS.map((target) => target.key)).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'win32-x64',
      'win32-arm64',
    ]);
  });
});
