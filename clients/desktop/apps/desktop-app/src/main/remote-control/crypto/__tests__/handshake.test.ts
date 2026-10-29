import { randomBytes } from 'node:crypto';
import {
  deriveDeviceId,
  exportDeviceKeyPair,
  generateDeviceKeyPair,
  importDeviceKeyPair,
  publicKeyMatchesDeviceId,
  type DeviceKeyPair,
} from '../device-key';
import {
  HandshakeError,
  HandshakeInitiator,
  HandshakeResponder,
  type HandshakePurpose,
  type HandshakeResult,
} from '../handshake';
import { SecureChannel, SecureChannelError } from '../secure-channel';

/** The `code` of the error `action` throws; fails if it does not throw. */
function thrownCode(action: () => unknown): unknown {
  try {
    action();
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error ? error.code : undefined;
  }
  throw new Error('Expected the action to throw.');
}

interface Pair {
  initiator: HandshakeResult;
  responder: HandshakeResult;
}

function runHandshake(options: {
  controller: DeviceKeyPair;
  host: DeviceKeyPair;
  purpose?: HandshakePurpose;
  pinnedHostKey?: string | null;
  authorize?: (purpose: HandshakePurpose, key: string) => boolean;
}): Pair {
  const sessionId = randomBytes(16);
  const initiator = new HandshakeInitiator({
    sessionId,
    purpose: options.purpose ?? 'control',
    identity: options.controller,
    peerDeviceId: options.host.deviceId,
    pinnedPeerPublicKey:
      options.pinnedHostKey === undefined
        ? options.host.publicKey
        : options.pinnedHostKey,
  });
  const responder = new HandshakeResponder({
    sessionId,
    identity: options.host,
    peerDeviceId: options.controller.deviceId,
    authorize: options.authorize ?? ((): boolean => true),
  });
  const hello2 = responder.receiveHello1(initiator.start());
  const hello3 = initiator.receiveHello2(hello2);
  const { hello4, result } = responder.receiveHello3(hello3);
  return { initiator: initiator.receiveHello4(hello4), responder: result };
}

