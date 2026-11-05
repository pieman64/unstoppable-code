import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

import '../protocol.dart';
import 'handshake.dart';

/// AES-GCM wire compatibility with the desktop SecureChannel. Its caller
/// serializes reads/writes; a failed authentication invalidates the channel.
final class DeviceLinkSecureChannel {
  DeviceLinkSecureChannel(this.keys);
  final DeviceLinkKeys keys;
  final _cipher = AesGcm.with256bits();
  int _sendCounter = 0;
  int _receiveCounter = 0;
  bool _failed = false;

  Uint8List _nonce(int counter) =>
      (ByteData(12)..setUint64(4, counter)).buffer.asUint8List();

  Future<Uint8List> seal(Uint8List plaintext, Uint8List associatedData) async {
    if (_failed || _sendCounter == 0x7fffffffffffffff) {
      throw const DeviceLinkException('The encrypted connection ended.');
    }
    final counter = _sendCounter++;
    try {
      final box = await _cipher.encrypt(
        plaintext,
        secretKey: keys.sendKey,
        nonce: _nonce(counter),
        aad: associatedData,
      );
      return Uint8List.fromList([
        ...(ByteData(8)..setUint64(0, counter)).buffer.asUint8List(),
        ...box.cipherText,
        ...box.mac.bytes,
      ]);
    } catch (_) {
      _failed = true;
      throw const DeviceLinkException('Could not encrypt the message.');
    }
  }

  Future<Uint8List> open(Uint8List frame, Uint8List associatedData) async {
    try {
      if (_failed ||
          frame.length < 24 ||
          ByteData.sublistView(frame).getUint64(0) != _receiveCounter) {
        throw const DeviceLinkException(
          'The encrypted message is out of sequence.',
        );
      }
      final plaintext = await _cipher.decrypt(
        SecretBox(
          frame.sublist(8, frame.length - 16),
          nonce: _nonce(_receiveCounter),
          mac: Mac(frame.sublist(frame.length - 16)),
        ),
        secretKey: keys.receiveKey,
        aad: associatedData,
      );
      _receiveCounter++;
      return Uint8List.fromList(plaintext);
    } catch (_) {
      _failed = true;
      throw const DeviceLinkException(
        'The encrypted message could not be verified.',
      );
    }
  }
}
