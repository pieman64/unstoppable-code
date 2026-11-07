import { prepareNativeQualification } from './fixtures/native-vault-qualification';
import { readCredentialProfileDiagnostic } from './fixtures/credential-profile-diagnostics';
import type { PreparedNativeArtifact } from '../secret-protection/authorization';
import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { runSecretProtectionConformance } from '@canopy/core-runtime/platform/testing';
import { createSecretProtectionServices } from '../secret-protection';
import { nativeCode } from '../secret-protection/native-results';
import {
  credentialMutexName,
  createWindowsSecretProtection,
} from '../secret-protection/win32';
import type { PlatformSecretProtectionServices } from '@canopy/core-runtime';
import { storeFolder } from '../../../core-runtime/src/node/vault/repository/__tests__/store-fixtures';
import { openVaultReadRepository } from '../../../core-runtime/src/node/vault/repository/read-repository';
import { initializeVault } from '../../../core-runtime/src/node/vault/repository/store-init';
import { createVaultKeyHolder } from '../../../core-runtime/src/node/vault/repository/key-holder';

const windows = process.platform === 'win32' ? describe : describe.skip;
const root = resolve(__dirname, '../../../..');
const fixtures = join(__dirname, 'fixtures');
const run = promisify(execFile);
const prefix = `w${randomUUID().replaceAll('-', '').slice(0, 20)}`;
const authority = createHash('sha256').update(prefix).digest('hex');
let preparedNative: PreparedNativeArtifact | undefined;
let disposePreparation: (() => Promise<void>) | undefined;
let directory = '',
  addon = '',
  principal = '',
  aclFixturePath = '';
interface MutexFixture {
  corruptSlot(target: string, sid: string): void;
  holdMutex(name: string, sid: string, owned: boolean): unknown;
  releaseMutex(handle: unknown): void;
}
let mutexFixture: MutexFixture | undefined;
interface FaultFixture {
  run(
    operation: string,
    target: string,
    mutex: string,
    material: Uint8Array,
    principal: string,
    cancellation: Uint32Array,
  ): Promise<unknown>;
  arm(fault: number): void;
  audit(): { work: boolean; copy: boolean; credential: boolean };
  waitEntry(): boolean;
}
let faultFixture: FaultFixture | undefined;
function isFaultFixture(value: unknown): value is FaultFixture {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.getOwnPropertyDescriptor(value, 'fixture')?.value === true &&
    ['run', 'arm', 'audit', 'waitEntry'].every(
      (key) =>
        typeof Object.getOwnPropertyDescriptor(value, key)?.value ===
        'function',
    )
  );
}
function faults(): FaultFixture {
  if (!faultFixture) throw new Error('No native fault fixture.');
  return faultFixture;
}

const nativeHandles = new Set<unknown>();
function isFixture(value: unknown): value is MutexFixture {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.getOwnPropertyDescriptor(value, 'fixture')?.value === true &&
    typeof Object.getOwnPropertyDescriptor(value, 'holdMutex')?.value ===
      'function' &&
    typeof Object.getOwnPropertyDescriptor(value, 'releaseMutex')?.value ===
      'function' &&
    typeof Object.getOwnPropertyDescriptor(value, 'corruptSlot')?.value ===
      'function'
  );
}
function holdNative(name: string): unknown {
  if (!mutexFixture) throw new Error('No native mutex fixture.');
  const handle = mutexFixture.holdMutex(
    credentialMutexName(target(name), principal),
    principal,
    false,
  );
  nativeHandles.add(handle);
  return handle;
}
function releaseNative(handle: unknown): void {
  mutexFixture?.releaseMutex(handle);
  nativeHandles.delete(handle);
}
const held = new Set<ChildProcessWithoutNullStreams>();
const slots = new Set<string>();
function track(name: string): void {
  if (/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) slots.add(name);
}
const call = (): { signal: AbortSignal; interaction: 'never' } => ({
  signal: new AbortController().signal,
  interaction: 'never',
});
const target = (name: string): string =>
  `canopy.vault.v1/canopy/dev/${authority}/${name}`;
