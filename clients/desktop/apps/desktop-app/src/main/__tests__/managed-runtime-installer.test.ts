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
import { ZipFile } from 'yazl';
import { ManagedRuntimeInstaller } from '../lib/managed-runtime-installer';

const binary = '#!/bin/sh\nprintf fixture\n';
const artifact = {
  version: '1.2.3',
  url: 'https://registry.npmjs.org/fixture.tgz',
  archiveBytes: 1,
  integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
  executableSha256: createHash('sha256').update(binary).digest('hex'),
};

it.each([
  '.',
  '..',
  '../outside',
  '1/../../outside',
  '1\\outside',
  '1:stream',
  '1.2.3.',
])(
  'rejects a version that is not a safe directory component: %s',
  (version) => {
    expect(
      () =>
        new ManagedRuntimeInstaller({
          root: '/managed',
          artifact: { ...artifact, version },
          executableName: 'agent',
          label: 'Fixture',
        }),
    ).toThrow('runtime version');
  },
);

it.each([
  '',
  '.',
  '..',
  '../outside',
  '/outside',
  'bin/agent',
  'bin\\agent',
  'C:outside',
  'agent:stream',
  'agent.',
  'NUL',
  'con.exe',
])(
  'rejects an unsafe executable name before installation or verification: %s',
  (executableName) => {
    expect(
      () =>
        new ManagedRuntimeInstaller({
          root: '/managed',
          artifact,
          executableName,
          label: 'Fixture',
        }),
    ).toThrow('executable name');
  },
);

describe('managed runtime custom archive layout', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-layout-'));
    await mkdir(join(root, 'payload/bin'), { recursive: true });
    await writeFile(join(root, 'payload/bin/entry'), binary, { mode: 0o700 });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function installer(
    archivePath = 'payload/bin/entry',
  ): Promise<ManagedRuntimeInstaller> {
    await c({ cwd: root, file: join(root, 'archive.tgz'), gzip: true }, [
      'payload',
    ]);
    const archive = await readFile(join(root, 'archive.tgz'));
    return new ManagedRuntimeInstaller({
      root: join(root, 'managed'),
      label: 'Fixture',
      executableName: 'agent',
      archivePath,
      artifact: {
        ...artifact,
        archiveBytes: archive.length,
        integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
      },
      fetchArchive: jest.fn(() =>
        Promise.resolve(new Response(Uint8Array.from(archive))),
      ),
    });
  }

  it('installs and verifies the selected regular file under the destination name', async () => {
    const runtime = await installer();
    const signal = new AbortController().signal;
    const executable = await runtime.install(signal, () => undefined);
    expect(executable).toBe(join(root, 'managed/1.2.3/agent'));
    expect(await readFile(executable, 'utf8')).toBe(binary);
    expect(await readdir(runtime.directory)).toEqual(['agent']);
    await expect(runtime.verify(signal)).resolves.toBe(executable);
  });

  it('does not publish a runtime when the selected custom entry is missing', async () => {
    const runtime = await installer('payload/bin/missing');
    await expect(
      runtime.install(new AbortController().signal, () => undefined),
    ).rejects.toThrow('did not contain');
    expect(await runtime.isInstalled()).toBe(false);
    expect(await readdir(join(root, 'managed'))).toEqual([]);
  });

  it('rejects a selected link even when archive integrity matches', async () => {
    await rm(join(root, 'payload/bin/entry'));
    await writeFile(join(root, 'payload/actual'), binary);
    await symlink('../actual', join(root, 'payload/bin/entry'));
    const runtime = await installer();
    await expect(
      runtime.install(new AbortController().signal, () => undefined),
    ).rejects.toThrow('archive entry');
    expect(await runtime.isInstalled()).toBe(false);
    expect(await readdir(join(root, 'managed'))).toEqual([]);
  });
});

