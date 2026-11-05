import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

import '../protocol.dart';
import 'identity.dart';

// Matches Nick's existing crypto transcript byte-for-byte. The application
// contract negotiated AFTER this handshake is deviceLinkProtocol, not IPC v7.
const _handshakeProtocol = 'canopy-remote-control/1';

final class DeviceLinkKeys {
  const DeviceLinkKeys({
    required this.sendKey,
    required this.receiveKey,
    required this.code,
  });
  final SecretKey sendKey;
  final SecretKey receiveKey;
  final String code;
}

final class DeviceLinkHandshake {
  DeviceLinkHandshake._({
    required this.identity,
    required this.peerId,
    required this.pinnedPublicKey,
    required this.purpose,
    required this.sessionId,
    required this._ephemeral,
    required this._ephemeralPublicKey,
    required this._nonce,
    required this._commitment,
  });

  static Future<DeviceLinkHandshake> create({
    required DeviceLinkIdentity identity,
    required String peerId,
    required String pinnedPublicKey,
    required String purpose,
  }) async {
    if (purpose != 'pair' && purpose != 'control') {
      throw ArgumentError.value(purpose);
    }
    if (await linkDeviceId(pinnedPublicKey) != peerId) {
      throw const DeviceLinkException(
        'The peer identity does not match its key.',
      );
    }
    final ephemeral = await X25519().newKeyPair();
    final publicKey = (await ephemeral.extractPublicKey()).bytes;
    final nonce = linkRandomBytes(32);
    final commitment = await Sha256().hash([
      ...utf8.encode('commit'),
      ...publicKey,
      ...nonce,
    ]);
    return DeviceLinkHandshake._(
      identity: identity,
      peerId: peerId,
      pinnedPublicKey: pinnedPublicKey,
      purpose: purpose,
      sessionId: linkRandomBytes(16),
      ephemeral: ephemeral,
      ephemeralPublicKey: linkBase64(publicKey),
      nonce: linkBase64(nonce),
      commitment: linkBase64(commitment.bytes),
    );
  }

  final DeviceLinkIdentity identity;
  final String peerId;
  final String pinnedPublicKey;
  final String purpose;
  final Uint8List sessionId;
  final SimpleKeyPair _ephemeral;
  final String _ephemeralPublicKey;
  final String _nonce;
  final String _commitment;
  Uint8List? _transcript;
  SimplePublicKey? _peerEphemeral;
  int _stage = 0;

  Map<String, dynamic> start() {
    if (_stage != 0) {
      throw const DeviceLinkException('The handshake already started.');
    }
    _stage = 1;
    return {
      'protocol': _handshakeProtocol,
      'purpose': purpose,
      'initiatorKey': identity.publicKey,
      'commitment': _commitment,
    };
  }

  Future<Map<String, dynamic>> receiveHello2(Map<String, dynamic> hello) async {
    if (_stage != 1) {
      throw const DeviceLinkException('Unexpected handshake message.');
    }
    _stage = 2;
    if (hello['responderKey'] != pinnedPublicKey) {
      throw const DeviceLinkException(
        'The peer key changed. Pair again with the correct peer.',
      );
    }
    final remoteEphemeral = linkBytes(deviceLinkString(hello, 'ephemeral'), 32);
    final remoteNonce = linkBytes(deviceLinkString(hello, 'nonce'), 32);
    _peerEphemeral = SimplePublicKey(remoteEphemeral, type: KeyPairType.x25519);
    final transcript = BytesBuilder();
    for (final part in <List<int>>[
      utf8.encode(_handshakeProtocol),
      utf8.encode(purpose),
      sessionId,
      linkBytes(identity.publicKey, 32),
      linkBytes(pinnedPublicKey, 32),
      linkBytes(_commitment, 32),
      linkBytes(_ephemeralPublicKey, 32),
      linkBytes(_nonce, 32),
      remoteEphemeral,
      remoteNonce,
    ]) {
      final length = ByteData(4)..setUint32(0, part.length);
      transcript.add(length.buffer.asUint8List());
      transcript.add(part);
    }
    _transcript = Uint8List.fromList(
      (await Sha256().hash(transcript.takeBytes())).bytes,
    );
    final signature = await Ed25519().sign([
      ...utf8.encode('initiator'),
      ..._transcript!,
    ], keyPair: identity.keyPair);
    return {
      'ephemeral': _ephemeralPublicKey,
      'nonce': _nonce,
      'signature': linkBase64(signature.bytes),
    };
  }

  Future<DeviceLinkKeys> receiveHello4(Map<String, dynamic> hello) async {
    final transcript = _transcript;
    final remoteEphemeral = _peerEphemeral;
    if (_stage != 2 || transcript == null || remoteEphemeral == null) {
      throw const DeviceLinkException('Unexpected handshake message.');
    }
    _stage = 3;
    final valid = await Ed25519().verify(
      [...utf8.encode('responder'), ...transcript],
      signature: Signature(
        linkBytes(deviceLinkString(hello, 'signature'), 64),
        publicKey: SimplePublicKey(
          linkBytes(pinnedPublicKey, 32),
          type: KeyPairType.ed25519,
        ),
      ),
    );
    if (!valid) {
      throw const DeviceLinkException('The peer signature is invalid.');
    }
    final shared = await X25519().sharedSecretKey(
      keyPair: _ephemeral,
      remotePublicKey: remoteEphemeral,
    );
    if ((await shared.extractBytes()).every((byte) => byte == 0)) {
      throw const DeviceLinkException('The peer key is invalid.');
    }
    Future<List<int>> derive(String label, int length) async =>
        (await Hkdf(hmac: Hmac.sha256(), outputLength: length).deriveKey(
          secretKey: shared,
          nonce: transcript,
          info: utf8.encode('$_handshakeProtocol $label'),
        )).extractBytes();
    final traffic = await derive('traffic', 64);
    final sas = Uint8List.fromList(await derive('sas', 4));
    return DeviceLinkKeys(
      sendKey: SecretKey(traffic.sublist(0, 32)),
      receiveKey: SecretKey(traffic.sublist(32)),
      code: (ByteData.sublistView(sas).getUint32(0) % 1000000)
          .toString()
          .padLeft(6, '0'),
    );
  }
}
