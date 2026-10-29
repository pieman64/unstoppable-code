import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { c } from 'tar';
import { CopilotRuntimeInstaller } from '../copilot/runtime-installer';

describe('managed Copilot runtime installation', () => {
  let root: string;
  let archive: Buffer;
  const binary = '#!/bin/sh\nprintf fixture\n';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'copilot-install-test-'));
    await mkdir(join(root, 'package'));
    await writeFile(join(root, 'package/copilot'), binary, { mode: 0o700 });
    await writeFile(
      join(root, 'package/install.js'),
      'throw Error("must not execute")',
    );
    await c({ cwd: root, file: join(root, 'archive.tgz'), gzip: true }, [
      'package',
    ]);
    archive = await readFile(join(root, 'archive.tgz'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function installer(integrity?: string): CopilotRuntimeInstaller {
    return new CopilotRuntimeInstaller({
      root: join(root, 'managed'),
      executableName: 'copilot',
      artifact: {
        version: '1.2.3',
        url: 'https://registry.npmjs.org/fixture.tgz',
        archiveBytes: archive.length,
        integrity:
          integrity ??
          `sha512-${createHash('sha512').update(archive).digest('base64')}`,
        executableSha256: createHash('sha256').update(binary).digest('hex'),
      },
      fetchArchive: jest.fn(() =>
        Promise.resolve(new Response(Uint8Array.from(archive))),
      ),
    });
  }

  it('installs only the verified native executable and detects later tampering', async () => {
    const runtime = installer();
    const signal = new AbortController().signal;
    const executable = await runtime.install(signal, () => undefined);
    expect(await readFile(executable, 'utf8')).toBe(binary);
    await expect(
      readFile(join(runtime.directory, 'install.js')),
    ).rejects.toThrow();
    await expect(runtime.verify(signal)).resolves.toBe(executable);
    await writeFile(executable, 'changed');
    await expect(runtime.verify(signal)).rejects.toThrow('verification failed');
    await runtime.install(signal, () => undefined);
    expect(await readFile(executable, 'utf8')).toBe(binary);
  });

  it('does not publish a corrupt archive', async () => {
    const runtime = installer(`sha512-${Buffer.alloc(64).toString('base64')}`);
    await expect(
      runtime.install(new AbortController().signal, () => undefined),
    ).rejects.toThrow('checksum');
    expect(await runtime.isInstalled()).toBe(false);
  });

  it.each([false, true])(
    'prunes obsolete versions and interrupted installs (already installed: %s)',
    async (installed) => {
      const runtime = installer();
      const signal = new AbortController().signal;
      if (installed) await runtime.install(signal, () => undefined);
      for (const name of [
        '0.9.0',
        '.install-abandoned',
        '.previous-abandoned',
      ]) {
        await mkdir(join(root, 'managed', name), { recursive: true });
        await writeFile(join(root, 'managed', name, 'old'), 'obsolete');
      }
      await runtime.install(signal, () => undefined);
      expect(await readdir(join(root, 'managed'))).toEqual(['1.2.3']);
    },
  );

  it('refuses a native symlink even when the archive checksum matches', async () => {
    await rm(join(root, 'package/copilot'));
    await symlink(
      join(root, 'package/install.js'),
      join(root, 'package/copilot'),
    );
    await c({ cwd: root, file: join(root, 'archive.tgz'), gzip: true }, [
      'package',
    ]);
    archive = await readFile(join(root, 'archive.tgz'));
    await expect(
      installer().install(new AbortController().signal, () => undefined),
    ).rejects.toThrow('archive entry');
  });

  it('keeps a cancelled installation unavailable', async () => {
    const controller = new AbortController();
    const runtime = installer();
    await expect(
      runtime.install(controller.signal, () => controller.abort()),
    ).rejects.toThrow();
    expect(await runtime.isInstalled()).toBe(false);
  });
});
