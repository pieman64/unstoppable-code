import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { deriveLocalAuthorityIdentity } from '../local-authority';

const posix = process.platform === 'win32' ? describe.skip : describe;
posix('trusted local authority identity', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'authority-')));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('pins the versioned tuple and varies every authority input', async () => {
    const input = { brandId: 'canopy', dataRoot: root };
    const observation = {
      platform: 'darwin',
      getuid: (): number | undefined => 501,
    };
    const expected = createHash('sha256')
      .update(
        JSON.stringify([
          'canopy.local-authority',
          1,
          'canopy',
          root,
          ['posix-uid', 501],
        ]),
      )
      .digest('hex');
    const first = await deriveLocalAuthorityIdentity(input, observation);
    expect(first).toEqual({ authorityId: expected, canonicalDataRoot: root });
    expect(await deriveLocalAuthorityIdentity(input, observation)).toEqual(
      first,
    );
    expect(
      (
        await deriveLocalAuthorityIdentity(
          { ...input, brandId: 'other' },
          observation,
        )
      ).authorityId,
    ).not.toBe(expected);
    expect(
      (
        await deriveLocalAuthorityIdentity(input, {
          ...observation,
          getuid: (): number | undefined => 502,
        })
      ).authorityId,
    ).not.toBe(expected);
    const child = await mkdtemp(join(root, 'child-'));
    expect(
      (
        await deriveLocalAuthorityIdentity(
          { ...input, dataRoot: child },
          observation,
        )
      ).authorityId,
    ).not.toBe(expected);
  });

  it('canonicalizes aliases and keeps tuple boundaries distinct', async () => {
    const alias = join(root, 'alias');
    await symlink(root, alias);
    const options = { platform: 'linux', getuid: (): number | undefined => 0 };
    const identity = await deriveLocalAuthorityIdentity(
      { brandId: 'canopy', dataRoot: root },
      options,
    );
    expect(
      await deriveLocalAuthorityIdentity(
        { brandId: 'canopy', dataRoot: `${alias}/` },
        options,
      ),
    ).toEqual(identity);
    expect(
      (
        await deriveLocalAuthorityIdentity(
          { brandId: 'canop', dataRoot: root },
          options,
        )
      ).authorityId,
    ).not.toBe(identity.authorityId);
  });

  it('keeps root and UID tuple boundaries distinct', async () => {
    const first = join(root, 'path');
    const second = `${first}1`;
    await mkdir(first);
    await mkdir(second);
    const options = { platform: 'linux', getuid: (): number | undefined => 12 };
    const input = { brandId: 'canopy', dataRoot: first };
    const identity = await deriveLocalAuthorityIdentity(input, options);
    expect(`${first}12`).toBe(`${second}2`);
    expect(
      (
        await deriveLocalAuthorityIdentity(
          { ...input, dataRoot: second },
          { ...options, getuid: (): number | undefined => 2 },
        )
      ).authorityId,
    ).not.toBe(identity.authorityId);
  });

  it('agrees with fresh host processes without injected user identity', async () => {
    const source = pathToFileURL(join(__dirname, '../local-authority.ts')).href;
    const script = `import { deriveLocalAuthorityIdentity } from ${JSON.stringify(source)}; process.stdout.write(JSON.stringify(await deriveLocalAuthorityIdentity({brandId:'canopy',dataRoot:process.argv[1]})));`;
    const expected = await deriveLocalAuthorityIdentity({
      brandId: 'canopy',
      dataRoot: root,
    });
    for (let restart = 0; restart < 2; restart += 1) {
      const { stdout } = await promisify(execFile)(process.execPath, [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        script,
        root,
      ]);
      expect(JSON.parse(stdout)).toEqual(expected);
    }
  });

  it.each(['', ' ', 'Canopy', 'canopy\u0000', 'a/b'])(
    'rejects invalid brand %j',
    async (brandId) => {
      await expect(
        deriveLocalAuthorityIdentity({ brandId, dataRoot: root }),
      ).rejects.toMatchObject({ code: 'invalid_brand' });
    },
  );

  it('rejects missing, relative, and non-directory roots', async () => {
    const file = join(root, 'file');
    await writeFile(file, 'x');
    for (const dataRoot of [
      '',
      'relative',
      `${root}\u0000`,
      join(root, 'absent'),
      file,
    ]) {
      await expect(
        deriveLocalAuthorityIdentity({ brandId: 'canopy', dataRoot }),
      ).rejects.toMatchObject({ code: 'invalid_root' });
    }
  });

  it.each([undefined, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unverifiable UID %j',
    async (uid) => {
      await expect(
        deriveLocalAuthorityIdentity(
          { brandId: 'canopy', dataRoot: root },
          { platform: 'linux', getuid: (): number | undefined => uid },
        ),
      ).rejects.toMatchObject({ code: 'principal_unavailable' });
    },
  );

  it('fails closed when UID observation throws or the platform has no supported principal', async () => {
    const getuid = jest.fn(() => {
      throw new Error('unavailable');
    });
    await expect(
      deriveLocalAuthorityIdentity(
        { brandId: 'canopy', dataRoot: root },
        { platform: 'linux', getuid },
      ),
    ).rejects.toMatchObject({ code: 'principal_unavailable' });
    getuid.mockClear();
    await expect(
      deriveLocalAuthorityIdentity(
        { brandId: 'canopy', dataRoot: root },
        { platform: 'win32', getuid },
      ),
    ).rejects.toMatchObject({ code: 'principal_unavailable' });
    expect(getuid).not.toHaveBeenCalled();
  });
});
