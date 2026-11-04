import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { injectSecureStorageFault } from './secureStorageFixture.mjs';

test('serialized locked fixture controls live collection metadata and restores native methods', async () => {
  const originalExec = childProcess.execFileSync;
  const native = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (text) => Buffer.from(text),
  };
  const before = { ...native };
  const calls = [];
  childProcess.execFileSync = (file, args) => {
    calls.push([file, args]);
    if (file !== '/usr/bin/gdbus') return 'unrelated';
    const method = args[args.indexOf('--method') + 1];
    if (method === 'org.freedesktop.DBus.GetNameOwner') return "(':1.42',)";
    if (method === 'org.freedesktop.Secret.Service.ReadAlias')
      return "(objectpath '/org/freedesktop/secrets/collection/login',)";
    return '(<false>,)';
  };
  const source = readFileSync(
    new URL('../../src/main/lib/linux-secret-service.ts', import.meta.url),
    'utf8',
  );
  const module = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    {
      exports: module.exports,
      module,
      performance,
      require(name) {
        if (name === 'node:child_process') return childProcess;
        if (name === '@canopy/desktop-shared/pipelines/config-paths')
          return { getLinuxProbeEnv: () => ({}) };
        throw new Error(`Unexpected import ${name}`);
      },
    },
    {
      filename: fileURLToPath(
        new URL('../../src/main/lib/linux-secret-service.ts', import.meta.url),
      ),
    },
  );
  const app = {
    async evaluateHandle(callback, fault) {
      // Playwright serializes the callback into Electron main without a dynamic
      // import callback. Exercise that boundary instead of calling the closure.
      const evaluate = vm.runInNewContext(`(${callback.toString()})`, {
        process: {
          platform: 'linux',
          getBuiltinModule: process.getBuiltinModule,
        },
      });
      const value = await evaluate({ safeStorage: native }, fault);
      return { evaluate: (run) => run(value), dispose: async () => {} };
    },
  };
  let restore;
  try {
    assert.equal(module.exports.getLinuxSecretServiceState(), 'secure');
    restore = await injectSecureStorageFault(app, 'locked');
    assert.equal(module.exports.getLinuxSecretServiceState(), 'locked');
    assert.deepEqual(
      native,
      before,
      'a metadata lock must not falsify native availability',
    );
    assert.equal(childProcess.execFileSync('/unrelated', []), 'unrelated');
    assert.equal(
      childProcess.execFileSync('/usr/bin/gdbus', ['unrelated']),
      '(<false>,)',
    );
    await restore();
    assert.equal(module.exports.getLinuxSecretServiceState(), 'secure');
    assert.deepEqual(native, before);
    assert.equal(calls.filter(([file]) => file === '/unrelated').length, 1);
  } finally {
    await restore?.();
    childProcess.execFileSync = originalExec;
  }
});

test('golden world scopes secure OS metadata to its own mocked Electron lifetime', async () => {
  const { ModuleMocker } = await import('jest-mock');
  const mocker = new ModuleMocker(globalThis);
  const metadata = { getLinuxSecretServiceState: () => 'unavailable' };
  const originalProbe = metadata.getLinuxSecretServiceState;
  const accountSaves = [];
  const moduleFactories = new Map();
  let drained = false;
  const fakeGlobal = { fetch: async () => new Response('{}') };
  const env = {};
  const modules = {
    'node:child_process': { execFileSync() {} },
    'node:crypto': await import('node:crypto'),
    'node:path': await import('node:path'),
    'node:os': { tmpdir: () => '/synthetic' },
    'node:fs': {
      mkdtempSync: () => '/synthetic/golden',
      realpathSync: (path) => path,
      mkdirSync() {},
      rmSync() {},
      writeFileSync() {},
    },
    '@canopy/desktop-shared/node/pipelines/__tests__/golden-fixtures': {
      GOLDEN_PROJECT_PIPELINE_YAML: '',
      GOLDEN_USER_PIPELINE_YAML: '',
      normalizeGoldenValue: (value) => value,
      writeGoldenBundledResources: (path) => path,
    },
    '@canopy/desktop-shared/pipelines/store': {
      saveStoredPipeline: () => ({ success: true, data: { id: 'pipeline' } }),
    },
    '@canopy/desktop-shared/pipelines/parse-pipeline': {
      parsePipelineText: () => ({ name: 'fixture' }),
    },
    '../../lib/linux-secret-service': metadata,
    '../../canopy-cloud/shared-item-subscriptions': {
      flushSharedItemSubscriptions: async () => {
        await Promise.resolve();
        drained = true;
      },
    },
    '../../lib/canopy-cloud-account-store': {
      saveCanopyCloudAccount: async (account) => {
        assert.equal(metadata.getLinuxSecretServiceState(), 'secure');
        accountSaves.push(account);
      },
    },
  };
  const source = readFileSync(
    new URL(
      '../../src/main/__tests__/pipeline-golden/world.ts',
      import.meta.url,
    ),
    'utf8',
  );
  const module = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    {
      exports: module.exports,
      module,
      Buffer,
      Response,
      Request,
      URL,
      global: fakeGlobal,
      process: { env },
      jest: {
        requireActual: (name) => modules[name],
        spyOn: mocker.spyOn.bind(mocker),
        doMock: (name, factory) => moduleFactories.set(name, factory),
        dontMock: (name) => moduleFactories.delete(name),
      },
      require(name) {
        if (name in modules) return modules[name];
        throw new Error(`Unexpected import ${name}`);
      },
    },
  );
  const world = await module.exports.createPipelineGoldenWorld();
  try {
    assert.equal(metadata.getLinuxSecretServiceState(), 'secure');
    assert.equal(accountSaves.length, 1);
    // A Jest module reset discards the module cache, but keeps registered
    // mock factories; the relaunched world must still see secure metadata.
    const freshImport = moduleFactories.get('../../lib/linux-secret-service');
    assert.equal(typeof freshImport, 'function');
    assert.equal(freshImport().getLinuxSecretServiceState(), 'secure');
  } finally {
    await world.dispose();
  }
  assert.equal(drained, true);
  assert.equal(moduleFactories.size, 0);
  assert.equal(metadata.getLinuxSecretServiceState, originalProbe);
  assert.equal(metadata.getLinuxSecretServiceState(), 'unavailable');
  assert.equal(env.CANOPY_SECURE_DATA_DIR, undefined);
});
