import type {
  PlatformKeySlot,
  PlatformKeySlotBlockReason,
  PlatformKeySlotCallOptions,
  PlatformSecretProtectionBackend,
  PlatformSecretProtectionServices,
  PlatformSecretProtectionUnavailableReason,
} from '../secret-protection';
import {
  KEY_SLOT_MAX_BYTES,
  type FakeSecretProtection,
} from './fake-secret-protection';

export interface SecretProtectionConformanceTestApi {
  describe(name: string, body: () => void): void;
  it(name: string, body: () => Promise<void>): void;
}

export interface SecretProtectionConformanceSubject {
  readonly port: PlatformSecretProtectionServices;
  /**
   * Prompts the port has shown so far; a native harness counts calls that
   * reach an interactive API. Every case fails without a count.
   */
  readonly prompts: () => number;
  /** Fault control; required unless the runner gets `withFaults: false`. */
  readonly faults?: Pick<FakeSecretProtection, 'inject' | 'clearFaults'>;
  dispose?(): Promise<void>;
}

export type MakeSecretProtectionSubject = () =>
  | SecretProtectionConformanceSubject
  | Promise<SecretProtectionConformanceSubject>;

export class SecretProtectionConformanceFailure extends Error {
  override readonly name = 'SecretProtectionConformanceFailure';
}

const BACKENDS: Readonly<Record<PlatformSecretProtectionBackend, true>> = {
  macos_keychain: true,
  windows_credential_manager: true,
  windows_dpapi: true,
  linux_secret_service: true,
};

const UNAVAILABLE_REASONS: Readonly<
  Record<PlatformSecretProtectionUnavailableReason, true>
> = {
  no_backend: true,
  unsupported_session: true,
  backend_failed: true,
  authority_unavailable: true,
};

const BLOCK_REASONS: Readonly<Record<PlatformKeySlotBlockReason, true>> = {
  locked: true,
  interaction_required: true,
  denied: true,
  unavailable: true,
};

const INVALID_SLOT_NAMES = [
  '',
  '-leading',
  'Upper',
  'dot.name',
  '../escape',
  'a/b',
  'a\\b',
  'nul\0',
  'newline\n',
  'x'.repeat(65),
];

/** Node's `Buffer` shape: `slice` returns a view, so `input.slice()` keeps caller memory. */
class ViewSlicingBytes extends Uint8Array<ArrayBuffer> {
  override slice(start?: number, end?: number): Uint8Array<ArrayBuffer> {
    return this.subarray(start, end);
  }
}

function isKeyOf(record: object, key: string): boolean {
  return Object.keys(record).includes(key);
}

function fail(message: string): never {
  throw new SecretProtectionConformanceFailure(message);
}

function describeValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}

function kindOf(
  value: unknown,
  kinds: Readonly<Record<string, readonly string[]>>,
): string {
  if (typeof value !== 'object' || value === null || !('kind' in value))
    return fail(`expected a result object, got ${describeValue(value)}`);
  const kind = value.kind;
  if (typeof kind !== 'string' || !isKeyOf(kinds, kind))
    return fail(`unexpected result kind ${describeValue(kind)}`);
  if (!hasOnlyKeys(value, kinds[kind] ?? []))
    fail(`result ${kind} has fields ${Object.keys(value).join(', ')}`);
  if (kind === 'blocked') checkBlockReason(value);
  if (kind === 'present') checkPresentMaterial(value);
  return kind;
}

function checkBlockReason(value: object): void {
  const reason = 'reason' in value ? value.reason : undefined;
  if (typeof reason !== 'string' || !isKeyOf(BLOCK_REASONS, reason))
    fail(`unexpected block reason ${describeValue(reason)}`);
}

function checkPresentMaterial(value: object): void {
  const material = 'material' in value ? value.material : undefined;
  if (
    !(material instanceof Uint8Array) ||
    material.byteLength < 1 ||
    material.byteLength > KEY_SLOT_MAX_BYTES
  )
    fail(`present result needs 1-${KEY_SLOT_MAX_BYTES} bytes of material`);
}

const BLOCKED = ['kind', 'reason'];
const READ_KINDS = {
  present: ['kind', 'material'],
  absent: ['kind'],
  corrupt: ['kind'],
  blocked: BLOCKED,
};
const WRITE_KINDS = {
  written: ['kind'],
  conflict: ['kind'],
  uncertain: ['kind'],
  failed: ['kind'],
  blocked: BLOCKED,
};
const DELETE_KINDS = {
  deleted: ['kind'],
  absent: ['kind'],
  uncertain: ['kind'],
  blocked: BLOCKED,
};