function port(sid = principal): PlatformSecretProtectionServices {
  return createSecretProtectionServices({
    os: 'win32',
    preparedNative,
    applicationId: 'com.canopy.dev',
    authorityId: authority,
    brandId: 'canopy',
    build: 'dev',
    windowsPrincipalSid: sid,
  });
}
function powershell(): string {
  return join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32/WindowsPowerShell/v1.0/powershell.exe',
  );
}
const psArgs = (script: string, args: string[]): string[] => [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  join(fixtures, script),
  ...args,
];
function start(
  program: string,
  args: string[],
): {
  child: ChildProcessWithoutNullStreams;
  lines: AsyncIterableIterator<string>;
} {
  const child = spawn(program, args, {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  held.add(child);
  return {
    child,
    lines: createInterface({ input: child.stdout })[Symbol.asyncIterator](),
  };
}
async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.stdin.end();
  await closed;
}
async function ready(lines: AsyncIterableIterator<string>): Promise<void> {
  expect((await lines.next()).value).toBe('ready');
}
async function holder(
  name: string,
  mode = 'private',
): Promise<ReturnType<typeof start>> {
  const child = start(
    powershell(),
    psArgs('credential-mutex.ps1', [
      '-Name',
      credentialMutexName(target(name), principal),
      '-Mode',
      mode,
    ]),
  );
  await ready(child.lines);
  return child;
}

windows(
  'native Windows Credential Manager contract (synthetic disposable slots)',
  () => {
    beforeAll(async () => {
      directory = mkdtempSync(join(tmpdir(), 'credential-native-'));
      // Windows keeps loaded addons mapped until Jest exits; keep only that build in the ignored native cache.
      addon = join(
        root,
        '.cache/native-secret-protection',
        `qualification-${prefix}.node`,
      );
      aclFixturePath = join(
        root,
        '.cache/native-secret-protection',
        `qualification-${prefix}-acl.node`,
      );
      const errorContract = join(directory, 'credential-error-contract.exe');
      const faultAddon = join(
        root,
        '.cache/native-secret-protection',
        `qualification-${prefix}-fault.node`,
      );
      execFileSync(
        process.execPath,
        [
          join(root, 'scripts/build-secret-protection.mjs'),
          '--out',
          addon,
          '--test-out',
          errorContract,
          '--fixture-out',
          aclFixturePath,
          '--fault-out',
          faultAddon,
        ],
        { cwd: root, stdio: 'pipe', timeout: 240_000 },
      );
      const sea: unknown = JSON.parse(
        execFileSync(
          process.execPath,
          [
            join(root, 'scripts/lib/native-vault-sea-qualification.mjs'),
            addon,
            join(directory, 'renamed-sea'),
          ],
          { encoding: 'utf8', timeout: 120_000 },
        )
          .trim()
          .split(/\r?\n/)
          .at(-1) ?? '',
      );
      expect(sea).toMatchObject({
        valid: { loads: 1 },
        replaced: { loads: 0 },
      });
      ({ capability: preparedNative, dispose: disposePreparation } =
        await prepareNativeQualification(
          addon,
          directory,
          join(tmpdir(), 'canopy-native-vault-qualification'),
        ));
      const loaded = { exports: {} };
      process.dlopen(loaded, aclFixturePath);
      if (!isFixture(loaded.exports))
        throw new Error('Invalid native mutex fixture.');
      mutexFixture = loaded.exports;
      const faultLoaded = { exports: {} };
      process.dlopen(faultLoaded, faultAddon);
      if (!isFaultFixture(faultLoaded.exports))
        throw new Error('Invalid native fault fixture.');
      faultFixture = faultLoaded.exports;
      execFileSync(errorContract, [], { stdio: 'pipe', timeout: 10000 });
      const { stdout } = await run(
        powershell(),
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
        ],
        { windowsHide: true, timeout: 15000 },
      );
      principal = stdout.trim();
      // Unsupported sessions fail qualification; they must not become an all-skipped pass.
      expect(await port().status(call())).toEqual({ state: 'unknown' });
    }, 300_000);
    afterAll(async () => {
      for (const child of held) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const closed = once(child, 'close');
        child.kill();
        await closed;
      }
      for (const handle of nativeHandles) releaseNative(handle);
      if (principal && addon)
        for (const name of slots) await port().deleteKeySlot({ name }, call());
      await disposePreparation?.();
      if (directory)
        rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
    });

    runSecretProtectionConformance(
      { describe, it },
      () => {
        const service = port();
        const wrapped: PlatformSecretProtectionServices = {
          backend: service.backend,
          status: (options) => service.status(options),
          readKeySlot: (slot, options) => {
            track(slot.name);
            return service.readKeySlot(slot, options);
          },
          writeKeySlot: (slot, bytes, options) => {
            track(slot.name);
            return service.writeKeySlot(slot, bytes, options);
          },
          deleteKeySlot: (slot, options) => {
            track(slot.name);
            return service.deleteKeySlot(slot, options);
          },
        };
        // Prompt absence is source-reviewed; this kit does not observe OS UI.
        return { port: wrapped, prompts: (): number => 0 };
      },
      { withFaults: false, slotPrefix: prefix },
    );

    test('product factory refuses the separately marked fixture addon', async () => {
      const service = createSecretProtectionServices({
        os: 'win32',
        nativePath: aclFixturePath,
        applicationId: 'com.canopy.dev',
        authorityId: authority,
        brandId: 'canopy',
        build: 'dev',
        windowsPrincipalSid: principal,
      });
      expect(await service.status(call())).toEqual({
        state: 'unavailable',
        reason: 'backend_failed',
      });
    });

    test('two processes race create; exactly one wins and the winner remains unchanged', async () => {
      const name = `${prefix}-race`;
      slots.add(name);
      const launch = (bytes: number[]): ReturnType<typeof start> => {
        const file = join(directory, `request-${bytes[0]}.json`);
        writeFileSync(
          file,
          JSON.stringify({
            mode: 'race',
            target: target(name),
            principal,
            bytes,
          }),
        );
        return start(process.execPath, [
          join(fixtures, 'credential-child.ts'),
          addon,
          file,
        ]);
      };
      const a = launch([41]),
        b = launch([42]);
      await Promise.all([ready(a.lines), ready(b.lines)]);
      a.child.stdin.write('go\n');
      b.child.stdin.write('go\n');
      const aReply = nativeCode(
        JSON.parse(String((await a.lines.next()).value ?? '{}')),
      );
      const bReply = nativeCode(
        JSON.parse(String((await b.lines.next()).value ?? '{}')),
      );
      expect([aReply, bReply].sort()).toEqual(['conflict', 'ok']);
      const read = await port().readKeySlot({ name }, call());
      expect(read).toEqual({
        kind: 'present',
        material: new Uint8Array([aReply === 'ok' ? 41 : 42]),
      });
      if (read.kind === 'present') read.material.fill(0);
      await Promise.all([stop(a.child), stop(b.child)]);
    }, 30000);

    test('two processes order replace and delete without resurrecting the slot', async () => {
      const name = `${prefix}-ordering`;
      slots.add(name);
      expect(
        await port().writeKeySlot({ name }, new Uint8Array([31]), {
          ...call(),
          mode: 'create',
        }),
      ).toEqual({ kind: 'written' });
      const launch = (
        operation: 'replace' | 'delete',
      ): ReturnType<typeof start> => {
        const file = join(directory, `${operation}.json`);
        writeFileSync(
          file,
          JSON.stringify({
            mode: 'race',
            operation,
            target: target(name),
            principal,
            bytes: [32],
          }),
        );
        return start(process.execPath, [
          join(fixtures, 'credential-child.ts'),
          addon,
          file,
        ]);
      };
      const replace = launch('replace'),
        remove = launch('delete');
      await Promise.all([ready(replace.lines), ready(remove.lines)]);
      replace.child.stdin.write('go\n');
      remove.child.stdin.write('go\n');
      const replaced = nativeCode(
        JSON.parse(String((await replace.lines.next()).value ?? '{}')),
      );
      const deleted = nativeCode(
        JSON.parse(String((await remove.lines.next()).value ?? '{}')),
      );
      expect(['ok', 'conflict']).toContain(replaced);
      expect(deleted).toBe('ok');
      await Promise.all([stop(replace.child), stop(remove.child)]);
      expect(await port().readKeySlot({ name }, call())).toEqual({
        kind: 'absent',
      });
    }, 30000);

    test('replace repairs a corrupt slot, while create conflicts without changing it', async () => {
      const name = `${prefix}-corrupt`;
      slots.add(name);
      if (!mutexFixture) throw new Error('No corrupt-slot fixture.');
      mutexFixture.corruptSlot(target(name), principal);
      expect(await port().readKeySlot({ name }, call())).toEqual({
        kind: 'corrupt',
      });
      expect(
        await port().writeKeySlot({ name }, new Uint8Array([7]), {
          ...call(),
          mode: 'create',
        }),
      ).toEqual({ kind: 'conflict' });
      expect(await port().readKeySlot({ name }, call())).toEqual({
        kind: 'corrupt',
      });
      expect(
        await port().writeKeySlot({ name }, new Uint8Array([7]), {
          ...call(),
          mode: 'replace',
        }),
      ).toEqual({ kind: 'written' });
      expect(await port().readKeySlot({ name }, call())).toEqual({
        kind: 'present',
        material: new Uint8Array([7]),
      });
    });

    test('foreign principal refuses before mutation', async () => {
      const name = `${prefix}-principal`;
      slots.add(name);
      expect(
        await port('S-1-5-18').writeKeySlot({ name }, new Uint8Array([1]), {
          ...call(),
          mode: 'create',
        }),
      ).toEqual({ kind: 'blocked', reason: 'denied' });
      expect(await port().readKeySlot({ name }, call())).toEqual({
        kind: 'absent',
      });
    });

    test.each(['collision', 'event'])(
      'unsafe synchronization %s collision refuses without touching credentials',
      async (mode) => {
        const name = `${prefix}-${mode}`;
        slots.add(name);
        const hold = await holder(name, mode);
        try {
          expect(
            await port().writeKeySlot({ name }, new Uint8Array([1]), {
              ...call(),
              mode: 'create',
            }),
          ).toEqual({ kind: 'blocked', reason: 'denied' });
        } finally {
          await stop(hold.child);
        }
      },
      20000,
    );

    test('waiting cancellation settles without mutation; bounded contention also refuses', async () => {
      const name = `${prefix}-cancel`;
      slots.add(name);
      const hold = await holder(name);
      try {
        const controller = new AbortController();
        const pending = port().writeKeySlot({ name }, new Uint8Array([1]), {
          ...call(),
          signal: controller.signal,
          mode: 'create',
        });
        // The native worker sees an atomic cancellation flag even while waiting for another process.
        setImmediate(() => controller.abort(new Error('waiting')));
        await expect(pending).rejects.toThrow('waiting');
        const began = Date.now();
        expect(
          await port().writeKeySlot({ name }, new Uint8Array([2]), {
            ...call(),
            mode: 'create',
          }),
        ).toEqual({ kind: 'blocked', reason: 'unavailable' });
        expect(Date.now() - began).toBeLessThan(10000);
      } finally {
        await stop(hold.child);
      }
      expect(await port().readKeySlot({ name }, call())).toEqual({
        kind: 'absent',
      });
    }, 30000);

    test('native wait entry is observed before cancellation; no delayed mutation lands', async () => {
      const name = `${prefix}-wait-entry`;
      slots.add(name);
      const hold = await holder(name);
      const fixture = faults();
      fixture.arm(0);
      let dispatched: () => void = () => undefined;
      const dispatch = new Promise<void>((resolve) => {
        dispatched = resolve;
      });
      const service = createWindowsSecretProtection(
        () => ({
          run: (...args): Promise<unknown> => {
            const result = fixture.run(...args);
            dispatched();
            return result;
          },
        }),
        {
          prefix: `canopy.vault.v1/canopy/dev/${authority}/`,
          principalSid: principal,
        },
      );
      const controller = new AbortController();
      try {
        const pending = service.writeKeySlot({ name }, new Uint8Array([81]), {
          ...call(),
          mode: 'create',
          signal: controller.signal,
        });
        await dispatch;
        expect(fixture.waitEntry()).toBe(true);
        controller.abort(new Error('native wait entered'));
        await expect(pending).rejects.toThrow('native wait entered');
      } finally {
        await stop(hold.child);
      }
      expect(await port().readKeySlot({ name }, call())).toEqual({
        kind: 'absent',
      });
      expect(fixture.audit()).toEqual({
        work: true,
        copy: true,
        credential: false,
      });
    }, 20000);

    test('native boundary rejects embedded-NUL operations and detachable cancellation storage', async () => {
      const name = `${prefix}-native-invalid`;
      slots.add(name);
      const fixture = faults();
      fixture.arm(0);
      const mutex = credentialMutexName(target(name), principal);
      expect(() =>
        fixture.run(
          'read\0ignored',
          target(name),
          mutex,
          new Uint8Array(),
          principal,
          new Uint32Array(new SharedArrayBuffer(4)),
        ),
      ).toThrow('Invalid secret protection call');
      expect(() =>
        fixture.run(
          'read',
          target(name),
          mutex,
          new Uint8Array(),
          principal,
          new Uint32Array(1),
        ),
      ).toThrow('Invalid secret protection call');
      expect(fixture.audit()).toEqual({
        work: true,
        copy: true,
        credential: false,
      });
      expect(await port().readKeySlot({ name }, call())).toEqual({
        kind: 'absent',
      });
    });

    test('native reads erase credentials and work; N-API failures also erase unreturned copies', async () => {
      const name = `${prefix}-native-fault`;
      slots.add(name);
      const fixture = faults();
      const mutex = credentialMutexName(target(name), principal);
      const invoke = (): Promise<unknown> =>
        fixture.run(
          'read',
          target(name),
          mutex,
          new Uint8Array(),
          principal,
          new Uint32Array(new SharedArrayBuffer(4)),
        );
      const mutate = (): Promise<unknown> =>
        fixture.run(
          'create',
          target(name),
          mutex,
          new Uint8Array([91]),
          principal,
          new Uint32Array(new SharedArrayBuffer(4)),
        );
      fixture.arm(1);
      expect(mutate).toThrow('allocation failed');
      fixture.arm(6);
      expect(mutate).toThrow('Invalid secret protection call');
      expect(fixture.audit()).toEqual({
        work: true,
        copy: true,
        credential: false,
      });
      expect(
        await port().writeKeySlot({ name }, new Uint8Array([91]), {
          ...call(),
          mode: 'create',
        }),
      ).toEqual({ kind: 'written' });
      fixture.arm(0);
      expect(await invoke()).toEqual({
        code: 'ok',
        material: Buffer.from([91]),
      });
      expect(fixture.audit()).toEqual({
        work: true,
        copy: true,
        credential: true,
      });
      for (const fault of [2, 3, 4]) {
        fixture.arm(fault);
        await expect(invoke()).rejects.toThrow('completion failed');
        expect(fixture.audit()).toEqual({
          work: true,
          copy: true,
          credential: true,
        });
        expect(await port().readKeySlot({ name }, call())).toEqual({
          kind: 'present',
          material: new Uint8Array([91]),
        });
      }
    });

    test('submitted mutation keeps its actual outcome after native cancellation is observed', async () => {
      const name = `${prefix}-entered`;
      slots.add(name);
      const fixture = faults();
      fixture.arm(5);
      const cancel = new Uint32Array(new SharedArrayBuffer(4));
      expect(
        await fixture.run(
          'create',
          target(name),
          credentialMutexName(target(name), principal),
          new Uint8Array([82]),
          principal,
          cancel,
        ),
      ).toEqual({ code: 'ok' });
      expect(Atomics.load(cancel, 0)).toBe(1);
      expect(await port().readKeySlot({ name }, call())).toEqual({
        kind: 'present',
        material: new Uint8Array([82]),
      });
    });

    test('abandoned synchronization object recovers from the authoritative credential', async () => {
      const name = `${prefix}-abandoned`;
      slots.add(name);
      expect(
        await port().writeKeySlot({ name }, new Uint8Array([37]), {
          ...call(),
          mode: 'create',
        }),
      ).toEqual({ kind: 'written' });
      const retained = holdNative(name);
      const request = join(directory, 'abandoned.json');
      writeFileSync(
        request,
        JSON.stringify({ mode: 'hold', target: target(name), principal }),
      );
      const hold = start(process.execPath, [
        join(fixtures, 'credential-child.ts'),
        aclFixturePath,
        request,
      ]);
      try {
        await ready(hold.lines);
        const closed = once(hold.child, 'close');
        hold.child.kill();
        await closed;
        // The independent native handle preserves the abandoned object, even before a waiter enters.
        expect(await port().readKeySlot({ name }, call())).toEqual({
          kind: 'present',
          material: new Uint8Array([37]),
        });
      } finally {
        releaseNative(retained);
      }
    }, 20000);

    test('loaded independent profile has a positive control; same-name B writes/deletes preserve A', async () => {
      const name = `${prefix}-profile`;
      slots.add(name);
      expect(
        await port().writeKeySlot({ name }, new Uint8Array([11]), {
          ...call(),
          mode: 'create',
        }),
      ).toEqual({ kind: 'written' });
      const files = ['credential-child.ts', 'credential-profile-child.ps1'];
      for (const file of files)
        copyFileSync(join(fixtures, file), join(directory, file));
      // The runner's node.exe may live under an owner-only TEMP ancestor.
      const profileNode = join(directory, 'node.exe');
      copyFileSync(process.execPath, profileNode);
      const profileAddon = join(directory, 'profile.node');
      copyFileSync(addon, profileAddon);
      const request = join(directory, 'profile.json');
      const output = join(directory, 'profile-output.json');
      const challenge = randomUUID();
      const stage = join(
        process.env.ProgramData ?? 'C:\\ProgramData',
        `canopy-credential-${randomUUID()}`,
      );
      const stageCreated = join(directory, 'profile-stage-created');
      const diagnosticReport = join(directory, 'profile-child-diagnostics.log');
      rmSync(stageCreated, { force: true });
      rmSync(diagnosticReport, { force: true });
      writeFileSync(
        request,
        JSON.stringify({
          mode: 'profile',
          challenge,
          target: target(name),
          mutex: credentialMutexName(target(name), principal),
          output,
          vaultFile: join(directory, 'vault/synthetic.db'),
        }),
      );
      const retained = holdNative(name);
      const profileStarted = performance.now();
      process.stderr.write(
        `credential-profile launch:start utc=${new Date().toISOString()}\n`,
      );
      let profileStderr = '';
      try {
        const { stderr } = await run(
          powershell(),
          psArgs('credential-profile.ps1', [
            '-Node',
            profileNode,
            '-Addon',
            profileAddon,
            '-Child',
            join(directory, 'credential-child.ts'),
            '-Request',
            request,
            '-Root',
            directory,
            '-Stage',
            stage,
          ]),
          { windowsHide: true, timeout: 45000, maxBuffer: 1 << 20 },
        );
        profileStderr = stderr;
        process.stderr.write(stderr);
        const receipt: unknown = JSON.parse(readFileSync(output, 'utf8'));
        expect(receipt).toMatchObject({
          challenge,
          status: { code: 'unknown' },
          controlCreate: { code: 'ok' },
          controlRead: { code: 'ok', material: [22] },
          probe: { code: 'absent' },
          sameCreate: { code: 'ok' },
          sameRead: { code: 'ok', material: [23] },
          sameDelete: { code: 'ok' },
          controlDelete: { code: 'ok' },
          directoryDenied: true,
          mutexDenied: true,
        });
      } catch (error) {
        const stderr: unknown =
          typeof error === 'object' && error !== null
            ? Reflect.get(error, 'stderr')
            : undefined;
        const diagnostics = [
          typeof stderr === 'string' ? stderr : profileStderr,
        ];
        // A persists the report before deleting staging; timeout may bypass that finally.
        if (existsSync(diagnosticReport))
          diagnostics.push(
            readCredentialProfileDiagnostic(diagnosticReport, 16384),
          );
        else if (existsSync(stageCreated))
          for (const log of [
            'profile-child-host.log',
            'profile-child-ps.log',
            'profile-child-node.log',
          ])
            diagnostics.push(readCredentialProfileDiagnostic(join(stage, log)));
        else diagnostics.push('credential-profile staging-not-created');
        // Jest reporters retain the thrown message even when stderr is buffered or omitted.
        throw new Error(
          `Independent credential profile failed.\n${diagnostics.join('\n')}`,
          { cause: error },
        );
      } finally {
        process.stderr.write(
          `credential-profile launch:finished elapsedMs=${Math.round(performance.now() - profileStarted)}\n`,
        );
        releaseNative(retained);
        // execFile's timeout can kill PowerShell before its finally runs.
        // The marker is A-only and written only after exclusive protected creation.
        if (existsSync(stageCreated))
          rmSync(stage, {
            recursive: true,
            force: true,
            maxRetries: 20,
            retryDelay: 100,
          });
      }
      expect(await port().readKeySlot({ name }, call())).toEqual({
        kind: 'present',
        material: new Uint8Array([11]),
      });
    }, 60000);

    test.each(['missing', 'wrong', 'short', 'corrupt'])(
      'recovery with %s KEK preserves the database and never creates a replacement',
      async (failure) => {
        // Real SQLite + native slots. ACLs/flush are independently qualified, not this recording store fixture.
        const folder = storeFolder();
        const store = await folder.opened();
        const service = port();
        try {
          const first = await openVaultReadRepository({
            store,
            slots: service,
            signal: call().signal,
          });
          expect(first.kind).toBe('opened');
          if (first.kind !== 'opened') throw new Error('vault not opened');
          const name = `vault-${first.vault.vaultId}`;
          slots.add(name);
          expect(first.vault.repository.status()).toMatchObject({
            protection: { state: 'available' },
          });
          const header = store.header;
          if (!header) throw new Error('no vault header');
          // Cached keys are not an immediate-revocation mechanism.
          if (failure === 'missing')
            await service.deleteKeySlot({ name }, call());
          else if (failure === 'corrupt') {
            if (!mutexFixture) throw new Error('No corrupt-slot fixture.');
            mutexFixture.corruptSlot(target(name), principal);
            expect(await service.readKeySlot({ name }, call())).toEqual({
              kind: 'corrupt',
            });
          } else
            await service.writeKeySlot(
              { name },
              new Uint8Array(failure === 'short' ? 1 : 32).fill(9),
              { ...call(), mode: 'replace' },
            );
          expect(first.vault.repository.status()).toMatchObject({
            protection: { state: 'available' },
          });
          first.vault.dispose();
          const before = readFileSync(join(folder.folder, 'vault.sqlite'));
          const writes = jest.spyOn(service, 'writeKeySlot');
          const reopened = await openVaultReadRepository({
            store,
            slots: service,
            signal: call().signal,
          });
          if (reopened.kind !== 'opened')
            throw new Error('recovery view not opened');
          expect(reopened.vault.repository.status()).toMatchObject({
            protection: { state: 'key_missing' },
          });
          expect(writes).not.toHaveBeenCalled();
          expect(readFileSync(join(folder.folder, 'vault.sqlite'))).toEqual(
            before,
          );
          const unprobed = createVaultKeyHolder({
            slots: service,
            header,
            clock: () => new Date(),
            probeTimeoutMs: 5000,
            minProbeIntervalMs: 0,
          });
          const reads = jest.spyOn(service, 'readKeySlot');
          expect(unprobed.status()).toMatchObject({
            protection: { state: 'unknown' },
          });
          expect(reads).not.toHaveBeenCalled();
          unprobed.dispose();
          reopened.vault.dispose();
        } finally {
          store.close();
          folder.remove();
        }
      },
    );

    test('header initialization failure preserves its orphan slot without rekey or cleanup', async () => {
      const folder = storeFolder();
      const store = await folder.opened({
        beforeWrite: () => {
          throw new Error('header refused');
        },
      });
      const service = port();
      let orphan: string | undefined;
      const write = service.writeKeySlot.bind(service);
      jest
        .spyOn(service, 'writeKeySlot')
        .mockImplementation((slot, bytes, options) => {
          orphan = slot.name;
          slots.add(slot.name);
          return write(slot, bytes, options);
        });
      const remove = jest.spyOn(service, 'deleteKeySlot');
      try {
        expect(
          await initializeVault(store, service, call().signal),
        ).toMatchObject({ kind: 'not_initialized' });
        expect(store.header).toBeNull();
        expect(remove).not.toHaveBeenCalled();
        if (!orphan) throw new Error('slot was not created');
        const read = await service.readKeySlot({ name: orphan }, call());
        expect(read.kind).toBe('present');
        if (read.kind === 'present') read.material.fill(0);
      } finally {
        store.close();
        folder.remove();
      }
    });
  },
);
