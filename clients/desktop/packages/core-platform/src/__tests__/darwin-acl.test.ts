import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { checkDarwinAcl, probeDarwinAcl } from '../secure-files/darwin-acl';
import { createSecureFileServices } from '../secure-files';

const darwinIt = process.platform === 'darwin' ? it : it.skip;

it.each([null, 0, 1, 128, 1024])(
  'preserves ACL evidence semantics for entries=%s',
  async (entries) => {
    const opened = await fs.stat(process.cwd(), { bigint: true });
    const bytes = Buffer.alloc(24);
    bytes.writeInt32LE(Number(BigInt.asIntN(32, opened.dev)), 0);
    bytes.writeBigUInt64LE(opened.ino, 8);
    const result = checkDarwinAcl(
      JSON.stringify({ st: bytes.toString('base64'), entries }),
      opened,
    );
    expect(result?.state ?? 'private').toBe(
      entries !== null && entries > 0 ? 'insecure' : 'private',
    );
  },
);
let dir = '';
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'darwin-acl-'));
});
afterEach(async () => {
  if (process.platform === 'darwin')
    execFileSync('/bin/chmod', ['-R', '-N', dir]);
  await fs.rm(dir, { recursive: true, force: true });
});

darwinIt.each(['file', 'directory'] as const)(
  'refuses and repairs extended ACL grants on a private-mode %s',
  async (kind) => {
    const target = path.join(dir, 'target');
    if (kind === 'file') await fs.writeFile(target, 'private');
    else await fs.mkdir(target);
    await fs.chmod(target, kind === 'file' ? 0o600 : 0o700);
    execFileSync('/bin/chmod', [
      '+a',
      kind === 'file'
        ? 'everyone allow read'
        : 'everyone allow list,search,add_file',
      target,
    ]);
    const services = createSecureFileServices('darwin');
    const request = { path: target, kind, mode: 'owner-only' } as const;
    expect(
      (await services.permissions({ ...request, action: 'verify' })).state,
    ).toBe('insecure');
    expect(
      (await services.permissions({ ...request, action: 'restrict' })).state,
    ).toBe('private');
    expect(
      (await services.permissions({ ...request, action: 'verify' })).state,
    ).toBe('private');
  },
);

darwinIt(
  'clears only the opened inode when the pathname is replaced',
  async () => {
    const target = path.join(dir, 'target'),
      original = path.join(dir, 'original');
    await fs.writeFile(target, 'original', { mode: 0o600 });
    execFileSync('/bin/chmod', ['+a', 'everyone allow read', target]);
    const services = createSecureFileServices('darwin', {
      darwinAcl: async (handle, clear) => {
        await fs.rename(target, original);
        await fs.writeFile(target, 'replacement', { mode: 0o600 });
        execFileSync('/bin/chmod', ['+a', 'everyone allow read', target]);
        return probeDarwinAcl(handle, clear);
      },
    });
    const request = { kind: 'file', mode: 'owner-only' } as const;
    expect(
      (
        await services.permissions({
          ...request,
          path: target,
          action: 'restrict',
        })
      ).state,
    ).toBe('insecure');
    const native = createSecureFileServices('darwin');
    expect(
      (
        await native.permissions({
          ...request,
          path: original,
          action: 'verify',
        })
      ).state,
    ).toBe('private');
    expect(
      (await native.permissions({ ...request, path: target, action: 'verify' }))
        .state,
    ).toBe('insecure');
    expect(await fs.readFile(target, 'utf8')).toBe('replacement');
  },
);

darwinIt('fails closed when the native ACL read is denied', async () => {
  const target = path.join(dir, 'target');
  await fs.writeFile(target, 'private', { mode: 0o600 });
  const handle = await fs.open(target, 'r');
  try {
    execFileSync('/bin/chmod', [
      '+a',
      `user:${userInfo().username} deny readsecurity`,
      target,
    ]);
    await expect(probeDarwinAcl(handle, false)).rejects.toMatchObject({
      code: 'ACL_PROBE_FAILED',
    });
    await probeDarwinAcl(handle, true);
  } finally {
    await handle.close();
  }
});

(process.platform === 'win32' ? it.skip : it).each([
  'garbage',
  'wrong inode',
  'bad entry count',
  'missing entries',
  'rejection',
])('returns unverifiable for an ACL receipt with %s', async (fault) => {
  const target = path.join(dir, 'target');
  await fs.writeFile(target, 'private', { mode: 0o600 });
  const stat = await fs.stat(target, { bigint: true });
  const bytes = Buffer.alloc(24);
  bytes.writeInt32LE(Number(BigInt.asIntN(32, stat.dev)), 0);
  bytes.writeBigUInt64LE(
    stat.ino + (fault === 'wrong inode' ? BigInt(1) : BigInt(0)),
    8,
  );
  const darwinAcl = (): Promise<string> => {
    if (fault === 'rejection') return Promise.reject(new Error('unavailable'));
    if (fault === 'garbage') return Promise.resolve('bad');
    return Promise.resolve(
      JSON.stringify({
        st: bytes.toString('base64'),
        entries:
          fault === 'bad entry count'
            ? -1
            : fault === 'missing entries'
              ? undefined
              : null,
      }),
    );
  };
  const services = createSecureFileServices('darwin', { darwinAcl });
  expect(
    (
      await services.permissions({
        path: target,
        kind: 'file',
        mode: 'owner-only',
        action: 'verify',
      })
    ).state,
  ).toBe('unverifiable');
  const linuxProbe = jest.fn(darwinAcl);
  const linux = createSecureFileServices('linux', { darwinAcl: linuxProbe });
  expect(
    (
      await linux.permissions({
        path: target,
        kind: 'file',
        mode: 'owner-only',
        action: 'verify',
      })
    ).state,
  ).toBe('private');
  expect(linuxProbe).not.toHaveBeenCalled();
});
