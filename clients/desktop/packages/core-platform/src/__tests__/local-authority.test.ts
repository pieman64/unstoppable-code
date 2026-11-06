import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  realpath,
  cp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  deriveLocalAuthorityIdentity,
  hostLocalAuthorityObservation,
  observeLocalAuthorityRelocation,
  type LocalAuthorityObservation,
} from '../local-authority';
import {
  WINDOWS_PROCESS_FILE,
  windowsPrincipalObserver,
} from '../supervision/windows-process';

/** Independent of the implementation: the pinned v1 tuple, hashed here. */
const expectedAuthority = (
  brandId: string,
  canonicalDataRoot: string,
  principal: readonly [string, string | number],
): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        'canopy.local-authority',
        1,
        brandId,
        canonicalDataRoot,
        principal,
      ]),
    )
    .digest('hex');

const posix = process.platform === 'win32' ? describe.skip : describe;
posix('trusted local authority identity', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'authority-')));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('qualifies one principal and exact old/new roots without globally accepting old authority', async () => {
    const sourceRoot = join(root, 'old');
    const destinationRoot = join(root, 'new');
    await mkdir(sourceRoot);
    const getuid = jest.fn(() => 501);
    const observation = { platform: 'darwin', getuid };
    const transition = await observeLocalAuthorityRelocation(
      {
        brandId: 'canopy',
        installationId: 'installation-1',
        sourceRoot,
        destinationRoot,
      },
      observation,
    );
    expect(getuid).toHaveBeenCalledTimes(1);
    expect(transition.from).toEqual({
      authorityId: expectedAuthority('canopy', sourceRoot, ['posix-uid', 501]),
      canonicalDataRoot: sourceRoot,
    });
    expect(transition.to).toEqual({
      authorityId: expectedAuthority('canopy', destinationRoot, [
        'posix-uid',
        501,
      ]),
      canonicalDataRoot: destinationRoot,
    });
    await writeFile(join(sourceRoot, 'preserved'), 'source bytes');
    await cp(sourceRoot, destinationRoot, {
      recursive: true,
      verbatimSymlinks: true,
    });
    expect(await readFile(join(sourceRoot, 'preserved'), 'utf8')).toBe(
      'source bytes',
    );
    await expect(
      observeLocalAuthorityRelocation(
        {
          brandId: 'canopy',
          installationId: 'installation',
          sourceRoot,
          destinationRoot,
        },
        observation,
      ),
    ).rejects.toMatchObject({ code: 'invalid_root' });
    expect(
      await deriveLocalAuthorityIdentity(
        { brandId: 'canopy', dataRoot: destinationRoot },
        observation,
      ),
    ).toEqual(transition.to);
    expect(transition.from.authorityId).not.toBe(transition.to.authorityId);
    await expect(
      observeLocalAuthorityRelocation(
        {
          brandId: 'canopy',
          installationId: 'other',
          sourceRoot: destinationRoot,
          destinationRoot,
        },
        observation,
      ),
    ).rejects.toThrow();
  });

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

