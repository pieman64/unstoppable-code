import { createHash } from 'node:crypto';
import {
  codexProfileDigest,
  resetCodexProfileDigestKeyForTests,
} from '../profile-digest-key';
import { resolveCodexSpawnProfile } from '../profile';

afterEach(() => {
  resetCodexProfileDigestKeyForTests();
});

it('a profile id is not the plain SHA-256 of its secret values', () => {
  for (const input of ['{"TOKEN":"abc"}', '[["TOKEN","abc"]]']) {
    const digest = codexProfileDigest(input);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toBe(createHash('sha256').update(input).digest('hex'));
  }

  const request = {
    environment: { TOKEN: 'abc' },
    secretVersionFingerprint: codexProfileDigest('[["TOKEN","abc"]]'),
  };
  expect(resolveCodexSpawnProfile(request).id).toBe(
    resolveCodexSpawnProfile(request).id,
  );
});

it('the key changes the id but not equality within a process', () => {
  resetCodexProfileDigestKeyForTests(Buffer.alloc(32, 1));
  const request = { environment: { TOKEN: 'abc' } };
  const first = resolveCodexSpawnProfile(request).id;
  expect(resolveCodexSpawnProfile(request).id).toBe(first);

  resetCodexProfileDigestKeyForTests(Buffer.alloc(32, 2));
  expect(resolveCodexSpawnProfile(request).id).not.toBe(first);
});

it('a short key is refused', () => {
  expect(() => resetCodexProfileDigestKeyForTests(Buffer.alloc(16))).toThrow(
    'A Codex profile digest key is 32 bytes.',
  );
});
