import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mac = process.platform === 'darwin';
const tools = '/Library/Developer/CommandLineTools/usr/bin';
// Local qualification opt-in: owned fixtures must yield receipts, not safe failure.
const requireReceipts = process.env.DARWIN_ACL_REQUIRE_RECEIPTS === '1';
assert.ok(
  [undefined, '1'].includes(process.env.DARWIN_ACL_REQUIRE_RECEIPTS),
  'DARWIN_ACL_REQUIRE_RECEIPTS must be unset or 1',
);
const receipts = new Set();
let temp, product, harness;
const run = (command, args, options = {}) =>
  spawnSync(command, args, { encoding: 'utf8', timeout: 15000, ...options });
before(() => {
  if (!mac) return;
  temp = mkdtempSync(path.join(tmpdir(), 'darwin-acl-native-'));
  product = path.join(temp, 'canopy-darwin-acl');
  harness = path.join(temp, 'faults');
  for (const [entry, output] of [
    ['main.c', product],
    ['tests/faults.c', harness],
  ]) {
    const result = run(`${tools}/clang`, [
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-isysroot',
      '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk',
      path.join(source, 'operation.c'),
      path.join(source, entry),
      '-o',
      output,
    ]);
    assert.equal(result.status, 0, result.stderr);
  }
});
after(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
});
// Required mode fails when a filter, skip or platform left any receipt
// undemonstrated. exitCode: direct and --test-isolation=none runs otherwise
// exit 0 after a failed after hook.
after(() => {
  const missing = ['file', 'directory']
    .flatMap((kind) => [`${kind} verify`, `${kind} restrict`])
    .filter((name) => !receipts.has(name));
  if (requireReceipts && missing.length) {
    process.exitCode = 1;
    assert.fail(
      `receipts required but not demonstrated: ${missing.join(', ')}`,
    );
  }
});

// This is a test oracle, not a selected production receipt consumer.
function receipt(result, action) {
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(
    result.stdout,
    `${JSON.stringify({ v: 1, action, st: value.st, entries: value.entries })}\n`,
  );
  const st = Buffer.from(value.st, 'base64');
  assert.equal(st.length, 24);
  assert.equal(st.toString('base64'), value.st);
  assert.deepEqual(st.subarray(4, 8), Buffer.alloc(4));
  assert.deepEqual(st.subarray(16), Buffer.alloc(8));
  assert.ok(
    value.entries === null ||
      (Number.isInteger(value.entries) &&
        value.entries >= 0 &&
        value.entries <= 1024),
  );
  return value;
}

test(
  'count witness and operation-table failure/ownership matrix',
  { skip: !mac },
  () => {
    const result = run(harness, []);
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /restrict\/inspect-init: 70/);
  },
);

test(
  'product links the real operations into a const table and nothing else',
  { skip: !mac },
  () => {
    // Imports from the pinned toolchain build. This rejects getenv-style fault
    // switches and unwired operations; it cannot prove every switch is absent.
    const real = `_acl_free _acl_valid _close _fchmodx_np _fgetattrlist
      _filesec_free _filesec_get_property _filesec_init _filesec_query_property
      _filesec_set_property _free _fstatx_np _malloc _sigaction _write`.split(
      /\s+/,
    );
    const support = `___error ___memcpy_chk ___memset_chk ___snprintf_chk
      ___stack_chk_fail ___stack_chk_guard _bzero _memcpy _memset _snprintf
      _strcmp _strlen`.split(/\s+/);
    const nm = (flag) => {
      const result = run(`${tools}/nm`, [flag, product]);
      assert.equal(result.status, 0, result.stderr ?? String(result.error));
      return result.stdout;
    };
    const names = nm('-u').split('\n').filter(Boolean);
    assert.deepEqual(
      real.filter((name) => !names.includes(name)),
      [],
    );
    assert.deepEqual(
      names.filter((name) => !real.includes(name) && !support.includes(name)),
      [],
    );
    assert.match(
      nm('-m'),
      /\(__DATA_CONST,__const\) non-external _real_operations$/m,
    );
  },
);

