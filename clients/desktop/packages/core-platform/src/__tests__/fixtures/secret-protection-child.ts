/** Standalone Node qualification. Only disposable test bytes; no Electron. */
import assert from 'node:assert/strict';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  KeychainNative,
  NativeOperation,
} from '../../secret-protection/darwin';
import type { KeychainNamespace } from '../../secret-protection/policy';
import type { PlatformKeySlotCallOptions } from '@canopy/core-runtime';
import type { VaultStore } from '@canopy/core-runtime/node/vault/repository/store';
import type { VaultReadRepository } from '@canopy/core-runtime/node/vault/repository/read-repository';
import type { SecretProtectionConformanceSubject } from '../../../../core-runtime/src/platform/testing/secret-protection-conformance';
import { resolve } from 'node:path';

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (!specifier.startsWith('.')) throw error;
      try {
        return next(`${specifier}.ts`, context);
      } catch {
        return next(`${specifier}/index.ts`, context);
      }
    }
  },
  load(url, context, next) {
    if (!url.startsWith('file:') || !url.endsWith('.ts'))
      return next(url, context);
    return {
      format: 'module',
      shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), {
        mode: 'transform',
        sourceUrl: url,
      }),
    };
  },
});

const [root, addon, keychain, mode] = process.argv.slice(2);
assert.ok(root && addon && keychain && mode, 'Missing fixture arguments.');
const { createDarwinSecretProtection } =
  await import('../../secret-protection/darwin');
const { createSecretProtectionServices } =
  await import('../../secret-protection/index');
const { resolveSecretProtectionPolicy } =
  await import('../../secret-protection/policy');
const { deriveLocalAuthorityIdentity } = await import('../../local-authority');
const { runSecretProtectionConformance } =
  await import('../../../../core-runtime/src/platform/testing/secret-protection-conformance');
const loaded = { exports: {} };
process.dlopen(loaded, addon);
interface FixtureDiagnostics {
  readonly prompts: number;
  readonly apiCalls: number;
  readonly ownedBytes: number;
}
interface KeychainFixture {
  readonly fixture: true;
  run(
    ...args: [...Parameters<KeychainNative['run']>, string, string]
  ): Promise<unknown>;
  control(operation: string, path: string): number;
  diagnostics(): FixtureDiagnostics;
  mapStatus(operation: NativeOperation, status: number): string;
}
function isFixture(value: unknown): value is KeychainFixture {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.getOwnPropertyDescriptor(value, 'fixture')?.value === true &&
    ['run', 'control', 'diagnostics', 'mapStatus'].every(
      (key) =>
        typeof Object.getOwnPropertyDescriptor(value, key)?.value ===
        'function',
    )
  );
}
assert.ok(isFixture(loaded.exports), 'Invalid fixture addon.');
const native = loaded.exports;
assert.equal(native.fixture, true);
const call = (): PlatformKeySlotCallOptions => ({
  signal: new AbortController().signal,
  interaction: 'never',
});
const namespace = resolveSecretProtectionPolicy({
  os: 'darwin',
  nativePath: addon,
  brandId: 'canopy',
  build: 'stable',
  authorityId: 'a'.repeat(64),
}).namespace;
const fixtureRun: KeychainNative['run'] = (...args) =>
  native.run(...args, keychain, 'cancel');
const make = (
  identity: KeychainNamespace = namespace,
): ReturnType<typeof createDarwinSecretProtection> =>
  createDarwinSecretProtection(
    () => ({
      run: fixtureRun,
    }),
    identity,
  );
const port = make();
const slot = { name: 'vault-restart' };
const material = new Uint8Array(32).fill(73);
let report: Record<string, unknown> = {};

