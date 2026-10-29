import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createControlledPortalClone } from '../portal/cloneProgressFixture.mjs';

test(
  'controlled clone setup ignores host Git signing configuration',
  { skip: process.platform === 'win32' },
  () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'clone-config-'));
    const config = path.join(root, 'gitconfig');
    writeFileSync(
      config,
      '[commit]\n gpgsign = true\n[gpg]\n program = /usr/bin/false\n',
    );
    try {
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { createControlledPortalClone } from ${JSON.stringify(new URL('../portal/cloneProgressFixture.mjs', import.meta.url).href)};
const clone = createControlledPortalClone({ linkedFiles: { 'README.md': 'linked' } });
try { clone.release(); } finally { clone.dispose(); }`,
        ],
        {
          env: { ...process.env, GIT_CONFIG_GLOBAL: config },
          stdio: 'pipe',
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'controlled clone accepts only the exact root and checks out the default branch',
  { skip: process.platform === 'win32' },
  () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "clone-quoted'-"));
    const files = {
      'README.md': 'default',
      'pstack/README.md': 'default pstack',
    };
    const clone = createControlledPortalClone({
      remoteUrl: 'https://github.com/cursor/plugins',
      files,
      linkedFiles: {
        'README.md': 'linked',
        'pstack/README.md': 'linked pstack',
      },
    });
    try {
      clone.release();
      const env = { ...process.env, ...clone.env };
      for (const suffix of [
        '/tree/main/pstack',
        '/blob/linked/pstack/README.md',
      ]) {
        const rejected = spawnSync(
          clone.env.CANOPY_GIT_EXECUTABLE,
          ['clone', clone.remoteUrl + suffix, path.join(root, 'rejected')],
          { env, encoding: 'utf8', timeout: 10_000 },
        );
        assert.equal(rejected.status, 1);
        assert.match(rejected.stderr, /unexpected clone remote/);
      }
      const destination = path.join(root, 'explicit destination');
      execFileSync(
        clone.env.CANOPY_GIT_EXECUTABLE,
        ['clone', clone.remoteUrl, destination],
        {
          env,
          stdio: 'pipe',
          timeout: 10_000,
        },
      );
      assert.deepEqual(clone.verifyCheckout(destination), {
        branch: 'main',
        files,
      });
      assert.equal(clone.destination(), destination);
      assert.deepEqual(clone.arguments(), [
        clone.remoteUrl + '/tree/main/pstack',
        clone.remoteUrl + '/blob/linked/pstack/README.md',
        clone.remoteUrl,
      ]);
      clone.release({ fail: true });
      const failed = spawnSync(
        clone.env.CANOPY_GIT_EXECUTABLE,
        ['clone', clone.remoteUrl, path.join(root, 'failed')],
        {
          env,
          encoding: 'utf8',
          timeout: 10_000,
        },
      );
      assert.equal(failed.status, 1);
      assert.match(failed.stderr, /controlled authentication failure/);
    } finally {
      clone.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
