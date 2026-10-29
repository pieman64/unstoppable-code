import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cursorRuntimeInstalled } from '../runtime-status';
import { CURSOR_RUNTIME_VERSION } from '../runtime-metadata';

describe('cursorRuntimeInstalled', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cursor-runtime-status-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reports unsupported on a host with no pinned target', async () => {
    await expect(
      cursorRuntimeInstalled({ root, platform: 'linux', arch: 'x64' }),
    ).resolves.toEqual({
      supported: false,
      installed: false,
      version: CURSOR_RUNTIME_VERSION,
    });
  });

  it('reports installed only when every required file is a regular executable file', async () => {
    const dir = join(root, CURSOR_RUNTIME_VERSION);
    await mkdir(dir, { recursive: true });
    await expect(
      cursorRuntimeInstalled({ root, platform: 'darwin', arch: 'arm64' }),
    ).resolves.toMatchObject({ supported: true, installed: false });
    await writeFile(join(dir, 'cursor-agent'), '#!/bin/sh\n', { mode: 0o755 });
    await writeFile(join(dir, 'node'), '#!/bin/sh\n', { mode: 0o755 });
    await expect(
      cursorRuntimeInstalled({ root, platform: 'darwin', arch: 'arm64' }),
    ).resolves.toMatchObject({ supported: true, installed: true });
    await chmod(join(dir, 'cursor-agent'), 0o644);
    await expect(
      cursorRuntimeInstalled({ root, platform: 'darwin', arch: 'arm64' }),
    ).resolves.toMatchObject({ supported: true, installed: false });
  });
});