function checkState(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('state' in value))
    return fail(`expected a protection state, got ${describeValue(value)}`);
  const { state } = value;
  switch (state) {
    case 'available':
    case 'unknown':
    case 'denied':
      if (!hasOnlyKeys(value, ['state'])) fail(`${state} carries extra fields`);
      return state;
    case 'locked': {
      const evidence = 'evidence' in value ? value.evidence : undefined;
      if (
        !hasOnlyKeys(value, ['state', 'evidence']) ||
        (evidence !== 'reported' && evidence !== 'inferred')
      )
        fail(`malformed locked state ${describeValue(value)}`);
      return state;
    }
    case 'unavailable':
      return `unavailable:${unavailableReasonOf(value)}`;
    default:
      return fail(`unexpected protection state ${describeValue(state)}`);
  }
}

function unavailableReasonOf(value: object): string {
  const reason = 'reason' in value ? value.reason : undefined;
  if (
    !hasOnlyKeys(value, ['state', 'reason']) ||
    typeof reason !== 'string' ||
    !isKeyOf(UNAVAILABLE_REASONS, reason)
  )
    return fail(`malformed unavailable state ${describeValue(value)}`);
  return reason;
}

function expectEqual(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected)
    fail(
      `${what}: expected ${describeValue(expected)}, got ${describeValue(actual)}`,
    );
}

function sameBytes(actual: unknown, expected: Uint8Array): boolean {
  return (
    actual instanceof Uint8Array &&
    actual.byteLength === expected.byteLength &&
    actual.every((byte, index) => byte === expected[index])
  );
}

function expectBytes(
  actual: unknown,
  expected: Uint8Array,
  what: string,
): void {
  if (!sameBytes(actual, expected)) fail(`${what}: material differs`);
}

async function expectRejects(
  run: () => Promise<unknown>,
  matches: (error: unknown) => boolean,
  what: string,
): Promise<void> {
  let settled: { readonly error: unknown } | null = null;
  try {
    await run();
  } catch (error) {
    settled = { error };
  }
  if (!settled) fail(`${what}: resolved instead of rejecting`);
  else if (settled.error instanceof SecretProtectionConformanceFailure)
    throw settled.error;
  else if (!matches(settled.error))
    fail(`${what}: rejected with ${describeValue(String(settled.error))}`);
}

/** Backend outcomes resolve; a rejection where none is expected fails the case. */
async function resolves<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SecretProtectionConformanceFailure) throw error;
    return fail(`${what} rejected with ${describeValue(String(error))}`);
  }
}

async function forget(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Ignored by design: cleanup only.
  }
}

function macrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Starts the call now; a synchronous throw becomes a rejection. */
function start(
  run: (signal: AbortSignal) => Promise<unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const pending = new Promise((resolve) => resolve(run(signal)));
  // Handled later; this only keeps an early rejection from going unhandled.
  pending.catch(() => undefined);
  return pending;
}

/**
 * How an aborted call settled; any rejection other than the signal reason
 * fails. Unbounded: a port that hangs fails on the test runner's timeout.
 */
type AbortOutcome =
  | { readonly resolved: true; readonly value: unknown }
  | { readonly resolved: false };

async function outcomeAfterAbort(
  pending: Promise<unknown>,
  reason: unknown,
  what: string,
): Promise<AbortOutcome> {
  try {
    return { resolved: true, value: await pending };
  } catch (error) {
    if (error instanceof SecretProtectionConformanceFailure) throw error;
    if (error !== reason)
      fail(`${what}: rejected with ${describeValue(String(error))}`);
    return { resolved: false };
  }
}

/**
 * Judges an aborted mutation by the slot it left (`landed`): a rejection
 * promises nothing changed, `done` that it changed, `uncertain` allows either.
 */
function checkAbortedMutation(
  outcome: AbortOutcome,
  kinds: Readonly<Record<string, readonly string[]>>,
  done: string,
  landed: boolean,
  what: string,
): void {
  if (!outcome.resolved) {
    if (landed) fail(`${what}: rejected, but the slot changed`);
    return;
  }
  const kind = kindOf(outcome.value, kinds);
  if (kind === 'uncertain') return;
  expectEqual(kind, done, what);
  if (!landed) fail(`${what}: reported ${done}, but the slot did not change`);
}

function materialOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'material' in value
    ? value.material
    : undefined;
}

/**
 * The contract every `PlatformSecretProtectionServices` meets. Adapters run
 * the available-backend cases against a disposable store; the fake, or any
 * harness with `faults`, also runs the fault cases.
 */
export function runSecretProtectionConformance(
  t: SecretProtectionConformanceTestApi,
  makeSubject: MakeSecretProtectionSubject,
  options: {
    /** Make it unique per run when the store is shared, such as a real keychain. */
    readonly slotPrefix?: string;
    /** False for real adapters, which cannot inject faults. Default true. */
    readonly withFaults?: boolean;
  } = {},
): void {
  const prefix = options.slotPrefix ?? 'conformance';
  let slots = 0;

  type Case = (
    port: PlatformSecretProtectionServices,
    slot: PlatformKeySlot,
    faults: SecretProtectionConformanceSubject['faults'],
    /** Prompts since the case started. */
    prompted: () => number,
  ) => Promise<void> | void;

  function signal(): AbortSignal {
    return new AbortController().signal;
  }
  function never(): PlatformKeySlotCallOptions {
    return { signal: signal(), interaction: 'never' };
  }
  function allowed(): PlatformKeySlotCallOptions {
    return { signal: signal(), interaction: 'allowed' };
  }
  function material(seed: number): Uint8Array {
    return Uint8Array.from({ length: 32 }, (_, index) => (seed + index) & 0xff);
  }

  async function read(
    port: PlatformSecretProtectionServices,
    slot: PlatformKeySlot,
    call: PlatformKeySlotCallOptions = never(),
  ): Promise<string> {
    const result = await resolves('read', () => port.readKeySlot(slot, call));
    return kindOf(result, READ_KINDS);
  }
  async function write(
    port: PlatformSecretProtectionServices,
    slot: PlatformKeySlot,
    bytes: Uint8Array,
    mode: 'create' | 'replace',
    call: PlatformKeySlotCallOptions = never(),
  ): Promise<string> {
    const result = await resolves('write', () =>
      port.writeKeySlot(slot, bytes, { ...call, mode }),
    );
    return kindOf(result, WRITE_KINDS);
  }
  async function remove(
    port: PlatformSecretProtectionServices,
    slot: PlatformKeySlot,
    call: PlatformKeySlotCallOptions = never(),
  ): Promise<string> {
    const result = await resolves('delete', () =>
      port.deleteKeySlot(slot, call),
    );
    return kindOf(result, DELETE_KINDS);
  }
  /** `null` only for `absent`; a `corrupt` or `blocked` read fails the case. */
  async function readBytes(
    port: PlatformSecretProtectionServices,
    slot: PlatformKeySlot,
    what = 'read',
  ): Promise<Uint8Array | null> {
    const result = await resolves(what, () => port.readKeySlot(slot, never()));
    const kind = kindOf(result, READ_KINDS);
    if (result.kind === 'present') return result.material;
    if (result.kind === 'absent') return null;
    const detail = result.kind === 'blocked' ? ` (${result.reason})` : '';
    return fail(`${what}: read ${kind}${detail}, expected present or absent`);
  }
  /**
   * After a delete reads as absent, `create` must write, then the slot is
   * deleted again. Catches a read path that hides a slot the backend kept.
   */
  async function expectCreatable(
    port: PlatformSecretProtectionServices,
    slot: PlatformKeySlot,
    what: string,
  ): Promise<void> {
    const created = await write(port, slot, material(9), 'create');
    if (created !== 'written')
      fail(`${what}: read absent, but create returned ${created}`);
    expectEqual(await remove(port, slot), 'deleted', `${what}: cleanup`);
  }
  /** After a `deleted` result: the slot reads absent and is creatable. */
  async function expectGone(
    port: PlatformSecretProtectionServices,
    slot: PlatformKeySlot,
    what: string,
  ): Promise<void> {
    expectEqual(await read(port, slot), 'absent', `read after ${what}`);
    await expectCreatable(port, slot, what);
  }
  function promptCount(subject: SecretProtectionConformanceSubject): number {
    if (typeof subject.prompts !== 'function')
      return fail('the subject has no prompt observer');
    const count = subject.prompts();
    if (!Number.isSafeInteger(count) || count < 0)
      fail(`the prompt observer returned ${describeValue(count)}`);
    return count;
  }
  /** The slot after a call settled; it must not change a macrotask later. */
  async function settledBytes(
    port: PlatformSecretProtectionServices,
    slot: PlatformKeySlot,
    what: string,
  ): Promise<Uint8Array | null> {
    const now = await readBytes(port, slot, what);
    await macrotask();
    const later = await readBytes(port, slot, what);
    if (now === null ? later !== null : !sameBytes(later, now))
      fail(`${what}: the slot changed after the call settled`);
    return now;
  }
  async function abortPending(
    run: (signal: AbortSignal) => Promise<unknown>,
    reason: unknown,
    when: 'at once' | 'after a macrotask',
    what: string,
  ): Promise<AbortOutcome> {
    const controller = new AbortController();
    const pending = start(run, controller.signal);
    if (when === 'after a macrotask') await macrotask();
    controller.abort(reason);
    return outcomeAfterAbort(pending, reason, what);
  }
  /** Aborts a call an injected `abort` fault holds; fails if nothing holds it. */
  async function abortHeld(
    run: (signal: AbortSignal) => Promise<unknown>,
    what: string,
  ): Promise<AbortOutcome> {
    const controller = new AbortController();
    const reason = new Error('conformance abort');
    const pending = start(run, controller.signal);
    let settled = false;
    const mark = (): void => {
      settled = true;
    };
    void pending.then(mark, mark);
    await macrotask();
    if (settled)
      fail(`${what}: the abort fault did not hold the call in flight`);
    controller.abort(reason);
    return outcomeAfterAbort(pending, reason, what);
  }

  function scenario(name: string, body: Case, needsFaults = false): void {
    t.it(name, async () => {
      const subject = await makeSubject();
      const { port, faults } = subject;
      slots += 1;
      const slot = { name: `${prefix}-${slots}` };
      try {
        if (needsFaults && !faults)
          fail('the subject has no fault control; pass withFaults: false');
        const start = promptCount(subject);
        const prompted = (): number => promptCount(subject) - start;
        await body(port, slot, faults, prompted);
        // Available-backend cases make only status and `interaction: 'never'` calls.
        if (!needsFaults) expectEqual(prompted(), 0, 'prompts');
      } finally {
        faults?.clearFaults();
        // Best-effort cleanup; a failure here must not hide the case's own.
        await forget(() => port.deleteKeySlot(slot, never()));
        await subject.dispose?.();
      }
    });
  }

  t.describe('secret protection: available backend', () => {
    scenario('names a native backend', (port) => {
      if (!isKeyOf(BACKENDS, port.backend))
        fail(`unknown backend ${describeValue(port.backend)}`);
    });

    scenario(
      'status resolves a closed state without prompting',
      async (port, _, __, prompted) => {
        checkState(await port.status({ signal: signal() }));
        expectEqual(prompted(), 0, 'prompts');
      },
    );

    scenario('reads an unwritten slot as absent', async (port, slot) => {
      expectEqual(await read(port, slot), 'absent', 'read');
    });

    scenario(
      'creates a slot and never shares material buffers',
      async (port, slot) => {
        const original = material(1);
        const view = new ViewSlicingBytes(
          new ArrayBuffer(original.byteLength + 16),
          8,
          original.byteLength,
        );
        view.set(original);
        const inputs = [
          { label: 'a plain', input: original.slice() },
          { label: 'a Buffer-like', input: view },
        ];
        for (const { label, input } of inputs) {
          expectEqual(
            await write(port, slot, input, 'create'),
            'written',
            `create from ${label} input`,
          );
          input.fill(0);
          const first = await readBytes(port, slot);
          expectBytes(first, original, `read after zeroing ${label} input`);
          first?.fill(0);
          expectBytes(
            await readBytes(port, slot),
            original,
            'read after caller zeroed a read',
          );
          expectEqual(await remove(port, slot), 'deleted', 'delete');
        }
      },
    );

    scenario(
      'create conflicts on a present slot and keeps it',
      async (port, slot) => {
        await write(port, slot, material(1), 'create');
        expectEqual(
          await write(port, slot, material(2), 'create'),
          'conflict',
          'create',
        );
        expectBytes(await readBytes(port, slot), material(1), 'read');
      },
    );

    scenario(
      'replace conflicts on an absent slot and writes nothing',
      async (port, slot) => {
        expectEqual(
          await write(port, slot, material(1), 'replace'),
          'conflict',
          'replace',
        );
        expectEqual(await read(port, slot), 'absent', 'read');
      },
    );

    scenario('replace overwrites a present slot', async (port, slot) => {
      await write(port, slot, material(1), 'create');
      expectEqual(
        await write(port, slot, material(2), 'replace'),
        'written',
        'replace',
      );
      expectBytes(await readBytes(port, slot), material(2), 'read');
    });

    scenario(
      'deletes a present slot, then reports absent',
      async (port, slot) => {
        await write(port, slot, material(1), 'create');
        expectEqual(await remove(port, slot), 'deleted', 'delete');
        expectEqual(await remove(port, slot), 'absent', 'second delete');
        await expectGone(port, slot, 'delete');
      },
    );

    scenario('accepts every valid slot name shape', async (port, slot) => {
      const names = [
        `0${slot.name}`,
        `${slot.name}-`,
        slot.name.padEnd(64, 'x'),
      ];
      for (const name of names) {
        const valid = { name };
        try {
          expectEqual(
            await write(port, valid, material(1), 'create'),
            'written',
            `create ${name}`,
          );
          expectBytes(await readBytes(port, valid), material(1), name);
          expectEqual(await remove(port, valid), 'deleted', `delete ${name}`);
          await expectGone(port, valid, `delete ${name}`);
        } finally {
          await forget(() => port.deleteKeySlot(valid, never()));
        }
      }
    });

    scenario(
      'rejects invalid slot names and material before the backend',
      async (port, slot) => {
        const isTypeError = (error: unknown): boolean =>
          error instanceof TypeError;
        for (const name of INVALID_SLOT_NAMES) {
          const bad = { name };
          await expectRejects(
            () => port.readKeySlot(bad, never()),
            isTypeError,
            `read ${describeValue(name)}`,
          );
          await expectRejects(
            () =>
              port.writeKeySlot(bad, material(1), {
                ...never(),
                mode: 'create',
              }),
            isTypeError,
            `write ${describeValue(name)}`,
          );
          await expectRejects(
            () => port.deleteKeySlot(bad, never()),
            isTypeError,
            `delete ${describeValue(name)}`,
          );
        }
        for (const size of [0, KEY_SLOT_MAX_BYTES + 1])
          await expectRejects(
            () =>
              port.writeKeySlot(slot, new Uint8Array(size), {
                ...never(),
                mode: 'create',
              }),
            isTypeError,
            `write ${size} bytes`,
          );
        // Untyped callers; method parameters are bivariant, so no cast.
        const loose: {
          readKeySlot(...args: readonly unknown[]): Promise<unknown>;
          writeKeySlot(...args: readonly unknown[]): Promise<unknown>;
        } = port;
        await expectRejects(
          () =>
            loose.readKeySlot(slot, { signal: signal(), interaction: 'ask' }),
          isTypeError,
          'read with an unknown interaction',
        );
        await expectRejects(
          () =>
            loose.writeKeySlot(slot, material(1), {
              signal: signal(),
              interaction: 'never',
              mode: 'upsert',
            }),
          isTypeError,
          'write with an unknown mode',
        );
        expectEqual(
          await read(port, slot),
          'absent',
          'read after rejected writes',
        );
        expectEqual(
          await write(port, slot, new Uint8Array(KEY_SLOT_MAX_BYTES), 'create'),
          'written',
          `write ${KEY_SLOT_MAX_BYTES} bytes`,
        );
      },
    );

    scenario(
      'a pre-aborted call rejects with the signal reason and changes nothing',
      async (port, slot) => {
        const controller = new AbortController();
        const reason = new Error('conformance abort');
        controller.abort(reason);
        const call = {
          signal: controller.signal,
          interaction: 'never',
        } as const;
        const isReason = (error: unknown): boolean => error === reason;
        await expectRejects(
          () => port.status({ signal: controller.signal }),
          isReason,
          'status',
        );
        await expectRejects(
          () => port.readKeySlot(slot, call),
          isReason,
          'read',
        );
        await expectRejects(
          () =>
            port.writeKeySlot(slot, material(1), { ...call, mode: 'create' }),
          isReason,
          'write',
        );
        expectEqual(
          await read(port, slot),
          'absent',
          'read after aborted write',
        );
        await write(port, slot, material(1), 'create');
        await expectRejects(
          () => port.deleteKeySlot(slot, call),
          isReason,
          'delete',
        );
        expectBytes(
          await readBytes(port, slot),
          material(1),
          'read after aborted delete',
        );
      },
    );

    for (const when of ['at once', 'after a macrotask'] as const)
      scenario(
        `a call aborted while pending settles consistently with the slot (${when})`,
        async (port, slot) => {
          await write(port, slot, material(1), 'create');
          const reason = new Error('conformance abort');
          const state = checkState(await port.status({ signal: signal() }));
          const status = await abortPending(
            (s) => port.status({ signal: s }),
            reason,
            when,
            'status',
          );
          // A resolved status is the one the backend returned.
          if (status.resolved)
            expectEqual(checkState(status.value), state, 'aborted status');
          const read = await abortPending(
            (s) => port.readKeySlot(slot, { signal: s, interaction: 'never' }),
            reason,
            when,
            'read',
          );
          if (read.resolved) {
            expectEqual(kindOf(read.value, READ_KINDS), 'present', 'read');
            expectBytes(materialOf(read.value), material(1), 'read');
          }
          const replaced = await abortPending(
            (s) =>
              port.writeKeySlot(slot, material(2), {
                signal: s,
                interaction: 'never',
                mode: 'replace',
              }),
            reason,
            when,
            'replace',
          );
          const afterReplace = await settledBytes(port, slot, 'replace');
          const replaceLanded = sameBytes(afterReplace, material(2));
          if (!replaceLanded)
            expectBytes(
              afterReplace,
              material(1),
              'read after aborted replace',
            );
          checkAbortedMutation(
            replaced,
            WRITE_KINDS,
            'written',
            replaceLanded,
            'replace',
          );
          const deleted = await abortPending(
            (s) =>
              port.deleteKeySlot(slot, { signal: s, interaction: 'never' }),
            reason,
            when,
            'delete',
          );
          const afterDelete = await settledBytes(port, slot, 'delete');
          if (afterDelete)
            expectBytes(
              afterDelete,
              material(replaceLanded ? 2 : 1),
              'read after aborted delete',
            );
          else await expectCreatable(port, slot, 'delete');
          checkAbortedMutation(
            deleted,
            DELETE_KINDS,
            'deleted',
            afterDelete === null,
            'delete',
          );
        },
      );

    scenario(
      'an abort after a call settles changes nothing',
      async (port, slot) => {
        async function thenAbort(
          run: (s: AbortSignal) => Promise<unknown>,
          kinds: Readonly<Record<string, readonly string[]>>,
          done: string,
          what: string,
        ): Promise<void> {
          const controller = new AbortController();
          const result = await resolves(what, () => run(controller.signal));
          expectEqual(kindOf(result, kinds), done, what);
          controller.abort(new Error('conformance abort'));
          await macrotask();
        }
        await thenAbort(
          (s) =>
            port.writeKeySlot(slot, material(1), {
              signal: s,
              interaction: 'never',
              mode: 'create',
            }),
          WRITE_KINDS,
          'written',
          'create',
        );
        expectBytes(
          await readBytes(port, slot),
          material(1),
          'read after create',
        );
        await thenAbort(
          (s) =>
            port.writeKeySlot(slot, material(2), {
              signal: s,
              interaction: 'never',
              mode: 'replace',
            }),
          WRITE_KINDS,
          'written',
          'replace',
        );
        expectBytes(
          await readBytes(port, slot),
          material(2),
          'read after replace',
        );
        await thenAbort(
          (s) => port.deleteKeySlot(slot, { signal: s, interaction: 'never' }),
          DELETE_KINDS,
          'deleted',
          'delete',
        );
        await expectGone(port, slot, 'delete');
      },
    );
  });

  if (options.withFaults === false) return;
  t.describe('secret protection: faults', () => {
    const blocking: readonly {
      readonly label: string;
      readonly inject: Parameters<FakeSecretProtection['inject']>[0];
      readonly state: string;
      readonly never: PlatformKeySlotBlockReason;
      /** Whether an `allowed` call may prompt past it. */
      readonly promptable: boolean;
    }[] = [
      {
        label: 'locked',
        inject: { kind: 'locked' },
        state: 'locked',
        never: 'locked',
        promptable: true,
      },
      {
        label: 'locked (inferred)',
        inject: { kind: 'locked', evidence: 'inferred' },
        state: 'locked',
        never: 'locked',
        promptable: true,
      },
      {
        label: 'unknown',
        inject: { kind: 'unknown' },
        state: 'unknown',
        never: 'interaction_required',
        promptable: true,
      },
      {
        label: 'denied',
        inject: { kind: 'denied' },
        state: 'denied',
        never: 'denied',
        promptable: false,
      },
      ...Object.keys(UNAVAILABLE_REASONS).map((reason) => ({
        label: `unavailable (${reason})`,
        inject: {
          kind: 'unavailable' as const,
          reason: unavailableReason(reason),
        },
        state: `unavailable:${reason}`,
        never: 'unavailable' as const,
        promptable: false,
      })),
    ];

    for (const entry of blocking) {
      scenario(
        `${entry.label}: status reports it without prompting`,
        async (port, _, faults, prompted) => {
          faults?.inject(entry.inject);
          expectEqual(
            checkState(await port.status({ signal: signal() })),
            entry.state,
            'status',
          );
          expectEqual(prompted(), 0, 'prompts');
        },
        true,
      );

      scenario(
        `${entry.label}: interaction 'never' blocks every call without prompting`,
        async (port, slot, faults, prompted) => {
          await write(port, slot, material(1), 'create');
          faults?.inject(entry.inject);
          const blocked = (kind: string): void =>
            expectEqual(kind, 'blocked', 'result');
          const reason = async (result: Promise<unknown>): Promise<void> => {
            const value = await result;
            blocked(
              kindOf(value, { ...READ_KINDS, ...WRITE_KINDS, ...DELETE_KINDS }),
            );
            expectEqual(
              typeof value === 'object' && value !== null && 'reason' in value
                ? value.reason
                : undefined,
              entry.never,
              'block reason',
            );
          };
          await reason(port.readKeySlot(slot, never()));
          await reason(
            port.writeKeySlot(slot, material(2), {
              ...never(),
              mode: 'replace',
            }),
          );
          await reason(port.deleteKeySlot(slot, never()));
          expectEqual(prompted(), 0, 'prompts');
          faults?.clearFaults();
          expectBytes(
            await readBytes(port, slot),
            material(1),
            'slot after blocked calls',
          );
        },
        true,
      );

      scenario(
        `${entry.label}: interaction 'allowed' ${entry.promptable ? 'prompts once, then proceeds' : 'stays blocked'}`,
        async (port, slot, faults, prompted) => {
          await write(port, slot, material(1), 'create');
          faults?.inject(entry.inject);
          const result = await port.readKeySlot(slot, allowed());
          if (entry.promptable) {
            expectEqual(kindOf(result, READ_KINDS), 'present', 'read');
            expectEqual(prompted(), 1, 'prompts');
            expectEqual(
              checkState(await port.status({ signal: signal() })),
              'available',
              'status after prompt',
            );
          } else {
            expectEqual(kindOf(result, READ_KINDS), 'blocked', 'read');
            expectEqual(
              result.kind === 'blocked' ? result.reason : undefined,
              entry.never,
              'block reason',
            );
            expectEqual(prompted(), 0, 'prompts');
          }
        },
        true,
      );
    }

    scenario(
      'corrupt: reads corrupt; create conflicts; replace and delete recover',
      async (port, slot, faults) => {
        await write(port, slot, material(1), 'create');
        faults?.inject({ kind: 'corrupt', slot: slot.name });
        expectEqual(await read(port, slot), 'corrupt', 'read');
        expectEqual(
          await write(port, slot, material(2), 'create'),
          'conflict',
          'create',
        );
        expectEqual(
          await write(port, slot, material(2), 'replace'),
          'written',
          'replace',
        );
        expectBytes(
          await readBytes(port, slot),
          material(2),
          'read after replace',
        );
        faults?.inject({ kind: 'corrupt', slot: slot.name });
        expectEqual(await remove(port, slot), 'deleted', 'delete');
        await expectGone(port, slot, 'delete');
      },
      true,
    );

    scenario(
      'key_missing: reads absent; replace conflicts; create writes',
      async (port, slot, faults) => {
        await write(port, slot, material(1), 'create');
        faults?.inject({ kind: 'key_missing', slot: slot.name });
        expectEqual(await read(port, slot), 'absent', 'read');
        expectEqual(
          await write(port, slot, material(2), 'replace'),
          'conflict',
          'replace',
        );
        expectEqual(
          await write(port, slot, material(2), 'create'),
          'written',
          'create',
        );
      },
      true,
    );

    for (const applied of [false, true]) {
      scenario(
        `uncertain write (${applied ? 'landed' : 'lost'}) is reported, not masked`,
        async (port, slot, faults) => {
          await write(port, slot, material(1), 'create');
          faults?.inject({ kind: 'uncertain', operation: 'write', applied });
          expectEqual(
            await write(port, slot, material(2), 'replace'),
            'uncertain',
            'replace',
          );
          expectBytes(
            await readBytes(port, slot),
            material(applied ? 2 : 1),
            'read',
          );
        },
        true,
      );

      scenario(
        `uncertain delete (${applied ? 'landed' : 'lost'}) is reported, not masked`,
        async (port, slot, faults) => {
          await write(port, slot, material(1), 'create');
          faults?.inject({ kind: 'uncertain', operation: 'delete', applied });
          expectEqual(await remove(port, slot), 'uncertain', 'delete');
          expectEqual(
            await read(port, slot),
            applied ? 'absent' : 'present',
            'read',
          );
          if (applied) await expectCreatable(port, slot, 'delete');
        },
        true,
      );
    }

    scenario(
      'a failed write changes nothing',
      async (port, slot, faults) => {
        await write(port, slot, material(1), 'create');
        faults?.inject({ kind: 'write_failed' });
        expectEqual(
          await write(port, slot, material(2), 'replace'),
          'failed',
          'replace',
        );
        expectBytes(await readBytes(port, slot), material(1), 'read');
      },
      true,
    );

    scenario(
      'abort during status or a read rejects with the signal reason',
      async (port, slot, faults) => {
        const reads: readonly {
          readonly what: string;
          readonly run: (s: AbortSignal) => Promise<unknown>;
        }[] = [
          { what: 'status', run: (s) => port.status({ signal: s }) },
          {
            what: 'read',
            run: (s) =>
              port.readKeySlot(slot, { signal: s, interaction: 'never' }),
          },
        ];
        for (const { what, run } of reads) {
          faults?.inject({ kind: 'abort' });
          // The held call has no backend result to return.
          if ((await abortHeld(run, what)).resolved)
            fail(`${what}: resolved instead of rejecting`);
        }
      },
      true,
    );

    for (const applied of [false, true]) {
      scenario(
        `abort during a mutation (${applied ? 'landed' : 'lost'}) settles consistently with the slot`,
        async (port, slot, faults) => {
          await write(port, slot, material(1), 'create');
          faults?.inject({ kind: 'abort', applied });
          const replaced = await abortHeld(
            (s) =>
              port.writeKeySlot(slot, material(2), {
                signal: s,
                interaction: 'never',
                mode: 'replace',
              }),
            'replace',
          );
          const afterReplace = await readBytes(port, slot);
          checkAbortedMutation(
            replaced,
            WRITE_KINDS,
            'written',
            sameBytes(afterReplace, material(2)),
            'replace',
          );
          expectBytes(
            afterReplace,
            material(applied ? 2 : 1),
            'read after aborted replace',
          );
          faults?.inject({ kind: 'abort', applied });
          const deleted = await abortHeld(
            (s) =>
              port.deleteKeySlot(slot, { signal: s, interaction: 'never' }),
            'delete',
          );
          const afterDelete = await read(port, slot);
          if (afterDelete === 'absent')
            await expectCreatable(port, slot, 'delete');
          checkAbortedMutation(
            deleted,
            DELETE_KINDS,
            'deleted',
            afterDelete === 'absent',
            'delete',
          );
          expectEqual(
            afterDelete,
            applied ? 'absent' : 'present',
            'read after aborted delete',
          );
        },
        true,
      );
    }
  });
}

function unavailableReason(
  value: string,
): PlatformSecretProtectionUnavailableReason {
  switch (value) {
    case 'no_backend':
    case 'unsupported_session':
    case 'backend_failed':
    case 'authority_unavailable':
      return value;
    default:
      return fail(`unknown unavailable reason ${value}`);
  }
}
