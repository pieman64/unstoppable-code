import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintCursorRuntime } from '../runtime-fingerprint';

const sha = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

describe('fingerprintCursorRuntime', () => {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'canopy-fingerprint-'));
    await mkdir(join(root, 'lib'));
    await writeFile(join(root, 'cursor-agent'), 'launcher');
    await chmod(join(root, 'cursor-agent'), 0o755);
    await writeFile(join(root, 'lib', 'b.js'), 'bee');
    await writeFile(join(root, 'lib', 'a.js'), 'ay');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const signal = (): AbortSignal => new AbortController().signal;

  it('hashes every file by its relative path, sorted, as the installer pins it', async () => {
    const expected = sha(
      JSON.stringify({
        'cursor-agent': sha('launcher'),
        'lib/a.js': sha('ay'),
        'lib/b.js': sha('bee'),
      }),
    );
    expect(
      await fingerprintCursorRuntime(root, ['cursor-agent'], signal()),
    ).toBe(expected);
  });

  it('changes when any file changes, is added or is removed', async () => {
    const before = await fingerprintCursorRuntime(root, [], signal());
    await writeFile(join(root, 'lib', 'a.js'), 'ay!');
    const changed = await fingerprintCursorRuntime(root, [], signal());
    await writeFile(join(root, 'lib', 'c.js'), 'sea');
    const added = await fingerprintCursorRuntime(root, [], signal());
    await rm(join(root, 'lib', 'b.js'));
    const removed = await fingerprintCursorRuntime(root, [], signal());
    expect(new Set([before, changed, added, removed]).size).toBe(4);
  });

  it('refuses a link, a missing tree and a required executable that is not executable', async () => {
    await symlink(join(root, 'lib', 'a.js'), join(root, 'link.js'));
    await expect(fingerprintCursorRuntime(root, [], signal())).rejects.toThrow(
      'Runtime links are not supported',
    );
    await rm(join(root, 'link.js'));
    await chmod(join(root, 'cursor-agent'), 0o644);
    await expect(
      fingerprintCursorRuntime(root, ['cursor-agent'], signal()),
    ).rejects.toThrow();
    await expect(
      fingerprintCursorRuntime(join(root, 'missing'), [], signal()),
    ).rejects.toThrow();
  });

  it('stops when its signal aborts', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stopped'));
    await expect(
      fingerprintCursorRuntime(root, [], controller.signal),
    ).rejects.toThrow('stopped');
    // A later verification is not blocked by the stopped one.
    await expect(fingerprintCursorRuntime(root, [], signal())).resolves.toMatch(
      /^[a-f0-9]{64}$/,
    );
  });
});
