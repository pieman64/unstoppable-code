import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveHostRepositoryPolicy } from '../repository-policy';

let temporary: string;
let root: string;
const body = (
  result: Awaited<ReturnType<typeof resolveHostRepositoryPolicy>>,
): string => (result.status === 'delivered' ? result.block : '');
async function file(path: string, content: string): Promise<void> {
  await fs.mkdir(dirname(join(root, path)), { recursive: true });
  await fs.writeFile(join(root, path), content);
}
const host = (cwd = root): ReturnType<typeof resolveHostRepositoryPolicy> =>
  resolveHostRepositoryPolicy({ kind: 'checkout', root }, cwd);
beforeEach(async () => {
  temporary = await fs.mkdtemp(join(tmpdir(), 'repository-policy-'));
  root = join(temporary, 'checkout');
  await fs.mkdir(root);
  root = await fs.realpath(root);
});
afterEach(async () => {
  jest.restoreAllMocks();
  await fs.rm(temporary, { recursive: true, force: true });
});

test('reads root to cwd without ancestor, sibling or descendant bodies', async () => {
  await fs.writeFile(join(temporary, 'AGENTS.md'), 'OUTSIDE');
  await file('CLAUDE.md', 'ROOT');
  await file('desktop/AGENTS.md', 'SCOPED');
  await file('desktop/child/AGENTS.md', 'DESCENDANT');
  await file('mobile/AGENTS.md', 'SIBLING');
  expect(body(await host(join(root, 'desktop')))).toBe(
    '### CLAUDE.md\nROOT\n\n### desktop/AGENTS.md\nSCOPED',
  );
});

test.each(['alias', 'reverse-alias', 'copy', 'pointer', 'reverse-pointer'])(
  '%s pair delivers content once under its content-bearing regular label',
  async (layout) => {
    if (layout === 'reverse-alias' || layout === 'pointer') {
      await file('AGENTS.md', 'policy');
      if (layout === 'pointer') await file('CLAUDE.md', ' AGENTS.md\n');
      else await fs.symlink('AGENTS.md', join(root, 'CLAUDE.md'));
    } else {
      await file('CLAUDE.md', 'policy');
      if (layout === 'alias')
        await fs.symlink('CLAUDE.md', join(root, 'AGENTS.md'));
      else
        await file('AGENTS.md', layout === 'copy' ? 'policy' : '\nCLAUDE.md\n');
    }
    const result = await host();
    expect(result.status).toBe('delivered');
    expect(body(result).match(/policy/g)).toHaveLength(1);
    expect(body(result)).toContain(
      `### ${layout === 'pointer' || layout === 'reverse-alias' ? 'AGENTS.md' : 'CLAUDE.md'}\npolicy`,
    );
  },
);
test('divergent regular bodies deliver twice, CLAUDE before AGENTS', async () => {
  await file('CLAUDE.md', 'first');
  await file('AGENTS.md', 'second');
  expect(body(await host())).toBe(
    '### CLAUDE.md\nfirst\n\n### AGENTS.md\nsecond',
  );
});
test.each([
  'missing-pointer',
  'reverse-missing-pointer',
  'pointer-cycle',
  'link-cycle',
  'dangling',
  'external',
  'directory',
])('fails closed on %s without partial text', async (layout) => {
  await file('CLAUDE.md', 'partial text');
  if (layout === 'missing-pointer') await file('CLAUDE.md', 'AGENTS.md');
  if (layout === 'reverse-missing-pointer') {
    await fs.rm(join(root, 'CLAUDE.md'));
    await file('AGENTS.md', 'CLAUDE.md');
  }
  if (layout === 'pointer-cycle') {
    await file('CLAUDE.md', 'AGENTS.md');
    await file('AGENTS.md', 'CLAUDE.md');
  }
  if (layout === 'link-cycle') {
    await fs.rm(join(root, 'CLAUDE.md'));
    await fs.symlink('AGENTS.md', join(root, 'CLAUDE.md'));
    await fs.symlink('CLAUDE.md', join(root, 'AGENTS.md'));
  }
  if (layout === 'dangling')
    await fs.symlink('missing.md', join(root, 'AGENTS.md'));
  if (layout === 'external') {
    await fs.writeFile(join(temporary, 'external'), 'outside');
    await fs.symlink('../external', join(root, 'AGENTS.md'));
  }
  if (layout === 'directory') await fs.mkdir(join(root, 'AGENTS.md'));
  const result = await host();
  expect(result.status).toBe('unsupported-layout');
  expect(result).not.toHaveProperty('block');
});
test('genuine absence, explicit rootless and missing checkout are different', async () => {
  expect((await host()).status).toBe('absent');
  expect(
    (await resolveHostRepositoryPolicy({ kind: 'rootless' }, '/missing'))
      .status,
  ).toBe('absent');
  expect(
    (
      await resolveHostRepositoryPolicy(
        { kind: 'checkout', root: join(root, 'missing') },
        root,
      )
    ).status,
  ).toBe('unsupported-layout');
  expect(
    (
      await resolveHostRepositoryPolicy(
        { kind: 'checkout', root: join(root, 'missing') },
        join(root, 'missing'),
      )
    ).status,
  ).toBe('unreadable');
  expect((await resolveHostRepositoryPolicy(undefined, root)).status).toBe(
    'unreadable',
  );
});
test('rejects escaping cwd and linked directory components', async () => {
  expect((await host(temporary)).status).toBe('unsupported-layout');
  await fs.symlink(temporary, join(root, 'linked'));
  expect((await host(join(root, 'linked'))).status).toBe('unsupported-layout');
});
test('UTF-8 per-file and complete formatted budgets include labels', async () => {
  await file('CLAUDE.md', 'é'.repeat(32768));
  expect((await host()).status).toBe('delivered');
  await file('CLAUDE.md', 'é'.repeat(32769));
  expect((await host()).status).toBe('oversize');
  await file('CLAUDE.md', 'r'.repeat(65536));
  await file('AGENTS.md', 'a'.repeat(65536));
  const result = await host();
  expect(result.status).toBe('oversize');
  expect(result).not.toHaveProperty('block');
  await file('CLAUDE.md', 'r'.repeat(65536));
  await file('AGENTS.md', 'a'.repeat(65506)); // labels and separator = 30 bytes
  expect((await host()).status).toBe('delivered');
});
test.each([false, true])(
  'retries mutation once; repeated instability=%s is unreadable',
  async (repeated) => {
    await file('CLAUDE.md', 'body');
    const original = fs.open;
    let mutations = 0;
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await original(...args);
      if (mutations === 0 || repeated) {
        const before = await handle.stat();
        mutations++;
        await fs.appendFile(join(root, 'CLAUDE.md'), ' changed');
        jest.spyOn(handle, 'stat').mockResolvedValueOnce(before);
      }
      return handle;
    });
    const result = await host();
    expect(result.status).toBe(repeated ? 'unreadable' : 'delivered');
    if (!repeated) expect(body(result)).toContain('body changed');
  },
);
test.each([false, true])(
  'retries replacement once; repeated replacement=%s is unreadable',
  async (repeated) => {
    await file('CLAUDE.md', 'original');
    const original = fs.open;
    let replacements = 0;
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await original(...args);
      if (replacements === 0 || repeated) {
        replacements++;
        await fs.writeFile(join(root, 'replacement'), 'replacement body');
        await fs.rename(join(root, 'replacement'), join(root, 'CLAUDE.md'));
      }
      return handle;
    });
    const result = await host();
    expect(result.status).toBe(repeated ? 'unreadable' : 'delivered');
    if (!repeated) expect(body(result)).toContain('replacement body');
  },
);

