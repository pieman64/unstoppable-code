import type { PlatformSecretProtectionServices as Port } from '../../secret-protection';
import { createFakeSecretProtection, KEY_SLOT_MAX_BYTES } from '../index';

const SLOT = { name: 'vault-key' };
const bytes = (value: number): Uint8Array => new Uint8Array(32).fill(value);
const never = (): { signal: AbortSignal; interaction: 'never' } => ({
  signal: new AbortController().signal,
  interaction: 'never',
});

describe('createFakeSecretProtection', () => {
  it('seeds copies of its slots and validates them', () => {
    const seed = bytes(1);
    const fake = createFakeSecretProtection({
      backend: 'macos_keychain',
      slots: { 'vault-key': seed },
    });
    seed.fill(0);
    expect(fake.peek('vault-key')).toEqual(bytes(1));
    expect(() =>
      createFakeSecretProtection({
        backend: 'macos_keychain',
        slots: { '../vault-key': bytes(1) },
      }),
    ).toThrow(TypeError);
    expect(() =>
      createFakeSecretProtection({
        backend: 'macos_keychain',
        slots: { 'vault-key': new Uint8Array(KEY_SLOT_MAX_BYTES + 1) },
      }),
    ).toThrow(TypeError);
  });

  // Buffer#slice returns a view, so these fail if the fake stores or returns one.
  it('never shares Buffer material in or out', async () => {
    const seed = Buffer.from(bytes(1));
    const fake = createFakeSecretProtection({
      backend: 'macos_keychain',
      slots: { 'vault-key': seed },
    });
    seed.fill(0);
    expect(fake.peek('vault-key')).toEqual(bytes(1));
    const read = await fake.port.readKeySlot(SLOT, never());
    if (read.kind === 'present') read.material.fill(9);
    expect(read.kind).toBe('present');
    expect(fake.peek('vault-key')).toEqual(bytes(1));

    const input = Buffer.from(bytes(2));
    await expect(
      fake.port.writeKeySlot(SLOT, input, { ...never(), mode: 'replace' }),
    ).resolves.toEqual({ kind: 'written' });
    input.fill(0);
    expect(fake.peek('vault-key')).toEqual(bytes(2));
  });

  it('peeks copies, and reports corrupt and absent slots', () => {
    const fake = createFakeSecretProtection({
      backend: 'windows_dpapi',
      slots: { 'vault-key': bytes(1) },
    });
    const peeked = fake.peek('vault-key');
    if (peeked instanceof Uint8Array) peeked.fill(9);
    expect(fake.peek('vault-key')).toEqual(bytes(1));
    fake.inject({ kind: 'corrupt', slot: 'vault-key' });
    expect(fake.peek('vault-key')).toBe('corrupt');
    expect(fake.peek('other')).toBeNull();
    expect(() => fake.inject({ kind: 'corrupt', slot: 'a/b' })).toThrow(
      TypeError,
    );
  });

  it('writes after an allowed prompt unlocks a locked backend', async () => {
    const fake = createFakeSecretProtection({
      backend: 'linux_secret_service',
    });
    fake.inject({ kind: 'locked', evidence: 'inferred' });
    await expect(fake.port.status({ signal: never().signal })).resolves.toEqual(
      { state: 'locked', evidence: 'inferred' },
    );
    await expect(
      fake.port.writeKeySlot(SLOT, bytes(1), {
        signal: new AbortController().signal,
        interaction: 'allowed',
        mode: 'create',
      }),
    ).resolves.toEqual({ kind: 'written' });
    expect(fake.prompts).toBe(1);
    expect(fake.peek('vault-key')).toEqual(bytes(1));
  });

  it('keeps an abort hold armed through blocked calls', async () => {
    const fake = createFakeSecretProtection({ backend: 'macos_keychain' });
    fake.inject({ kind: 'denied' });
    fake.inject({ kind: 'abort' });
    await expect(fake.port.readKeySlot(SLOT, never())).resolves.toEqual({
      kind: 'blocked',
      reason: 'denied',
    });
    fake.inject({ kind: 'unknown' });
    const controller = new AbortController();
    const pending = fake.port.readKeySlot(SLOT, {
      signal: controller.signal,
      interaction: 'allowed',
    });
    const reason = new Error('stop');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(fake.prompts).toBe(1);
  });

  it('never lands an aborted create over a present slot', async () => {
    const fake = createFakeSecretProtection({
      backend: 'macos_keychain',
      slots: { 'vault-key': bytes(1) },
    });
    fake.inject({ kind: 'abort', applied: true });
    const controller = new AbortController();
    const pending = fake.port.writeKeySlot(SLOT, bytes(2), {
      signal: controller.signal,
      interaction: 'never',
      mode: 'create',
    });
    controller.abort();
    await expect(pending).resolves.toEqual({ kind: 'uncertain' });
    expect(fake.peek('vault-key')).toEqual(bytes(1));
  });

  // No fault armed: the abort lands while the call awaits before the backend.
  it.each([
    {
      label: 'status',
      run: (port: Port, signal: AbortSignal): Promise<unknown> =>
        port.status({ signal }),
    },
    {
      label: 'read',
      run: (port: Port, signal: AbortSignal): Promise<unknown> =>
        port.readKeySlot(SLOT, { signal, interaction: 'never' }),
    },
    {
      label: 'replace',
      run: (port: Port, signal: AbortSignal): Promise<unknown> =>
        port.writeKeySlot(SLOT, bytes(2), {
          signal,
          interaction: 'never',
          mode: 'replace',
        }),
    },
    {
      label: 'create',
      run: (port: Port, signal: AbortSignal): Promise<unknown> =>
        port.writeKeySlot({ name: 'other' }, bytes(2), {
          signal,
          interaction: 'never',
          mode: 'create',
        }),
    },
    {
      label: 'delete',
      run: (port: Port, signal: AbortSignal): Promise<unknown> =>
        port.deleteKeySlot(SLOT, { signal, interaction: 'never' }),
    },
  ])(
    'rejects a $label aborted after the call and changes nothing',
    async ({ run }) => {
      const fake = createFakeSecretProtection({
        backend: 'macos_keychain',
        slots: { 'vault-key': bytes(1) },
      });
      const controller = new AbortController();
      const pending = run(fake.port, controller.signal);
      const reason = new Error('stop');
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
      expect(fake.peek('vault-key')).toEqual(bytes(1));
      expect(fake.peek('other')).toBeNull();
    },
  );

  it('arms uncertain and failed writes for the next write that would succeed', async () => {
    const fake = createFakeSecretProtection({
      backend: 'windows_credential_manager',
      slots: { 'vault-key': bytes(1) },
    });
    fake.inject({ kind: 'write_failed' });
    const create = { ...never(), mode: 'create' as const };
    await expect(
      fake.port.writeKeySlot(SLOT, bytes(2), create),
    ).resolves.toEqual({ kind: 'conflict' });
    await expect(
      fake.port.writeKeySlot(SLOT, bytes(2), { ...never(), mode: 'replace' }),
    ).resolves.toEqual({ kind: 'failed' });
    await expect(
      fake.port.writeKeySlot(SLOT, bytes(3), { ...never(), mode: 'replace' }),
    ).resolves.toEqual({ kind: 'written' });
    expect(fake.peek('vault-key')).toEqual(bytes(3));
  });

  it('clears faults without touching slot contents', async () => {
    const fake = createFakeSecretProtection({
      backend: 'macos_keychain',
      slots: { 'vault-key': bytes(1) },
    });
    fake.inject({ kind: 'unavailable', reason: 'authority_unavailable' });
    fake.inject({ kind: 'abort' });
    fake.inject({ kind: 'uncertain', operation: 'delete', applied: false });
    fake.clearFaults();
    await expect(fake.port.status({ signal: never().signal })).resolves.toEqual(
      { state: 'available' },
    );
    await expect(fake.port.deleteKeySlot(SLOT, never())).resolves.toEqual({
      kind: 'deleted',
    });
    expect(fake.peek('vault-key')).toBeNull();
  });
});