test(
  'only protocol 1 verify/restrict argv is admitted; invalid fd has no receipt',
  { skip: !mac },
  () => {
    for (const args of [
      [],
      ['verify'],
      ['--protocol=2', 'verify'],
      ['--protocol=1', 'clear'],
      ['--protocol=1', 'verify', 'extra'],
    ]) {
      const result = run(product, args);
      assert.equal(result.status, 64, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'ACL helper usage\n');
    }
    const result = run(product, ['--protocol=1', 'verify']);
    assert.equal(result.status, 70, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'ACL helper operation failed\n');
  },
);

for (const kind of ['file', 'directory'])
  test(
    `owned ${kind}: verify never repairs, restrict clears before independent inspection`,
    { skip: !mac },
    (t) => {
      const target = path.join(temp, kind);
      if (kind === 'file') writeFileSync(target, 'private', { mode: 0o600 });
      else mkdirSync(target, { mode: 0o700 });
      const chmod = (...args) =>
        assert.equal(run('/bin/chmod', [...args, target]).status, 0);
      const probe = (action) => {
        const fd = openSync(target, 'r');
        try {
          return run(product, ['--protocol=1', action], {
            stdio: ['ignore', 'pipe', 'pipe', fd],
          });
        } finally {
          closeSync(fd);
        }
      };
      const evidence = (result, action) => {
        if (result.status === 0) {
          const value = receipt(result, action);
          const st = Buffer.from(value.st, 'base64');
          const opened = statSync(target, { bigint: true });
          assert.equal(
            BigInt.asUintN(64, BigInt(st.readInt32LE(0))),
            opened.dev,
          );
          assert.equal(st.readBigUInt64LE(8), opened.ino);
          receipts.add(`${kind} ${action}`);
          return value;
        }
        assert.ok(
          !requireReceipts,
          `${action}: receipt required, exit ${result.status}: ${result.stderr}`,
        );
        assert.equal(result.status, 70, result.stderr);
        assert.equal(result.stdout, '');
        t.diagnostic(
          `${action}: native representation/query unverified on this filesystem; safe failure is not support equivalence`,
        );
        return null;
      };
      try {
        chmod(
          '+a',
          kind === 'file'
            ? 'everyone allow read'
            : 'everyone allow list,search',
        );
        const before = run('/bin/ls', ['-led', target]).stdout;
        const verified = evidence(probe('verify'), 'verify');
        if (verified) assert.ok(verified.entries > 0);
        assert.equal(run('/bin/ls', ['-led', target]).stdout, before);
        const restricted = evidence(probe('restrict'), 'restrict');
        if (restricted)
          assert.ok(restricted.entries === null || restricted.entries === 0);
        assert.doesNotMatch(
          run('/bin/ls', ['-led', target]).stdout,
          /everyone allow/,
        );
      } finally {
        chmod('-N');
      }
    },
  );

test(
  'denied native read fails without receipt on an owned fixture',
  { skip: !mac },
  () => {
    const target = path.join(temp, 'denied');
    writeFileSync(target, 'private', { mode: 0o600 });
    const fd = openSync(target, 'r');
    try {
      assert.equal(
        run('/bin/chmod', [
          '+a',
          `user:${userInfo().username} deny readsecurity`,
          target,
        ]).status,
        0,
      );
      const result = run(product, ['--protocol=1', 'verify'], {
        stdio: ['ignore', 'pipe', 'pipe', fd],
      });
      assert.equal(result.status, 70);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'ACL helper operation failed\n');
    } finally {
      closeSync(fd);
      assert.equal(run('/bin/chmod', ['-N', target]).status, 0);
    }
  },
);

test(
  'invalid protocol with a broken diagnostic pipe retains usage exit 64',
  { skip: !mac },
  () => {
    const result = run(harness, [product, 'broken-stderr']);
    assert.equal(result.signal, null);
    assert.equal(result.status, 64);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  },
);

test(
  'real broken stdout pipe exits 74 rather than SIGPIPE',
  { skip: !mac },
  () => {
    const target = path.join(temp, 'broken-pipe');
    writeFileSync(target, 'private', { mode: 0o600 });
    const fd = openSync(target, 'r');
    try {
      const result = run(harness, [product], {
        stdio: ['ignore', 'pipe', 'pipe', fd],
      });
      assert.equal(result.signal, null);
      assert.equal(result.status, 74, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'ACL helper output failed\n');
    } finally {
      closeSync(fd);
    }
  },
);