if (mode === 'create') {
  assert.equal(native.control('create', keychain), 0);
} else if (mode === 'cleanup') {
  assert.equal(native.control('delete', keychain), 0);
} else if (mode === 'write') {
  assert.deepEqual(
    await port.writeKeySlot(slot, material, { ...call(), mode: 'create' }),
    { kind: 'written' },
  );
} else if (mode === 'read') {
  const recovered = await port.readKeySlot(slot, call());
  assert.equal(recovered.kind, 'present');
  assert.deepEqual(recovered.material, material);
  recovered.material.fill(0);
} else if (mode === 'lock') {
  assert.equal(native.control('lock', keychain), 0);
  assert.deepEqual(await port.status(call()), {
    state: 'locked',
    evidence: 'reported',
  });
  for (const interaction of ['never', 'allowed'] as const) {
    assert.deepEqual(await port.readKeySlot(slot, { ...call(), interaction }), {
      kind: 'blocked',
      reason: 'locked',
    });
    assert.deepEqual(
      await port.writeKeySlot(slot, material, {
        ...call(),
        interaction,
        mode: 'replace',
      }),
      { kind: 'blocked', reason: 'locked' },
    );
    assert.deepEqual(
      await port.deleteKeySlot(slot, { ...call(), interaction }),
      { kind: 'blocked', reason: 'locked' },
    );
  }
  report.expectedPrompts = 3;
} else if (mode === 'unlock') {
  assert.equal(native.control('unlock', keychain), 0);
  assert.deepEqual(await port.status(call()), { state: 'available' });
} else if (mode === 'repository-write' || mode === 'repository-recover') {
  const { openVaultStore } =
    await import('../../../../core-runtime/src/node/vault/repository/store');
  const { openVaultReadRepository } =
    await import('../../../../core-runtime/src/node/vault/repository/read-repository');
  const { createSecureFileServices } = await import('../../secure-files/index');
  const folder = resolve(keychain, '..', 'vault');
  async function openRepository(): Promise<{
    store: VaultStore;
    vault: VaultReadRepository;
  }> {
    const opened = await openVaultStore({
      folder,
      platform: {
        os: 'darwin',
        secureFiles: createSecureFileServices('darwin'),
      },
    });
    assert.equal(opened.kind, 'opened');
    const repository = await openVaultReadRepository({
      store: opened.store,
      slots: port,
      signal: call().signal,
    });
    assert.equal(repository.kind, 'opened');
    return { store: opened.store, vault: repository.vault };
  }
  if (mode === 'repository-write') {
    const { store, vault } = await openRepository();
    try {
      const result = await vault.writer('test.family').put({
        entryId: null,
        expectedRevision: null,
        family: 'test.family',
        label: 'Disposable',
        material,
        expiresAt: null,
        idempotencyKey: 'native-seed',
      });
      assert.equal(result.kind, 'committed');
    } finally {
      vault.dispose();
      store.close();
    }
  } else {
    const initial = await openRepository();
    const metadata = await initial.vault.repository.list();
    assert.equal(metadata.length, 1);
    const ref = metadata[0].ref;
    const header = initial.store.header;
    assert.ok(header);
    const stored = initial.store.readEntry(ref.entryId);
    const keySlot = { name: `vault-${header.vaultId}` };
    const original = await port.readKeySlot(keySlot, call());
    assert.equal(original.kind, 'present');
    initial.vault.dispose();
    initial.store.close();
    async function expectRead(
      expected: 'available' | 'locked' | 'key_missing',
    ): Promise<void> {
      const { store, vault } = await openRepository();
      try {
        assert.deepEqual(
          store.header,
          header,
          'recovery must not initialize another vault',
        );
        assert.deepEqual(
          store.readEntry(ref.entryId),
          stored,
          'recovery must preserve ciphertext',
        );
        const result = await vault.repository.get(ref);
        if (expected === 'available') {
          assert.equal(result.kind, 'available');
          assert.deepEqual(result.material, material);
          result.material.fill(0);
        } else assert.deepEqual(result, { kind: 'blocked', reason: expected });
      } finally {
        vault.dispose();
        store.close();
      }
    }
    try {
      await expectRead('available');
      assert.equal(native.control('lock', keychain), 0);
      await expectRead('locked');
      assert.equal(native.control('unlock', keychain), 0);
      await expectRead('available');
      assert.deepEqual(await port.deleteKeySlot(keySlot, call()), {
        kind: 'deleted',
      });
      await expectRead('key_missing');
      for (const replacement of [
        new Uint8Array([1]),
        new Uint8Array(32).fill(9),
      ]) {
        const result = await port.writeKeySlot(keySlot, replacement, {
          ...call(),
          mode: 'create',
        });
        assert.equal(result.kind, 'written');
        await expectRead('key_missing');
        await port.deleteKeySlot(keySlot, call());
      }
      assert.deepEqual(
        await port.writeKeySlot(keySlot, original.material, {
          ...call(),
          mode: 'create',
        }),
        { kind: 'written' },
      );
      await expectRead('available');
    } finally {
      original.material.fill(0);
      assert.equal(native.control('unlock', keychain), 0);
    }
  }
} else if (mode === 'unavailable') {
  const missing = createDarwinSecretProtection(
    () => ({
      run: (...args): Promise<unknown> =>
        native.run(...args, `${keychain}.missing`, 'cancel'),
    }),
    namespace,
  );
  assert.deepEqual(await missing.readKeySlot(slot, call()), {
    kind: 'blocked',
    reason: 'unavailable',
  });
} else if (mode === 'prompt') {
  let attempts = 0;
  for (const response of [
    'cancel',
    'deny',
    'unavailable',
    'unknown',
    'success',
  ]) {
    assert.equal(native.control('lock', keychain), 0);
    const run: KeychainNative['run'] = (...args) =>
      native.run(...args, keychain, response);
    const subject = createDarwinSecretProtection(() => ({ run }), namespace);
    const before = native.diagnostics().prompts;
    assert.deepEqual(await subject.status(call()), {
      state: 'locked',
      evidence: 'reported',
    });
    assert.deepEqual(await subject.readKeySlot(slot, call()), {
      kind: 'blocked',
      reason: 'locked',
    });
    assert.equal(native.diagnostics().prompts, before);
    const value = await subject.readKeySlot(slot, {
      ...call(),
      interaction: 'allowed',
    });
    assert.deepEqual(
      value,
      response === 'success'
        ? { kind: 'absent' }
        : {
            kind: 'blocked',
            reason:
              response === 'cancel' || response === 'deny'
                ? 'locked'
                : 'unavailable',
          },
    );
    assert.equal(native.diagnostics().prompts, before + 1);
    attempts++;
  }
  report.expectedPrompts = attempts;
} else if (mode === 'mapping') {
  for (const status of [-25293, -128, -25308, -25315])
    assert.equal(native.mapStatus('unlock', status), 'locked');
  assert.equal(native.mapStatus('unlock', -199999), 'unavailable');
  for (const operation of ['read', 'create', 'replace', 'delete'] as const) {
    for (const [status, code] of [
      [0, 'ok'],
      [-25293, 'denied'],
      [-128, 'denied'],
      [-25308, 'interaction_required'],
      [-25315, 'interaction_required'],
      [-25291, 'unavailable'],
    ] as const) {
      assert.equal(native.mapStatus(operation, status), code);
    }
    assert.equal(
      native.mapStatus(operation, -199999),
      operation === 'read' ? 'unavailable' : 'uncertain',
    );
  }
  assert.equal(native.mapStatus('read', -25300), 'absent');
  assert.equal(native.mapStatus('delete', -25300), 'absent');
  assert.equal(native.mapStatus('replace', -25300), 'conflict');
  assert.equal(native.mapStatus('create', -25299), 'conflict');
  assert.equal(native.mapStatus('read', -26275), 'corrupt');
} else if (mode === 'conformance') {
  const tests: { name: string; body: () => Promise<void> }[] = [];
  runSecretProtectionConformance(
    {
      describe: (_name, body) => body(),
      it: (name, body) => tests.push({ name, body }),
    },
    (): SecretProtectionConformanceSubject => ({
      port: make(),
      prompts: () => native.diagnostics().prompts,
    }),
    { withFaults: false, slotPrefix: 'native-contract' },
  );
  for (const { name, body } of tests) {
    try {
      await body();
    } catch (error) {
      throw Object.assign(new Error(name), { cause: error });
    }
  }
  report.tests = tests.length;
  // Separate instances submit concurrent create calls to the native backend.
  const concurrentSlot = { name: 'concurrent-create' };
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      make().writeKeySlot(concurrentSlot, material, {
        ...call(),
        mode: 'create',
      }),
    ),
  );
  assert.equal(results.filter((value) => value.kind === 'written').length, 1);
  assert.equal(results.filter((value) => value.kind === 'conflict').length, 7);
  assert.deepEqual(await port.deleteKeySlot(concurrentSlot, call()), {
    kind: 'deleted',
  });
} else if (mode === 'namespace') {
  // V-3: brand + build must separate both names even at the same authority.
  const identity = (
    brandId: string,
    rootPath: string,
    uid = 501,
  ): ReturnType<typeof deriveLocalAuthorityIdentity> =>
    deriveLocalAuthorityIdentity(
      { brandId, dataRoot: rootPath },
      { platform: 'darwin', getuid: () => uid },
    );
  const canopy = await identity('canopy', root);
  const otherRoot = await identity('canopy', resolve(root, 'packages'));
  const otherPrincipal = await identity('canopy', root, 502);
  const otherBrand = await identity('unstoppable-code', root);
  const stable = make({ ...namespace, authorityId: canopy.authorityId });
  const sameIdentity = make({
    ...namespace,
    authorityId: (await identity('canopy', root)).authorityId,
  });
  const name = { name: 'namespace-isolation' };
  assert.deepEqual(
    await stable.writeKeySlot(name, material, { ...call(), mode: 'create' }),
    { kind: 'written' },
  );
  try {
    const same = await sameIdentity.readKeySlot(name, call());
    assert.equal(same.kind, 'present');
    same.material.fill(0);
    for (const authority of [otherRoot, otherPrincipal, otherBrand]) {
      assert.deepEqual(
        await make({
          ...namespace,
          authorityId: authority.authorityId,
        }).readKeySlot(name, call()),
        { kind: 'absent' },
      );
    }

    const pairs: ReturnType<typeof make>[] = [];
    for (const brandId of ['canopy', 'unstoppable-code'] as const) {
      for (const build of ['stable', 'internal', 'rc', 'dev'] as const) {
        const policy = resolveSecretProtectionPolicy({
          os: 'darwin',
          nativePath: addon,
          brandId,
          build,
          authorityId: canopy.authorityId,
        });
        assert.equal(policy.enabled, true);
        pairs.push(make(policy.namespace));
        // All builds must still refuse a fixture addon through the product loader.
        const forged = createSecretProtectionServices({
          os: 'darwin',
          nativePath: addon,
          brandId,
          build,
          authorityId: canopy.authorityId,
        });
        assert.deepEqual(await forged.status(call()), {
          state: 'unavailable',
          reason: 'backend_failed',
        });
        assert.deepEqual(await forged.readKeySlot(name, call()), {
          kind: 'blocked',
          reason: 'unavailable',
        });
      }
    }
    const buildSlot = { name: 'brand-build-isolation' };
    try {
      for (const [i, writer] of pairs.entries()) {
        const bytes = new Uint8Array([i + 1]);
        try {
          assert.deepEqual(
            await writer.writeKeySlot(buildSlot, bytes, {
              ...call(),
              mode: 'create',
            }),
            { kind: 'written' },
          );
        } finally {
          bytes.fill(0);
        }
      }
      for (const [i, reader] of pairs.entries()) {
        const result = await reader.readKeySlot(buildSlot, call());
        assert.equal(result.kind, 'present');
        assert.deepEqual([...result.material], [i + 1]);
        result.material.fill(0);
      }
    } finally {
      for (const pair of pairs) await pair.deleteKeySlot(buildSlot, call());
    }
    const account = `${namespace.service}/${namespace.authorityId}/valid`;
    const before = native.diagnostics().apiCalls;
    for (const [service, invalidAccount] of [
      ['other.stable.vault', account],
      ['canopy.prod.vault', account],
      ['canopy.stable.vault\n', account],
      [namespace.service, `canopy.dev.vault/${namespace.authorityId}/valid`],
      [namespace.service, `${namespace.service}/${'A'.repeat(64)}/valid`],
      [namespace.service, `${namespace.service}/${namespace.authorityId}/`],
      [namespace.service, `${account}/escape`],
      [
        namespace.service,
        `${namespace.service}/${namespace.authorityId}/${'a'.repeat(65)}`,
      ],
    ] as const) {
      assert.throws(
        () =>
          native.run(
            'read',
            service,
            invalidAccount,
            new Uint8Array(),
            keychain,
            'cancel',
          ),
        TypeError,
      );
    }
    assert.equal(native.diagnostics().apiCalls, before);
  } finally {
    await stable.deleteKeySlot(name, call());
  }
} else {
  throw new Error('Unknown fixture mode.');
}
const diagnostics = native.diagnostics();
assert.equal(diagnostics.prompts, report.expectedPrompts ?? 0);
assert.equal(diagnostics.ownedBytes, 0);
report = { ...report, ...diagnostics };
material.fill(0);
process.stdout.write(`${JSON.stringify(report)}\n`);
