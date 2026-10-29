import assert from 'node:assert/strict';
import test from 'node:test';

import {
  scrubBundledBinaryOverrides,
  withBundledBinaryOverridesScrubbed,
} from '../seeders/bundledBinaryOverrides.mjs';

test('scrubs only bundled binary overrides and restores absent versus empty values', () => {
  const environment = {
    CANOPY_CLAUDE_BINARY_PATH: '/packaged/claude',
    CANOPY_CODEX_BINARY_PATH: '',
    CANOPY_UNRELATED_PATH: '/keep',
    OTHER_BINARY_PATH: '/keep-too',
  };

  const scrubbed = scrubBundledBinaryOverrides(environment);
  assert.deepEqual(scrubbed.keys.sort(), [
    'CANOPY_CLAUDE_BINARY_PATH',
    'CANOPY_CODEX_BINARY_PATH',
  ]);
  assert.equal('CANOPY_CLAUDE_BINARY_PATH' in environment, false);
  assert.equal('CANOPY_CODEX_BINARY_PATH' in environment, false);
  assert.equal(environment.CANOPY_UNRELATED_PATH, '/keep');

  environment.CANOPY_CLAUDE_BINARY_PATH = '/test-mutated';
  scrubbed.restore();
  scrubbed.restore();

  assert.equal(environment.CANOPY_CLAUDE_BINARY_PATH, '/packaged/claude');
  assert.equal(environment.CANOPY_CODEX_BINARY_PATH, '');
  assert.equal(environment.CANOPY_UNRELATED_PATH, '/keep');
  assert.equal(environment.OTHER_BINARY_PATH, '/keep-too');
});

test('withBundledBinaryOverridesScrubbed restores overrides when the operation throws', async () => {
  const environment = { CANOPY_CLAUDE_BINARY_PATH: '/packaged/claude' };

  await assert.rejects(
    () =>
      withBundledBinaryOverridesScrubbed(async () => {
        assert.equal('CANOPY_CLAUDE_BINARY_PATH' in environment, false);
        throw new Error('injected launch failure');
      }, environment),
    /injected launch failure/,
  );

  assert.equal(environment.CANOPY_CLAUDE_BINARY_PATH, '/packaged/claude');
});