describe('managed runtime from a GitHub release', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-release-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const RELEASE_URL =
    'https://github.com/owner/tool/releases/download/v1.2.3/tool.tgz';
  const ASSET_URL =
    'https://release-assets.githubusercontent.com/github-production-release-asset/1/asset';

  async function tarball(): Promise<Buffer> {
    await writeFile(join(root, 'tool'), binary, { mode: 0o700 });
    await c({ cwd: root, file: join(root, 'archive.tgz'), gzip: true }, [
      'tool',
    ]);
    return readFile(join(root, 'archive.tgz'));
  }

  function zipball(name: string, mode?: number): Promise<Buffer> {
    const zip = new ZipFile();
    zip.addBuffer(
      Buffer.from(binary),
      name,
      mode === undefined ? {} : { mode },
    );
    zip.addBuffer(Buffer.from('notes'), 'README.md');
    zip.end();
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
      zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
      zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
      zip.outputStream.on('error', reject);
    });
  }

  function release(
    archive: Buffer,
    options: {
      archiveFormat?: 'tgz' | 'zip';
      executableName?: string;
      archivePath?: string;
      fetchArchive: typeof fetch;
    },
  ): ManagedRuntimeInstaller {
    return new ManagedRuntimeInstaller({
      root: join(root, 'managed'),
      label: 'Fixture',
      executableName: options.executableName ?? 'agent',
      archivePath: options.archivePath ?? 'tool',
      archiveFormat: options.archiveFormat ?? 'tgz',
      source: 'github-release',
      artifact: {
        ...artifact,
        url: RELEASE_URL,
        archiveBytes: archive.length,
        integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
      },
      fetchArchive: options.fetchArchive,
    });
  }

  function urlOf(input: Parameters<typeof fetch>[0]): string {
    if (typeof input === 'string') return input;
    return input instanceof URL ? input.href : input.url;
  }

  function redirectingFetch(
    archive: Buffer,
    location = ASSET_URL,
  ): jest.Mock<Promise<Response>, Parameters<typeof fetch>> {
    return jest.fn((input: Parameters<typeof fetch>[0]) => {
      const url = urlOf(input);
      if (url === RELEASE_URL) {
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location } }),
        );
      }
      return Promise.resolve(new Response(Uint8Array.from(archive)));
    });
  }

  it('follows the release redirect to GitHub release storage', async () => {
    const archive = await tarball();
    const fetchArchive = redirectingFetch(archive);
    const runtime = release(archive, { fetchArchive });
    const executable = await runtime.install(
      new AbortController().signal,
      () => undefined,
    );
    expect(await readFile(executable, 'utf8')).toBe(binary);
    expect(fetchArchive.mock.calls.map(([url]) => urlOf(url))).toEqual([
      RELEASE_URL,
      ASSET_URL,
    ]);
    for (const [, init] of fetchArchive.mock.calls) {
      expect(init?.redirect).toBe('manual');
    }
  });

  it('refuses a redirect anywhere but GitHub release storage', async () => {
    const archive = await tarball();
    const runtime = release(archive, {
      fetchArchive: redirectingFetch(archive, 'https://example.com/tool.tgz'),
    });
    await expect(
      runtime.install(new AbortController().signal, () => undefined),
    ).rejects.toThrow('download metadata');
    expect(await runtime.isInstalled()).toBe(false);
  });

  it('refuses a GitHub address that is not a release download', async () => {
    const archive = await tarball();
    const runtime = new ManagedRuntimeInstaller({
      root: join(root, 'managed'),
      label: 'Fixture',
      executableName: 'agent',
      archivePath: 'tool',
      source: 'github-release',
      artifact: {
        ...artifact,
        url: 'https://github.com/owner/tool/archive/main.tar.gz',
        archiveBytes: archive.length,
      },
      fetchArchive: redirectingFetch(archive),
    });
    await expect(
      runtime.install(new AbortController().signal, () => undefined),
    ).rejects.toThrow('download metadata');
  });

  it('installs the executable from a zip archive', async () => {
    const archive = await zipball('tool.exe');
    const runtime = release(archive, {
      archiveFormat: 'zip',
      archivePath: 'tool.exe',
      executableName: 'agent.exe',
      fetchArchive: redirectingFetch(archive),
    });
    const executable = await runtime.install(
      new AbortController().signal,
      () => undefined,
    );
    expect(executable).toBe(join(root, 'managed/1.2.3/agent.exe'));
    expect(await readFile(executable, 'utf8')).toBe(binary);
    expect(await readdir(runtime.directory)).toEqual(['agent.exe']);
  });

  it('does not publish a zip runtime without its executable', async () => {
    const archive = await zipball('other.exe');
    const runtime = release(archive, {
      archiveFormat: 'zip',
      archivePath: 'tool.exe',
      executableName: 'agent.exe',
      fetchArchive: redirectingFetch(archive),
    });
    await expect(
      runtime.install(new AbortController().signal, () => undefined),
    ).rejects.toThrow('did not contain');
    expect(await runtime.isInstalled()).toBe(false);
  });

  it('refuses a link in a zip archive even when integrity matches', async () => {
    const archive = await zipball('tool.exe', 0o120777);
    const runtime = release(archive, {
      archiveFormat: 'zip',
      archivePath: 'tool.exe',
      executableName: 'agent.exe',
      fetchArchive: redirectingFetch(archive),
    });
    await expect(
      runtime.install(new AbortController().signal, () => undefined),
    ).rejects.toThrow('archive entry');
    expect(await runtime.isInstalled()).toBe(false);
  });

  it('still refuses redirects for npm downloads', async () => {
    const archive = await tarball();
    const fetchArchive = jest.fn(() =>
      Promise.resolve(new Response(Uint8Array.from(archive))),
    );
    const runtime = new ManagedRuntimeInstaller({
      root: join(root, 'managed'),
      label: 'Fixture',
      executableName: 'agent',
      archivePath: 'tool',
      artifact: {
        ...artifact,
        archiveBytes: archive.length,
        integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
      },
      fetchArchive,
    });
    await runtime.install(new AbortController().signal, () => undefined);
    expect(fetchArchive).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ redirect: 'error' }),
    );
  });
});
