import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertMatchingUuid,
  buildElectronSymbolsArtifactRequest,
  parseBreakpadModule,
  parseElectronCrashFrames,
  resolveBreakpadSymbolText,
} from './symbolicate-electron-crash.mjs';

const CRASH_STACK = `0  Electron Framework 0x00000001129eea14 0x000000010d2e8000 + 91253268
0  Electron Framework 0x00000001129eea28 0x000000010d2e8000 + 91253288
0  ??? 0x0000000157e7d108 0x0000000000000000 + 5769777416
0  CoreFoundation 0x0000000182baaf2c 0x0000000182b2d000 + 515884`;

test('uses direct process streams instead of forbidden console methods', () => {
  const source = readFileSync(
    new URL('./symbolicate-electron-crash.mjs', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /\bconsole\.(?:log|error)\b/);
});

test('builds the matching upstream Electron symbols request', () => {
  assert.deepEqual(
    buildElectronSymbolsArtifactRequest({
      version: '42.3.0',
      arch: 'arm64',
    }),
    {
      version: '42.3.0',
      platform: 'darwin',
      arch: 'arm64',
      artifactName: 'electron',
      artifactSuffix: 'symbols',
    },
  );
});

test('rejects unsupported versions and architectures before constructing paths', () => {
  assert.throws(
    () =>
      buildElectronSymbolsArtifactRequest({
        version: '../42.3.0',
        arch: 'arm64',
      }),
    /valid Electron version/,
  );
  assert.throws(
    () =>
      buildElectronSymbolsArtifactRequest({
        version: '42.3.0',
        arch: 'ia32',
      }),
    /arm64 or x64/,
  );
});

test('extracts Electron Framework addresses and their shared load address', () => {
  assert.deepEqual(parseElectronCrashFrames(CRASH_STACK), {
    loadAddress: '0x000000010d2e8000',
    addresses: ['0x00000001129eea14', '0x00000001129eea28'],
  });
});

test('rejects a stack containing inconsistent Electron Framework load addresses', () => {
  assert.throws(
    () =>
      parseElectronCrashFrames(
        `${CRASH_STACK}\n0  Electron Framework 0x00000001129eea44 0x0000000100000000 + 91253316`,
      ),
    /multiple Electron Framework load addresses/,
  );
});

test('parses and verifies the Breakpad module UUID', () => {
  const module = parseBreakpadModule(
    'MODULE mac arm64 4C4C441655553144A1EAB6C25F3532300 Electron Framework',
  );

  assert.deepEqual(module, {
    os: 'mac',
    arch: 'arm64',
    uuid: '4c4c4416-5555-3144-a1ea-b6c25f353230',
    name: 'Electron Framework',
  });
  assert.doesNotThrow(() =>
    assertMatchingUuid({
      expectedUuid: '4C4C4416-5555-3144-A1EA-B6C25F353230',
      arch: 'arm64',
      module,
    }),
  );
  assert.throws(
    () =>
      assertMatchingUuid({
        expectedUuid: '00000000-0000-0000-0000-000000000000',
        arch: 'arm64',
        module,
      }),
    /does not contain expected UUID/,
  );
});

test('maps Electron x64 to the Breakpad x86_64 architecture token', () => {
  const module = parseBreakpadModule(
    'MODULE mac x86_64 4C4C441655553144A1EAB6C25F3532300 Electron Framework',
  );

  assert.doesNotThrow(() =>
    assertMatchingUuid({
      expectedUuid: '4C4C4416-5555-3144-A1EA-B6C25F353230',
      arch: 'x64',
      module,
    }),
  );
});

test('rejects symbolication when --uuid is omitted', () => {
  const cacheDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-symbols-test-'),
  );
  const symbolDir = path.join(
    cacheDir,
    '42.3.0',
    'darwin-arm64',
    'breakpad_symbols',
    'Electron Framework',
    'fixture',
  );
  mkdirSync(symbolDir, { recursive: true });
  writeFileSync(
    path.join(symbolDir, 'Electron Framework.sym'),
    'MODULE mac arm64 4C4C441655553144A1EAB6C25F3532300 Electron Framework\n',
  );

  try {
    const result = spawnSync(
      process.execPath,
      [
        new URL('./symbolicate-electron-crash.mjs', import.meta.url).pathname,
        '--version',
        '42.3.0',
        '--arch',
        'arm64',
        '--load-address',
        '0x1000',
        '--address',
        '0x1001',
        '--cache-dir',
        cacheDir,
      ],
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--uuid is required/);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('resolves Breakpad functions and source lines while preserving frame order', () => {
  const symbols = `MODULE mac arm64 4C4C441655553144A1EAB6C25F3532300 Electron Framework
FILE 0 ../../base/check.cc
FILE 1 ../../v8/api.cc
FUNC 100 20 0 logging::CheckFailure()
100 10 44 0
110 10 45 0
FUNC 200 30 0 v8::Isolate::FatalProcessOutOfMemory()
200 30 123 1`;

  assert.deepEqual(
    resolveBreakpadSymbolText({
      text: symbols,
      offsets: ['0x205', '0x115', '0x999'],
    }),
    [
      {
        offset: '0x205',
        function: 'v8::Isolate::FatalProcessOutOfMemory()',
        functionOffset: 5,
        file: '../../v8/api.cc',
        line: 123,
      },
      {
        offset: '0x115',
        function: 'logging::CheckFailure()',
        functionOffset: 21,
        file: '../../base/check.cc',
        line: 45,
      },
      {
        offset: '0x999',
        function: '',
        functionOffset: null,
        file: '',
        line: null,
      },
    ],
  );
});