// Controlled observation: alternate principals without any account change.
describe('trusted Windows principal authority', () => {
  const SID = 'S-1-5-21-3623811015-3361044348-30300820-1013';
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'authority-')));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));
  const windows = (
    windowsPrincipal: () => Promise<string>,
    getuid: () => number | undefined = jest.fn(() => 501),
  ): LocalAuthorityObservation => ({
    platform: 'win32',
    getuid,
    windowsPrincipal,
  });

  it('pins the windows-sid tuple and never reads a UID', async () => {
    const getuid = jest.fn(() => 501);
    const principal = jest.fn(() => Promise.resolve(SID));
    const identity = await deriveLocalAuthorityIdentity(
      { brandId: 'canopy', dataRoot: root },
      windows(principal, getuid),
    );
    expect(identity).toEqual({
      authorityId: expectedAuthority('canopy', root, ['windows-sid', SID]),
      canonicalDataRoot: root,
    });
    expect(principal).toHaveBeenCalledTimes(1);
    expect(getuid).not.toHaveBeenCalled();
    // A restarted host re-observes and agrees.
    expect(
      await deriveLocalAuthorityIdentity(
        { brandId: 'canopy', dataRoot: root },
        windows(() => Promise.resolve(SID)),
      ),
    ).toEqual(identity);
    // Darwin/Linux bytes are untouched by the Windows branch.
    expect(
      (
        await deriveLocalAuthorityIdentity(
          { brandId: 'canopy', dataRoot: root },
          {
            platform: 'darwin',
            getuid: () => 501,
            windowsPrincipal: principal,
          },
        )
      ).authorityId,
    ).toBe(expectedAuthority('canopy', root, ['posix-uid', 501]));
    expect(principal).toHaveBeenCalledTimes(1);
  });

  it('separates principals, brands and roots', async () => {
    const child = await mkdtemp(join(root, 'child-'));
    const derive = async (
      brandId: string,
      dataRoot: string,
      sid: string,
    ): Promise<string> =>
      (
        await deriveLocalAuthorityIdentity(
          { brandId, dataRoot },
          windows(() => Promise.resolve(sid)),
        )
      ).authorityId;
    const ids = [
      await derive('canopy', root, SID),
      await derive(
        'canopy',
        root,
        'S-1-5-21-3623811015-3361044348-30300820-1014',
      ),
      await derive('canopy', root, 'S-1-5-18'),
      await derive('canopy', root, 'S-1-0'),
      await derive('canopy-dev', root, SID),
      await derive('canopy', child, SID),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[3]).toBe(
      expectedAuthority('canopy', root, ['windows-sid', 'S-1-0']),
    );
  });

  it.each<[string, (() => Promise<string>) | undefined]>([
    ['no observer', undefined],
    [
      'a failed observation',
      (): Promise<string> => Promise.reject(new Error(SID)),
    ],
    [
      'a throwing observer',
      (): Promise<string> => {
        throw new Error('unavailable');
      },
    ],
    ...[
      '',
      's-1-5-18',
      'S-1-5-018',
      'S-01-5-18',
      'S-2-5-18',
      'S-1-0x5-18',
      'S-1-5-+18',
      ' S-1-5-18',
      'S-1-5-18 ',
      'S-1-5-18\n',
      'S-1-5-18-',
      'S-1-5--18',
      'S-1-5-١٨',
      'S-1-281474976710656',
      'S-1-5-4294967296',
      `S-1-5${'-1'.repeat(16)}`,
      `canopy-principal-v1 ${SID}`,
    ].map((sid): [string, () => Promise<string>] => [
      JSON.stringify(sid),
      (): Promise<string> => Promise.resolve(sid),
    ]),
  ])('refuses %s as principal_unavailable', async (_label, observer) => {
    await expect(
      deriveLocalAuthorityIdentity(
        { brandId: 'canopy', dataRoot: root },
        {
          platform: 'win32',
          getuid: () => 0,
          ...(observer && { windowsPrincipal: observer }),
        },
      ),
    ).rejects.toMatchObject({
      code: 'principal_unavailable',
      message: 'Local authority identity unavailable: principal_unavailable.',
    });
  });

  it('accepts the boundary SID forms the receipt allows', async () => {
    for (const sid of [
      'S-1-281474976710655',
      `S-1-5${'-4294967295'.repeat(15)}`,
    ])
      expect(
        (
          await deriveLocalAuthorityIdentity(
            { brandId: 'canopy', dataRoot: root },
            windows(() => Promise.resolve(sid)),
          )
        ).authorityId,
      ).toBe(expectedAuthority('canopy', root, ['windows-sid', sid]));
  });

  it('refuses a bad brand before observing, and a bad root after a trusted SID', async () => {
    const principal = jest.fn(() => Promise.resolve(SID));
    await expect(
      deriveLocalAuthorityIdentity(
        { brandId: 'Canopy', dataRoot: root },
        windows(principal),
      ),
    ).rejects.toMatchObject({ code: 'invalid_brand' });
    expect(principal).not.toHaveBeenCalled();
    for (const dataRoot of ['', 'relative', join(root, 'absent')])
      await expect(
        deriveLocalAuthorityIdentity(
          { brandId: 'canopy', dataRoot },
          windows(principal),
        ),
      ).rejects.toMatchObject({ code: 'invalid_root' });
  });

  it('defaults to this host and forwards only a supplied observer', () => {
    const principal = (): Promise<string> => Promise.resolve(SID);
    const host = hostLocalAuthorityObservation();
    expect(Object.keys(host).sort()).toEqual(['getuid', 'platform']);
    expect(host.platform).toBe(process.platform);
    expect(hostLocalAuthorityObservation(principal).windowsPrincipal).toBe(
      principal,
    );
    expect(hostLocalAuthorityObservation().getuid()).toBe(process.getuid?.());
  });
});