describe('device keys', () => {
  it('derives a stable 22-character device ID from the public key', () => {
    const keyPair = generateDeviceKeyPair();
    expect(keyPair.deviceId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(deriveDeviceId(keyPair.publicKey)).toBe(keyPair.deviceId);
    expect(publicKeyMatchesDeviceId(keyPair.publicKey, keyPair.deviceId)).toBe(
      true,
    );
    const other = generateDeviceKeyPair();
    expect(publicKeyMatchesDeviceId(other.publicKey, keyPair.deviceId)).toBe(
      false,
    );
  });

  it('round-trips the private key through PKCS8', () => {
    const keyPair = generateDeviceKeyPair();
    const restored = importDeviceKeyPair(exportDeviceKeyPair(keyPair));
    expect(restored.deviceId).toBe(keyPair.deviceId);
    expect(restored.publicKey).toBe(keyPair.publicKey);
  });
});

describe('handshake', () => {
  const controller = generateDeviceKeyPair();
  const host = generateDeviceKeyPair();

  it('agrees on crossed traffic keys and the same pairing code', () => {
    const { initiator, responder } = runHandshake({ controller, host });
    expect(initiator.sendKey.equals(responder.receiveKey)).toBe(true);
    expect(initiator.receiveKey.equals(responder.sendKey)).toBe(true);
    expect(initiator.sendKey.equals(initiator.receiveKey)).toBe(false);
    expect(initiator.shortAuthenticationString).toMatch(/^\d{6}$/);
    expect(initiator.shortAuthenticationString).toBe(
      responder.shortAuthenticationString,
    );
    expect(initiator.peerDeviceId).toBe(host.deviceId);
    expect(responder.peerDeviceId).toBe(controller.deviceId);
  });

  it('uses fresh keys for every session', () => {
    const first = runHandshake({ controller, host });
    const second = runHandshake({ controller, host });
    expect(first.initiator.sendKey.equals(second.initiator.sendKey)).toBe(
      false,
    );
  });

  it('rejects a controller the host has not authorized', () => {
    expect(() =>
      runHandshake({ controller, host, authorize: () => false }),
    ).toThrow(HandshakeError);
  });

  it('passes the purpose and initiator key to authorization', () => {
    const authorize = jest.fn((): boolean => true);
    runHandshake({ controller, host, purpose: 'pair', authorize });
    expect(authorize).toHaveBeenCalledWith('pair', controller.publicKey);
  });

  it('rejects a host whose key differs from the pinned key', () => {
    const impostor = generateDeviceKeyPair();
    const sessionId = randomBytes(16);
    const initiator = new HandshakeInitiator({
      sessionId,
      purpose: 'control',
      identity: controller,
      peerDeviceId: host.deviceId,
      pinnedPeerPublicKey: host.publicKey,
    });
    const responder = new HandshakeResponder({
      sessionId,
      identity: impostor,
      peerDeviceId: controller.deviceId,
      authorize: (): boolean => true,
    });
    const hello2 = responder.receiveHello1(initiator.start());
    expect(thrownCode(() => initiator.receiveHello2(hello2))).toBe(
      'peer_key_mismatch',
    );
  });

  it('rejects an initiator whose key does not hash to the relay source', () => {
    const sessionId = randomBytes(16);
    const initiator = new HandshakeInitiator({
      sessionId,
      purpose: 'control',
      identity: controller,
      peerDeviceId: host.deviceId,
      pinnedPeerPublicKey: host.publicKey,
    });
    const responder = new HandshakeResponder({
      sessionId,
      identity: host,
      peerDeviceId: generateDeviceKeyPair().deviceId,
      authorize: (): boolean => true,
    });
    expect(thrownCode(() => responder.receiveHello1(initiator.start()))).toBe(
      'peer_key_mismatch',
    );
  });

  it('rejects an ephemeral key that does not match the commitment', () => {
    const sessionId = randomBytes(16);
    const initiator = new HandshakeInitiator({
      sessionId,
      purpose: 'pair',
      identity: controller,
      peerDeviceId: host.deviceId,
      pinnedPeerPublicKey: null,
    });
    const responder = new HandshakeResponder({
      sessionId,
      identity: host,
      peerDeviceId: controller.deviceId,
      authorize: (): boolean => true,
    });
    const hello3 = initiator.receiveHello2(
      responder.receiveHello1(initiator.start()),
    );
    const swapped = new HandshakeInitiator({
      sessionId,
      purpose: 'pair',
      identity: controller,
      peerDeviceId: host.deviceId,
      pinnedPeerPublicKey: null,
    });
    swapped.start();
    const otherHello3 = swapped.receiveHello2({
      responderKey: host.publicKey,
      ephemeral: hello3.ephemeral,
      nonce: hello3.nonce,
    });
    expect(
      thrownCode(() =>
        responder.receiveHello3({
          ...hello3,
          ephemeral: otherHello3.ephemeral,
        }),
      ),
    ).toBe('bad_commitment');
  });

  it('rejects a tampered signature from either side', () => {
    const sessionId = randomBytes(16);
    const initiator = new HandshakeInitiator({
      sessionId,
      purpose: 'control',
      identity: controller,
      peerDeviceId: host.deviceId,
      pinnedPeerPublicKey: host.publicKey,
    });
    const responder = new HandshakeResponder({
      sessionId,
      identity: host,
      peerDeviceId: controller.deviceId,
      authorize: (): boolean => true,
    });
    const hello3 = initiator.receiveHello2(
      responder.receiveHello1(initiator.start()),
    );
    const forged = generateDeviceKeyPair();
    const forgedInitiator = new HandshakeInitiator({
      sessionId,
      purpose: 'control',
      identity: forged,
      peerDeviceId: host.deviceId,
      pinnedPeerPublicKey: host.publicKey,
    });
    forgedInitiator.start();
    const { signature } = forgedInitiator.receiveHello2({
      responderKey: host.publicKey,
      ephemeral: hello3.ephemeral,
      nonce: hello3.nonce,
    });
    expect(
      thrownCode(() => responder.receiveHello3({ ...hello3, signature })),
    ).toBe('bad_signature');
  });

  it('gives a relay-in-the-middle different pairing codes on each side', () => {
    // The relay terminates both handshakes with its own identity. It must
    // send its hello2 to the controller before the controller reveals its
    // ephemeral key, so it cannot steer both codes to match.
    const mitm = generateDeviceKeyPair();
    const toController = runHandshake({
      controller,
      host: mitm,
      purpose: 'pair',
      pinnedHostKey: null,
    });
    const toHost = runHandshake({
      controller: mitm,
      host,
      purpose: 'pair',
      pinnedHostKey: null,
    });
    expect(toController.initiator.peerDeviceId).not.toBe(host.deviceId);
    // The pairing codes derive from the transcripts, which the relay cannot
    // make equal. (Comparing the six-digit codes themselves would fail one
    // run in a million by chance.)
    expect(
      toController.initiator.transcriptHash.equals(
        toHost.responder.transcriptHash,
      ),
    ).toBe(false);
  });

  it('refuses out-of-order messages', () => {
    const initiator = new HandshakeInitiator({
      sessionId: randomBytes(16),
      purpose: 'control',
      identity: controller,
      peerDeviceId: host.deviceId,
      pinnedPeerPublicKey: host.publicKey,
    });
    expect(
      thrownCode(() => initiator.receiveHello4({ signature: 'AAAA' })),
    ).toBe('unexpected_message');
  });
});

describe('secure channel', () => {
  const controller = generateDeviceKeyPair();
  const host = generateDeviceKeyPair();
  const aad = Buffer.from('header');

  function channels(): { a: SecureChannel; b: SecureChannel } {
    const { initiator, responder } = runHandshake({ controller, host });
    return {
      a: new SecureChannel(initiator.sendKey, initiator.receiveKey),
      b: new SecureChannel(responder.sendKey, responder.receiveKey),
    };
  }

  it('round-trips frames in both directions', () => {
    const { a, b } = channels();
    for (let index = 0; index < 3; index += 1) {
      const frame = a.seal(Buffer.from(`hello ${index}`), aad);
      expect(b.open(frame, aad).toString()).toBe(`hello ${index}`);
    }
    expect(a.open(b.seal(Buffer.from('back'), aad), aad).toString()).toBe(
      'back',
    );
  });

  it('rejects replayed and skipped frames', () => {
    const { a, b } = channels();
    const first = a.seal(Buffer.from('one'), aad);
    b.open(first, aad);
    expect(() => b.open(first, aad)).toThrow(SecureChannelError);
    a.seal(Buffer.from('two'), aad);
    const third = a.seal(Buffer.from('three'), aad);
    expect(thrownCode(() => b.open(third, aad))).toBe('replayed');
  });

  it('rejects tampered ciphertext and mismatched associated data', () => {
    const { a, b } = channels();
    const frame = a.seal(Buffer.from('secret'), aad);
    const tampered = Buffer.from(frame);
    tampered[10] = (tampered[10] ?? 0) ^ 0xff;
    expect(thrownCode(() => b.open(tampered, aad))).toBe('authentication');
    const { a: a2, b: b2 } = channels();
    expect(
      thrownCode(() =>
        b2.open(a2.seal(Buffer.from('x'), aad), Buffer.from('other')),
      ),
    ).toBe('authentication');
  });
});
