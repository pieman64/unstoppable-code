import * as os from 'node:os';
import * as path from 'node:path';
import { getCodexMcpBrokerRuntimeDir } from '../mcp-runtime-dir';

describe('getCodexMcpBrokerRuntimeDir', () => {
  const originalDataDir = process.env.CANOPY_DATA_DIR;
  const originalCodexHome = process.env.CODEX_HOME;
  const originalHome = process.env.HOME;

  afterEach(() => {
    if (originalDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalDataDir;
    }
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  it('is stable across parent and sanitized app-server child environments', () => {
    process.env.CANOPY_DATA_DIR = path.join(os.tmpdir(), 'canopy-data-a');
    process.env.CODEX_HOME = path.join(os.tmpdir(), 'codex-home-a');
    process.env.HOME = path.join(os.tmpdir(), 'synthetic-home-a');
    const withOverride = getCodexMcpBrokerRuntimeDir();

    delete process.env.CANOPY_DATA_DIR;
    delete process.env.CODEX_HOME;
    delete process.env.HOME;
    const withoutOverride = getCodexMcpBrokerRuntimeDir();

    expect(withOverride).toBe(withoutOverride);
    expect(path.dirname(withOverride)).toBe(os.tmpdir());
    expect(withOverride).not.toContain('canopy-data-a');
    expect(withOverride).not.toContain('codex-home-a');
    expect(withOverride).not.toContain('synthetic-home-a');
  });
});