const ROOT = join(__dirname, '../../../..');
const HELPER = join(ROOT, '.cache/bin/win32-x64', WINDOWS_PROCESS_FILE);
const run = promisify(execFile);
const onWindows = process.platform === 'win32' ? describe : describe.skip;
onWindows('Windows host authority with the shipped helper', () => {
  let root: string;
  let sid: string;
  beforeAll(async () => {
    // Rebuilds only when source/recipe/PE binding is stale.
    await run(
      process.execPath,
      [join(ROOT, 'scripts/build-windows-process-identity.mjs')],
      { cwd: ROOT, windowsHide: true, timeout: 240_000, maxBuffer: 1 << 20 },
    );
    const whoami = await run(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'),
      ['/user', '/fo', 'csv', '/nh'],
      { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
    );
    sid = /,"(S-1-[0-9-]+)"\s*$/.exec(whoami.stdout)?.[1] ?? '';
    expect(sid).toMatch(/^S-1-/);
  }, 600_000);
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'authority-')));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));
  const fixed = (): LocalAuthorityObservation => ({
    platform: 'win32',
    getuid: () => undefined,
    windowsPrincipal: () => Promise.resolve(sid),
  });

  it('agrees across fresh processes, restarts and canonical root aliases', async () => {
    const alias = join(root, 'alias');
    const target = join(root, 'Target');
    await mkdir(target);
    await symlink(target, alias, 'junction');
    const canonical = await realpath(target);
    const expected = {
      authorityId: expectedAuthority('canopy', canonical, ['windows-sid', sid]),
      canonicalDataRoot: canonical,
    };
    const local = join(__dirname, '../local-authority.ts');
    const helper = join(__dirname, '../supervision/windows-process.ts');
    const script = `import { deriveLocalAuthorityIdentity, hostLocalAuthorityObservation } from ${JSON.stringify(pathToFileURL(local).href)}; import { windowsPrincipalObserver } from ${JSON.stringify(pathToFileURL(helper).href)}; process.stdout.write(JSON.stringify(await deriveLocalAuthorityIdentity({brandId:'canopy',dataRoot:process.argv[1]}, hostLocalAuthorityObservation(windowsPrincipalObserver(process.argv[2])))));`;
    for (const dataRoot of [
      target,
      alias,
      `${alias}\\`,
      target.toUpperCase(),
      target.replaceAll('\\', '/'),
    ]) {
      // Each spelling in a fresh process, as a restarted host would see it.
      const { stdout } = await run(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          script,
          dataRoot,
          HELPER,
        ],
        { cwd: ROOT, windowsHide: true, timeout: 60_000 },
      );
      expect(JSON.parse(stdout)).toEqual(expected);
    }
  }, 120_000);

  it('refuses roots outside drive or UNC form even when they resolve', async () => {
    const drive = root.slice(0, 2);
    const file = join(root, 'file');
    await writeFile(file, 'x');
    for (const dataRoot of [
      `\\\\?\\${root}`,
      `\\\\.\\${root}`,
      '\\\\.\\pipe\\canopy',
      `${drive}relative`,
      root.slice(2),
      'relative',
      join(root, 'absent'),
      file,
      `${root}\u0000`,
    ])
      await expect(
        deriveLocalAuthorityIdentity({ brandId: 'canopy', dataRoot }, fixed()),
      ).rejects.toMatchObject({ code: 'invalid_root' });
  });

  it('refuses an untrusted helper location as principal_unavailable', async () => {
    for (const file of [
      join(root, WINDOWS_PROCESS_FILE),
      join(ROOT, '.cache/bin/win32-x64/other.exe'),
      `.cache\\bin\\win32-x64\\${WINDOWS_PROCESS_FILE}`,
    ])
      await expect(
        deriveLocalAuthorityIdentity(
          { brandId: 'canopy', dataRoot: root },
          hostLocalAuthorityObservation(windowsPrincipalObserver(file)),
        ),
      ).rejects.toMatchObject({ code: 'principal_unavailable' });
  });
});