test('preserves cancellation', async () => {
  await expect(
    resolveHostRepositoryPolicy({ kind: 'checkout', root }, root, {
      signal: AbortSignal.abort(),
    }),
  ).rejects.toThrow();
});

test.each(['a:b', 'a\\b', 'control\u0001'])(
  'gives actionable recovery for unsupported directory %j',
  async (name) => {
    const result = await host(join(root, name));
    expect(result.status).toBe('unsupported-layout');
    if (result.status !== 'unsupported-layout')
      throw new Error('Expected unsupported layout');
    expect(result.message).toContain('Select a regular directory');
    expect(result.message).toContain('unsupported name');
  },
);

test('keeps an explicit empty instruction file as labelled provenance', async () => {
  await file('AGENTS.md', '');
  expect(await host()).toMatchObject({
    status: 'delivered',
    block: '### AGENTS.md\n',
    entries: [
      { path: 'CLAUDE.md', result: 'absent' },
      { path: 'AGENTS.md', result: 'content' },
    ],
  });
});

test('missing checkout recovery does not expose an errno', async () => {
  await fs.rm(root, { recursive: true });
  const result = await host();
  expect(result).toMatchObject({ status: 'unreadable' });
  if (result.status !== 'unreadable') throw new Error('Expected unreadable');
  expect(result.message).toContain('folder is missing');
  expect(result.message).toContain('run the workflow again');
  expect(result.message).not.toContain('ENOENT');
});

test.each(['EACCES', 'EPERM'])(
  'checkout permission recovery for %s does not expose an errno',
  async (code) => {
    jest
      .spyOn(fs, 'realpath')
      .mockRejectedValueOnce(
        Object.assign(new Error('permission denied'), { code }),
      );
    const result = await host();
    if (result.status !== 'unreadable') throw new Error('Expected unreadable');
    expect(result.message).toContain('Check its permissions');
    expect(result.message).not.toContain(code);
  },
);

test('stale checkout recovery distinguishes a fresh launch from Start over', async () => {
  const result = await host(temporary);
  if (result.status !== 'unsupported-layout')
    throw new Error('Expected unsupported layout');
  expect(result.message).toContain('Run the workflow again');
  expect(result.message).toContain('Start over keeps');
});

describe.each(['metadata', 'read'])('%s instruction failures', (stage) => {
  test.each(['EACCES', 'EPERM', 'EIO'])(
    'explains %s recovery without exposing the errno',
    async (code) => {
      await file('CLAUDE.md', 'policy');
      const error = Object.assign(new Error('filesystem failure'), { code });
      if (stage === 'metadata')
        jest.spyOn(fs, 'lstat').mockRejectedValue(error);
      else jest.spyOn(fs, 'open').mockRejectedValue(error);
      const result = await host();
      if (result.status !== 'unreadable')
        throw new Error('Expected unreadable');
      expect(result.message).toContain('CLAUDE.md');
      expect(result.message).toContain(
        code === 'EIO' ? 'available and readable' : 'Check its permissions',
      );
      expect(result.message).not.toContain(code);
      expect(result).not.toHaveProperty('block');
    },
  );
});

test('an instruction that disappears while opening gives recovery guidance', async () => {
  await file('CLAUDE.md', 'policy');
  jest
    .spyOn(fs, 'open')
    .mockRejectedValue(
      Object.assign(new Error('file disappeared'), { code: 'ENOENT' }),
    );
  const result = await host();
  if (result.status !== 'unreadable') throw new Error('Expected unreadable');
  expect(result.message).toContain('CLAUDE.md');
  expect(result.message).toContain('Restore it, then try again');
  expect(result.message).not.toContain('ENOENT');
});
