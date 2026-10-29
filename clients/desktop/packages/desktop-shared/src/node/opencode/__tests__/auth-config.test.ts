import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertOpenCodeAuthConfigSafe,
  assertOpenCodeSystemConfigSafe,
} from '../auth-config';
import { DatabaseSync } from 'node:sqlite';

it('rejects system config discovery that v2 cannot isolate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-system-config-'));
  try {
    await expect(
      assertOpenCodeSystemConfigSafe({ ProgramData: root }, 'win32'),
    ).resolves.toBeUndefined();
    await mkdir(join(root, 'opencode'));
    await expect(
      assertOpenCodeSystemConfigSafe({ ProgramData: root }, 'win32'),
    ).rejects.toThrow('system configuration');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects v2 remote configuration sources before native plugins can load, without changing the database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-v2-auth-'));
  await mkdir(join(root, 'opencode'));
  const file = join(root, 'opencode', 'opencode.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO kv VALUES (?, ?)').run(
    'wellknown:sources',
    '["https://remote.invalid"]',
  );
  db.close();
  const before = await readFile(file);
  try {
    await expect(
      assertOpenCodeAuthConfigSafe(
        { XDG_DATA_HOME: root, OPENCODE_AUTH_CONTENT: '{}' },
        root,
      ),
    ).rejects.toThrow('remote configuration');
    expect(await readFile(file)).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('preserves native API/OAuth credentials and rechecks changes between turns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-auth-'));
  const file = join(root, 'opencode', 'auth.json');
  const env = { XDG_DATA_HOME: root };
  try {
    await expect(
      assertOpenCodeAuthConfigSafe(env, root),
    ).resolves.toBeUndefined();
    await mkdir(join(root, 'opencode'));
    const auth = JSON.stringify({
      api: { type: 'api', key: 'test-key' },
      oauth: {
        type: 'oauth',
        access: 'test-access',
        refresh: 'test-refresh',
        expires: 0,
      },
    });
    await writeFile(file, auth);
    await expect(
      assertOpenCodeAuthConfigSafe(env, root),
    ).resolves.toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe(auth);
    expect(env).toEqual({ XDG_DATA_HOME: root });
    await writeFile(
      file,
      '{"https://remote.invalid/":{"type":"wellknown","key":"TOKEN","token":"secret"}}',
    );
    await expect(assertOpenCodeAuthConfigSafe(env, root)).rejects.toThrow(
      'remote configuration',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['{bad', 'null', '[]', '"secret"'])(
  'rejects invalid inline auth rather than falling back to native remote credentials: %s',
  async (source) => {
    await expect(
      assertOpenCodeAuthConfigSafe(
        { OPENCODE_AUTH_CONTENT: source },
        process.cwd(),
      ),
    ).rejects.toThrow('invalid JSON');
  },
);

it('checks escaped credential types without exposing their values', async () => {
  await expect(
    assertOpenCodeAuthConfigSafe(
      {
        OPENCODE_AUTH_CONTENT:
          '{"__proto__":{"type":"well\\u006bnown","key":"PRIVATE_TOKEN","token":"secret"}}',
      },
      process.cwd(),
    ),
  ).rejects.toThrow(
    'OpenCode remote configuration is not supported. Use a provider sign-in or API key.',
  );
});

it('allows supported credentials when no native auth store exists', async () => {
  await expect(
    assertOpenCodeAuthConfigSafe(
      {
        OPENCODE_AUTH_CONTENT: '{"provider":{"type":"api","key":"test"}}',
        XDG_DATA_HOME: '/unreadable/unused-auth-store',
      },
      process.cwd(),
    ),
  ).resolves.toBeUndefined();
});

it('bounds inline credential data before parsing it', async () => {
  await expect(
    assertOpenCodeAuthConfigSafe(
      {
        OPENCODE_AUTH_CONTENT: ' '.repeat(1024 * 1024 + 1),
      },
      process.cwd(),
    ),
  ).rejects.toThrow('too large');
});

it('checks an existing native SQLite database without altering provider credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-native-auth-'));
  await mkdir(join(root, 'opencode'));
  const file = join(root, 'opencode', 'opencode.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO kv VALUES (?, ?)').run(
    'fixture:credential',
    'native-owned',
  );
  db.close();
  const before = await readFile(file);
  try {
    await expect(
      assertOpenCodeAuthConfigSafe({ XDG_DATA_HOME: root }, root),
    ).resolves.toBeUndefined();
    expect(await readFile(file)).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
