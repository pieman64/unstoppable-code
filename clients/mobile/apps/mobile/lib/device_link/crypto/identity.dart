import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

import '../protocol.dart';

String linkBase64(List<int> bytes) =>
    base64Url.encode(bytes).replaceAll('=', '');

Uint8List linkBytes(String value, int length) {
  try {
    if (!RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(value)) {
      throw const FormatException();
    }
    final bytes = base64Url.decode(base64Url.normalize(value));
    if (bytes.length != length) throw const FormatException();
    return bytes;
  } on FormatException {
    throw const DeviceLinkException('Invalid peer key or signature.');
  }
}

Uint8List linkRandomBytes(int length) {
  final random = Random.secure();
  return Uint8List.fromList(List.generate(length, (_) => random.nextInt(256)));
}

Future<String> linkDeviceId(String publicKey) async {
  final digest = await Sha256().hash(linkBytes(publicKey, 32));
  return linkBase64(digest.bytes.sublist(0, 16));
}

final class DeviceLinkIdentity {
  DeviceLinkIdentity._(this.keyPair, this.publicKey, this.deviceId);

  static Future<DeviceLinkIdentity> fromSeed(List<int> seed) async {
    if (seed.length != 32) {
      throw const DeviceLinkException('Invalid device identity.');
    }
    final key = await Ed25519().newKeyPairFromSeed(seed);
    final publicKey = linkBase64((await key.extractPublicKey()).bytes);
    return DeviceLinkIdentity._(key, publicKey, await linkDeviceId(publicKey));
  }

  final SimpleKeyPair keyPair;
  final String publicKey;
  final String deviceId;
}
